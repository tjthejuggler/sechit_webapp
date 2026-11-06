// Board page controller: renders the public game state broadcast by the
// server. Read-only except lobby/start controls and the draggable president
// plaque (manual placement per requirements).
//
// Visuals are driven by the official print-and-play art (public/assets,
// see manifest.json): the liberal board strip carries the draw/discard pile
// art + live counts + election tracker + draw-QR overlay; the fascist half
// images are chosen per player count and policy tiles fill the track slots.
//
// i18n: every rendered string goes through t() (public/shared/i18n.js); the
// EN|TR toggle re-renders the latest state live and swaps localizable board
// art to the Turkish variants (identical display geometry — see BOARD_GEO).
import { showToast, setQrImg } from '../shared/shared.js';
import { detectMode, MODE, connectBoardLan, deadSocket, generateGameCode } from '../shared/net.js';
import { startHost } from './host.js';
import {
  t, getLang, setLang, onChange, applyI18n, createLangToggle,
  localizedAssetPath, errorText,
} from '../shared/i18n.js';

const $ = (sel) => document.querySelector(sel);

const POWER_ICONS = {
  investigate: '🔍',
  specialElection: '⚖️',
  policyPeek: '👀',
  execute: '☠️',
};

// Fascist board halves per player count (track half + powers/summary half).
function fascistBoardKey(playerCount) {
  if (playerCount <= 6) return '5-6';
  if (playerCount <= 8) return '7-8';
  return '9-10';
}

// Slot geometry per LANGUAGE, measured from each art (fractions of each image
// box). All EN and TR files share identical display dimensions (4266×1515,
// 2133×1499, 2139×1499 — build_assets.py trims/resamples the TR sources onto
// the EN canvas), so one coordinate set per language is enough; the TR art's
// printed features sit within ±8px of EN, absorbed by the constants below.
const BOARD_GEO = {
  en: {
    LIBERAL_SLOTS: [
      { cx: 0.2261, cy: 0.525, w: 0.117, h: 0.40 },
      { cx: 0.3622, cy: 0.525, w: 0.117, h: 0.40 },
      { cx: 0.4985, cy: 0.525, w: 0.117, h: 0.40 },
      { cx: 0.6346, cy: 0.525, w: 0.117, h: 0.40 },
      { cx: 0.7728, cy: 0.525, w: 0.117, h: 0.40 },
    ],
    FASC_TRACK_SLOTS: [
      { cx: 0.2866, cy: 0.50, w: 0.26, h: 0.48 },
      { cx: 0.5936, cy: 0.50, w: 0.24, h: 0.48 },
      { cx: 0.8680, cy: 0.50, w: 0.24, h: 0.48 },
    ],
    FASC_SUM_SLOTS: [
      { cx: 0.1324, cy: 0.50, w: 0.24, h: 0.48 },
      { cx: 0.4152, cy: 0.50, w: 0.24, h: 0.48 },
      { cx: 0.7400, cy: 0.50, w: 0.30, h: 0.48 },
    ],
    TRACKER_CIRCLES: [
      { cx: 0.3537, cy: 0.834 },
      { cx: 0.4466, cy: 0.834 },
      { cx: 0.5379, cy: 0.836 },
    ],
  },
  tr: {
    LIBERAL_SLOTS: [
      { cx: 0.2256, cy: 0.521, w: 0.117, h: 0.40 },
      { cx: 0.3622, cy: 0.521, w: 0.117, h: 0.40 },
      { cx: 0.4946, cy: 0.521, w: 0.117, h: 0.40 },
      { cx: 0.6346, cy: 0.525, w: 0.117, h: 0.40 },
      { cx: 0.7733, cy: 0.525, w: 0.117, h: 0.40 },
    ],
    FASC_TRACK_SLOTS: [
      { cx: 0.2866, cy: 0.50, w: 0.26, h: 0.48 },
      { cx: 0.5936, cy: 0.50, w: 0.24, h: 0.48 },
      { cx: 0.8680, cy: 0.50, w: 0.24, h: 0.48 },
    ],
    FASC_SUM_SLOTS: [
      { cx: 0.1324, cy: 0.50, w: 0.24, h: 0.48 },
      { cx: 0.4152, cy: 0.50, w: 0.24, h: 0.48 },
      { cx: 0.7400, cy: 0.50, w: 0.30, h: 0.48 },
    ],
    TRACKER_CIRCLES: [
      { cx: 0.3542, cy: 0.823 },
      { cx: 0.4468, cy: 0.823 },
      { cx: 0.5377, cy: 0.829 },
    ],
  },
};

