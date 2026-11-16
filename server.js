// SpotyClips - servidor local sin dependencias (Node 18+)
// Saca las canciones de una playlist de Spotify y busca su videoclip en YouTube.
const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const dns = require('dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch {}

// Petición HTTPS con el módulo nativo (más fiable que fetch en algunos equipos/redes).
// Devuelve un objeto parecido a Response: { ok, status, text(), json() }
function fetch(url, opts = {}, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      family: 4,
      timeout: 20000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetch(new URL(res.headers.location, url).toString(), opts, redirects - 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode,
          text: async () => body, json: async () => JSON.parse(body) });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Tiempo de espera agotado')));
    req.on('error', (e) => reject(new Error(`No se pudo conectar con ${new URL(url).host}: ${e.code || e.message}`)));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const PORT = process.env.PORT || 3456;
const PUBLIC = path.join(__dirname, 'public');
const CACHE_FILE = path.join(__dirname, 'cache-youtube.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  // Evita la pantalla de consentimiento de cookies de Google/YouTube en Europa
  'Cookie': 'CONSENT=YES+cb; SOCS=CAI',
};

// ---------- utilidades ----------
let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}

let ytCache = {};
try { ytCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}
let saveTimer = null;
function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(CACHE_FILE, JSON.stringify(ytCache), () => {});
  }, 1000);
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function extractPlaylistId(input) {
  input = String(input || '').trim();
  const m = input.match(/playlist[/:]([A-Za-z0-9]{10,})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9]{10,}$/.test(input)) return input;
  return null;
}

// ---------- Spotify ----------
// Opción A (sin claves): página "embed" pública de la playlist.
async function playlistFromEmbed(id) {
  const r = await fetch(`https://open.spotify.com/embed/playlist/${id}`, { headers: HEADERS });
  if (!r.ok) throw new Error(`Spotify respondió ${r.status}`);
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('No se pudo leer la playlist (¿es pública?)');
  const data = JSON.parse(m[1]);
  const entity = data?.props?.pageProps?.state?.data?.entity;
  if (!entity || !Array.isArray(entity.trackList)) throw new Error('Playlist no encontrada o privada');
  const cover = entity.coverArt?.sources?.[0]?.url || null;
  return {
    id,
    name: entity.name || entity.title || 'Playlist',
    owner: entity.subtitle || '',
    cover,
    source: 'embed',
    tracks: entity.trackList.map((t) => ({
      key: t.uri || t.uid || `${t.title}|${t.subtitle}`,
      title: t.title,
      artists: (t.subtitle || '').replace(/ /g, ' '),
      durationMs: t.duration || 0,
      spotifyUrl: t.uri ? `https://open.spotify.com/track/${t.uri.split(':').pop()}` : null,
    })),
  };
}

// Opción B (opcional, para playlists de más de 100 canciones): API oficial con
// client credentials. Rellena config.json con clientId y clientSecret.
let spToken = null, spTokenExp = 0;
async function spotifyToken() {
  if (spToken && Date.now() < spTokenExp) return spToken;
  const auth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`Token Spotify: ${r.status}`);
  const j = await r.json();
  spToken = j.access_token;
  spTokenExp = Date.now() + (j.expires_in - 60) * 1000;
  return spToken;
}

async function playlistFromApi(id) {
  const token = await spotifyToken();
  const h = { Authorization: `Bearer ${token}` };
  const metaR = await fetch(`https://api.spotify.com/v1/playlists/${id}?fields=name,owner(display_name),images`, { headers: h });
  if (!metaR.ok) throw new Error(`API Spotify: ${metaR.status}`);
  const meta = await metaR.json();
  const tracks = [];
  let url = `https://api.spotify.com/v1/playlists/${id}/items?limit=100`; // /tracks se retiró en 2026
  while (url) {
    const r = await fetch(url, { headers: h });
    if (!r.ok) throw new Error(`API Spotify: ${r.status}`);
    const j = await r.json();
    for (const it of j.items || []) {
      const t = it.track || it.item;
      if (!t || t.type === 'episode' || !t.name) continue;
      tracks.push({
        key: t.uri,
        title: t.name,
        artists: (t.artists || []).map((a) => a.name).join(', '),
        durationMs: t.duration_ms || 0,
        spotifyUrl: t.external_urls?.spotify || null,
      });
    }
    url = j.next;
  }
  return {
    id, name: meta.name, owner: meta.owner?.display_name || '',
    cover: meta.images?.[0]?.url || null, source: 'api', tracks,
  };
}

