'use strict';

const STREAM_URL = 'https://icecast.tacogroup.uk/stream';
// The same broadcast at half the size (64 kbps), for the data saver
const STREAM_URL_LOW = 'https://icecast.tacogroup.uk/stream-low';
const FEED_URL = 'https://icecast.tacogroup.uk/nowplaying/nowplaying.json';
// Lyrics, with word-by-word (karaoke) timings for many songs
const SYNCLRC_API = 'https://api.synclrc.dev';
// Lyric timings only fit a recording of the same length (in seconds) as the one playing
const SYNC_TOLERANCE = 3;
// When to ask again if SyncLRC was still fetching a song's word timings
const KARAOKE_RETRY_MS = 15000;
const LIBRARY_URL = 'https://icecast.tacogroup.uk/nowplaying/library.json';
const REQUEST_API = 'https://icecast.tacogroup.uk/requests';
// Live timing from the server: the playing song's elapsed and remaining with the server's clock
// every second, and song changes the moment they happen. The app keeps in time with it continuously.
const LIVE_URL = `${REQUEST_API}/live`;
const LIKE_API = `${REQUEST_API}/like`;
const CHARTS_URL = `${REQUEST_API}/charts`;
// How often to check the feed: without live updates often enough that a skipped song shows up
// within a couple of seconds; with them, just for the listener count and recently played
const POLL_MS = 2000;
const LIVE_POLL_MS = 10000;
// Listeners hear the stream a little behind the feed, so titles, progress and lyrics are held
// back to match. While playing, the app works out the delay from the stream itself; this is the
// guess used when it isn't playing (typical when playing: about 1.2 s).
const DEFAULT_LISTEN_DELAY = 1.2;
// Icecast sends this much audio from just before "now" when a player connects (16 KB: 1 s at
// 128 kbps, twice that on the data saver stream)
const BURST_SECONDS = 1;
// Audio reaches listeners about this long after the AutoDJ starts it (measured: 0.1 to 0.25 s)
const STREAM_LATENCY = 0.15;
// How long connecting to the stream takes before audio arrives, until the feed has been timed
const CONNECT_SECONDS = 0.4;
const FALLBACK_COVER = 'icons/icon-maskable-512.png'; // the logo, edge to edge, when a song has no cover

const $ = (id) => document.getElementById(id);
const els = {
  app: document.querySelector('.app'),
  play: $('play'),
  coverA: $('cover-a'),
  coverB: $('cover-b'),
  ambientA: $('ambient-a'),
  ambientB: $('ambient-b'),
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
  tabRequest: $('tab-request'),
  tabRecent: $('tab-recent'),
  requestPanel: $('request-panel'),
  requestedChip: $('requested-chip'),
  queue: $('queue'),
  queueEmpty: $('queue-empty'),
  songSearch: $('song-search'),
  songs: $('songs'),
  songsEmpty: $('songs-empty'),
  requestStatus: $('request-status'),
  notice: $('notice'),
  volume: $('volume'),
  volumeRow: $('volume-row'),
  install: $('install'),
  iosHint: $('ios-hint'),
  lyricsStage: $('lyrics-stage'),
  credit: $('lyrics-credit'),
  lyricsStatusText: $('lyrics-status-text'),
  lyricsExpand: $('lyrics-expand'),
  nowLine: $('now-line'),
  nowLineText: $('now-line-text'),
  lyricsView: $('lyrics-view'),
  lvHead: $('lv-head'),
  lvBody: $('lv-body'),
  lvClose: $('lv-close'),
  lvArt: $('lv-art'),
  lvThumb: $('lv-thumb'),
  lvTitle: $('lv-title'),
  lvArtist: $('lv-artist'),
  lvProgress: $('lv-progress'),
  lvFill: $('lv-fill'),
  lvElapsed: $('lv-elapsed'),
  lvRemaining: $('lv-remaining'),
  lvPlay: $('lv-play'),
  like: $('like'),
  likeCount: $('like-count'),
  share: $('share'),
  sleepBtn: $('sleep-btn'),
  sleepLabel: $('sleep-label'),
  sleepMenu: $('sleep-menu'),
  moreBtn: $('more-btn'),
  moreMenu: $('more-menu'),
  saverChip: $('saver-chip'),
  djChip: $('dj-chip'),
  visualiser: $('visualiser'),
  toasts: $('toasts'),
  tabTop: $('tab-top'),
  topPanel: $('top-panel'),
  charts: $('charts'),
  chartsEmpty: $('charts-empty'),
  notifyOffer: $('notify-offer'),
  adminOpen: $('admin-open'),
  adminView: $('admin-view'),
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
let listenDelay = DEFAULT_LISTEN_DELAY;
let clockOffset = 0;
const clockSamples = [];
const roundTrips = []; // how long recent feed requests took, a guide to how long connecting takes
const liveSamples = [];
let liveAt = 0; // when the last live update arrived (ms)
let liveKey = null;
let wasLive = false;
let liveRetryMs = 5000;
const liveConnected = () => Date.now() - liveAt < 3500;

// Server time: this device's clock, corrected using the feed's server_time
const now = () => Date.now() / 1000 + clockOffset;

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

// Where the browser allows it, the app downloads the stream itself and hands it to the player
// (Media Source Extensions). Playback then starts as soon as the first second arrives, rather than
// after the several seconds Chrome otherwise collects first, and the app knows exactly which moment
// of the broadcast is playing. iPhones and iPads keep the plain player, which carries on playing
// in the background.
let useMediaSource = !isIOS && typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg');
let connection = null; // timing for the current connection, used to work out the listening delay
const clock = () => performance.now() / 1000; // steady seconds, unaffected by clock changes

// Data saver: the half-size stream, always or (automatically) on mobile data
let saverSetting = 'auto';
let lowUnavailable = false; // the server doesn't have the data saver stream
try {
  const saved = localStorage.getItem('taco-saver');
  if (['auto', 'on', 'off'].includes(saved)) saverSetting = saved;
} catch { /* storage unavailable */ }

function onMobileData() {
  const c = navigator.connection;
  return !!c && (c.saveData || c.type === 'cellular' || ['slow-2g', '2g', '3g'].includes(c.effectiveType));
}

const useLowStream = () => !lowUnavailable && (saverSetting === 'on' || (saverSetting === 'auto' && onMobileData()));
const burstSeconds = () => (connection && connection.low ? BURST_SECONDS * 2 : BURST_SECONDS);

function setState(state) {
  for (const button of [els.play, els.lvPlay]) {
    button.dataset.state = state;
    button.setAttribute('aria-label', state === 'idle' ? 'Play' : 'Pause');
  }
  els.app.dataset.playing = String(state === 'playing');
  if (hasMediaSession) navigator.mediaSession.playbackState = state === 'idle' ? 'paused' : 'playing';
}

function closeConnection() {
  if (connection && connection.abort) connection.abort.abort();
  connection = null;
}

// Feed the stream to the player in pieces as it downloads, noting when each piece arrived
async function pumpStream(source, conn) {
  let buffer;
  try {
    buffer = source.addSourceBuffer('audio/mpeg');
  } catch (err) {
    useMediaSource = false; // this browser can't do it after all
    throw err;
  }
  try { buffer.mode = 'sequence'; } catch { /* the browser already chose it */ }
  const pending = [];
  let appendedAt = 0;
  const appendNext = () => {
    if (buffer.updating || source.readyState !== 'open') return;
    const { buffered } = buffer;
    // Let go of audio that has played, keeping the last half minute
    if (buffered.length && audio.currentTime - buffered.start(0) > 60) {
      buffer.remove(buffered.start(0), audio.currentTime - 30);
      return;
    }
    if (!pending.length) return;
    const size = pending.reduce((n, piece) => n + piece.length, 0);
    const data = new Uint8Array(size);
    let at = 0;
    for (const piece of pending) {
      data.set(piece, at);
      at += piece.length;
    }
    pending.length = 0;
    appendedAt = conn.lastArrival;
    buffer.appendBuffer(data);
  };
  buffer.addEventListener('updateend', () => {
    const { buffered } = buffer;
    if (buffered.length && appendedAt) {
      conn.gotAudio = true;
      // Audio arrives as it's broadcast, so arrival time minus position in the stream gives the
      // moment the stream started. Pieces held up on the way only make it later, so keep the earliest.
      conn.origin = Math.min(conn.origin, appendedAt - buffered.end(buffered.length - 1));
      appendedAt = 0;
    }
    appendNext();
  });
  const res = await fetch(`${conn.low ? STREAM_URL_LOW : STREAM_URL}?t=${Date.now()}`, { signal: conn.abort.signal, cache: 'no-store' });
  if (res.status === 404 && conn.low) lowUnavailable = true; // the normal stream from now on
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error('The stream ended');
    conn.lastArrival = clock();
    pending.push(value);
    appendNext();
  }
}

function connectMediaSource() {
  const source = new MediaSource();
  const conn = { abort: new AbortController(), origin: Infinity, lastArrival: 0, played: false, mediaSource: true, low: useLowStream() };
  connection = conn;
  audio.src = URL.createObjectURL(source);
  source.addEventListener('sourceopen', () => {
    URL.revokeObjectURL(audio.src);
    pumpStream(source, conn).catch(() => {
      if (connection === conn) reconnect();
    });
  }, { once: true });
}