function geo() {
  return BOARD_GEO[getLang()] ?? BOARD_GEO.en;
}

let latestState = null;

// Connection bootstrap (top-level await). LAN mode: plain Socket.IO client of
// the Node server, exactly as before. Static/online mode: THIS page becomes
// the authoritative host — the engine runs here, phones reach it over PeerJS,
// and the UI keeps talking to the same NetSocket loopback.
let socket;
let hostInfo = null;
try {
  const mode = await detectMode();
  if (mode === MODE.LAN) {
    socket = await connectBoardLan();
  } else {
    hostInfo = await startHost();
    socket = hostInfo.socket;
  }
} catch (err) {
  socket = deadSocket('Could not start the game host.');
  showToast(t('board.toast.hostFailed', { msg: err?.message ?? err }), { error: true });
}

socket.on('state', (state) => {
  latestState = state;
  render(state);
});
socket.on('connect_error', (err) => showToast(t('board.toast.connFailed', { msg: err.message }), { error: true }));

// Test hook (online simulator): board/?bots=N[&games=G] spawns N in-page
// virtual phones through the REAL hosted GameRoom and plays complete games.
// Dynamically imported ONLY when the param is present — normal players never
// download this code. The Node driver (scripts/simulate-online.mjs) launches
// this page headless, waits for window.__sim.done, and re-verifies every
// game's public event log offline (tests/bots/driver.js verifyLogHistory).
if (hostInfo && new URLSearchParams(location.search).has('bots')) {
  const bp = new URLSearchParams(location.search);
  const n = Math.min(10, Math.max(5, parseInt(bp.get('bots'), 10) || 5));
  const games = Math.max(1, parseInt(bp.get('games'), 10) || 1);
  import('./bots.js')
    .then((m) => m.runBots(hostInfo, n, games))
    .catch((err) => {
      if (window.__sim) window.__sim.error = String(err?.message ?? err);
      else console.error('[bots]', err);
      showToast(`Simulator failed: ${err?.message ?? err}`, { error: true, ms: 10000 });
    });
}

// Language switch: re-render everything from the latest state (live, no
// reload) and refresh static chrome + localizable art.
onChange(() => {
  applyI18n();
  if (latestState) render(latestState);
});

// ---------------------------------------------------------------- boot

$('#lang-toggle-board').replaceChildren(createLangToggle());
$('#btn-start').dataset.i18n = 'board.btn.start';
$('#btn-begin').dataset.i18n = 'board.btn.begin';
$('#btn-reset').dataset.i18n = 'board.btn.reset';
$('#btn-again').dataset.i18n = 'board.btn.again';
$('#join-qr').dataset.i18nAlt = 'board.lobby.qrAlt';
applyI18n();

// ------------------------------------------------------ share / copy controls
// Online mode affordances under the lobby QR: the short game code, a copy
// button for the full join URL, a native share sheet where available, and a
// "New code" button that abandons the current lobby and re-mints a fresh
// game code + QR (regenerating the QR is an explicit user action — see
// board.lobby.newCodeConfirm). Hidden entirely in LAN mode (the QR + URL are
// enough there, and the server owns the game id).
if (hostInfo) {
  $('#btn-copy-link')?.addEventListener('click', async () => {
    const url = $('#join-url')?.dataset.copyText ?? $('#join-url')?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(url);
      showToast(t('board.lobby.copied'));
    } catch {
      showToast(t('board.lobby.copyFailed'), { error: true });
    }
  });
  $('#btn-share')?.addEventListener('click', async () => {
    const url = $('#join-url')?.dataset.copyText ?? $('#join-url')?.textContent ?? '';
    const code = $('#join-code')?.textContent ?? '';
    const shareData = {
      title: t('app.title'),
      text: t('board.lobby.shareText', { code }),
      url,
    };
    if (navigator.share) {
      try { await navigator.share(shareData); } catch { /* user cancelled */ }
    } else {
      try {
        await navigator.clipboard.writeText(`${shareData.text} ${url}`);
        showToast(t('board.lobby.copied'));
      } catch {
        showToast(t('board.lobby.copyFailed'), { error: true });
      }
    }
  });
  // "New code": abandon the current lobby + code and re-mint a fresh game
  // code + QR via a clean navigation to board/?host=<fresh code>.
  $('#btn-new-code')?.addEventListener('click', () => {
    if (!confirm(t('board.lobby.newCodeConfirm'))) return;
    try { hostInfo?.peer?.destroy(); } catch { /* already gone */ }
    const url = new URL('../board/', document.baseURI);
    url.searchParams.set('host', generateGameCode());
    location.replace(url.href);
  });
} else {
  $('#join-code')?.closest('.join-code-card')?.classList.add('hidden');
  $('#share-row')?.classList.add('hidden');
}

