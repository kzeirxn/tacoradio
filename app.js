'use strict';

const STREAM_URL = 'https://icecast.tacogroup.uk/stream';
const FEED_URL = 'https://icecast.tacogroup.uk/nowplaying/nowplaying.json';
const LYRICS_API = 'https://lrclib.net/api/search';
const POLL_MS = 10000;
// Listeners hear the stream a couple of seconds behind the feed, so hold new titles
// (and the lyrics timing) back to match. Raise it if lyrics run ahead of the music.
const LISTEN_DELAY = 2;
const FALLBACK_COVER = 'icons/icon-512.png';

const $ = (id) => document.getElementById(id);
const els = {
  app: document.querySelector('.app'),
  play: $('play'),
  coverA: $('cover-a'),
  coverB: $('cover-b'),
  vinylCover: $('vinyl-cover'),
  meta: $('meta'),
  themeColor: $('theme-color'),
  title: $('title'),
  artist: $('artist'),
  album: $('album'),
  progress: $('progress'),
  fill: $('progress-fill'),
  elapsed: $('elapsed'),
  duration: $('duration'),
  live: $('live-badge'),
  listeners: $('listener-count'),
  history: $('history'),
  historyEmpty: $('history-empty'),
  lyrics: $('lyrics'),
  lyricsStatus: $('lyrics-status'),
  lyricsPanel: $('lyrics-panel'),
  recentPanel: $('recent-panel'),
  tabLyrics: $('tab-lyrics'),
  tabRecent: $('tab-recent'),
  notice: $('notice'),
  volume: $('volume'),
  volumeRow: $('volume-row'),
  install: $('install'),
  iosHint: $('ios-hint'),
};

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const hasMediaSession = 'mediaSession' in navigator;

const audio = new Audio();
audio.preload = 'none';

let wantPlaying = false;
let retryTimer = null;
let pollTimer = null;
let feed = null;
let shownKey;
let shownTrack = null;
let historySig = '';

const now = () => Date.now() / 1000;

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function timeAgo(ts) {
  if (!ts) return '';
  const s = now() - ts;
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// ---- Playback ----

function setState(state) {
  els.play.dataset.state = state;
  els.play.setAttribute('aria-label', state === 'idle' ? 'Play' : 'Pause');
  els.app.dataset.playing = String(state === 'playing');
  if (hasMediaSession) navigator.mediaSession.playbackState = state === 'idle' ? 'paused' : 'playing';
}

function play() {
  wantPlaying = true;
  clearTimeout(retryTimer);
  els.notice.textContent = '';
  setState('loading');
  // A fresh connection every time, so playback always starts at the live point
  audio.src = `${STREAM_URL}?t=${Date.now()}`;
  audio.play().catch((err) => {
    if (err.name === 'NotAllowedError') {
      wantPlaying = false;
      setState('idle');
    }
  });
}

function stop() {
  wantPlaying = false;
  clearTimeout(retryTimer);
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  els.notice.textContent = '';
  setState('idle');
}

function reconnect() {
  if (!wantPlaying) return;
  setState('loading');
  els.notice.textContent = 'Connection lost. Reconnecting…';
  clearTimeout(retryTimer);
  retryTimer = setTimeout(play, 3000);
}

els.play.addEventListener('click', () => (wantPlaying ? stop() : play()));
audio.addEventListener('playing', () => {
  els.notice.textContent = '';
  setState('playing');
});
audio.addEventListener('waiting', () => {
  if (wantPlaying) setState('loading');
});
audio.addEventListener('error', reconnect);
audio.addEventListener('ended', reconnect);

if (hasMediaSession) {
  for (const [action, handler] of [['play', play], ['pause', stop], ['stop', stop]]) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* not supported */ }
  }
}