function play() {
  wantPlaying = true;
  clearTimeout(retryTimer);
  els.notice.textContent = '';
  setState('loading');
  closeConnection();
  // A fresh connection every time, so playback always starts at the live point
  if (useMediaSource) {
    connectMediaSource();
    startAudioGraph();
  } else {
    const low = useLowStream();
    connection = { requestedAt: clock(), played: false, low };
    audio.src = `${low ? STREAM_URL_LOW : STREAM_URL}?t=${Date.now()}`;
  }
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
  cancelSleep();
  closeConnection();
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  els.notice.textContent = '';
  setState('idle');
}

// How far behind the broadcast this listener is hearing, in seconds
function measureListenDelay() {
  if (!wantPlaying || !connection) {
    listenDelay = DEFAULT_LISTEN_DELAY;
    return;
  }
  let behind = null;
  if (connection.mediaSource && Number.isFinite(connection.origin)) {
    // Exact: the stream position playing now, against when that part of the stream arrived
    behind = clock() - (connection.origin + audio.currentTime) + STREAM_LATENCY;
  } else if (connection.playingAt) {
    // Plain player: the delay when playback began, plus any time spent waiting for data since
    behind = connection.startDelay
      + (clock() - connection.playingAt) - (audio.currentTime - connection.playingPosition);
  }
  if (behind !== null && behind >= 0 && behind < 300) listenDelay = behind;
}

function reconnect() {
  if (!wantPlaying) return;
  // If audio arrived but the browser couldn't play it this way, use the plain player from now on
  // (a connection that simply dropped is no reason to)
  if (connection && connection.mediaSource && connection.gotAudio && !connection.played && audio.error) useMediaSource = false;
  // The plain player couldn't find the data saver stream: use the normal one
  if (connection && !connection.mediaSource && connection.low && !connection.played && audio.error
    && audio.error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) lowUnavailable = true;
  closeConnection();
  setState('loading');
  els.notice.textContent = 'Connection lost. Reconnecting…';
  clearTimeout(retryTimer);
  retryTimer = setTimeout(play, 3000);
}

els.play.addEventListener('click', () => (wantPlaying ? stop() : play()));
audio.addEventListener('playing', () => {
  els.notice.textContent = '';
  setState('playing');
  startAudioGraph();
  startVisualiser();
  if (connection && !connection.played) {
    connection.played = true;
    if (!connection.mediaSource) {
      // The plain player collects audio before it starts, and everything collected puts the
      // listener further behind. Time it: from asking for the stream (less connecting) to playing,
      // plus the audio Icecast sends from before the moment of connecting.
      connection.playingAt = clock();
      connection.playingPosition = audio.currentTime;
      connection.startDelay = Math.max(0, connection.playingAt - connection.requestedAt - connectSeconds())
        + burstSeconds() + STREAM_LATENCY;
    }
  }
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
const showVolume = () => els.volume.style.setProperty('--vol', `${els.volume.value * 100}%`);
showVolume();
els.volume.addEventListener('input', () => {
  showVolume();
  if (!sleepFade) audio.volume = parseFloat(els.volume.value);
  try { localStorage.setItem('taco-volume', els.volume.value); } catch { /* storage unavailable */ }
});

// ---- Visualiser ----

// Where the app downloads the stream itself (not on iPhones and iPads), the music can also go
// through Web Audio, which measures it for the bars on the cover. That's set up on the first press
// of play, as browsers only allow it then.
let audioGraph = null;
let vizFrame = 0;
let vizHeights = [];
let vizColour = '';
let vizColourAt = 0;
const VIZ_BARS = 28;

function startAudioGraph() {
  if (!audioGraph && useMediaSource && !reduceMotion && typeof AudioContext !== 'undefined') {
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.75;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      audioGraph = { ctx, source, analyser, data: new Uint8Array(analyser.frequencyBinCount) };
    } catch {
      return;
    }
  }
  // The music only plays while Web Audio is running
  if (audioGraph && audioGraph.ctx.state !== 'running') audioGraph.ctx.resume().catch(() => {});
}

function drawVisualiser() {
  vizFrame = 0;
  const on = !!audioGraph && wantPlaying && els.app.dataset.playing === 'true' && !document.hidden
    && !lyricsViewOpen && els.adminView.hidden;
  els.app.dataset.viz = on ? 'on' : 'off';
  if (!on) return;
  const canvas = els.visualiser;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (!w || !h) return;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  if (Date.now() - vizColourAt > 1000) {
    vizColour = getComputedStyle(els.app).getPropertyValue('--accent').trim() || '#FF8A3D';
    vizColourAt = Date.now();
  }
  const { analyser, data } = audioGraph;
  analyser.getByteFrequencyData(data);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  // A soft shade so the bars stand out on any cover
  const shade = ctx.createLinearGradient(0, 0, 0, h);
  shade.addColorStop(0, 'rgba(0, 0, 0, 0)');
  shade.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, w, h);
  // Bars spaced like hearing: more of them for the low and middle notes
  const usable = data.length * 0.62;
  const gap = w * 0.012;
  const barW = (w - gap * (VIZ_BARS + 1)) / VIZ_BARS;
  ctx.fillStyle = vizColour;
  for (let i = 0; i < VIZ_BARS; i += 1) {
    const from = Math.floor(usable ** (i / VIZ_BARS));
    const to = Math.max(from + 1, Math.floor(usable ** ((i + 1) / VIZ_BARS)));
    let sum = 0;
    for (let b = from; b < to; b += 1) sum += data[b];
    const level = sum / (to - from) / 255;
    const target = level ** 1.6;
    // Rise quickly, fall gently
    const prev = vizHeights[i] || 0;
    const height = target > prev ? target : prev - Math.min(prev - target, 0.035);
    vizHeights[i] = height;
    const barH = height * h * 0.92;
    if (barH < 2) continue; // nothing drawn while it's quiet
    const x = gap + i * (barW + gap);
    ctx.globalAlpha = 0.55 + height * 0.45;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, h - barH, barW, barH, [barW / 2, barW / 2, 0, 0]);
    else ctx.rect(x, h - barH, barW, barH);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  vizFrame = requestAnimationFrame(drawVisualiser);
}

function startVisualiser() {
  if (!vizFrame && audioGraph) vizFrame = requestAnimationFrame(drawVisualiser);
}

// ---- Sleep timer ----

let sleepAt = 0;
let sleepFade = null;

function cancelSleep() {
  sleepAt = 0;
  if (sleepFade) {
    clearInterval(sleepFade);
    sleepFade = null;
    audio.volume = parseFloat(els.volume.value);
  }
  renderSleep();
}

function setSleep(minutes) {
  cancelSleep();
  if (minutes > 0) {
    sleepAt = Date.now() + minutes * 60000;
    if (!wantPlaying) play();
  }
  renderSleep();
}

function renderSleep() {
  const left = formatTime(Math.max(0, sleepAt - Date.now()) / 1000);
  els.sleepBtn.classList.toggle('on', sleepAt > 0);
  setText(els.sleepLabel, sleepAt ? left : '');
  const label = sleepAt ? `Sleep timer: stops in ${left}` : 'Sleep timer';
  if (els.sleepBtn.getAttribute('aria-label') !== label) {
    els.sleepBtn.setAttribute('aria-label', label);
    els.sleepBtn.title = label;
  }
  for (const item of els.sleepMenu.querySelectorAll('button')) {
    item.setAttribute('aria-checked', String(item.dataset.minutes === '0' ? !sleepAt : false));
  }
}

// Time's up: fade out over 8 seconds, then stop
function checkSleep() {
  if (!sleepAt) return;
  renderSleep();
  if (Date.now() < sleepAt || sleepFade) return;
  if (!wantPlaying) return cancelSleep();
  const start = audio.volume;
  const began = Date.now();
  sleepFade = setInterval(() => {
    const t = (Date.now() - began) / 8000;
    if (t >= 1) {
      stop(); // also puts the volume back
      toast('Sleep timer: playback stopped. Good night.');
      return;
    }
    audio.volume = start * (1 - t);
  }, 100);
}

// ---- Data saver ----

function renderSaver() {
  els.saverChip.hidden = !useLowStream();
  for (const item of els.moreMenu.querySelectorAll('[data-saver]')) {
    item.setAttribute('aria-checked', String(item.dataset.saver === saverSetting));
  }
}

// Switch streams straight away if the choice (or the connection) changes what's needed, or
// reconnect now if a reconnection was waiting anyway
function saverChanged() {
  renderSaver();
  if (wantPlaying && (!connection || !!connection.low !== useLowStream())) play();
}

function setSaver(value) {
  saverSetting = value;
  try { localStorage.setItem('taco-saver', value); } catch { /* storage unavailable */ }
  saverChanged();
}

if (navigator.connection && navigator.connection.addEventListener) {
  navigator.connection.addEventListener('change', saverChanged);
}

// ---- Menus (sleep timer, and "more": data saver, installing, station admin) ----

const menus = [
  { button: els.sleepBtn, menu: els.sleepMenu, pick: (item) => setSleep(Number(item.dataset.minutes)) },
  { button: els.moreBtn, menu: els.moreMenu, pick: (item) => { if (item.dataset.saver) setSaver(item.dataset.saver); } },
];

function closeMenus(except) {
  for (const m of menus) {
    if (m === except || m.menu.hidden) continue;
    m.menu.hidden = true;
    m.button.setAttribute('aria-expanded', 'false');
  }
}