async function getPlaylist(id) {
  if (config.clientId && config.clientSecret) {
    try { return await playlistFromApi(id); }
    catch (e) { console.warn('API de Spotify falló, uso embed:', e.message); }
  }
  return playlistFromEmbed(id);
}

// ---------- YouTube ----------
function findVideoRenderers(node, out) {
  if (!node || typeof node !== 'object' || out.length >= 15) return;
  if (Array.isArray(node)) { for (const n of node) findVideoRenderers(n, out); return; }
  if (node.videoRenderer && node.videoRenderer.videoId) { out.push(node.videoRenderer); return; }
  for (const k in node) findVideoRenderers(node[k], out);
}

const txt = (o) => o?.simpleText || (o?.runs || []).map((r) => r.text).join('') || '';
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function scoreVideo(v, title, artists) {
  const t = norm(v.title), ch = norm(v.channel);
  const mainArtist = norm(artists.split(',')[0].trim());
  const songWords = norm(title.replace(/\(.*?\)|\[.*?\]|- .*$/g, '')).split(/\s+/).filter((w) => w.length > 2);
  let s = 0;
  if (/official (music )?video|videoclip|video oficial|music video|\(official\)/.test(t)) s += 30;
  if (/vevo/.test(ch)) s += 20;
  if (mainArtist && (ch.includes(mainArtist) || ch.replace(/\s/g, '').includes(mainArtist.replace(/\s/g, '')))) s += 15;
  if (mainArtist && t.includes(mainArtist)) s += 10;
  const hits = songWords.filter((w) => t.includes(w)).length;
  s += songWords.length ? Math.round((hits / songWords.length) * 25) : 0;
  if (/lyric|letra|karaoke|cover|reaction|tutorial|8d|slowed|sped up|nightcore|instrumental/.test(t)) s -= 25;
  if (/official audio|audio oficial|\(audio\)|visualizer|visualiser/.test(t)) s -= 12;
  if (/\blive\b|en vivo|en directo|concert/.test(t) && !/live/.test(norm(title))) s -= 10;
  if (/ - topic$/.test(ch)) s -= 15; // canales "Artista - Topic" = solo audio
  return s;
}

async function searchYouTube(query) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D`; // solo vídeos
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`YouTube respondió ${r.status}`);
  const html = await r.text();
  const m = html.match(/var ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/) || html.match(/ytInitialData"\]\s*=\s*(\{[\s\S]*?\});/);
  if (!m) throw new Error('No se pudo leer la búsqueda de YouTube');
  const data = JSON.parse(m[1]);
  const renderers = [];
  findVideoRenderers(data, renderers);
  return renderers.map((v) => ({
    videoId: v.videoId,
    title: txt(v.title),
    channel: txt(v.ownerText) || txt(v.longBylineText),
    length: txt(v.lengthText),
    views: txt(v.shortViewCountText),
  }));
}

async function findClip(title, artists) {
  const key = norm(`${artists}|${title}`);
  if (ytCache[key]) return ytCache[key];
  const cleanTitle = title.replace(/\s*-\s*(remaster(ed)?|\d{4} remaster).*$/i, '').trim();
  const mainArtist = artists.split(',')[0].trim();
  const results = await searchYouTube(`${mainArtist} ${cleanTitle} official video`);
  const ranked = results
    .map((v) => ({ ...v, score: scoreVideo(v, cleanTitle, artists) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  const out = { best: ranked[0] || null, alternatives: ranked };
  if (ranked.length) { ytCache[key] = out; saveCache(); }
  return out;
}

// ---------- servidor ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (u.pathname === '/api/playlist') {
      const id = extractPlaylistId(u.searchParams.get('id'));
      if (!id) return sendJSON(res, 400, { error: 'ID o enlace de playlist no válido' });
      return sendJSON(res, 200, await getPlaylist(id));
    }
    if (u.pathname === '/api/clip') {
      const title = u.searchParams.get('title') || '';
      const artists = u.searchParams.get('artists') || '';
      if (!title) return sendJSON(res, 400, { error: 'Falta el título' });
      return sendJSON(res, 200, await findClip(title, artists));
    }
    if (u.pathname === '/api/search') {
      const q = u.searchParams.get('q') || '';
      return sendJSON(res, 200, { results: (await searchYouTube(q)).slice(0, 10) });
    }
    // archivos estáticos
    let file = path.normalize(path.join(PUBLIC, u.pathname === '/' ? 'index.html' : u.pathname));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('No encontrado'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  } catch (e) {
    console.error(e);
    sendJSON(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n  SpotyClips listo en  http://localhost:${PORT}\n`);
});