// iOS ignores page volume control, so only offer the slider elsewhere
if (isIOS) els.volumeRow.hidden = true;
try {
  const saved = parseFloat(localStorage.getItem('taco-volume'));
  if (saved >= 0 && saved <= 1) els.volume.value = saved;
} catch { /* storage unavailable */ }
audio.volume = parseFloat(els.volume.value);
els.volume.addEventListener('input', () => {
  audio.volume = parseFloat(els.volume.value);
  try { localStorage.setItem('taco-volume', els.volume.value); } catch { /* storage unavailable */ }
});

// ---- Now playing ----

function currentTrack() {
  const np = feed && feed.now_playing;
  const history = (feed && feed.history) || [];
  if (!np) return { track: null, history };
  if (np.started_at && now() < np.started_at + LISTEN_DELAY && history[0]) {
    // Listeners are still hearing the previous song
    const previous = shownTrack && shownTrack.text === history[0].text
      ? shownTrack
      : { ...history[0], started_at: null, duration: null };
    return { track: previous, history: history.slice(1) };
  }
  return { track: np, history };
}

// ---- Cover art and colours ----

const BRAND_THEME = { tint1: 'hsl(20 50% 13%)', tint2: 'hsl(16 72% 31%)', accent: 'hsl(24 100% 62%)', ink: '#1A0F09' };
let coverRequest = '';
let frontCover = els.coverA;

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}

function luminance([r, g, b]) {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// The cover's dominant colour and a contrasting second one, found by sorting the pixels
// of a small thumbnail into hue buckets weighted by how colourful each pixel is
function coverColors(img) {
  try {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    const buckets = Array.from({ length: 18 }, () => ({ weight: 0, sat: 0, x: 0, y: 0 }));
    let total = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
      const weight = s * Math.max(0, 1 - Math.abs(l - 0.5) * 1.6);
      if (weight <= 0) continue;
      const bucket = buckets[Math.floor(h / 20) % 18];
      bucket.weight += weight;
      bucket.sat += s * weight;
      bucket.x += Math.cos((h * Math.PI) / 180) * weight;
      bucket.y += Math.sin((h * Math.PI) / 180) * weight;
      total += weight;
    }
    if (total < 8) return null; // mostly black, white or grey
    const ranked = buckets
      .map((b, i) => ({ ...b, index: i }))
      .filter((b) => b.weight > 0)
      .sort((a, b) => b.weight - a.weight);
    const colour = (b) => [((Math.atan2(b.y, b.x) * 180) / Math.PI + 360) % 360, b.sat / b.weight];
    const first = ranked[0];
    // Second colour: the strongest hue at least 40° away from the first
    const second = ranked.find((b) => {
      const gap = Math.abs(b.index - first.index);
      return Math.min(gap, 18 - gap) >= 2 && b.weight > total * 0.08;
    });
    return { primary: colour(first), secondary: second ? colour(second) : null };
  } catch {
    return null; // cover served without CORS headers: keep the brand colours
  }
}

function themeFrom(colors) {
  if (!colors) return BRAND_THEME;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pct = (v) => `${(v * 100).toFixed(0)}%`;
  const [ph, ps] = colors.primary;
  const [sh, ss] = colors.secondary || colors.primary;
  const accentS = clamp(ps * 1.25, 0.55, 0.9);
  const ink = luminance(hslToRgb(ph, accentS, 0.62)) > 0.3 ? '#140C08' : '#FFFFFF';
  return {
    tint1: `hsl(${ph.toFixed(0)} ${pct(clamp(ps, 0.25, 0.6))} 12%)`,
    tint2: `hsl(${sh.toFixed(0)} ${pct(clamp(ss, 0.4, 0.8))} 32%)`,
    accent: `hsl(${ph.toFixed(0)} ${pct(accentS)} 62%)`,
    ink,
  };
}

function applyTheme(theme) {
  const style = els.app.style;
  style.setProperty('--tint-1', theme.tint1);
  style.setProperty('--tint-2', theme.tint2);
  style.setProperty('--accent', theme.accent);
  style.setProperty('--accent-ink', theme.ink);
  els.themeColor.setAttribute('content', theme.tint1);
}

