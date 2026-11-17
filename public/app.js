// SpotyClips - frontend
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

const OVR_KEY = 'spotyclips_overrides';   // vídeos elegidos a mano
const LAST_KEY = 'spotyclips_last';
let overrides = {};
try { overrides = JSON.parse(localStorage.getItem(OVR_KEY) || '{}'); } catch {}
const saveOverrides = () => { try { localStorage.setItem(OVR_KEY, JSON.stringify(overrides)); } catch {} };

let tracks = [];        // {key,title,artists,durationMs,spotifyUrl, video, alternatives, state}
let current = -1;
let player = null, playerReady = false, pendingVideo = null;
let loadToken = 0;

// ---------- YouTube player ----------
window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('player', {
    playerVars: { autoplay: 1, rel: 0, modestbranding: 1 },
    events: {
      onReady: () => { playerReady = true; if (pendingVideo) { player.loadVideoById(pendingVideo); pendingVideo = null; } },
      onStateChange: (e) => { if (e.data === YT.PlayerState.ENDED) next(); },
      // 101/150 = el dueño no permite reproducirlo incrustado -> probar alternativa o saltar
      onError: (e) => handleVideoError(e.data),
    },
  });
};

function loadVideo(id) {
  $('#playerEmpty').style.display = 'none';
  if (playerReady) player.loadVideoById(id); else pendingVideo = id;
}

function handleVideoError(code) {
  const t = tracks[current];
  if (!t) return;
  if ((code === 101 || code === 150 || code === 100) && t.alternatives?.length && !overrides[t.key]) {
    const idx = t.alternatives.findIndex((a) => a.videoId === t.video?.videoId);
    const alt = t.alternatives[idx + 1];
    if (alt) { t.video = alt; renderRow(current); loadVideo(alt.videoId); return; }
  }
  setTimeout(next, 800);
}

// ---------- reproducción ----------
async function play(i) {
  if (i < 0 || i >= tracks.length) return;
  const prev = current; current = i;
  if (prev >= 0) renderRow(prev);
  renderRow(i);
  const t = tracks[i];
  $('#nowPlaying').innerHTML = `${esc(t.title)}<small>${esc(t.artists)}</small>`;
  document.getElementById(`row-${i}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (!t.video) await ensureClip(i, true);
  if (current !== i) return;
  if (t.video) loadVideo(t.video.videoId); else next();
}

function next() {
  if (!tracks.length) return;
  if (current + 1 < tracks.length) play(current + 1);
}

// ---------- búsqueda de clips ----------
async function ensureClip(i, priority = false) {
  const t = tracks[i];
  if (t.video || (t.state === 'none' && !t.failed)) return; // si falló por error, se reintenta
  if (overrides[t.key]) { t.video = overrides[t.key]; t.state = 'done'; renderRow(i); return; }
  if (t.promise) return t.promise;
  t.state = 'loading'; renderRow(i);
  t.promise = (async () => {
    try {
      const r = await fetch(`/api/clip?title=${encodeURIComponent(t.title)}&artists=${encodeURIComponent(t.artists)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      t.video = j.best; t.alternatives = j.alternatives || [];
      t.state = t.video ? 'done' : 'none'; t.failed = false;
    } catch (e) {
      console.warn(t.title, e); t.state = 'none'; t.failed = true;
    }
    t.promise = null;
    renderRow(i); updateProgress();
  })();
  return t.promise;
}

async function searchAll(token) {
  // 3 búsquedas en paralelo para no saturar YouTube
  let idx = 0;
  const worker = async () => {
    while (idx < tracks.length && token === loadToken) await ensureClip(idx++);
  };
  await Promise.all([worker(), worker()]);
  // Segunda pasada: reintenta las que fallaron por error de conexión
  for (let i = 0; i < tracks.length && token === loadToken; i++) {
    if (tracks[i].failed) { await new Promise((r) => setTimeout(r, 1500)); await ensureClip(i); }
  }
}