for (const m of menus) {
  m.button.addEventListener('click', (event) => {
    event.stopPropagation();
    closeMenus(m);
    const open = m.menu.hidden;
    m.menu.hidden = !open;
    m.button.setAttribute('aria-expanded', String(open));
    if (open) (m.menu.querySelector('[aria-checked="true"]') || m.menu.querySelector('button:not([hidden])')).focus();
  });
  m.menu.addEventListener('click', (event) => {
    const item = event.target.closest('button');
    if (!item) return;
    event.stopPropagation();
    m.pick(item);
    closeMenus();
    m.button.focus();
  });
  m.menu.addEventListener('keydown', (event) => {
    const items = [...m.menu.querySelectorAll('button:not([hidden])')];
    const i = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      items[(i + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    } else if (event.key === 'Escape') {
      closeMenus();
      m.button.focus();
    }
  });
}
document.addEventListener('click', () => closeMenus());

// ---- Pop-up messages ----

function toast(text, { sub = '', img = '', ms = 4500 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  if (img) {
    const pic = document.createElement('img');
    pic.alt = '';
    pic.src = img;
    pic.onerror = () => pic.remove();
    el.append(pic);
  }
  const p = document.createElement('p');
  p.textContent = text;
  if (sub) {
    const small = document.createElement('small');
    small.textContent = sub;
    p.append(small);
  }
  el.append(p);
  els.toasts.append(el);
  while (els.toasts.children.length > 3) els.toasts.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

// ---- Now playing ----

function currentTrack() {
  const np = feed && feed.now_playing;
  const history = (feed && feed.history) || [];
  if (!np) return { track: null, history };
  if (np.started_at && now() < np.started_at + listenDelay && history[0]) {
    // Listeners are still hearing the previous song
    const previous = shownTrack && shownTrack.text === history[0].text
      ? shownTrack
      : { ...history[0], started_at: null, duration: null };
    return { track: previous, history: history.slice(1) };
  }
  return { track: np, history };
}

// ---- Cover art and colours ----

// Taco Music's own colours (aqua and iris), when there's no cover to take them from
const BRAND_THEME = { tint1: 'hsl(232 45% 10%)', tint2: 'hsl(250 70% 32%)', accent: 'hsl(170 80% 62%)', ink: '#04140F' };
let coverRequest = '';
let frontCover = els.coverA;
let frontAmbient = els.ambientA;

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
      // The same cover, blurred, behind everything (not the station logo)
      const ambient = frontAmbient === els.ambientA ? els.ambientB : els.ambientA;
      if (src !== FALLBACK_COVER) ambient.src = src;
      ambient.classList.toggle('is-front', src !== FALLBACK_COVER);
      frontAmbient.classList.remove('is-front');
      frontAmbient = ambient;
      applyTheme(themeFrom(cors && src !== FALLBACK_COVER ? coverColors(img) : null));
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
  els.artist.textContent = track ? (track.artist || (track.jingle ? 'Station ident' : '')) : 'Live radio, 24/7';
  els.album.textContent = (track && track.album) || '';
  els.requestedChip.hidden = !(track && track.requested);
  els.djChip.hidden = !(track && track.live_dj);
  setCover(track && track.cover);
  // The full-screen lyrics header and backdrop
  els.lvTitle.textContent = els.title.textContent;
  els.lvArtist.textContent = track ? (track.artist || '') : 'Live radio, 24/7';
  for (const img of [els.lvThumb, els.lvArt]) {
    img.onerror = () => { img.onerror = null; img.src = FALLBACK_COVER; };
    img.src = (track && track.cover) || FALLBACK_COVER;
  }
  document.title = track
    ? `${track.title}${track.artist ? ` – ${track.artist}` : ''} · Taco Music`
    : 'Taco Music';
  updateMediaSession(track);
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function renderProgress(track) {
  if (!track || !track.started_at || !track.duration) {
    els.progress.hidden = true;
    els.lvProgress.hidden = true;
    return;
  }
  const elapsed = Math.min(Math.max(songPosition(track), 0), track.duration);
  els.progress.hidden = false;
  els.fill.style.transform = `scaleX(${elapsed / track.duration})`;
  setText(els.elapsed, formatTime(elapsed));
  setText(els.duration, formatTime(track.duration));
  // Full-screen lyrics show the time left instead
  els.lvProgress.hidden = false;
  els.lvFill.style.transform = els.fill.style.transform;
  setText(els.lvElapsed, els.elapsed.textContent);
  setText(els.lvRemaining, `-${formatTime(Math.ceil(track.duration - elapsed))}`);
}

function makeThumb(src) {
  const img = document.createElement('img');
  img.className = 'thumb';
  img.alt = '';
  img.loading = 'lazy';
  img.src = src || FALLBACK_COVER;
  img.onerror = () => {
    img.onerror = null;
    img.src = FALLBACK_COVER;
  };
  return img;
}

function makeText(item) {
  const text = document.createElement('div');
  text.className = 'h-text';
  const title = document.createElement('span');
  title.className = 'h-title';
  title.textContent = item.title || item.text || 'Unknown';
  const artist = document.createElement('span');
  artist.className = 'h-artist';
  artist.textContent = item.artist || '';
  text.append(title, artist);
  return text;
}

function historyItem(item) {
  const li = document.createElement('li');
  const time = document.createElement('time');
  time.textContent = timeAgo(item.played_at);
  if (item.played_at) time.dateTime = new Date(item.played_at * 1000).toISOString();
  li.append(makeThumb(item.cover), makeText(item), time);
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
  measureListenDelay();
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
    if (!sameSong) announceMyRequest(track);
  }
  renderLike(track);
  renderProgress(track);
  renderHistory(history);
  renderQueue();
  updateRequestButtons();
  syncLyrics();
}

// ---- Likes ----

function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// An anonymous id, so the server counts each listener's like once
let clientId;
try {
  clientId = localStorage.getItem('taco-client');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientId || '')) {
    clientId = randomId();
    localStorage.setItem('taco-client', clientId);
  }
} catch {
  clientId = randomId();
}

let likedSongs = new Set();
try {
  likedSongs = new Set(JSON.parse(localStorage.getItem('taco-liked') || '[]'));
} catch { /* storage unavailable */ }
let likeBusy = false;

function saveLiked() {
  try { localStorage.setItem('taco-liked', JSON.stringify([...likedSongs].slice(-500))); } catch { /* storage unavailable */ }
}

// The newest count: the feed (and live updates) carry it for the song playing now
function likesFor(track) {
  const np = feed && feed.now_playing;
  if (np && track && np.id === track.id && typeof np.likes === 'number') return np.likes;
  return track && typeof track.likes === 'number' ? track.likes : 0;
}

function renderLike(track) {
  const id = track && !track.jingle ? track.id : null;
  const liked = !!id && likedSongs.has(id);
  els.like.disabled = !id || likeBusy;
  els.like.setAttribute('aria-pressed', String(liked));
  const label = liked ? 'Unlike this song' : 'Like this song';
  if (els.like.getAttribute('aria-label') !== label) {
    els.like.setAttribute('aria-label', label);
    els.like.title = label;
  }
  const count = id ? likesFor(track) : 0;
  setText(els.likeCount, count > 0 ? (count > 999 ? `${Math.floor(count / 1000)}k` : String(count)) : '');
}

async function toggleLike() {
  const track = shownTrack;
  if (!track || !track.id || track.jingle || likeBusy) return;
  const liked = !likedSongs.has(track.id);
  likeBusy = true;
  // Show it straight away; the server's count follows
  if (liked) likedSongs.add(track.id);
  else likedSongs.delete(track.id);
  const np = feed && feed.now_playing;
  if (np && np.id === track.id) np.likes = Math.max(0, likesFor(track) + (liked ? 1 : -1));
  renderLike(track);
  try {
    const res = await fetch(LIKE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ song_id: track.id, client: clientId, liked }),
    });
    const reply = await res.json().catch(() => ({}));
    if (!res.ok || !reply.ok) throw new Error(reply.error || `HTTP ${res.status}`);
    const latest = feed && feed.now_playing;
    if (latest && latest.id === track.id) latest.likes = reply.likes;
    saveLiked();
  } catch {
    if (liked) likedSongs.delete(track.id);
    else likedSongs.add(track.id);
    toast('Couldn’t save that like. Try again in a moment.');
  } finally {
    likeBusy = false;
    renderLike(shownTrack);
  }
}

els.like.addEventListener('click', toggleLike);

// ---- Sharing ----

async function share() {
  const track = shownTrack && !shownTrack.jingle ? shownTrack : null;
  const url = new URL('./', location.href).href;
  const text = track && track.title
    ? `Listening to “${track.title}”${track.artist ? ` by ${track.artist}` : ''} on Taco Music`
    : 'Listen to Taco Music, live radio 24/7';
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Taco Music', text, url });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // closed the share sheet
    }
  }
  try {
    await navigator.clipboard.writeText(`${text} ${url}`);
    toast('Link copied', { sub: 'Paste it anywhere to share' });
  } catch {
    toast('Share this link', { sub: url, ms: 8000 });
  }
}

els.share.addEventListener('click', share);

// ---- Your request is playing ----

let myRequests = [];
try {
  myRequests = JSON.parse(localStorage.getItem('taco-my-requests') || '[]').filter((r) => r && r.id);
} catch { /* storage unavailable */ }