function loadImage(src, cors) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (cors) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function setCors(img, cors) {
  if (cors) img.crossOrigin = 'anonymous';
  else img.removeAttribute('crossorigin');
}

function setCover(url) {
  const src = url || FALLBACK_COVER;
  if (coverRequest === src) return;
  coverRequest = src;
  // Load with CORS so the colours can be read; fall back to a plain load if that's refused
  loadImage(src, true)
    .catch(() => loadImage(src, false))
    .then((img) => {
      if (coverRequest !== src) return;
      const cors = img.crossOrigin === 'anonymous';
      const back = frontCover === els.coverA ? els.coverB : els.coverA;
      setCors(back, cors);
      back.src = src;
      back.classList.add('is-front');
      frontCover.classList.remove('is-front');
      frontCover = back;
      setCors(els.vinylCover, cors);
      els.vinylCover.src = src;
      applyTheme(themeFrom(cors ? coverColors(img) : null));
    })
    .catch(() => {
      if (coverRequest === src && src !== FALLBACK_COVER) {
        coverRequest = '';
        setCover(null);
      }
    });
}

function updateMediaSession(track) {
  if (!hasMediaSession || typeof MediaMetadata === 'undefined') return;
  const artwork = track && track.cover
    ? [{ src: track.cover }]
    : [{ src: new URL(FALLBACK_COVER, location.href).href, sizes: '512x512', type: 'image/png' }];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: (track && track.title) || 'Taco Music',
    artist: (track && track.artist) || 'Live radio',
    album: (track && track.album) || 'Taco Music',
    artwork,
  });
}

function showTrack(track) {
  els.meta.classList.remove('enter');
  void els.meta.offsetWidth; // restart the entrance animation
  els.meta.classList.add('enter');
  els.title.textContent = (track && track.title) || 'Taco Music';
  els.artist.textContent = track ? (track.artist || '') : 'Live radio, 24/7';
  els.album.textContent = (track && track.album) || '';
  setCover(track && track.cover);
  document.title = track
    ? `${track.title}${track.artist ? ` – ${track.artist}` : ''} · Taco Music`
    : 'Taco Music';
  updateMediaSession(track);
}

function renderProgress(track) {
  if (!track || !track.started_at || !track.duration) {
    els.progress.hidden = true;
    return;
  }
  const elapsed = Math.min(Math.max(now() - track.started_at - LISTEN_DELAY, 0), track.duration);
  els.progress.hidden = false;
  els.fill.style.transform = `scaleX(${elapsed / track.duration})`;
  els.elapsed.textContent = formatTime(elapsed);
  els.duration.textContent = formatTime(track.duration);
}

function historyItem(item) {
  const li = document.createElement('li');

  const img = document.createElement('img');
  img.className = 'thumb';
  img.alt = '';
  img.loading = 'lazy';
  img.src = item.cover || FALLBACK_COVER;
  img.onerror = () => {
    img.onerror = null;
    img.src = FALLBACK_COVER;
  };

  const text = document.createElement('div');
  text.className = 'h-text';
  const title = document.createElement('span');
  title.className = 'h-title';
  title.textContent = item.title || item.text || 'Unknown';
  const artist = document.createElement('span');
  artist.className = 'h-artist';
  artist.textContent = item.artist || '';
  text.append(title, artist);

  const time = document.createElement('time');
  time.textContent = timeAgo(item.played_at);
  if (item.played_at) time.dateTime = new Date(item.played_at * 1000).toISOString();

  li.append(img, text, time);
  return li;
}

function renderHistory(items) {
  // Rebuild only when the list changes, or every 30 s to refresh the "min ago" labels
  const sig = items.map((i) => `${i.text}@${i.played_at}`).join('|') + Math.floor(now() / 30);
  if (sig === historySig) return;
  historySig = sig;
  els.history.replaceChildren(...items.map(historyItem));
  els.historyEmpty.hidden = items.length > 0;
}

