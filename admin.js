'use strict';

// Station admin: skip songs, reorder or remove requests, see who's listening, upload music and
// see the stats. Loaded by app.js only when someone opens it, and only works with the admin password.
(() => {
  const TOKEN_KEY = 'taco-admin-token';
  // Uploads go in pieces of 4 MB, or under 1 MB if the proxy turns big ones away, three files at a time
  const BIG_CHUNK = 4 * 1024 * 1024;
  const SMALL_CHUNK = 900 * 1024;
  const PARALLEL = 3;
  const AUDIO_FILE = /\.(mp3|m4a|aac|flac|ogg|opus|wav)$/i;
  const view = document.getElementById('admin-view');
  let app = null; // helpers from app.js
  let isOpen = false;
  let token = '';
  let status = null;
  let stats = null;
  let statusTimer = null;
  let statsTimer = null;
  let focusBefore = null;
  let busy = false;
  let uploadKind = 'song';
  let topKind = 'most_played';
  const uploads = []; // { file, kind, state, received, message, tone, result, el }
  let chunkSize = BIG_CHUNK;

  try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch { /* storage unavailable */ }

  // ---- Small helpers ----

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
    return el;
  }

  const ICONS = {
    close: 'M5.3 5.3a1 1 0 0 1 1.4 0L12 10.6l5.3-5.3a1 1 0 1 1 1.4 1.4L13.4 12l5.3 5.3a1 1 0 0 1-1.4 1.4L12 13.4l-5.3 5.3a1 1 0 0 1-1.4-1.4l5.3-5.3-5.3-5.3a1 1 0 0 1 0-1.4z',
    up: 'M12 5.6a1 1 0 0 1 .7.3l6 6a1 1 0 0 1-1.4 1.4L12 8 6.7 13.3a1 1 0 0 1-1.4-1.4l6-6a1 1 0 0 1 .7-.3z',
    down: 'M5.3 10.7a1 1 0 0 1 1.4 0L12 16l5.3-5.3a1 1 0 1 1 1.4 1.4l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.4z',
    skip: 'M5 6.2v11.6a1 1 0 0 0 1.55.83L15 13v4.8a1 1 0 1 0 2 0V6.2a1 1 0 1 0-2 0V11L6.55 5.37A1 1 0 0 0 5 6.2z',
    upload: 'M12 3a1 1 0 0 1 .7.3l4 4a1 1 0 0 1-1.4 1.4L13 6.4V15a1 1 0 1 1-2 0V6.4L8.7 8.7a1 1 0 0 1-1.4-1.4l4-4A1 1 0 0 1 12 3zM5 14a1 1 0 0 1 1 1v3h12v-3a1 1 0 1 1 2 0v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a1 1 0 0 1 1-1z',
  };

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }

  const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

  function duration(seconds) {
    if (seconds < 60) return 'under a minute';
    if (seconds < 3600) return plural(Math.floor(seconds / 60), 'minute', 'minutes');
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours} h ${minutes} min`;
  }

  // "iPhone · Safari" from a user agent
  function device(agent) {
    const a = agent || '';
    const os = /iPhone/.test(a) ? 'iPhone' : /iPad/.test(a) ? 'iPad' : /Android/.test(a) ? 'Android'
      : /CrOS/.test(a) ? 'Chromebook' : /Windows/.test(a) ? 'Windows' : /Macintosh|Mac OS X/.test(a) ? 'Mac'
        : /Linux/.test(a) ? 'Linux' : '';
    const browser = /Edg\//.test(a) ? 'Edge' : /OPR\//.test(a) ? 'Opera' : /SamsungBrowser/.test(a) ? 'Samsung Internet'
      : /Firefox\//.test(a) ? 'Firefox' : /Chrome\//.test(a) ? 'Chrome' : /Safari\//.test(a) ? 'Safari'
        : /VLC/i.test(a) ? 'VLC' : /iTunes|AppleCoreMedia/.test(a) ? 'Apple Music player' : /Lavf|ffmpeg/i.test(a) ? 'FFmpeg' : '';
    const name = [os, browser].filter(Boolean).join(' · ');
    return name || (a.split(/[\s/]/)[0] || 'Unknown player');
  }

  async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
    const res = await fetch(`${app.api}/admin/${path}`, {
      method,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(raw ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: raw || (body ? JSON.stringify(body) : undefined),
    });
    let reply = await res.json().catch(() => null);
    // Not an answer from our server (the proxy's own error page, for example)
    if (!reply || typeof reply !== 'object') reply = { ok: false, error: `The server answered ${res.status}.`, unparsed: true };
    if (res.status === 401 && path !== 'login') {
      signOut('Your sign-in has run out. Sign in again.');
      throw new Error('signed out');
    }
    return { status: res.status, ...reply };
  }

  // ---- Opening and closing ----

  function open(helpers) {
    app = helpers;
    if (isOpen) return;
    isOpen = true;
    focusBefore = document.activeElement;
    view.hidden = false;
    document.body.classList.add('admin-open');
    requestAnimationFrame(() => view.classList.add('open'));
    if (location.hash !== '#admin') {
      try { history.pushState({ admin: true }, '', '#admin'); } catch { /* not allowed */ }
    }
    render();
    if (token) refresh();
  }

  function close(fromHistory) {
    if (!isOpen) return;
    isOpen = false;
    clearInterval(statusTimer);
    clearInterval(statsTimer);
    view.classList.remove('open');
    document.body.classList.remove('admin-open');
    if (!fromHistory) {
      if (history.state && history.state.admin) history.back();
      else if (location.hash === '#admin') history.replaceState(null, '', location.pathname + location.search);
    }
    setTimeout(() => {
      if (!isOpen) view.hidden = true;
    }, 300);
    if (focusBefore && document.contains(focusBefore)) focusBefore.focus({ preventScroll: true });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen && !event.defaultPrevented) close(false);
  });

  function signOut(message) {
    token = '';
    status = null;
    stats = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ }
    clearInterval(statusTimer);
    clearInterval(statsTimer);
    render(message);
  }

  // Status every 5 seconds while open (and on screen); stats every minute
  async function refresh() {
    await Promise.all([loadStatus(), loadStats()]);
    clearInterval(statusTimer);
    clearInterval(statsTimer);
    statusTimer = setInterval(() => { if (!document.hidden) loadStatus(); }, 5000);
    statsTimer = setInterval(() => { if (!document.hidden) loadStats(); }, 60000);
  }

  async function loadStatus() {
    try {
      const reply = await api('status');
      if (reply.ok) status = reply;
    } catch { /* shown as unavailable */ }
    if (isOpen && token) renderStatus();
  }

  async function loadStats() {
    try {
      const reply = await api('stats');
      if (reply.ok) stats = reply;
    } catch { /* shown as unavailable */ }
    if (isOpen && token) renderStats();
  }

  // ---- Layout ----

  const parts = {};

  function render(message = '') {
    view.replaceChildren(
      h('div', { class: 'admin-wrap' },
        h('header', { class: 'admin-head' },
          h('div', {},
            h('p', { class: 'eyebrow', text: 'Taco Music' }),
            h('h2', { class: 'admin-title', text: 'Station admin' })),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close admin', title: 'Close', onclick: () => close(false) }, icon('close'))),
        token ? signedIn() : signIn(message)),
    );
    if (token) {
      renderStatus();
      renderUpload();
      renderStats();
    }
  }

  function signIn(message) {
    const input = h('input', { type: 'password', id: 'admin-password', autocomplete: 'current-password', required: true, enterkeyhint: 'go' });
    const note = h('p', { class: 'admin-note', role: 'status', text: message });
    const button = h('button', { class: 'request-btn big', type: 'submit', text: 'Sign in' });
    const form = h('form', { class: 'card signin', onsubmit: async (event) => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      button.disabled = true;
      note.textContent = 'Signing in…';
      try {
        const reply = await api('login', { method: 'POST', body: { password: input.value } });
        if (reply.ok) {
          token = reply.token;
          try { localStorage.setItem(TOKEN_KEY, token); } catch { /* storage unavailable */ }
          render();
          refresh();
          pump(); // carry on with any uploads that were waiting
          return;
        }
        note.textContent = reply.error || 'That didn’t work.';
      } catch {
        note.textContent = 'Couldn’t reach the server. Check your connection.';
      } finally {
        busy = false;
        button.disabled = false;
      }
    } },
    h('label', { for: 'admin-password', text: 'Admin password' }),
    input,
    button,
    note,
    h('p', { class: 'admin-hint', text: 'The password was shown when the server update was installed. It’s also in the .env file in ~/autodj on the server.' }));
    setTimeout(() => input.focus(), 50);
    return form;
  }

  function signedIn() {
    parts.onAir = h('section', { class: 'card', 'aria-labelledby': 'adm-onair' }, h('h3', { id: 'adm-onair', text: 'On air' }));
    parts.queue = h('section', { class: 'card', 'aria-labelledby': 'adm-queue' }, h('h3', { id: 'adm-queue', text: 'Up next' }));
    parts.listeners = h('section', { class: 'card', 'aria-labelledby': 'adm-listeners' }, h('h3', { id: 'adm-listeners', text: 'Listeners' }));
    parts.upload = h('section', { class: 'card', 'aria-labelledby': 'adm-upload' }, h('h3', { id: 'adm-upload', text: 'Upload music' }));
    parts.stats = h('section', { class: 'card wide', 'aria-labelledby': 'adm-stats' }, h('h3', { id: 'adm-stats', text: 'Stats' }));
    const grid = h('div', { class: 'admin-grid' },
      h('div', { class: 'admin-col' }, parts.onAir, parts.queue),
      h('div', { class: 'admin-col' }, parts.listeners, parts.upload),
      parts.stats);
    return h('div', {}, grid,
      h('p', { class: 'admin-foot' }, h('button', { class: 'link-btn', type: 'button', text: 'Sign out', onclick: () => signOut('Signed out.') })));
  }

  function fill(card, ...children) {
    card.replaceChildren(card.firstElementChild, ...children.flat().filter(Boolean));
  }

  // ---- On air, up next and listeners ----

  function renderStatus() {
    if (!parts.onAir || !document.contains(parts.onAir)) return;
    if (!status) {
      const waiting = h('p', { class: 'admin-note', text: 'Loading…' });
      fill(parts.onAir, waiting);
      fill(parts.queue, waiting.cloneNode(true));
      fill(parts.listeners, waiting.cloneNode(true));
      return;
    }
    renderOnAir();
    renderQueue();
    renderListeners();
  }

  function renderOnAir() {
    const np = status.now_playing;
    const chips = [];
    if (np && np.requested) chips.push(h('span', { class: 'chip', text: 'Requested' }));
    if (np && np.live_dj) chips.push(h('span', { class: 'chip chip-live', text: 'Live DJ' }));
    if (np && np.jingle) chips.push(h('span', { class: 'chip', text: 'Jingle' }));
    const row = np
      ? h('div', { class: 'admin-track' }, app.makeThumb(np.cover), app.makeText(np), h('div', { class: 'chips' }, chips))
      : h('p', { class: 'admin-note', text: status.live ? 'Nothing announced yet.' : 'The stream is off air.' });
    const actions = h('div', { class: 'admin-actions' });
    if (np && np.live_dj) {
      actions.append(action('End the DJ’s set', 'end-dj', 'The DJ was disconnected. The AutoDJ carries on.'));
    } else {
      const skip = action('Skip song', 'skip', 'Skipped. The next song blends in.');
      skip.prepend(icon('skip'));
      actions.append(skip);
    }
    const facts = h('p', { class: 'admin-facts', text: [
      status.live ? plural(status.listeners, 'listener', 'listeners') : 'Off air',
      plural(status.library, 'song', 'songs'),
      plural(status.jingles, 'jingle', 'jingles'),
      `up ${duration(status.uptime)}`,
    ].join(' · ') });
    fill(parts.onAir, row, actions, facts);
  }

  function action(label, path, done) {
    const button = h('button', { class: 'request-btn', type: 'button', text: label });
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const reply = await api(path, { method: 'POST', body: {} });
        app.toast(reply.ok ? done : reply.error || 'That didn’t work.');
        setTimeout(loadStatus, 1500);
      } catch { /* signed out */ } finally {
        button.disabled = false;
      }
    });
    return button;
  }

  async function setOrder(ids) {
    try {
      const reply = await api('queue', { method: 'POST', body: { order: ids } });
      if (!reply.ok) app.toast(reply.error || 'Couldn’t change the queue.');
      else status.requests = reply.requests;
    } catch { /* signed out */ }
    renderQueue();
  }

  function renderQueue() {
    const items = status.requests || [];
    const ids = items.map((r) => r.id);
    const list = h('ol', { class: 'history admin-queue' }, items.map((item, i) => {
      const move = (to) => {
        const next = [...ids];
        next.splice(to, 0, next.splice(i, 1)[0]);
        setOrder(next);
      };
      return h('li', {},
        app.makeThumb(item.cover),
        app.makeText({ title: item.title, artist: [item.artist, item.by_admin ? 'added by you' : ''].filter(Boolean).join(' · ') }),
        h('div', { class: 'row-actions' },
          h('button', { class: 'icon-btn small', type: 'button', 'aria-label': `Move ${item.title} up`, disabled: i === 0, onclick: () => move(i - 1) }, icon('up')),
          h('button', { class: 'icon-btn small', type: 'button', 'aria-label': `Move ${item.title} down`, disabled: i === items.length - 1, onclick: () => move(i + 1) }, icon('down')),
          h('button', { class: 'icon-btn small danger', type: 'button', 'aria-label': `Remove ${item.title}`, onclick: () => setOrder(ids.filter((id) => id !== item.id)) }, icon('close'))));
    }));
    const empty = items.length ? null : h('p', { class: 'admin-note', text: 'No requests waiting.' });
    // Add a song to the queue, no waiting
    const results = h('ul', { class: 'history admin-results' });
    const search = h('input', { type: 'search', placeholder: 'Add a song: search the library', autocomplete: 'off', 'aria-label': 'Search the library to add a song' });
    search.addEventListener('input', async () => {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return results.replaceChildren();
      const songs = await app.library();
      const found = songs.filter((s) => words.every((w) => `${s.title} ${s.artist} ${s.album}`.toLowerCase().includes(w))).slice(0, 6);
      results.replaceChildren(...found.map((song) => h('li', {}, app.makeThumb(song.cover), app.makeText(song),
        h('button', { class: 'request-btn', type: 'button', text: ids.includes(song.id) ? 'Queued' : 'Add', disabled: ids.includes(song.id), onclick: async (event) => {
          event.currentTarget.disabled = true;
          try {
            const reply = await api('request', { method: 'POST', body: { song_id: song.id } });
            if (reply.ok) {
              status.requests = reply.requests;
              search.value = '';
              results.replaceChildren();
              renderQueue();
            } else {
              app.toast(reply.error || 'Couldn’t add it.');
            }
          } catch { /* signed out */ }
        } }))));
    });
    // Keep what's being typed when the list refreshes
    const old = parts.queue.querySelector('input[type="search"]');
    if (old && old.value) {
      search.value = old.value;
      const oldResults = parts.queue.querySelector('.admin-results');
      if (oldResults) results.append(...oldResults.children);
    }
    const hadFocus = old && document.activeElement === old;
    fill(parts.queue, list, empty, h('label', { class: 'search' }, search), results);
    if (hadFocus) search.focus();
  }

  function renderListeners() {
    const clients = status.clients;
    const count = h('p', { class: 'admin-big' }, h('strong', { text: String(status.listeners) }), ` listening now`);
    if (clients === null || clients === undefined) {
      return fill(parts.listeners, count, h('p', { class: 'admin-note', text: 'Listener details need the Icecast admin password in the server’s settings.' }));
    }
    const list = h('ul', { class: 'history admin-clients' }, clients.map((c) => h('li', {},
      h('div', { class: 'h-text' },
        h('span', { class: 'h-title', text: device(c.agent) }),
        h('span', { class: 'h-artist', text: [c.mount === '/stream-low' ? 'Data saver' : 'Full quality', c.address].filter(Boolean).join(' · ') })),
      h('time', { text: duration(c.seconds) }))));
    fill(parts.listeners, count, clients.length ? list : h('p', { class: 'admin-note', text: 'Nobody’s listening right now.' }));
  }

  // ---- Uploads ----

  let uploadList = null; // kept between redraws, so its scroll position stays put
  let uploadSummary = null;
  let active = 0;
  let wakeLock = null;

  function renderUpload() {
    if (!parts.upload || !document.contains(parts.upload)) return;
    const kinds = h('div', { class: 'segmented', role: 'group', 'aria-label': 'What you’re uploading' },
      ['song', 'jingle'].map((kind) => h('button', { type: 'button', 'aria-pressed': String(uploadKind === kind), text: kind === 'song' ? 'Songs' : 'Jingles',
        onclick: () => { uploadKind = kind; renderUpload(); } })));
    const input = h('input', { type: 'file', multiple: true, accept: 'audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav', class: 'visually-hidden', id: 'admin-files' });
    input.addEventListener('change', () => {
      addFiles(input.files);
      input.value = '';
    });
    // A whole folder at once (not offered on iPhones and iPads, which can't pick folders)
    const folder = h('input', { type: 'file', multiple: true, class: 'visually-hidden', id: 'admin-folder' });
    const folders = 'webkitdirectory' in folder && !/iPhone|iPad|iPod/.test(navigator.userAgent);
    if (folders) folder.webkitdirectory = true;
    folder.addEventListener('change', () => {
      addFiles([...folder.files].sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name)));
      folder.value = '';
    });
    const max = status ? status.max_upload_mb : 500;
    const zone = h('label', { class: 'dropzone', for: 'admin-files' },
      icon('upload'),
      h('span', { text: uploadKind === 'song' ? 'Choose songs or drop them here' : 'Choose jingles or drop them here' }),
      h('small', { text: uploadKind === 'song'
        ? `MP3, M4A, FLAC, OGG or WAV, up to ${max} MB each. Pick as many as you like${folders ? ', or drop a whole folder' : ''}. Duplicates are turned away and lyrics are checked.`
        : 'Short station idents, up to 90 seconds. One plays every few songs.' }));
    zone.addEventListener('dragover', (event) => { event.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', async (event) => {
      event.preventDefault();
      zone.classList.remove('over');
      addFiles(await droppedFiles(event.dataTransfer));
    });
    const folderPick = folders ? h('p', { class: 'folder-pick' }, h('label', { class: 'link-btn', for: 'admin-folder', text: 'Or choose a whole folder' })) : null;
    if (!uploadList) {
      uploadList = h('ul', { class: 'uploads', 'aria-label': 'Uploads' });
      uploadSummary = h('div', { class: 'upload-summary', role: 'status' });
    }
    for (const u of uploads) if (!u.el) uploadList.append(row(u));
    const blocked = status && !(uploadKind === 'song' ? status.uploads : status.jingle_uploads)
      ? h('p', { class: 'admin-note', text: 'The server can’t save uploads yet: its upload folder isn’t set up.' }) : null;
    fill(parts.upload, kinds, blocked, input, folder, zone, folderPick, uploadSummary, uploadList);
    renderSummary();
  }

  // Everything in a dropped folder (and its folders), or just the dropped files
  async function droppedFiles(transfer) {
    const entries = [...(transfer.items || [])].map((item) => item.webkitGetAsEntry && item.webkitGetAsEntry()).filter(Boolean);
    if (!entries.length) return [...transfer.files];
    const files = [];
    const walk = async (entry) => {
      if (entry.isFile) {
        files.push(await new Promise((resolve, reject) => { entry.file(resolve, reject); }));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((resolve, reject) => { reader.readEntries(resolve, reject); });
          if (!batch.length) break;
          for (const e of batch) await walk(e);
        }
      }
    };
    for (const entry of entries) {
      try { await walk(entry); } catch { /* unreadable: skip it */ }
    }
    return files.sort((a, b) => a.name.localeCompare(b.name));
  }

  function row(u) {
    u.el = h('li', {},
      h('div', { class: 'upload-name' }, h('span', { text: u.file.name }), h('small', {})),
      h('div', { class: 'bar' }, h('div', { class: 'fill' })));
    updateRow(u);
    return u.el;
  }

  function updateRow(u) {
    if (!u.el) return;
    u.el.dataset.tone = u.tone || '';
    u.el.dataset.state = u.state;
    u.el.querySelector('small').textContent = u.message;
    u.el.querySelector('.fill').style.transform = `scaleX(${u.file.size ? u.received / u.file.size : 0})`;
  }

  let summaryFrame = 0;
  function renderSummary() {
    if (summaryFrame) return;
    summaryFrame = requestAnimationFrame(() => {
      summaryFrame = 0;
      if (!uploadSummary) return;
      const count = (what) => uploads.filter((u) => u.result === what).length;
      const done = uploads.filter((u) => u.state === 'done').length;
      if (!uploads.length) return uploadSummary.replaceChildren();
      const busy = uploads.some((u) => u.state !== 'done');
      const total = uploads.reduce((n, u) => n + u.file.size, 0);
      const sent = uploads.reduce((n, u) => n + (u.state === 'done' ? u.file.size : u.received), 0);
      const checking = uploads.filter((u) => u.lyrics === 'checking').length;
      const untimed = uploads.filter((u) => ['other', 'plain', 'none'].includes(u.lyrics)).length;
      const facts = [
        count('added') && `${count('added')} added`,
        untimed && `${untimed} without timed lyrics`,
        count('duplicate') && `${count('duplicate')} already in the library`,
        count('failed') && `${count('failed')} failed`,
      ].filter(Boolean).join(' · ');
      const actions = h('div', { class: 'upload-actions' },
        count('failed') && !busy ? h('button', { class: 'request-btn', type: 'button', text: 'Try the failed ones again', onclick: retryFailed }) : null,
        !busy ? h('button', { class: 'link-btn', type: 'button', text: checking ? 'Clear the list (stops the lyrics checks)' : 'Clear the list', onclick: clearUploads }) : null);
      const heading = busy ? `Uploading: ${done} of ${uploads.length} done`
        : checking ? `${plural(uploads.length, 'file', 'files')} uploaded · checking lyrics for ${checking} more`
          : `${plural(uploads.length, 'file', 'files')} done`;
      uploadSummary.replaceChildren(...[
        h('p', {}, h('strong', { text: heading }), facts ? h('span', { text: ` · ${facts}` }) : null),
        busy ? h('div', { class: 'bar' }, h('div', { class: 'fill', style: `transform: scaleX(${total ? sent / total : 0})` })) : null,
        busy ? h('small', { text: 'Keep this page open until it’s finished.' }) : null,
        !busy && checking ? h('small', { text: 'SyncLRC answers about 25 songs a minute, so a big batch takes a few minutes. The songs are already in the library.' }) : null,
        busy ? null : actions,
      ].filter(Boolean));
    });
  }

  function addFiles(files) {
    const max = (status ? status.max_upload_mb : 500) * 1024 * 1024;
    let skipped = 0;
    for (const file of files) {
      if (!AUDIO_FILE.test(file.name)) {
        skipped += 1;
        continue;
      }
      const u = { file, kind: uploadKind, state: 'waiting', received: 0, message: 'Waiting…' };
      if (file.size > max) finish(u, 'error', `Too big: files can be up to ${max / 1048576} MB.`, 'failed');
      uploads.push(u);
    }
    if (skipped) app.toast(`Skipped ${plural(skipped, 'file', 'files')} that ${skipped === 1 ? 'isn’t' : 'aren’t'} music.`);
    renderUpload();
    pump();
  }

  function retryFailed() {
    for (const u of uploads) {
      if (u.result !== 'failed' || u.message.startsWith('Too big')) continue;
      Object.assign(u, { state: 'waiting', received: 0, tone: '', result: undefined, message: 'Waiting…' });
      updateRow(u);
    }
    renderSummary();
    pump();
  }

  function clearUploads() {
    uploads.length = 0;
    if (uploadList) uploadList.replaceChildren();
    renderSummary();
  }

  // Three at a time; the screen stays on until they're done
  function pump() {
    while (token && active < PARALLEL) {
      const u = uploads.find((x) => x.state === 'waiting');
      if (!u) break;
      active += 1;
      u.state = 'sending';
      send(u)
        .catch(() => finish(u, 'error', 'The upload didn’t work.', 'failed'))
        .finally(() => {
          active -= 1;
          updateRow(u);
          renderSummary();
          pump();
          if (!active) {
            releaseWakeLock();
            loadStatus();
          }
        });
    }
    if (active) holdWakeLock();
  }

  async function holdWakeLock() {
    if (wakeLock || !navigator.wakeLock || document.hidden) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* not allowed right now */ }
  }

  function releaseWakeLock() {
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && active) holdWakeLock();
  });
  window.addEventListener('beforeunload', (event) => {
    if (active || uploads.some((u) => u.state === 'waiting')) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  const LYRICS = {
    words: ['ok', 'Word-by-word lyrics found.'],
    synced: ['ok', 'Timed lyrics found.'],
    other: ['warn', 'Timed lyrics are only for a different length of recording, so just the words will show.'],
    plain: ['warn', 'Only untimed lyrics found.'],
    instrumental: ['ok', 'It’s instrumental.'],
    none: ['warn', 'No lyrics found on SyncLRC.'],
    unknown: ['warn', 'Lyrics couldn’t be checked.'],
  };

  // Ask SyncLRC about an added song. These go out within its limit (shared with the lyrics on
  // screen), so a big batch is checked over a few minutes; clearing the list stops the rest.
  async function checkLyrics(u, song, added) {
    u.lyrics = 'checking';
    u.message = `${added} Checking lyrics…`;
    updateRow(u);
    renderSummary();
    const result = await app.lyricsCheck(song, () => uploads.includes(u));
    if (!uploads.includes(u)) return;
    const [tone, said] = LYRICS[result] || LYRICS.unknown;
    u.lyrics = result;
    u.tone = u.tone === 'warn' ? 'warn' : tone;
    u.message = `${added} ${said}`;
    updateRow(u);
    renderSummary();
  }

  async function send(u) {
    u.message = 'Uploading…';
    updateRow(u);
    const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
    let failures = 0;
    const retry = async (message) => {
      failures += 1;
      if (failures > 5) return false;
      u.message = message;
      updateRow(u);
      await new Promise((r) => { setTimeout(r, 1500 * failures); });
      return true;
    };
    while (u.received < u.file.size) {
      const piece = u.file.slice(u.received, Math.min(u.received + chunkSize, u.file.size));
      let reply;
      try {
        reply = await api('upload', { method: 'POST', raw: piece, headers: {
          'X-Upload-Id': id,
          'X-Upload-Name': encodeURIComponent(u.file.name),
          'X-Upload-Kind': u.kind,
          'X-Upload-Offset': String(u.received),
          'X-Upload-Size': String(u.file.size),
        } });
      } catch (err) {
        if (err.message === 'signed out') {
          // Starts again once signed back in
          Object.assign(u, { state: 'waiting', received: 0, message: 'Waiting…' });
          return;
        }
        if (await retry('The connection dropped. Trying again…')) continue;
        return finish(u, 'error', 'The connection kept dropping. Try again.', 'failed');
      }
      // The proxy turned a big piece away: smaller pieces from now on
      if (reply.status === 413 && reply.unparsed && chunkSize > SMALL_CHUNK) {
        chunkSize = SMALL_CHUNK;
        continue;
      }
      if (reply.unparsed && reply.status >= 500) {
        if (await retry('The server was busy. Trying again…')) continue;
        return finish(u, 'error', reply.error, 'failed');
      }
      if (reply.status === 409 && typeof reply.received === 'number') {
        u.received = reply.received; // pick up where the server got to
        continue;
      }
      if (!reply.ok) {
        const dup = reply.duplicate;
        return dup
          ? finish(u, 'warn', `Already in the library as “${dup.title}”${dup.artist ? ` by ${dup.artist}` : ''}.`, 'duplicate')
          : finish(u, 'error', reply.error || 'The upload didn’t work.', 'failed');
      }
      if (typeof reply.received === 'number') {
        u.received = reply.received;
        u.message = `Uploading… ${Math.floor((u.received / u.file.size) * 100)}%`;
        updateRow(u);
        renderSummary();
        continue;
      }
      u.received = u.file.size;
      if (reply.kind === 'jingle') return finish(u, 'ok', `Added as a jingle (${Math.round(reply.duration)} s).`, 'added');
      const song = reply.song;
      const warnings = reply.warnings || [];
      const added = [`Added: “${song.title}”${song.artist ? ` by ${song.artist}` : ''}.`, ...warnings].join(' ');
      finish(u, warnings.length ? 'warn' : 'ok', added, 'added');
      checkLyrics(u, song, added);
      return;
    }
  }

  function finish(u, tone, message, result) {
    u.state = 'done';
    u.tone = tone;
    u.message = message;
    u.result = result;
    updateRow(u);
    renderSummary();
  }

  // ---- Stats ----

  function renderStats() {
    if (!parts.stats || !document.contains(parts.stats)) return;
    if (!stats) return fill(parts.stats, h('p', { class: 'admin-note', text: 'Loading…' }));
    const since = new Date(stats.since * 1000).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
    const peakAt = stats.peak.at ? new Date(stats.peak.at * 1000).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    const tiles = h('div', { class: 'tiles' },
      tile('Most listeners at once', stats.peak.listeners, peakAt),
      tile('Songs played', stats.total_plays),
      tile('Requests', stats.total_requests),
      tile('Likes', stats.total_likes));
    const chart = h('figure', { class: 'peaks' },
      h('figcaption', {}, h('strong', { text: 'Most listeners at once, each hour' }), h('span', { text: 'Last 7 days' })));
    const tops = h('div', { class: 'admin-top' },
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Top songs' },
        [['most_played', 'Most played'], ['most_requested', 'Most requested'], ['most_liked', 'Most liked']].map(([kind, label]) =>
          h('button', { type: 'button', 'aria-pressed': String(topKind === kind), text: label, onclick: () => { topKind = kind; renderStats(); } }))),
      topList(stats[topKind] || []));
    const days = h('details', { class: 'admin-days' },
      h('summary', { text: 'Daily peaks as a table' }),
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Day' }), h('th', { scope: 'col', text: 'Most listeners at once' }))),
        h('tbody', {}, [...stats.listener_days].reverse().map(([day, n]) => h('tr', {},
          h('td', { text: new Date(`${day}T12:00:00Z`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) }),
          h('td', { text: String(n) }))))));
    fill(parts.stats, h('p', { class: 'admin-facts', text: `Counting since ${since}.` }), tiles, chart, tops, days);
    drawPeaks(chart);
  }

  function tile(label, value, note) {
    return h('div', { class: 'tile' },
      h('span', { class: 'tile-label', text: label }),
      h('span', { class: 'tile-value', text: Number(value).toLocaleString() }),
      note ? h('span', { class: 'tile-note', text: note }) : null);
  }

  function topList(items) {
    if (!items.length) return h('p', { class: 'admin-note', text: 'Nothing yet.' });
    return h('ol', { class: 'history charts' }, items.slice(0, 10).map((item, i) => h('li', {},
      h('span', { class: 'rank', text: String(i + 1) }),
      app.makeThumb(item.cover),
      app.makeText(item),
      h('span', { class: 'count', text: item.count.toLocaleString() }))));
  }

  // Hourly peaks for the last week, as columns, with the busiest hour labelled
  function drawPeaks(figure) {
    const NS = 'http://www.w3.org/2000/svg';
    const svgEl = (tag, attrs = {}) => {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      return el;
    };
    const known = new Map(stats.listener_hours.map(([hour, n]) => [hour, n]));
    const last = Math.floor(Date.now() / 3600000) * 3600;
    const hours = Array.from({ length: 168 }, (_, i) => last - (167 - i) * 3600);
    const values = hours.map((t) => (known.has(t) ? known.get(t) : null));
    const width = Math.max(280, Math.round(figure.clientWidth || parts.stats.clientWidth - 40));
    const height = 190;
    const m = { top: 22, right: 6, bottom: 24, left: 30 };
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;
    const max = Math.max(4, ...values.filter((v) => v !== null));
    const top = max <= 4 ? 4 : Math.ceil(max / 4) * 4; // clean ticks: 0, top/2, top
    const y = (v) => m.top + plotH - (v / top) * plotH;
    const slot = plotW / hours.length;
    const gap = slot > 5 ? 2 : 1;
    const barW = Math.max(1, slot - gap);
    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Most listeners at once each hour for the last 7 days; the busiest hour had ${max}` });
    for (const v of [0, top / 2, top]) {
      svg.append(svgEl('line', { x1: m.left, x2: width - m.right, y1: y(v), y2: y(v), class: 'grid' }));
      const label = svgEl('text', { x: m.left - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' });
      label.textContent = String(v);
      svg.append(label);
    }
    // Day labels at local midnight
    hours.forEach((t, i) => {
      const d = new Date(t * 1000);
      if (d.getHours() !== 0) return;
      const label = svgEl('text', { x: m.left + i * slot, y: height - 6, class: 'tick' });
      label.textContent = d.toLocaleDateString([], { weekday: 'short' });
      svg.append(label);
    });
    const bars = values.map((v, i) => {
      if (!v) return null;
      const barH = Math.max(1, (v / top) * plotH);
      const r = Math.min(4, barW / 2);
      const x = m.left + i * slot + gap / 2;
      const yTop = m.top + plotH - barH;
      // rounded at the top, square at the baseline
      const d = `M${x},${m.top + plotH}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + barW - r}Q${x + barW},${yTop} ${x + barW},${yTop + r}V${m.top + plotH}Z`;
      const bar = svgEl('path', { d, class: 'col' });
      svg.append(bar);
      return bar;
    });
    // Label the busiest hour
    const best = values.reduce((b, v, i) => (v !== null && v > (values[b] ?? -1) ? i : b), 0);
    if (values[best]) {
      const label = svgEl('text', { x: Math.min(Math.max(m.left + best * slot + slot / 2, m.left + 14), width - m.right - 14), y: y(values[best]) - 7, 'text-anchor': 'middle', class: 'peak-label' });
      label.textContent = String(values[best]);
      svg.append(label);
    }
    // Hover: the whole column height answers, not just the bar
    const tip = h('div', { class: 'chart-tip', hidden: true });
    const hit = svgEl('rect', { x: m.left, y: m.top, width: plotW, height: plotH, fill: 'transparent' });
    let lit = null;
    const show = (event) => {
      const box = svg.getBoundingClientRect();
      const scale = box.width / width; // the chart shrinks to fit narrow screens
      const i = Math.min(hours.length - 1, Math.max(0, Math.floor(((event.clientX - box.left) / scale - m.left) / slot)));
      if (lit) lit.classList.remove('lit');
      lit = bars[i];
      if (lit) lit.classList.add('lit');
      const d = new Date(hours[i] * 1000);
      const when = d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      tip.replaceChildren(h('strong', { text: values[i] === null ? 'No data' : plural(values[i], 'listener', 'listeners') }), h('span', { text: when }));
      tip.hidden = false;
      const x = (m.left + i * slot + slot / 2) * scale;
      tip.style.left = `${Math.min(Math.max(x, 60), box.width - 60)}px`;
    };
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', () => {
      tip.hidden = true;
      if (lit) lit.classList.remove('lit');
      lit = null;
    });
    svg.append(hit);
    figure.append(h('div', { class: 'chart-box' }, svg, tip));
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (isOpen && token) renderStats(); }, 200);
  });

  window.TacoAdmin = { open, close, isOpen: () => isOpen };
})();