function saveMyRequests() {
  myRequests = myRequests.filter((r) => Date.now() - r.at < 3 * 3600 * 1000).slice(-10);
  try { localStorage.setItem('taco-my-requests', JSON.stringify(myRequests)); } catch { /* storage unavailable */ }
}

function announceMyRequest(track) {
  if (!track || !track.requested || !track.id || !myRequests.some((r) => r.id === track.id)) return;
  myRequests = myRequests.filter((r) => r.id !== track.id);
  saveMyRequests();
  const about = `${track.title}${track.artist ? ` – ${track.artist}` : ''}`;
  toast('Your request is playing now', { sub: about, img: track.cover || FALLBACK_COVER, ms: 7000 });
  // And on the lock screen, if the app's in the background and the listener said yes to that
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    const options = { body: about, icon: track.cover || 'icons/icon-192.png', tag: 'taco-request' };
    navigator.serviceWorker && navigator.serviceWorker.ready
      ? navigator.serviceWorker.ready.then((reg) => reg.showNotification('Your request is playing now', options)).catch(() => {})
      : new Notification('Your request is playing now', options);
  }
}

els.notifyOffer.addEventListener('click', async () => {
  els.notifyOffer.hidden = true;
  try {
    if (await Notification.requestPermission() === 'granted') toast('We’ll let you know when it plays.');
  } catch { /* not supported */ }
});

// ---- Song requests ----

let library = null;
let libraryLoading = null;
let requestBusy = false;
let requestUntil = 0; // when this listener may request again (ms)
let statusHoldUntil = 0; // keep a success/error message up until then (ms)
let queueSig = '';
let buttonsSig = '';
const songRows = new Map(); // song id -> { song, li, button, search }

try {
  requestUntil = Number(localStorage.getItem('taco-request-until')) || 0;
} catch { /* storage unavailable */ }

const songText = (song) => (song.artist ? `${song.artist} - ${song.title}` : song.title);
const normalize = (text) => (text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function setRequestStatus(text, tone = '') {
  els.requestStatus.textContent = text;
  els.requestStatus.dataset.tone = tone;
}

function setRequestUntil(ms) {
  requestUntil = ms;
  try { localStorage.setItem('taco-request-until', String(ms)); } catch { /* storage unavailable */ }
}

function renderQueue() {
  const items = (feed && feed.requests) || [];
  const sig = items.map((r) => r.id).join('|');
  if (sig === queueSig) return;
  queueSig = sig;
  els.queue.replaceChildren(...items.map((item, i) => {
    const li = document.createElement('li');
    const tag = document.createElement('span');
    tag.className = 'queue-tag';
    tag.textContent = i === 0 ? 'Next' : `#${i + 1}`;
    li.append(makeThumb(item.cover), makeText(item), tag);
    return li;
  }));
  els.queueEmpty.hidden = items.length > 0;
}

function updateRequestButtons() {
  const waitMs = requestUntil - Date.now();
  if (Date.now() > statusHoldUntil) {
    setRequestStatus(waitMs > 0 ? `You can request another song in ${formatTime(waitMs / 1000)}.` : '');
  }
  if (!songRows.size) return;
  const queued = new Set(((feed && feed.requests) || []).map((r) => r.id));
  const playing = shownTrack && shownTrack.text;
  const sig = `${[...queued].join(',')}|${playing}|${waitMs > 0}|${requestBusy}`;
  if (sig === buttonsSig) return;
  buttonsSig = sig;
  for (const [id, row] of songRows) {
    let label = 'Request';
    if (queued.has(id)) label = 'Queued';
    else if (songText(row.song) === playing) label = 'Playing';
    row.button.textContent = label;
    row.button.disabled = label !== 'Request' || waitMs > 0 || requestBusy;
  }
}

function filterSongs() {
  const words = normalize(els.songSearch.value).split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const row of songRows.values()) {
    const match = words.every((word) => row.search.includes(word));
    row.li.hidden = !match;
    if (match) shown += 1;
  }
  els.songsEmpty.hidden = shown > 0 || !library;
}

function buildSongList() {
  songRows.clear();
  buttonsSig = '';
  els.songs.replaceChildren(...library.map((song) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'request-btn';
    button.textContent = 'Request';
    button.setAttribute('aria-label', `Request ${song.title}${song.artist ? ` by ${song.artist}` : ''}`);
    button.addEventListener('click', () => requestSong(song));
    li.append(makeThumb(song.cover), makeText(song), button);
    songRows.set(song.id, { song, li, button, search: normalize(`${song.title} ${song.artist} ${song.album}`) });
    return li;
  }));
  filterSongs();
  updateRequestButtons();
}