function render() {
  if (feed) {
    els.live.dataset.live = String(!!feed.live);
    els.live.textContent = feed.live ? 'Live' : 'Off air';
    els.listeners.textContent = String(feed.listeners ?? 0);
  }
  const { track, history } = currentTrack();
  const key = track ? `${track.text}|${track.started_at}` : null;
  if (key !== shownKey) {
    const sameSong = shownTrack && track && shownTrack.text === track.text;
    shownKey = key;
    shownTrack = track;
    showTrack(track);
    if (!sameSong) showLyrics(track);
  }
  renderProgress(track);
  renderHistory(history);
  syncLyrics();
}

// ---- Lyrics ----

const lyricsCache = new Map();
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let lyricsLines = [];
let activeLine = -1;
let lyricsToken = 0;
let userScrolledUntil = 0;

// Drop "(Remastered)", "(feat. …)", "(From …)" and similar so the search can match
function cleanTitle(title) {
  return title
    .replace(/\s*[([][^)\]]*(remaster|remix|live|version|edit|mono|stereo|from |feat\.?|ft\.|with )[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+.*(remaster|version|edit|live).*$/i, '')
    .trim();
}

async function searchLyrics(artist, title) {
  const params = new URLSearchParams({ track_name: title });
  if (artist) params.set('artist_name', artist);
  const res = await fetch(`${LYRICS_API}?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const results = await res.json();
  return Array.isArray(results) ? results : [];
}

function pickLyrics(results, duration) {
  const usable = results.filter((r) => r.syncedLyrics || r.plainLyrics || r.instrumental);
  const close = duration ? usable.filter((r) => r.duration && Math.abs(r.duration - duration) <= 8) : [];
  for (const pool of [close, usable]) {
    const synced = pool.find((r) => r.syncedLyrics);
    if (synced) return synced;
    if (pool.length) return pool[0];
  }
  return null;
}

function parseLrc(lrc) {
  const lines = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) lines.push({ time: parseInt(m[1], 10) * 60 + parseFloat(m[2]), text });
  }
  return lines.sort((a, b) => a.time - b.time);
}

function fetchLyrics(track) {
  const key = `${track.artist}|${track.title}`;
  if (!lyricsCache.has(key)) {
    const lookup = (async () => {
      let match = pickLyrics(await searchLyrics(track.artist, track.title), track.duration);
      const cleaned = cleanTitle(track.title);
      if (!match && cleaned && cleaned !== track.title) {
        match = pickLyrics(await searchLyrics(track.artist, cleaned), track.duration);
      }
      if (!match) return { kind: 'none' };
      if (match.syncedLyrics) {
        const lines = parseLrc(match.syncedLyrics);
        if (lines.length) return { kind: 'synced', lines };
      }
      if (match.plainLyrics) return { kind: 'plain', text: match.plainLyrics };
      return { kind: match.instrumental ? 'instrumental' : 'none' };
    })();
    lyricsCache.set(key, lookup);
    lookup.catch(() => lyricsCache.delete(key)); // let a failed lookup try again next time
  }
  return lyricsCache.get(key);
}

function setLyricsStatus(text) {
  els.lyricsStatus.textContent = text;
}

async function showLyrics(track) {
  const token = ++lyricsToken;
  lyricsLines = [];
  activeLine = -1;
  els.lyrics.replaceChildren();
  els.lyrics.dataset.synced = 'false';
  els.lyrics.scrollTop = 0;
  if (!track || !track.title) {
    setLyricsStatus('Lyrics will show up here when a song is playing.');
    return;
  }
  setLyricsStatus('Finding lyrics…');
  let result;
  try {
    result = await fetchLyrics(track);
  } catch {
    if (token === lyricsToken) setLyricsStatus('Couldn’t load lyrics right now.');
    return;
  }
  if (token !== lyricsToken) return; // the song changed while we were waiting

  if (result.kind === 'none') return setLyricsStatus('No lyrics found for this song.');
  if (result.kind === 'instrumental') return setLyricsStatus('Instrumental. Enjoy the music.');
  setLyricsStatus('');

  if (result.kind === 'synced') {
    lyricsLines = result.lines.map((line) => {
      const p = document.createElement('p');
      p.className = 'line';
      p.textContent = line.text || '♪';
      return { time: line.time, el: p };
    });
    els.lyrics.dataset.synced = 'true';
    els.lyrics.append(...lyricsLines.map((line) => line.el));
    syncLyrics();
  } else {
    const plain = document.createElement('div');
    plain.className = 'plain';
    plain.textContent = result.text;
    els.lyrics.append(plain);
  }
}

function scrollToLine(el) {
  const box = els.lyrics;
  box.scrollTo({
    top: el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2,
    behavior: reduceMotion ? 'auto' : 'smooth',
  });
}

function syncLyrics() {
  const track = shownTrack;
  const timed = lyricsLines.length > 0 && track && track.started_at;
  els.lyrics.classList.toggle('syncing', !!timed);
  if (!timed) return;
  const elapsed = now() - track.started_at - LISTEN_DELAY;
  let index = -1;
  while (index + 1 < lyricsLines.length && lyricsLines[index + 1].time <= elapsed) index += 1;
  if (index === activeLine) return;
  activeLine = index;
  lyricsLines.forEach((line, i) => {
    line.el.classList.toggle('past', i < index);
    line.el.classList.toggle('active', i === index);
  });
  // Follow along, unless the listener has just scrolled the lyrics themselves
  if (index >= 0 && !els.lyricsPanel.hidden && Date.now() > userScrolledUntil) {
    scrollToLine(lyricsLines[index].el);
  }
}

for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
  els.lyrics.addEventListener(type, () => { userScrolledUntil = Date.now() + 6000; }, { passive: true });
}

// ---- Tabs ----

function selectTab(name) {
  const lyrics = name === 'lyrics';
  els.tabLyrics.setAttribute('aria-selected', String(lyrics));
  els.tabRecent.setAttribute('aria-selected', String(!lyrics));
  els.tabLyrics.tabIndex = lyrics ? 0 : -1;
  els.tabRecent.tabIndex = lyrics ? -1 : 0;
  els.lyricsPanel.hidden = !lyrics;
  els.recentPanel.hidden = lyrics;
  try { localStorage.setItem('taco-tab', name); } catch { /* storage unavailable */ }
  if (lyrics && activeLine >= 0) scrollToLine(lyricsLines[activeLine].el);
}

els.tabLyrics.addEventListener('click', () => selectTab('lyrics'));
els.tabRecent.addEventListener('click', () => selectTab('recent'));
for (const tab of [els.tabLyrics, els.tabRecent]) {
  tab.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const next = tab === els.tabLyrics ? els.tabRecent : els.tabLyrics;
    selectTab(next === els.tabLyrics ? 'lyrics' : 'recent');
    next.focus();
  });
}
try {
  if (localStorage.getItem('taco-tab') === 'recent') selectTab('recent');
} catch { /* storage unavailable */ }

async function loadFeed() {
  try {
    const res = await fetch(`${FEED_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    feed = await res.json();
  } catch {
    if (!feed) els.live.textContent = 'Offline';
  }
  render();
}

function poll() {
  clearTimeout(pollTimer);
  loadFeed().finally(() => {
    pollTimer = setTimeout(poll, POLL_MS);
  });
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) poll();
});
setInterval(render, 1000);
setInterval(syncLyrics, 250);
poll();

// ---- Install as an app ----

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  els.install.hidden = false;
});
els.install.addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  try { await installPrompt.userChoice; } catch { /* dismissed */ }
  installPrompt = null;
  els.install.hidden = true;
});
window.addEventListener('appinstalled', () => {
  els.install.hidden = true;
});

const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (isIOS && !standalone) els.iosHint.hidden = false;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app still works without it */ });
  });
}