function updateProgress() {
  const done = tracks.filter((t) => t.state === 'done').length;
  const none = tracks.filter((t) => t.state === 'none').length;
  const pending = tracks.length - done - none;
  $('#progress').textContent = `${tracks.length} canciones · ${done} con vídeo` + (none ? ` · ${none} sin encontrar` : '') + (pending ? ` · buscando ${pending}…` : '');
}

// ---------- render ----------
function rowHTML(t, i) {
  const v = t.video;
  const manual = !!overrides[t.key];
  return `
    <span class="num">${i + 1}</span>
    <div class="thumb ${t.state === 'loading' ? 'loading' : ''}" data-play="${i}" style="${v ? `background-image:url(https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg)` : ''}"></div>
    <div class="info">
      <div class="t">${esc(t.title)}</div>
      <div class="a">${esc(t.artists)} · ${fmt(t.durationMs)}</div>
      <div class="v ${manual ? 'manual' : ''}">${v ? `${manual ? '✔ elegido a mano · ' : ''}${esc(v.title)} — ${esc(v.channel || '')}` : t.state === 'none' ? 'Sin vídeo encontrado' : ''}</div>
    </div>
    <div class="acts">
      <button data-play="${i}" title="Reproducir">▶</button>
      <button data-alt="${i}" title="Elegir otro vídeo">🔄</button>
      ${v ? `<a href="https://www.youtube.com/watch?v=${v.videoId}" target="_blank" title="Abrir en YouTube">↗</a>` : ''}
    </div>`;
}

function renderRow(i) {
  const li = document.getElementById(`row-${i}`);
  if (!li) return;
  const t = tracks[i];
  li.className = `${i === current ? 'playing' : ''} ${t.state === 'none' ? 'novideo' : ''}`;
  li.innerHTML = rowHTML(t, i);
}

function renderList() {
  $('#list').innerHTML = tracks.map((_, i) => `<li id="row-${i}"></li>`).join('');
  tracks.forEach((_, i) => renderRow(i));
}

$('#list').addEventListener('click', (e) => {
  const a = e.target.closest('[data-alt]'); if (a) return openAlternatives(+a.dataset.alt);
  if (e.target.closest('a')) return; // enlace "abrir en YouTube"
  const li = e.target.closest('li[id^="row-"]'); if (li) play(+li.id.slice(4));
});

// ---------- cargar playlist ----------
async function loadPlaylist(input) {
  const token = ++loadToken;
  $('#progress').textContent = 'Cargando playlist…';
  $('#list').innerHTML = ''; $('#plHeader').innerHTML = '';
  try {
    const r = await fetch(`/api/playlist?id=${encodeURIComponent(input)}`);
    const pl = await r.json();
    if (!r.ok) throw new Error(pl.error);
    if (token !== loadToken) return;
    try { localStorage.setItem(LAST_KEY, pl.id); } catch {}
    rememberList(pl);
    tracks = pl.tracks.map((t) => ({ ...t, video: null, alternatives: [], state: 'idle' }));
    current = -1;
    $('#plHeader').innerHTML = `${pl.cover ? `<img src="${esc(pl.cover)}">` : ''}<div><h2>${esc(pl.name)}</h2><p>${esc(pl.owner)}${pl.source === 'embed' && tracks.length >= 100 ? ' · (máx. 100 canciones sin claves de API, mira el LEEME)' : ''}</p></div>`;
    renderList(); updateProgress();
    document.body.classList.remove('empty'); // ya hay playlist: mostrar el reproductor
    searchAll(token);
  } catch (e) {
    $('#progress').textContent = e instanceof TypeError
      ? '❌ No conecta con el servidor local. ¿Está abierta la ventana negra de iniciar.bat?'
      : '❌ ' + e.message;
  }
}

$('#form').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#input').value.trim(); if (v) loadPlaylist(v); });