// Socket-independent fallback (LAN mode only): make sure the lobby join QR is
// visible even before the socket connects, straight from the REST API.
if (hostInfo === null) {
  fetch(new URL('../api/join-url', document.baseURI).href)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data?.url && !$('#join-qr').src) {
        setQrImg($('#join-qr'), data.url);
        $('#join-url').textContent = data.url;
      }
    })
    .catch(() => { /* socket path will populate it instead */ });
}


// ---------------------------------------------------------------- lobby view

function renderLobby(state) {
  $('#lobby-view').classList.remove('hidden');
  $('#game-view').classList.add('hidden');
  $('#phase-title').textContent = t('board.phase.LOBBY.title');
  $('#phase-sub').textContent = state.joinUrl;
  // Prominent, always-rendered join QR (rendered client-side, no server).
  setQrImg($('#join-qr'), state.joinUrl);
  $('#join-url').textContent = state.joinUrl;
  $('#join-url').dataset.copyText = state.joinUrl;
  // Online mode: show the short game code + copy/share affordances.
  const codeEl = $('#join-code');
  if (codeEl && hostInfo) {
    codeEl.textContent = state.gameId ?? '';
    $('#share-row')?.classList.remove('hidden');
  }

  const count = state.lobby.length;
  const canStart = count >= state.minPlayers && count <= state.maxPlayers;
  $('#lobby-count').textContent = t('board.lobby.count', {
    n: count, s: count === 1 ? '' : 's', min: state.minPlayers, max: state.maxPlayers,
  });
  renderLobbyRing(state);
  $('#btn-start').disabled = !canStart;
  $('#btn-start').textContent = canStart
    ? t('board.btn.start')
    : t('board.btn.waiting', { n: state.minPlayers });
  $('#btn-begin').classList.add('hidden');
}

// Pre-game seating circle: seats mirror the in-game ring geometry. Drag a
// player onto another seat (HTML5 DnD) — or tap one, then tap another — to
// SWAP them. The full new id order goes to the server (`board:reorder`),
// which is authoritative for the lobby (and thus seat) order.
let pendingLobbyPick = null;

function renderLobbyRing(state) {
  const ring = $('#lobby-ring');
  for (const old of ring.querySelectorAll('.lobby-seat')) old.remove();
  $('#lobby-rearrange-hint').textContent = state.lobby.length >= 2
    ? t('board.lobby.rearrange')
    : '';

  const players = state.lobby;
  const n = Math.max(players.length, 1);
  players.forEach((p, i) => {
    const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
    const radiusX = ring.clientWidth * 0.5 - 56;
    const radiusY = ring.clientHeight * 0.5 - 28;
    const x = ring.clientWidth / 2 + radiusX * Math.cos(angle);
    const y = ring.clientHeight / 2 + radiusY * Math.sin(angle);

    const seat = document.createElement('div');
    seat.className = 'lobby-seat';
    seat.style.left = `${x}px`;
    seat.style.top = `${y}px`;
    seat.dataset.playerId = p.id;
    seat.draggable = true;

    const name = document.createElement('span');
    name.className = 'seat-name';
    name.textContent = p.name;
    seat.appendChild(name);

    seat.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', p.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    seat.addEventListener('dragover', (e) => {
      e.preventDefault();
      seat.classList.add('drop-target');
    });
    seat.addEventListener('dragleave', () => seat.classList.remove('drop-target'));
    seat.addEventListener('drop', (e) => {
      e.preventDefault();
      seat.classList.remove('drop-target');
      clearLobbySelection();
      const from = e.dataTransfer.getData('text/plain');
      if (from && from !== p.id) swapLobbySeats(state, from, p.id);
    });
    // Tap-tap fallback for touch screens without drag support.
    seat.addEventListener('click', () => {
      if (pendingLobbyPick == null) {
        pendingLobbyPick = p.id;
        seat.classList.add('selected');
        return;
      }
      const from = pendingLobbyPick;
      clearLobbySelection();
      if (from !== p.id) swapLobbySeats(state, from, p.id);
    });

    ring.appendChild(seat);
  });
}