function loadLibrary() {
  if (!libraryLoading) {
    libraryLoading = (async () => {
      try {
        // The list only changes when songs are added, so refetch at most every 10 minutes
        const res = await fetch(`${LIBRARY_URL}?v=${Math.floor(Date.now() / 600000)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        library = (await res.json()).songs || [];
        buildSongList();
      } catch {
        libraryLoading = null; // try again next time the tab opens
        statusHoldUntil = Date.now() + 8000;
        setRequestStatus('Couldn’t load the song list. Try again in a moment.', 'error');
      }
    })();
  }
  return libraryLoading;
}

async function requestSong(song) {
  if (requestBusy) return;
  requestBusy = true;
  statusHoldUntil = Infinity;
  setRequestStatus(`Requesting “${song.title}”…`);
  updateRequestButtons();
  try {
    const res = await fetch(REQUEST_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ song_id: song.id }),
    });
    const reply = await res.json().catch(() => ({}));
    if (res.ok && reply.ok) {
      setRequestStatus(reply.message || 'Requested!', 'success');
      setRequestUntil(Date.now() + (reply.cooldown_seconds || 180) * 1000);
      if (feed && reply.requests) feed.requests = reply.requests;
      myRequests.push({ id: song.id, at: Date.now() });
      saveMyRequests();
      // Offer a notification for when it plays, if the app might be in the background by then
      els.notifyOffer.hidden = !('Notification' in window) || Notification.permission !== 'default';
    } else {
      if (reply.retry_after) setRequestUntil(Date.now() + reply.retry_after * 1000);
      setRequestStatus(reply.error || 'That didn’t work. Try again in a moment.', 'error');
    }
  } catch {
    setRequestStatus('Couldn’t reach the request service. Try again in a moment.', 'error');
  } finally {
    requestBusy = false;
    statusHoldUntil = Date.now() + 6000;
    render();
  }
}

els.songSearch.addEventListener('input', filterSongs);

// ---- Lyrics ----

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let lyricsLines = [];
let activeLine = -1;
let lyricsHasWords = false;
let lyricsToken = 0;
let userScrolledUntil = 0;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Drop "(Remastered)", "(feat. …)", "(From …)" and similar so the lookup can match
function cleanTitle(title) {
  return title
    .replace(/\s*[([][^)\]]*(remaster|remix|live|version|edit|mono|stereo|from |feat\.?|ft\.|with )[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+.*(remaster|version|edit|live).*$/i, '')
    .trim();
}

// Line-timed lyrics: [00:12.30]Hello world. {bg} marks a background vocals line, {agent:...} who sings.
function parseLrc(lrc) {
  const lines = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const background = raw.includes('{bg}');
    const text = raw.replace(/\[[^\]]*\]/g, '').replace(/\{[^}]*\}/g, '').trim();
    for (const m of stamps) {
      lines.push({ text, start: parseInt(m[1], 10) * 60 + parseFloat(m[2]), end: null, words: [], background });
    }
  }
  return lines.sort((a, b) => a.start - b.start);
}

// Word-by-word lyrics as SyncLRC writes them: [00:12.30]<00:12.30>Hello <00:12.80>world<00:13.40>
// Each word starts at the time before it; a time with no word after it ends the word before.
// {bg} marks background vocals, which have their own line; {agent:...} marks who sings, unused here.
const karaokeTime = (minutes, seconds) => parseInt(minutes, 10) * 60 + parseFloat(seconds.replace(':', '.'));

function parseKaraoke(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const head = raw.match(/^\[(\d+):(\d+(?:[.:]\d+)?)\](.*)$/);
    if (!head) continue;
    let rest = head[3].replace(/\{agent:[^}]*\}/g, '');
    const background = rest.includes('{bg}');
    rest = rest.replace(/\{bg\}/g, '');
    const parts = rest.split(/<(\d+):(\d+(?:[.:]\d+)?)>/);
    const words = [];
    for (let i = 1; i < parts.length; i += 3) {
      const time = karaokeTime(parts[i], parts[i + 1]);
      const word = parts[i + 2] || '';
      if (word) words.push({ text: word, start: time, end: null });
      else if (words.length) words[words.length - 1].end = time;
    }
    if (words.length && parts[0].trim()) words[0].text = parts[0] + words[0].text;
    const start = karaokeTime(head[1], head[2]);
    if (!words.length) {
      if (!rest.trim()) lines.push({ text: '', start, end: null, words: [] }); // a break
      continue;
    }
    lines.push({ text: words.map((w) => w.text).join('').trim(), start, end: words[words.length - 1].end, words, background });
  }
  return lines.sort((a, b) => a.start - b.start);
}

// ---- Lyrics from SyncLRC ----
// SyncLRC has word-by-word (karaoke) timings for many songs, and line timings or just the words for
// others. It keeps one version of each song's lyrics, timed for whichever recording it met first,
// so the app also asks for every version it knows (with each one's length) and fits the lyrics to
// the station's own file, as the lyrics did when they came from LRCLIB directly: line timings from
// the version made for a recording this long, and word timings moved to match it if they're out.
// SyncLRC allows each listener 30 requests a minute, so the app keeps under SYNCLRC_LIMIT,
// remembers what it found on this device, and makes at most four requests a song: the song and
// its versions, the title without "(Remastered)" and the like if the song found nothing, and once
// more a little later if the word timings weren't ready yet (asking can set SyncLRC fetching them).

const SYNCLRC_LIMIT = 25; // requests a minute
const SYNCLRC_PAUSE_MS = 60000; // after "too many requests"
const LYRICS_STORE = 'taco-lyrics-v3'; // v2 held lyrics not yet fitted to the station's files
const LYRICS_KEEP_MS = 7 * 86400000; // lyrics found
const MISS_KEEP_MS = 6 * 3600000; // songs SyncLRC had nothing for
const LYRICS_STORE_SIZE = 80; // songs remembered
let synclrcPausedUntil = 0;
const synclrcSent = []; // when recent requests went out (ms)
const lyricsMemory = new Map(); // in case this device can't store anything
try { localStorage.removeItem('taco-lyrics-v2'); } catch { /* storage unavailable */ }

// Wait for room under the limit. Returns false if the song changed meanwhile.
async function synclrcTurn(wanted) {
  for (;;) {
    if (!wanted()) return false;
    const t = Date.now();
    while (synclrcSent.length && t - synclrcSent[0] >= 60000) synclrcSent.shift();
    const full = synclrcSent.length >= SYNCLRC_LIMIT ? synclrcSent[0] + 60000 - t : 0;
    const wait = Math.max(synclrcPausedUntil - t, full);
    if (wait <= 0) {
      synclrcSent.push(t);
      return true;
    }
    await sleep(Math.min(wait, 2000));
  }
}

// One request: SyncLRC's answer, null if it has nothing for the song, or undefined if it couldn't
// be asked (offline, busy, the song changed, or SyncLRC's host turned the request away)
async function synclrc(params, wanted, fresh, path = 'lyrics') {
  if (!await synclrcTurn(wanted)) return undefined;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10000);
  try {
    const res = await fetch(`${SYNCLRC_API}/${path}?${params}`, { signal: abort.signal, cache: fresh ? 'no-store' : 'default' });
    if (res.status === 404) return null;
    if (res.status === 429) synclrcPausedUntil = Date.now() + SYNCLRC_PAUSE_MS;
    if (res.status === 503 || res.status === 504) synclrcPausedUntil = Date.now() + 15000;
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

const lyricsKey = (track) => `${track.artist}|${track.title}|${Math.round(track.duration || 0)}`.toLowerCase();
const slim = (data) => data && { type: data.type, lyrics: data.lyrics, duration: data.duration, instrumental: !!data.instrumental, shift: data.shift || 0 };

function lyricsStore() {
  try {
    return JSON.parse(localStorage.getItem(LYRICS_STORE) || '{}') || {};
  } catch {
    return {};
  }
}

// What's remembered for a song: its lyrics, null for "SyncLRC had nothing", or undefined
function recallLyrics(key) {
  const entry = lyricsStore()[key] || lyricsMemory.get(key);
  if (!entry) return undefined;
  const age = Date.now() - entry.at;
  return age < (entry.data ? LYRICS_KEEP_MS : MISS_KEEP_MS) ? entry.data : undefined;
}

function rememberLyrics(key, data) {
  const entry = { at: Date.now(), data: slim(data) };
  lyricsMemory.set(key, entry);
  try {
    const store = lyricsStore();
    store[key] = entry;
    // Keep the most recent songs, within the device's storage
    const keys = Object.keys(store).sort((a, b) => store[b].at - store[a].at);
    for (const old of keys.slice(LYRICS_STORE_SIZE)) delete store[old];
    localStorage.setItem(LYRICS_STORE, JSON.stringify(store));
  } catch {
    try { localStorage.removeItem(LYRICS_STORE); } catch { /* storage unavailable */ }
  }
}

function lyricsParams(track, title) {
  const params = new URLSearchParams({ track: title, include: 'bg' });
  if (track.artist) params.set('artist', track.artist);
  if (track.duration) params.set('duration', String(Math.round(track.duration)));
  return params;
}

// ---- Fitting the lyrics to the station's recording ----

// Word timings this far out (seconds) from the version made for a recording this long are moved
// to match it; closer than that, they're left as they are (line timings are a little rougher)
const SHIFT_MIN = 0.3;
// Further out than this, the two are probably for different songs: leave the timings alone
const SHIFT_MAX = 8;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// A line's words, for matching the same line across versions: no case, punctuation or backing vocals
const lineKey = (text) => text.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// How many seconds later the same lines start in reference than in lines: matched in order, it
// has to be the same for most lines (null if there aren't enough matches, or they don't agree)
function lineOffset(lines, reference) {
  const diffs = [];
  let j = 0;
  for (const line of lines) {
    const key = lineKey(line.text);
    if (!key || line.background) continue;
    for (let k = j; k < Math.min(reference.length, j + 8); k += 1) {
      if (lineKey(reference[k].text) === key) {
        diffs.push(reference[k].start - line.start);
        j = k + 1;
        break;
      }
    }
  }
  if (diffs.length < 5) return null;
  const mid = median(diffs);
  return median(diffs.map((d) => Math.abs(d - mid))) <= 0.3 ? mid : null;
}

// The version made for a recording this long: the closest in length and, where several copies are
// about that long, the timing most of them agree on, so one badly timed copy can't win
function pickVersion(versions, duration) {
  if (!duration || !versions) return null;
  const near = versions
    .filter((v) => Math.abs(v.duration - duration) <= SYNC_TOLERANCE)
    .map((v) => ({ ...v, gap: Math.abs(v.duration - duration), lines: parseLrc(v.lyrics).filter((l) => l.text) }))
    .filter((v) => v.lines.length >= 5)
    .sort((a, b) => a.gap - b.gap);
  if (!near.length) return null;
  const group = near.filter((v) => v.gap <= near[0].gap + 1);
  if (group.length < 3) return near[0];
  const disagreement = (v) => median(group.filter((o) => o !== v).map((o) => {
    const d = lineOffset(o.lines, v.lines);
    return d === null ? SHIFT_MAX : Math.abs(d);
  }));
  return group.map((v) => ({ v, score: disagreement(v) })).sort((a, b) => a.score - b.score || a.v.gap - b.v.gap)[0].v;
}

// SyncLRC's answer, fitted to the station's recording: line timings from the version made for a
// recording this long, and word timings moved to match that version if they're out
function fitLyrics(data, versions, duration) {
  if (!data || data.instrumental || typeof data.lyrics !== 'string') return data;
  const reference = pickVersion(versions, duration);
  if (!reference) return data;
  if (data.type === 'karaoke') {
    const shift = lineOffset(parseKaraoke(data.lyrics), reference.lines);
    if (shift === null || Math.abs(shift) > SHIFT_MAX) return data;
    return { ...data, duration: reference.duration, shift: Math.abs(shift) >= SHIFT_MIN ? Math.round(shift * 100) / 100 : 0 };
  }
  // The same words as SyncLRC's own (mostly), so it's this song and not another one this long
  const ours = new Set((data.type === 'synced' ? parseLrc(data.lyrics).map((l) => l.text) : data.lyrics.split('\n')).map(lineKey).filter(Boolean));
  const theirs = new Set(reference.lines.map((l) => lineKey(l.text)));
  if (!ours.size || [...ours].filter((key) => theirs.has(key)).length < ours.size * 0.6) return data;
  return { type: 'synced', lyrics: reference.lyrics, duration: reference.duration, instrumental: false };
}

const simpleText = (text) => (text || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// A title without any notes in brackets ("(Original 7" Mix)"), for finding and matching versions
const baseTitle = (title) => cleanTitle(title).replace(/\s*[([][^)\]]*[)\]]/g, '').trim() || cleanTitle(title);

// A search result for the same song (not another song by the artist, or a cover)
function sameSong(result, track) {
  const want = simpleText(baseTitle(track.title));
  if (!want || simpleText(baseTitle(result.track || '')) !== want) return false;
  const artist = simpleText((track.artist || '').split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bwith\b|\bx\b)\s*/i)[0]);
  return !artist || simpleText(result.artist).includes(artist);
}

// Every version of the song SyncLRC knows that has line timings, with each one's length;
// undefined if it couldn't be asked
async function lyricsVersions(track, wanted) {
  const q = `${track.artist || ''} ${baseTitle(track.title)}`.trim();
  const found = await synclrc(new URLSearchParams({ q, limit: '20' }), wanted, false, 'search');
  if (found === undefined) return undefined;
  return ((found && found.results) || [])
    .filter((r) => r && r.lyrics && typeof r.lyrics.synced === 'string' && Number(r.duration) > 0 && sameSong(r, track))
    .map((r) => ({ lyrics: r.lyrics.synced, duration: Number(r.duration) }));
}

// SyncLRC's answer for a song, by its title or else the title without notes like "(Remastered)":
// the lyrics, null for none, or undefined if it couldn't be asked
async function askSynclrc(track, wanted) {
  const data = await synclrc(lyricsParams(track, track.title), wanted);
  const cleaned = cleanTitle(track.title);
  if (data === null && cleaned && cleaned !== track.title) return synclrc(lyricsParams(track, cleaned), wanted);
  return data;
}

// The lyrics for a song, fitted to the station's recording: { data } (null when there are none),
// or { failed } if SyncLRC couldn't be asked. Remembered on this device once they're fitted.
async function findLyrics(track, wanted) {
  const key = lyricsKey(track);
  const known = recallLyrics(key);
  if (known !== undefined) return { data: known, key };
  const data = await askSynclrc(track, wanted);
  if (data === undefined) return { failed: true };
  const timed = data && !data.instrumental && track.duration && !track.live_dj;
  const versions = timed ? await lyricsVersions(track, wanted) : [];
  const fitted = fitLyrics(data, versions, track.duration);
  // Without the versions, these can't be fitted: show them, but ask again next time
  if (versions !== undefined) rememberLyrics(key, fitted);
  return { data: fitted, key, fresh: true, versions };
}

// What to show from the lyrics. Timings only fit a recording of about the same length as the one
// playing (within SYNC_TOLERANCE seconds); for another version, just the words.
function readLyrics(data, songDuration) {
  if (!data) return null;
  const text = typeof data.lyrics === 'string' ? data.lyrics : '';
  if (!text.trim()) return data.instrumental ? { instrumental: true, lines: [], plain: null, source: 'synclrc' } : null;
  const timed = data.type === 'karaoke' ? parseKaraoke(text) : data.type === 'synced' ? parseLrc(text) : [];
  const shift = data.shift || 0;
  if (shift) {
    const move = (item) => {
      item.start += shift;
      if (item.end !== null) item.end += shift;
    };
    for (const line of timed) {
      move(line);
      line.words.forEach(move);
    }
  }
  const fits = !songDuration || !data.duration || Math.abs(data.duration - songDuration) <= SYNC_TOLERANCE;
  if (timed.some((line) => line.text) && fits) return { lines: timed, plain: null, source: 'synclrc', words: data.type === 'karaoke' };
  const plain = timed.length ? timed.map((line) => line.text).join('\n') : text;
  if (!plain.trim()) return null;
  return { lines: [], plain, source: 'synclrc', otherVersion: timed.length > 0 && !fits };
}

// For the admin page: what SyncLRC has for an uploaded song (asked within the same limit as the
// lyrics on screen): 'words', 'synced', 'other' (timed, for another length of recording), 'plain',
// 'instrumental', 'none', or 'unknown' if it couldn't be asked. One request a song, so a big batch
// goes quickly; the lyrics are fitted to the file when the song first plays.
async function lyricsCheck(song, wanted) {
  const known = recallLyrics(lyricsKey(song));
  const data = known !== undefined ? known : await askSynclrc(song, wanted);
  if (data === undefined) return 'unknown';
  const shown = readLyrics(data, song.duration);
  if (!shown) return 'none';
  if (shown.instrumental) return 'instrumental';
  if (shown.words) return 'words';
  if (shown.lines.length) return 'synced';
  return shown.otherVersion ? 'other' : 'plain';
}

// kind: 'idle', 'loading', 'none', 'instrumental' or 'error' when there's nothing else to show,
// 'note' for a remark above words-only lyrics
function setLyricsStatus(text, kind = 'note') {
  els.lyricsStatusText.textContent = text;
  els.lyricsStatus.dataset.kind = text ? kind : '';
  els.lyricsStage.dataset.state = text && kind === 'loading' ? 'loading' : '';
}

// Where in the song listeners are, in seconds, going by the feed's start time and length
function songPosition(track) {
  return now() - track.started_at - listenDelay;
}

// Backing vocals, written in brackets, are shown smaller and lighter
function addText(el, text) {
  for (const part of text.split(/(\([^)]*\))/)) {
    if (!part) continue;
    if (part.startsWith('(') && part.endsWith(')')) {
      const span = document.createElement('span');
      span.className = 'bv';
      span.textContent = part;
      el.append(span);
    } else {
      el.append(part);
    }
  }
}

// Breaks with no singing at least this long (seconds) show the waiting dots
const GAP_SECONDS = 5;
// A word held at least this long (seconds) glows as it's sung, its letters lifting one by one
const LONG_WORD = 1;
// How long a held word's glow lingers after it (seconds)
const GLOW_FADE = 0.8;
// A line still showing this long after it started is over: the rest is an instrumental part
const LONGEST_LINE = 12;

function gapLine(start, end) {
  const el = document.createElement('p');
  el.className = 'line gap';
  el.setAttribute('aria-hidden', 'true');
  const dots = [0, 1, 2].map(() => {
    const dot = document.createElement('span');
    dot.className = 'gap-dot';
    return dot;
  });
  el.append(...dots);
  return { start, end, words: [], dots, lit: -1, gap: true, el, state: '', distance: -1 };
}

function sungLine(line, end) {
  const el = document.createElement('p');
  el.className = line.background ? 'line bg-line' : 'line';
  let inBrackets = !!line.background; // a background-vocals line is set smaller throughout
  const words = line.words.map((word, j) => {
    const span = document.createElement('span');
    span.className = 'word';
    // Words in brackets are backing vocals
    if (word.text.includes('(')) inBrackets = true;
    if (inBrackets) span.classList.add('bv');
    if (word.text.includes(')') && !line.background) inBrackets = false;
    const after = line.words[j + 1];
    const wordEnd = word.end ?? (after ? after.start : end);
    // A held word gets its letters one by one, so they can light up and lift in turn. The spaces
    // around it stay outside, where the line can wrap.
    const [, lead, core, trail] = word.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const long = !reduceMotion && wordEnd - word.start >= LONG_WORD && [...core].length > 1;
    let letters = null;
    if (long) {
      span.classList.add('long');
      letters = [...core].map((ch) => {
        if (/\s/.test(ch)) return { space: document.createTextNode(ch) };
        const letter = document.createElement('span');
        letter.className = 'ch';
        letter.textContent = ch;
        return { el: letter, f: -1 };
      });
      span.append(...letters.map((x) => x.el || x.space));
      letters = letters.filter((x) => x.el);
    } else {
      span.textContent = core;
    }
    const nodes = [lead && document.createTextNode(lead), span, trail && document.createTextNode(trail)].filter(Boolean);
    return { start: word.start, end: wordEnd, el: span, nodes, fill: -1, letters, glow: -1 };
  });
  if (words.length) {
    el.classList.add('has-words');
    el.append(...words.flatMap((word) => word.nodes));
  } else {
    addText(el, line.text);
  }
  return { start: line.start, end, words, el, state: '', distance: -1, text: line.text };
}

// Lines without an end time last until the next line starts (an empty line marks a break), or
// until the song ends. Long breaks between lines, and long intros, get the waiting dots.
function buildLines(lines, songDuration) {
  const timed = lines.map((line, i) => {
    const next = lines.slice(i + 1).find((l) => l.start > line.start);
    let end = line.end ?? (next ? next.start : songDuration || Infinity);
    if (end - line.start > LONGEST_LINE && !line.words.length) end = line.start + LONGEST_LINE;
    return { line, end };
  }).filter(({ line }) => line.text.trim() || line.words.length);
  const out = [];
  let freeFrom = 0; // when the last sung line ended
  for (const { line, end } of timed) {
    if (line.start - freeFrom >= GAP_SECONDS) out.push(gapLine(freeFrom, line.start));
    out.push(sungLine(line, end));
    freeFrom = Math.max(freeFrom, end);
  }
  return out;
}

// Words-only lyrics, laid out in verses, with [Section] labels picked out
function plainLyrics(text) {
  const box = document.createElement('div');
  box.className = 'plain';
  let stanza = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      stanza = null;
      continue;
    }
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      const label = document.createElement('p');
      label.className = 'section';
      label.textContent = section[1];
      box.append(label);
      stanza = null;
      continue;
    }
    if (!stanza) {
      stanza = document.createElement('div');
      stanza.className = 'stanza';
      box.append(stanza);
    }
    const p = document.createElement('p');
    addText(p, line);
    stanza.append(p);
  }
  return box;
}

// The strip under the song title: the line being sung, or a way into words-only lyrics
function setNowLine(text) {
  els.nowLine.hidden = !text;
  if (!text || els.nowLineText.textContent === text) return;
  els.nowLineText.textContent = text;
  els.nowLineText.classList.remove('swap');
  void els.nowLineText.offsetWidth; // restart the animation
  els.nowLineText.classList.add('swap');
}

function setCredit(words) {
  const synclrc = '<a href="https://synclrc.dev" target="_blank" rel="noopener">SyncLRC</a>';
  els.credit.innerHTML = words ? `Word-by-word lyrics from ${synclrc}` : `Lyrics from ${synclrc}`;
}

function renderLyrics(result, track) {
  // A live DJ's song can start anywhere, so its lyrics can't follow along: words only
  if (result && track.live_dj && result.lines.length) {
    result = { ...result, lines: [], plain: result.plain || result.lines.map((line) => line.text).join('\n') };
  }
  lyricsLines = [];
  lyricsHasWords = false;
  activeLine = -1;
  els.lyrics.replaceChildren();
  els.lyrics.dataset.synced = 'false';
  setNowLine('');
  setCredit(result && result.words);
  if (!result) return setLyricsStatus('No lyrics found for this song.', 'none');
  if (result.instrumental && !result.lines.length && !result.plain) {
    return setLyricsStatus('Instrumental. Enjoy the music.', 'instrumental');
  }
  setLyricsStatus(result.otherVersion
    ? 'Timed lyrics are only available for a different version of this song, so these won’t follow along.'
    : '');

  if (result.lines.length) {
    lyricsLines = buildLines(result.lines, track.duration);
    lyricsHasWords = lyricsLines.some((line) => line.words.length);
    els.lyrics.dataset.synced = 'true';
    els.lyrics.append(...lyricsLines.map((line) => line.el));
    syncLyrics();
  } else {
    els.lyrics.append(plainLyrics(result.plain));
    setNowLine('Lyrics');
  }
}

async function showLyrics(track) {
  const token = ++lyricsToken;
  lyricsLines = [];
  lyricsHasWords = false;
  activeLine = -1;
  els.lyrics.replaceChildren();
  els.lyrics.dataset.synced = 'false';
  els.lyrics.scrollTop = 0;
  setNowLine('');
  setCredit();
  if (!track || !track.title) {
    setLyricsStatus('Lyrics will show up here when a song is playing.', 'idle');
    return;
  }
  if (track.jingle) {
    setLyricsStatus('A word from the station. The music’s back in a moment.', 'idle');
    return;
  }
  if (track.live_dj && (track.text || '').startsWith('Live: ')) {
    setLyricsStatus('A live DJ is on air. Lyrics show up when they play a song.', 'idle');
    return;
  }
  setLyricsStatus('Finding lyrics…', 'loading');
  const wanted = () => token === lyricsToken; // until the song changes
  const found = await findLyrics(track, wanted);
  if (!wanted()) return;
  if (found.failed) return setLyricsStatus('Couldn’t load lyrics right now.', 'error');
  renderLyrics(readLyrics(found.data, track.duration), track);

  // Asking can set SyncLRC fetching a song's word timings: ask once more a little later
  const data = found.data;
  if (!found.fresh || !data || data.type === 'karaoke' || data.instrumental || track.live_dj) return;
  await sleep(KARAOKE_RETRY_MS);
  const again = await synclrc(lyricsParams(track, track.title), wanted, true);
  if (!wanted() || !again || again.type !== 'karaoke') return;
  const fitted = fitLyrics(again, found.versions, track.duration);
  if (found.versions !== undefined) rememberLyrics(found.key, fitted);
  renderLyrics(readLyrics(fitted, track.duration), track);
}

// Lyrics are on screen: the tab is open, or the full-screen view
const lyricsVisible = () => lyricsViewOpen || !els.lyricsPanel.hidden;

// Bring a line to a third of the way down, leaving room to read ahead
function scrollToLine(el, instant) {
  const box = els.lyrics;
  box.scrollTo({
    top: el.offsetTop + el.offsetHeight / 2 - box.clientHeight * 0.36,
    behavior: instant || reduceMotion ? 'auto' : 'smooth',
  });
}

// A held word: its glow builds while it's sung and lingers a moment after; each letter lights up
// and lifts in its turn, settling as the glow fades
function syncLongWord(word, t) {
  const p = Math.min(Math.max((t - word.start) / (word.end - word.start), 0), 1);
  let glow = 0;
  if (t >= word.end) glow = Math.max(0, 1 - (t - word.end) / GLOW_FADE);
  else if (t > word.start) glow = Math.min(1, p * 1.4);
  glow = Math.round(glow * 40) / 40;
  if (glow !== word.glow) {
    word.glow = glow;
    word.el.style.setProperty('--g', glow);
  }
  const n = word.letters.length;
  word.letters.forEach((letter, i) => {
    const f = Math.round(Math.min(Math.max(p * n - i, 0), 1) * 20) / 20;
    if (f === letter.f) return;
    letter.f = f;
    letter.el.style.setProperty('--f', f);
  });
  word.el.classList.toggle('sung', t >= word.end);
  word.el.classList.toggle('singing', t > word.start && t < word.end);
}

// Light up each word as it's sung: sung words are solid, the current one fills from the left
function syncWords(line, t) {
  for (const word of line.words) {
    if (word.letters) {
      syncLongWord(word, t);
      continue;
    }
    let fill = t >= word.end ? 1 : t <= word.start ? 0 : (t - word.start) / (word.end - word.start);
    if (reduceMotion) fill = t >= word.start ? 1 : 0;
    fill = Math.round(fill * 100) / 100;
    if (fill === word.fill) continue;
    word.fill = fill;
    word.el.classList.toggle('sung', fill === 1);
    word.el.classList.toggle('singing', fill > 0 && fill < 1);
    if (fill > 0 && fill < 1) word.el.style.setProperty('--fill', `${fill * 100}%`);
  }
}

// The waiting dots fill in one by one as the break goes on
function syncGap(line, t) {
  const progress = Math.min(Math.max((t - line.start) / (line.end - line.start), 0), 1);
  const lit = Math.round(progress * 30);
  if (lit === line.lit) return;
  line.lit = lit;
  line.dots.forEach((dot, i) => {
    dot.style.opacity = String(0.3 + 0.7 * Math.min(Math.max(progress * 3 - i, 0), 1));
  });
}

function syncLyrics() {
  const track = shownTrack;
  const timed = lyricsLines.length > 0 && track && track.started_at;
  els.lyrics.classList.toggle('syncing', !!timed);
  if (!timed) return;
  const t = songPosition(track);
  let focus = -1;
  let reached = -1;
  // Several lines can be active at once when vocals overlap
  lyricsLines.forEach((line, i) => {
    const state = t >= line.end ? 'past' : t >= line.start ? 'active' : '';
    if (state !== line.state) {
      line.state = state;
      line.el.classList.toggle('past', state === 'past');
      line.el.classList.toggle('active', state === 'active');
    }
    if (line.words.length) syncWords(line, t);
    if (line.gap && state === 'active') syncGap(line, t);
    if (state === 'active' && focus < 0) focus = i;
    if (t >= line.start) reached = i;
  });
  // Between lines, stay on the last line that was sung
  if (focus < 0) focus = reached;
  if (focus === activeLine) return;
  activeLine = focus;
  // Lines further from the one being sung fade more
  lyricsLines.forEach((line, i) => {
    const distance = focus < 0 ? Math.min(i + 1, 6) : Math.min(Math.abs(i - focus), 6);
    if (distance !== line.distance) {
      line.distance = distance;
      line.el.style.setProperty('--d', distance);
    }
  });
  const current = lyricsLines[focus];
  setNowLine(current && !current.gap && current.state === 'active' ? current.text : '♪');
  // Follow along, unless the listener has just scrolled the lyrics themselves
  if (focus >= 0 && lyricsVisible() && Date.now() > userScrolledUntil) scrollToLine(current.el);
}

// The progress bar and lyrics move together, from the same clock: every frame while word-by-word
// lyrics are on screen, otherwise 4 times a second
function tick() {
  try {
    measureListenDelay();
    // Switch to the next song the moment listeners hear it, not at the next once-a-second redraw
    const { track } = currentTrack();
    if ((track ? `${track.text}|${track.started_at}` : null) !== shownKey) render();
    renderProgress(shownTrack);
    syncLyrics();
  } finally {
    if (lyricsHasWords && lyricsVisible() && !reduceMotion) requestAnimationFrame(tick);
    else setTimeout(tick, 250);
  }
}

for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
  els.lyrics.addEventListener(type, () => { userScrolledUntil = Date.now() + 6000; }, { passive: true });
}

// ---- Full-screen lyrics ----

let lyricsViewOpen = false;
let lyricsCloseTimer = null;
let focusBeforeLyrics = null;

function jumpToCurrentLine() {
  requestAnimationFrame(() => {
    if (activeLine >= 0 && lyricsLines[activeLine]) scrollToLine(lyricsLines[activeLine].el, true);
  });
}

function openLyricsView() {
  if (lyricsViewOpen) return;
  lyricsViewOpen = true;
  clearTimeout(lyricsCloseTimer);
  focusBeforeLyrics = document.activeElement;
  els.lvBody.append(els.lyricsStage); // the same lyrics, moved into the full-screen view
  els.lyricsView.hidden = false;
  document.body.classList.add('lyrics-open');
  requestAnimationFrame(() => els.lyricsView.classList.add('open'));
  // The back button (or gesture) closes it
  try { history.pushState({ lyrics: true }, ''); } catch { /* not allowed */ }
  els.lvClose.focus({ preventScroll: true });
  userScrolledUntil = 0;
  jumpToCurrentLine();
}

function closeLyricsView(fromHistory) {
  if (!lyricsViewOpen) return;
  lyricsViewOpen = false;
  els.lyricsView.classList.remove('open');
  document.body.classList.remove('lyrics-open');
  if (!fromHistory && history.state && history.state.lyrics) history.back();
  // Move the lyrics back once the view has faded out
  lyricsCloseTimer = setTimeout(() => {
    els.lyricsView.hidden = true;
    els.lyricsPanel.prepend(els.lyricsStage);
    jumpToCurrentLine();
    startVisualiser();
  }, 300);
  if (focusBeforeLyrics && document.contains(focusBeforeLyrics)) focusBeforeLyrics.focus({ preventScroll: true });
}

els.nowLine.addEventListener('click', openLyricsView);
els.lyricsExpand.addEventListener('click', openLyricsView);
els.lvClose.addEventListener('click', () => closeLyricsView(false));
els.lvPlay.addEventListener('click', () => (wantPlaying ? stop() : play()));
window.addEventListener('popstate', () => {
  closeLyricsView(true);
  if (window.TacoAdmin && window.TacoAdmin.isOpen()) window.TacoAdmin.close(true);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && lyricsViewOpen) closeLyricsView(false);
});

// Swipe down on the header to close
let swipeFrom = null;
els.lvHead.addEventListener('pointerdown', (event) => {
  if (event.target.closest('button')) return; // leave the close button's click alone
  swipeFrom = event.clientY;
  els.lvHead.setPointerCapture(event.pointerId); // keep following the drag outside the header
});
els.lvHead.addEventListener('pointerup', (event) => {
  if (swipeFrom !== null && event.clientY - swipeFrom > 60) closeLyricsView(false);
  swipeFrom = null;
});
els.lvHead.addEventListener('pointercancel', () => { swipeFrom = null; });

// ---- Top songs ----

let charts = null;
let chartsAt = 0;
let chartKind = 'most_liked';
const CHART_WORDS = {
  most_liked: { one: 'like', many: 'likes', empty: 'No likes yet. Tap the heart on a song you love.' },
  most_played: { one: 'play', many: 'plays', empty: 'Songs will show up here as they play.' },
  most_requested: { one: 'request', many: 'requests', empty: 'No requests yet. Ask for a song in Request.' },
};

function renderCharts() {
  for (const b of els.topPanel.querySelectorAll('[data-chart]')) b.setAttribute('aria-pressed', String(b.dataset.chart === chartKind));
  const items = (charts && charts[chartKind]) || [];
  const words = CHART_WORDS[chartKind];
  els.charts.replaceChildren(...items.slice(0, 20).map((item, i) => {
    const li = document.createElement('li');
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = String(i + 1);
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `${item.count} ${item.count === 1 ? words.one : words.many}`;
    li.append(rank, makeThumb(item.cover), makeText(item), count);
    return li;
  }));
  els.chartsEmpty.hidden = items.length > 0;
  if (charts) els.chartsEmpty.textContent = words.empty;
}

async function loadCharts() {
  renderCharts();
  if (Date.now() - chartsAt < 60000) return; // at most once a minute
  chartsAt = Date.now();
  try {
    const res = await fetch(CHARTS_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    charts = await res.json();
  } catch {
    chartsAt = 0;
    if (!charts) els.chartsEmpty.textContent = 'Couldn’t load the charts. Try again in a moment.';
  }
  renderCharts();
}

els.topPanel.querySelector('.segmented').addEventListener('click', (event) => {
  const b = event.target.closest('[data-chart]');
  if (!b) return;
  chartKind = b.dataset.chart;
  renderCharts();
});

// ---- Station admin (loaded only when opened) ----

let adminLoading = null;

function openAdmin() {
  if (!adminLoading) {
    adminLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'admin.js';
      script.onload = resolve;
      script.onerror = () => {
        adminLoading = null;
        reject(new Error('admin.js'));
      };
      document.head.append(script);
    });
  }
  adminLoading.then(() => window.TacoAdmin.open({
    api: REQUEST_API, libraryUrl: LIBRARY_URL, formatTime, makeThumb, makeText, toast, lyricsCheck,
    library: () => loadLibrary().then(() => library || []),
    nowPlaying: () => feed && feed.now_playing,
  })).catch(() => toast('Couldn’t open the admin page. Check your connection.'));
}

els.adminOpen.addEventListener('click', openAdmin);
if (location.hash === '#admin') openAdmin();

// ---- Tabs ----

const tabs = [
  { name: 'lyrics', tab: els.tabLyrics, panel: els.lyricsPanel },
  { name: 'request', tab: els.tabRequest, panel: els.requestPanel },
  { name: 'top', tab: els.tabTop, panel: els.topPanel },
  { name: 'recent', tab: els.tabRecent, panel: els.recentPanel },
];

function selectTab(name) {
  for (const t of tabs) {
    const selected = t.name === name;
    t.tab.setAttribute('aria-selected', String(selected));
    t.tab.tabIndex = selected ? 0 : -1;
    t.panel.hidden = !selected;
  }
  try { localStorage.setItem('taco-tab', name); } catch { /* storage unavailable */ }
  if (name === 'lyrics') jumpToCurrentLine();
  if (name === 'request') loadLibrary();
  if (name === 'top') loadCharts();
}

tabs.forEach((t, i) => {
  t.tab.addEventListener('click', () => selectTab(t.name));
  t.tab.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const next = tabs[(i + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    selectTab(next.name);
    next.tab.focus();
  });
});
try {
  const saved = localStorage.getItem('taco-tab');
  if (tabs.some((t) => t.name === saved)) selectTab(saved);
} catch { /* storage unavailable */ }

// Line this device's clock up with the server's, using the freshest of recent readings
function syncClock(data, sent, received) {
  if (typeof data.server_time !== 'number') return;
  roundTrips.push(received - sent);
  if (roundTrips.length > 9) roundTrips.shift();
  // The feed is rewritten every poll_seconds, so each copy is up to that old when it arrives. The
  // freshest of several readings is the best guide, plus the typical age of the freshest of that many.
  const sample = data.server_time - (sent + received) / 2;
  if (clockSamples.length && Math.abs(sample - clockOffset) > 5) clockSamples.length = 0; // a clock changed
  clockSamples.push(sample);
  if (clockSamples.length > 20) clockSamples.shift();
  if (liveConnected()) return; // live updates give a sharper reading
  clockOffset = Math.max(...clockSamples) + (data.poll_seconds || 0) / (clockSamples.length + 1);
}

// Live updates are sent the moment they're made, so only the trip here makes them old. The quickest
// of the last 30 is the best guide, and half the quickest feed round trip allows for the trip.
function syncClockLive(serverTime, received) {
  const oneWay = roundTrips.length ? Math.min(...roundTrips) / 2 : 0.05;
  const sample = serverTime - received + oneWay;
  if (liveSamples.length && Math.abs(sample - clockOffset) > 5) liveSamples.length = 0; // a clock changed
  liveSamples.push(sample);
  if (liveSamples.length > 30) liveSamples.shift();
  clockOffset = Math.max(...liveSamples);
}

function onLive(update, received) {
  liveAt = Date.now();
  wasLive = true;
  liveRetryMs = 5000;
  if (typeof update.server_time === 'number') syncClockLive(update.server_time, received);
  // Likes and the listener count, as they change
  const playing = feed && feed.now_playing;
  if (playing && update.id && playing.id === update.id && typeof update.likes === 'number' && !likeBusy) playing.likes = update.likes;
  if (feed && typeof update.listeners === 'number') feed.listeners = update.listeners;
  // The song or the request queue changed: get the full feed now, not at the next check
  const key = `${update.text}|${update.started_at}|${update.requests}`;
  const np = feed && feed.now_playing;
  const behind = !np || np.text !== update.text || np.started_at !== update.started_at
    || (feed.requests || []).length !== update.requests;
  if (key !== liveKey && behind) poll();
  liveKey = key;
}

function connectLive() {
  if (typeof EventSource === 'undefined') return;
  const source = new EventSource(LIVE_URL);
  source.onmessage = (event) => {
    let update;
    try { update = JSON.parse(event.data); } catch { return; }
    onLive(update, Date.now() / 1000);
  };
  source.onerror = () => {
    // A dropped connection reconnects by itself. If the server turned it away (restarting, or one
    // without live updates), try again later, waiting longer each time up to a minute. The feed
    // checks carry on meanwhile.
    if (source.readyState !== EventSource.CLOSED) return;
    setTimeout(connectLive, liveRetryMs);
    liveRetryMs = Math.min(liveRetryMs * 2, 60000);
  };
}

// If live updates stop, go back to checking the feed often straight away
function checkLive() {
  if (wasLive && !liveConnected()) {
    wasLive = false;
    poll();
  }
}

function connectSeconds() {
  if (!roundTrips.length) return CONNECT_SECONDS;
  return [...roundTrips].sort((a, b) => a - b)[Math.floor(roundTrips.length / 2)];
}

async function loadFeed() {
  try {
    const sent = Date.now() / 1000;
    const res = await fetch(`${FEED_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    syncClock(data, sent, Date.now() / 1000);
    feed = data;
  } catch {
    if (!feed) els.live.textContent = 'Offline';
  }
  render();
}

// Check again just after the current song should end, so the next one shows up promptly
function nextPollMs() {
  // Live updates announce song changes themselves
  if (liveConnected()) return LIVE_POLL_MS;
  // A little randomness, so the readings land at different points in the feed's regular rewrite
  // and the clock sync gets a fresh one soon
  const regular = POLL_MS + Math.random() * 500;
  const np = feed && feed.now_playing;
  if (np && np.started_at && np.duration) {
    const endsIn = np.started_at + np.duration - now();
    // Listeners hear the next song about a second after the feed shows it, so check twice a second
    // around the end. Start a little early: a song's listed length can be a second or two out.
    if (endsIn < -8) return 2000; // well overdue: keep checking until the feed moves on
    if (endsIn < 3) return 500;
    if (endsIn < 3 + regular / 1000) return Math.max(500, (endsIn - 3) * 1000);
  }
  return regular;
}

function poll() {
  clearTimeout(pollTimer);
  loadFeed().finally(() => {
    pollTimer = setTimeout(poll, nextPollMs());
  });
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    poll();
    startVisualiser();
  }
});
setInterval(render, 1000);
setInterval(checkLive, 1000);
setInterval(checkSleep, 1000);
renderSleep();
renderSaver();
tick();
poll();
connectLive();

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