// ---------- diálogo de alternativas ----------
let altIndex = -1;
function openAlternatives(i) {
  altIndex = i;
  const t = tracks[i];
  $('#altTitle').textContent = `${t.title} — ${t.artists}`;
  $('#altQuery').value = `${t.artists.split(',')[0]} ${t.title}`;
  $('#altUrl').value = '';
  renderAlt(t.alternatives || []);
  $('#altDialog').showModal();
  if (!t.alternatives?.length) doAltSearch();
}

function renderAlt(list) {
  $('#altList').innerHTML = list.length ? list.map((v, k) => `
    <li data-k="${k}">
      <img src="https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg" loading="lazy">
      <div><div>${esc(v.title)}</div><div class="m">${esc(v.channel)} · ${esc(v.length || '')} · ${esc(v.views || '')}</div></div>
    </li>`).join('') : '<li style="cursor:default">Sin resultados</li>';
  $('#altList').onclick = (e) => {
    const li = e.target.closest('li[data-k]'); if (!li) return;
    chooseVideo(list[+li.dataset.k]);
  };
}

async function doAltSearch() {
  $('#altList').innerHTML = '<li style="cursor:default">Buscando…</li>';
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent($('#altQuery').value)}`);
    const j = await r.json();
    renderAlt(j.results || []);
  } catch { renderAlt([]); }
}
$('#altSearchBtn').onclick = doAltSearch;
$('#altQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAltSearch(); } });

$('#altUrlBtn').onclick = () => {
  const m = $('#altUrl').value.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/) || $('#altUrl').value.trim().match(/^([\w-]{11})$/);
  if (!m) return alert('Enlace de YouTube no válido');
  chooseVideo({ videoId: m[1], title: 'Vídeo elegido a mano', channel: '' });
};

function chooseVideo(v) {
  const t = tracks[altIndex];
  const clean = { videoId: v.videoId, title: v.title, channel: v.channel };
  t.video = clean; t.state = 'done';
  overrides[t.key] = clean; saveOverrides();
  $('#altDialog').close();
  renderRow(altIndex); updateProgress();
  play(altIndex);
}

// ---------- combo "Mis listas" ----------
const LISTS_KEY = 'spotyclips_lists';
let myLists = [];
try { myLists = JSON.parse(localStorage.getItem(LISTS_KEY) || '[]'); } catch {}

function renderMine(selectedId) {
  const sorted = [...myLists].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  $('#mine').innerHTML = '<option value="">📂 Mis listas</option>' +
    sorted.map((l) => `<option value="${esc(l.id)}">${esc(l.name)} (${l.count})</option>`).join('');
  $('#mine').value = selectedId || '';
}

function rememberList(pl) {
  const entry = { id: pl.id, name: pl.name, count: pl.tracks.length };
  const i = myLists.findIndex((l) => l.id === pl.id);
  if (i >= 0) myLists[i] = entry; else myLists.push(entry);
  try { localStorage.setItem(LISTS_KEY, JSON.stringify(myLists)); } catch {}
  renderMine(pl.id);
}

$('#mine').addEventListener('change', () => {
  const id = $('#mine').value;
  if (id) { $('#input').value = id; loadPlaylist(id); }
});
$('#mineDel').onclick = () => {
  const id = $('#mine').value;
  if (!id) return;
  myLists = myLists.filter((l) => l.id !== id);
  try { localStorage.setItem(LISTS_KEY, JSON.stringify(myLists)); } catch {}
  renderMine('');
};
renderMine(localStorage.getItem(LAST_KEY));

// ---------- arranque ----------
if (location.protocol === 'file:') {
  $('#progress').innerHTML = '⚠️ Has abierto el archivo directamente. Arranca <b>iniciar.bat</b> y entra en <b>http://localhost:3456</b>';
  throw new Error('Abierto como file://');
}
const last = new URLSearchParams(location.search).get('id') || localStorage.getItem(LAST_KEY);
if (last) { $('#input').value = last; loadPlaylist(last); }