function clearLobbySelection() {
  pendingLobbyPick = null;
  document.querySelectorAll('.lobby-seat.selected').forEach((el) => el.classList.remove('selected'));
}

// Swap two players in the lobby order and push the full order to the server.
// Optimistic local swap keeps the ring responsive; the server broadcast
// confirms (or reverts on failure).
function swapLobbySeats(state, fromId, toId) {
  const ids = state.lobby.map((p) => p.id);
  const i = ids.indexOf(fromId);
  const j = ids.indexOf(toId);
  if (i < 0 || j < 0) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  // Optimistic local re-render (server broadcast will follow anyway).
  const byId = new Map(state.lobby.map((p) => [p.id, p]));
  state.lobby = ids.map((id) => byId.get(id));
  renderLobbyRing(state);
  socket.timeout(8000).emit('board:reorder', ids, (err, res) => {
    if (err || !res?.ok) showToast(errorText(res?.code, t('board.toast.reorderFailed')), { error: true });
  });
}

// ---------------------------------------------------------------- game views

function render(state) {
  if (state.phase === 'LOBBY') {
    // Reset/Play-again path: dismiss the win splash IMMEDIATELY — the lobby
    // must be front-and-center the moment the state says LOBBY (the splash
    // used to linger here because only renderWin() ever hid it, and render()
    // returned early on LOBBY).
    $('#win-splash').classList.add('hidden');
    renderLobby(state);
    return;
  }
  $('#lobby-view').classList.add('hidden');
  $('#game-view').classList.remove('hidden');

  $('#phase-title').textContent = t(`board.phase.${state.phase}.title`);
  $('#phase-sub').textContent = t(`board.phase.${state.phase}.sub`);
  $('#btn-begin').classList.toggle('hidden', state.phase !== 'ROLE_REVEAL');

  renderFlash(state);
  renderAnnounce(state);
  renderBoards(state);
  renderSeats(state);
  renderVotePanel(state);
  renderVeto(state);
  renderLog(state);
  renderCenter(state);
  renderWin(state);
}

// Prominent banner while the investigation-acknowledgement gate is pending:
// the whole table should see who was investigated and who has acknowledged.
function renderAnnounce(state) {
  document.querySelector('.announce-banner')?.remove();
  const a = state.investigationAnnounce;
  if (!a) return;
  const el = document.createElement('div');
  el.className = 'announce-banner';
  el.innerHTML = t('board.announce.investigated', {
    pres: esc(nameOfLatest(a.presidentId)),
    target: esc(nameOfLatest(a.targetId)),
  }) + `<br /><span class="small">${t('board.announce.acks', {
    acked: a.ackedIds.length,
    total: state.players.filter((p) => p.alive).length,
  })}</span>`;
  document.body.appendChild(el);
}

function renderFlash(state) {
  if (state.flash?.reshuffle) {
    const el = document.createElement('div');
    el.className = 'reshuffle-flash';
    el.textContent = t('board.flash.reshuffle');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }
}

// ------------------------------------------------------- board art + tiles

function renderBoards(state) {
  // Pick the fascist art for this player count (track + summary halves).
  // Only touch the src when it changes — reassigning reloads the image.
  // The src must stay RELATIVE (../assets/…): an absolute /assets/… breaks
  // under the GitHub Pages project sub-path (404 → invisible fascist board).
  // localizedAssetPath() maps to the TR variant while the toggle is on TR.
  const key = fascistBoardKey(state.playerCount ?? 7);
  const trackArt = $('#fasc-track-art');
  const sumArt = $('#fasc-sum-art');
  const trackSrc = localizedAssetPath(`../assets/board_fascist_${key}.png`);
  const sumSrc = localizedAssetPath(`../assets/board_fascist_summary_${key}.png`);
  if (!trackArt.src.endsWith(trackSrc.replace(/^\.\.\//, ''))) trackArt.src = trackSrc;
  if (!sumArt.src.endsWith(sumSrc.replace(/^\.\.\//, ''))) sumArt.src = sumSrc;

  renderLiberalBoard(state);
  renderFascistBoard(state);
}

function tileEl(kind) {
  const t = document.createElement('div');
  t.className = `policy-tile ${kind}`;
  return t;
}

function renderLiberalBoard(state) {
  const slots = geo().LIBERAL_SLOTS;
  const wrap = $('#liberal-tiles');
  wrap.replaceChildren(...Array.from({ length: state.liberalCount }, (_, i) => {
    const t = tileEl('liberal');
    t.style.left = `${(slots[i].cx - slots[i].w / 2) * 100}%`;
    t.style.top = `${(slots[i].cy - slots[i].h / 2) * 100}%`;
    t.style.width = `${slots[i].w * 100}%`;
    t.style.height = `${slots[i].h * 100}%`;
    return t;
  }));

  // Pile counts on the official pile art.
  $('#draw-count').textContent = state.drawCount;
  $('#discard-count').textContent = state.discardCount;

  // Election tracker markers on the printed fail circles.
  const circles = geo().TRACKER_CIRCLES;
  const tr = $('#tracker-overlay');
  tr.replaceChildren(...circles.map((c, i) => {
    const dot = document.createElement('div');
    dot.className = 'tracker-mark' + (i < state.tracker ? ' filled' : '');
    dot.style.left = `${(c.cx * 100).toFixed(2)}%`;
    dot.style.top = `${(c.cy * 100).toFixed(2)}%`;
    return dot;
  }));

  // Draw-3 QR flow: during LEGISLATIVE_PRESIDENT before the president drew.
  const holder = $('#draw-qr');
  if (state.drawTokenUrl) {
    setQrImg(holder.querySelector('img'), state.drawTokenUrl);
    holder.classList.remove('hidden');
  } else {
    holder.classList.add('hidden');
  }
}

function placeTileAt(slot, kind) {
  const t = document.createElement('div');
  t.className = `policy-tile ${kind}`;
  t.style.left = `${(slot.cx - slot.w / 2) * 100}%`;
  t.style.top = `${(slot.cy - slot.h / 2) * 100}%`;
  t.style.width = `${slot.w * 100}%`;
  t.style.height = `${slot.h * 100}%`;
  return t;
}

function renderFascistBoard(state) {
  const count = state.fascistCount;
  const track = geo().FASC_TRACK_SLOTS;
  const sum = geo().FASC_SUM_SLOTS;
  const trackWrap = $('#fasc-track-tiles');
  const sumWrap = $('#fasc-sum-tiles');
  trackWrap.replaceChildren();
  sumWrap.replaceChildren();

  // Slots 1–3 on the track half, 4–6 on the summary half.
  for (let i = 0; i < Math.min(count, 3); i++) {
    trackWrap.appendChild(placeTileAt(track[i], 'fascist'));
  }
  for (let i = 3; i < Math.min(count, 6); i++) {
    sumWrap.appendChild(placeTileAt(sum[i - 3], 'fascist'));
  }
}

function powerLabel(power) {
  return {
    investigate: t('board.power.investigate'),
    specialElection: t('board.power.specialElection'),
    policyPeek: t('board.power.policyPeek'),
    execute: t('board.power.execute'),
  }[power] ?? power;
}

// --------------------------------------------------------------- seating ring

function renderSeats(state) {
  const ring = $('#seating-ring');
  for (const old of ring.querySelectorAll('.seat')) old.remove();

  const players = state.players ?? [];
  const n = Math.max(players.length, 1);
  players.forEach((p, i) => {
    const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
    const radiusX = ring.clientWidth * 0.5 - 40;
    const radiusY = ring.clientHeight * 0.5 - 40;
    const x = ring.clientWidth / 2 + radiusX * Math.cos(angle);
    const y = ring.clientHeight / 2 + radiusY * Math.sin(angle);

    const seat = document.createElement('div');
    seat.className = 'seat' + (p.alive ? '' : ' dead');
    seat.style.left = `${x}px`;
    seat.style.top = `${y}px`;
    seat.dataset.playerId = p.id;

    const markers = document.createElement('div');
    markers.className = 'marker-row';

    if (p.isPresident) {
      const plaque = document.createElement('span');
      plaque.className = 'plaque-img president';
      plaque.title = t('board.plaque.presidentTitle');
      const img = document.createElement('img');
      img.src = '../assets/plaque_president.png';
      img.alt = t('board.plaque.presidentAlt');
      img.draggable = false;
      plaque.appendChild(img);
      plaque.draggable = true;
      plaque.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', p.id);
        e.dataTransfer.effectAllowed = 'move';
      });
      // Touch fallback: tap-and-hold then tap target.
      plaque.addEventListener('click', () => {
        if (state.phase !== 'NOMINATION') return;
        showToast(t('board.toast.plaqueHint', { name: p.name }));
        pendingPlaque = p.id;
        for (const s of ring.querySelectorAll('.seat')) s.classList.add('drop-target');
      });
      markers.appendChild(plaque);
    }

    if (p.isChancellor) markers.appendChild(plaqueImg('chancellor'));
    if (p.isNominatedChancellor) markers.appendChild(plaqueImg('nominated', t('board.seat.candidate')));
    if (state.lastPresidentId === p.id && !p.isPresident) {
      markers.appendChild(plaqueImg('term-limit', t('board.seat.termLimitP')));
    }
    if (state.lastChancellorId === p.id && !p.isChancellor) {
      markers.appendChild(plaqueImg('term-limit', t('board.seat.termLimitC')));
    }
    if (state.investigatedIds?.includes(p.id)) {
      markers.appendChild(plaqueImg('investigated', t('board.seat.investigated')));
    }

    // Vote dots during election (hidden choices); reveal chips after resolve.
    if (state.phase === 'VOTE') {
      const dot = document.createElement('span');
      dot.className = 'vote-dot';
      dot.title = state.votesReceived.includes(p.id)
        ? t('board.seat.hasVoted')
        : t('board.seat.notVoted');
      if (state.votesReceived.includes(p.id)) dot.classList.add('voted');
      markers.appendChild(dot);
    }
    const revealed = state.lastVote?.votes?.[p.id];
    if (revealed && state.lastVote && voteIsCurrent(state, p)) {
      const dot = document.createElement('span');
      dot.className = `vote-dot ${revealed}`;
      dot.title = t('board.seat.votedChoice', { choice: revealed });
      markers.appendChild(dot);
    }

    const name = document.createElement('span');
    name.className = 'seat-name';
    name.textContent = p.name;

    seat.append(markers, name);
    seat.addEventListener('dragover', (e) => {
      e.preventDefault();
      seat.classList.add('drop-target');
    });
    seat.addEventListener('dragleave', () => seat.classList.remove('drop-target'));
    seat.addEventListener('drop', (e) => {
      e.preventDefault();
      seat.classList.remove('drop-target');
      pendingPlaque = null;
      clearDropTargets();
      const from = e.dataTransfer.getData('text/plain');
      if (from && from !== p.id) emitPresident(p.id);
    });
    seat.addEventListener('click', () => {
      if (pendingPlaque && pendingPlaque !== p.id) {
        pendingPlaque = null;
        clearDropTargets();
        emitPresident(p.id);
      }
    });

    ring.appendChild(seat);
  });
}

let pendingPlaque = null;

// Official podium plaque art for president/chancellor; CSS badges for the
// transient markers (candidate / term-limited / investigated).
function plaqueImg(kind, text) {
  if (kind === 'chancellor') {
    const el = document.createElement('span');
    el.className = 'plaque-img chancellor';
    const img = document.createElement('img');
    img.src = '../assets/plaque_chancellor.png';
    img.alt = t('board.plaque.chancellorAlt');
    img.draggable = false;
    el.appendChild(img);
    return el;
  }
  const el = document.createElement('span');
  el.className = `plaque ${kind}`;
  el.textContent = text;
  return el;
}

function clearDropTargets() {
  document.querySelectorAll('.seat.drop-target').forEach((el) => el.classList.remove('drop-target'));
}

function emitPresident(targetId) {
  socket.timeout(8000).emit('board:president', targetId, (err, res) => {
    if (err || !res?.ok) showToast(errorText(res?.code, res?.message ?? t('board.toast.cannotMovePlaque')), { error: true });
    else showToast(t('board.toast.presidencyMoved', {
      name: latestState?.players.find((p) => p.id === targetId)?.name ?? targetId,
    }));
  });
}

// If the last vote belongs to the CURRENT nomination (no new votes yet), show
// its reveal; older votes are still interesting context, so keep showing them.
function voteIsCurrent(state, _p) {
  return Boolean(state.lastVote);
}

function renderVotePanel(state) {
  const panel = $('#vote-panel');
  const reveal = $('#vote-reveal');
  const tally = $('#vote-tally');
  const status = $('#vote-status');

  if (state.phase === 'VOTE') {
    panel.classList.remove('hidden');
    reveal.classList.add('hidden');
    tally.classList.add('hidden');
    status.replaceChildren(
      ...state.players.filter((p) => p.alive).map((p) => {
        const dot = document.createElement('span');
        dot.className = 'vote-dot' + (state.votesReceived.includes(p.id) ? ' ja' : '');
        dot.title = `${p.name} — ${state.votesReceived.includes(p.id) ? t('board.seat.hasVoted') : t('board.seat.thinking')}`;
        const label = document.createElement('span');
        label.textContent = p.name;
        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.gap = '0.35rem';
        wrap.style.alignItems = 'center';
        wrap.append(label, dot);
        return wrap;
      }),
    );
    return;
  }

  if (state.lastVote) {
    panel.classList.remove('hidden');
    status.replaceChildren();
    reveal.classList.remove('hidden');
    reveal.replaceChildren(
      ...state.players.filter((p) => state.lastVote.votes[p.id]).map((p) => {
        const chip = document.createElement('div');
        chip.className = `vote-chip ${state.lastVote.votes[p.id]}`;
        const nm = document.createElement('span');
        nm.textContent = p.name;
        const choice = document.createElement('span');
        choice.className = 'choice';
        choice.textContent = state.lastVote.votes[p.id];
        chip.append(nm, choice);
        return chip;
      }),
    );
    tally.classList.remove('hidden');
    tally.textContent = state.lastVote.elected
      ? t('board.vote.tallyElected', { ja: state.lastVote.ja, nein: state.lastVote.nein })
      : t('board.vote.tallyRejected', { ja: state.lastVote.ja, nein: state.lastVote.nein });
    return;
  }

  panel.classList.add('hidden');
}

function renderVeto(state) {
  const el = $('#veto-indicator');
  if (state.vetoRequested) {
    el.textContent = t('board.veto.requested');
    el.className = 'panel requested';
  } else if (state.vetoUnlocked) {
    el.textContent = t('board.veto.unlocked');
    el.className = 'panel unlocked';
  } else {
    el.textContent = t('board.veto.locked');
    el.className = 'panel';
  }
}

function renderLog(state) {
  const log = $('#event-log');
  const entries = (state.log ?? []).slice(-40).reverse();
  log.replaceChildren(...entries.map((e) => {
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.innerHTML = logText(e);
    return div;
  }));
}

function nameOf(state, id) {
  return state.players?.find((p) => p.id === id)?.name ?? id;
}

function logText(e) {
  switch (e.type) {
    case 'gameStarted': return t('board.log.gameStarted', { n: e.playerCount });
    case 'nominationStarted': return t('board.log.nominationStarted', { name: esc(nameOfLatest(e.presidentId)) });
    case 'presidentMoved': return t('board.log.presidentMoved', { name: esc(nameOfLatest(e.presidentId)) });
    case 'chancellorNominated': return t('board.log.chancellorNominated', {
      pres: esc(nameOfLatest(e.presidentId)), chanc: esc(nameOfLatest(e.chancellorId)),
    });
    case 'voteCast': return t('board.log.voteCast', { received: e.votesReceived, expected: e.votesExpected });
    case 'voteResolved': return t('board.log.voteResolved', {
      ja: e.ja, nein: e.nein,
      outcome: e.elected ? t('board.log.voteResolvedElected') : t('board.log.voteResolvedRejected'),
    });
    case 'electionFailed': return t('board.log.electionFailed', { n: e.tracker });
    case 'governmentFormed': return t('board.log.governmentFormed', {
      pres: esc(nameOfLatest(e.presidentId)), chanc: esc(nameOfLatest(e.chancellorId)),
    });
    case 'cardsDrawn': return t('board.log.cardsDrawn', { n: e.count });
    case 'presidentDiscarded': return t('board.log.presidentDiscarded');
    case 'chancellorReceived': return t('board.log.chancellorReceived');
    case 'policyEnacted': return t('board.log.policyEnacted', {
      party: e.policy === 'liberal' ? t('play.card.liberal') : t('play.card.fascist'),
      chaos: e.chaos ? t('board.log.chaosSuffix') : '',
      l: e.liberalCount, f: e.fascistCount,
    });
    case 'vetoRequested': return t('board.log.vetoRequested');
    case 'vetoAgreed': return t('board.log.vetoAgreed', { n: e.tracker });
    case 'vetoRefused': return t('board.log.vetoRefused');
    case 'powerGranted': return t('board.log.powerGranted', { power: powerLabel(e.power) });
    case 'investigated': return t('board.log.investigated', {
      pres: esc(nameOfLatest(e.presidentId)), target: esc(nameOfLatest(e.targetId)),
    });
    case 'policyPeek': return t('board.log.policyPeek', { name: esc(nameOfLatest(e.presidentId)) });
    case 'specialElection': return t('board.log.specialElection', { name: esc(nameOfLatest(e.newPresidentId)) });
    case 'executed': return t('board.log.executed', { name: esc(nameOfLatest(e.targetId)) });
    case 'reshuffled': return t('board.log.reshuffled');
    case 'chaos': return t('board.log.chaos');
    case 'gameOver': return t('board.log.gameOver', {
      winner: e.winner === 'liberal' ? t('board.log.winnerLiberal') : t('board.log.winnerFascist'),
      reason: reasonText(e.winReason),
    });
    default: return esc(e.type);
  }
}

function reasonText(reason) {
  return {
    hitlerExecuted: t('board.reason.hitlerExecuted'),
    hitlerElectedChancellor: t('board.reason.hitlerElectedChancellor'),
    liberalPoliciesEnacted: t('board.reason.liberalPoliciesEnacted'),
    fascistPoliciesEnacted: t('board.reason.fascistPoliciesEnacted'),
  }[reason] ?? reason;
}

// Log entries reference ids; resolve against the latest known state.
function nameOfLatest(id) {
  return latestState?.players?.find((p) => p.id === id)?.name ?? id;
}

function esc(text) {
  const map = { '&': 'amp;', '<': 'lt;', '>': 'gt;', '"': 'quot;', "'": '#39;' };
  return String(text).replace(/[&<>"']/g, (c) => `&${map[c]}`);
}

function renderCenter(state) {
  const key = state.phase === 'NOMINATION' && state.specialElectionActive
    ? 'board.center.NOMINATION_SPECIAL'
    : `board.center.${state.phase}`;
  $('#center-label').textContent = t(key);
  $('#center-instruction').textContent = t(`board.phase.${state.phase}.sub`);
}

function renderWin(state) {
  const splash = $('#win-splash');
  if (state.phase !== 'GAME_OVER' || !state.winner) {
    splash.classList.add('hidden');
    return;
  }
  splash.classList.remove('hidden');
  splash.className = state.winner === 'liberal' ? 'liberal' : 'fascist';
  $('#win-title').textContent = state.winner === 'liberal'
    ? t('board.win.liberals')
    : t('board.win.fascists');
  $('#win-reason').textContent = reasonText(state.winReason) ?? '';
}

// ------------------------------------------------------------------ controls

$('#btn-start').addEventListener('click', () => {
  // Online host: sync the house-rule checkbox into the session right before
  // the engine is created (LAN mode has no hostInfo — the server flag rules).
  if (hostInfo) hostInfo.session.investigateFirstPower = window.__sechitInvestFirst?.() ?? true;
  socket.timeout(8000).emit('board:start', {}, (err, res) => {
    if (err || !res?.ok) showToast(errorText(res?.code, t('board.toast.cannotStart')), { error: true });
  });
});

$('#btn-begin').addEventListener('click', () => {
  socket.timeout(8000).emit('board:beginNomination', {}, (err, res) => {
    if (err || !res?.ok) showToast(errorText(res?.code, t('board.toast.cannotBegin')), { error: true });
  });
});

$('#btn-reset').addEventListener('click', () => {
  if (!confirm(t('board.confirm.reset'))) return;
  socket.timeout(8000).emit('board:reset', {}, (err, res) => {
    if (err || !res?.ok) showToast(errorText(res?.code, t('board.toast.cannotReset')), { error: true });
  });
});

$('#btn-again').addEventListener('click', () => {
  // Optimistic dismiss: the lobby replaces the splash the instant the user
  // acts (the reset broadcast confirms within ~instant; if it somehow fails
  // the toast tells them and the state stays GAME_OVER).
  $('#win-splash').classList.add('hidden');
  socket.timeout(8000).emit('board:reset', {}, (err, res) => {
    if (err || !res?.ok) showToast(errorText(res?.code, t('board.toast.cannotReset')), { error: true });
  });
});
