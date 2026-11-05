// Unified client transport: Socket.IO (Node server / LAN mode) or PeerJS
// (static hosting / online P2P mode) behind ONE socket-like API that the
// existing board/play pages already speak:
//
//   socket.on(event, cb)                     — server-pushed events
//   socket.emit(event, payload)              — fire-and-forget
//   socket.timeout(ms).emit(event, p, ack)   — request/response (ack style)
//
// Mode detection: the Node server serves the Socket.IO client at
// /socket.io/socket.io.js; static hosts (GitHub Pages) do not. We probe that
// path once per page load — a 404 means P2P mode.
//
// P2P wire protocol over a PeerJS DataConnection:
//   { k: 'req', id, event, payload }  →  { k: 'res', id, res }
//   { k: 'ev',  event, payload }      →  server-pushed event

const IO_PROBE = new URL('../socket.io/socket.io.js', document.baseURI).href;

let modePromise = null;
export const MODE = { LAN: 'lan', P2P: 'p2p' };

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(el);
  });
}

export function detectMode() {
  modePromise ??= loadScript(IO_PROBE)
    .then(() => MODE.LAN)
    .catch(() => MODE.P2P);
  return modePromise;
}

// ------------------------------------------------------------------ sockets

// Minimal event socket both transports are normalized into.
//
// Replay semantics: server-push events in REPLAY_EVENTS ('state', 'hello')
// are "latest value" events — a room may legitimately emit the initial state
// BEFORE the UI subscribes (the browser host adds its loopback board client
// synchronously inside startHost(), long before board.js reaches its
// socket.on('state') line — the LAN/Socket.IO path never hit this because
// its events always arrive asynchronously). NetSocket keeps the most recent
// payload per replayable event and delivers it to the FIRST subscriber
// immediately, so no initial state is ever lost to subscription timing.
const REPLAY_EVENTS = new Set(['state', 'hello']);

export class NetSocket {
  constructor() {
    this.handlers = new Map();
    this.latest = new Map(); // replayable event -> last payload
    this.replayed = new Set(); // events already replayed to a subscriber
    this._nextId = 1;
    this._pending = new Map(); // req id -> {resolve, reject, timer}
    this.defaultTimeoutMs = 8000;
  }

  on(event, cb) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    const subs = this.handlers.get(event);
    subs.push(cb);
    // First subscriber to a replayable event gets the retained payload.
    if (REPLAY_EVENTS.has(event) && this.latest.has(event) && !this.replayed.has(event)) {
      this.replayed.add(event);
      cb(this.latest.get(event));
    }
    return this;
  }

  fire(event, payload) {
    if (REPLAY_EVENTS.has(event)) this.latest.set(event, payload);
    for (const cb of this.handlers.get(event) ?? []) cb(payload);
  }

  // Send side. Subclasses implement _send(msg) / _call(event, payload).
  emit(event, payload, ack) {
    if (typeof ack === 'function') this._call(event, payload, ack);
    else this._send({ k: 'ev', event, payload });
    return this;
  }

  // Compatibility with the socket.io call shape used across the clients.
  timeout(ms) {
    const self = this;
    return {
      emit(event, payload, ack) {
        if (typeof ack === 'function') self._call(event, payload, ack, ms);
        else self._send({ k: 'ev', event, payload });
      },
    };
  }

  // Resolve an incoming response to a prior request.
  _resolve(id, res) {
    const p = this._pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this._pending.delete(id);
    p.resolve(res);
  }

  _rejectAll(code, message) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject({ code, message });
    }
    this._pending.clear();
  }

  close() {}
}

// ---------------------------------------------------------------- LAN mode

class LanSocket extends NetSocket {
  constructor(ioSocket) {
    super();
    this.io = ioSocket;
    ioSocket.onAny((event, ...args) => this.fire(event, ...args));
    ioSocket.on('disconnect', () => this._rejectAll('DISCONNECTED', 'Connection lost.'));
    // Forward ack-style requests through the real socket.io ack mechanism.
    this._send = (msg) => ioSocket.emit(msg.event, msg.payload);
  }

  _call(event, payload, ack, ms = this.defaultTimeoutMs) {
    this.io.timeout(ms).emit(event, payload, (err, res) => {
      if (err) return ack({ ok: false, code: 'TIMEOUT', message: 'Server did not respond.' });
      ack(res ?? { ok: false, code: 'SERVER_ERROR', message: 'Action failed.' });
    });
  }
}

export async function connectBoardLan() {
  await detectMode();
  return new LanSocket(window.io('/board', { auth: { client: 'board' } }));
}

// Inert stand-in used when no connection could be established at all (e.g.
// static page opened without ?g=, or the host vanished): UI code keeps its
// socket-shaped object; every action acks with a friendly error.
export function deadSocket(message = 'Not connected.') {
  return {
    on() {},
    emit() {},
    timeout() {
      return { emit(_e, _p, cb) { if (typeof cb === 'function') cb({ ok: false, code: 'NO_CONNECTION', message }); } };
    },
    fire() {},
  };
}

export async function connectPlayLan({ token = null } = {}) {
  await detectMode();
  return new LanSocket(window.io('/play', { auth: { token, client: 'play' } }));
}

// Mode-dispatching phone connection used by public/shared/shared.js:
// LAN server → Socket.IO; static site → PeerJS (?g=<code> required).
export async function connectPlay(opts = {}) {
  const m = await detectMode();
  return m === MODE.LAN ? connectPlayLan(opts) : connectPlayP2P(opts);
}

// ----------------------------------------------------------------- P2P mode

// Game code -> PeerJS peer id. Namespaced + versioned so this app's hosts
// never collide with other PeerJS users on the public broker.
export const PEER_NS = 'sechit-webapp-v1-';
export function peerIdForGame(code) {
  return PEER_NS + String(code ?? '').trim().toLowerCase();
}

// Random game code: Crockford-ish base32 (no 0/O/1/I) — easy to read aloud,
// easy to type, 32^6 ≈ 1e9 combinations.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function generateGameCode(len = 6) {
  const c = globalThis.crypto;
  let out = '';
  for (let i = 0; i < len; i++) {
    const n = c ? c.getRandomValues(new Uint32Array(1))[0] % CODE_ALPHABET.length
      : Math.floor(Math.random() * CODE_ALPHABET.length);
    out += CODE_ALPHABET[n];
  }
  return out;
}

class PeerSocket extends NetSocket {
  constructor(peer, conn) {
    super();
    this.peer = peer;
    this.conn = conn;
    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.k === 'res') this._resolve(msg.id, msg.res);
      else if (msg.k === 'ev') this.fire(msg.event, msg.payload);
    });
    conn.on('close', () => {
      this.fire('disconnect');
      this._rejectAll('DISCONNECTED', 'Connection to the host was lost.');
    });
    conn.on('error', (err) => {
      this.fire('connect_error', err);
      this._rejectAll('CONNECTION_ERROR', err?.message ?? 'Connection error.');
    });
    peer.on('error', (err) => {
      if (err?.type === 'peer-unavailable') {
        this.fire('connect_error', { code: 'GAME_NOT_FOUND', message: 'No game with that code is online.' });
        this._rejectAll('GAME_NOT_FOUND', 'No game with that code is online.');
      }
    });
    this._send = (msg) => conn.send(msg);
  }

  _call(event, payload, ack, ms = this.defaultTimeoutMs) {
    const id = this._nextId++;
    const timer = setTimeout(() => {
      this._pending.delete(id);
      ack({ ok: false, code: 'TIMEOUT', message: 'Host did not respond.' });
    }, ms);
    this._pending.set(id, { resolve: (res) => ack(res), timer });
    this.conn.send({ k: 'req', id, event, payload });
  }

  close() {
    try { this.conn.close(); } catch { /* already closed */ }
    try { this.peer.destroy(); } catch { /* already destroyed */ }
  }
}

// Phone → host connection. Requires ?g=<code> in the page URL.
export async function connectPlayP2P({ token = null } = {}) {
  await detectMode();
  if (typeof window.Peer !== 'function') {
    throw new Error('PeerJS failed to load — check the vendor bundle.');
  }
  const params = new URLSearchParams(location.search);
  const code = (params.get('g') ?? '').trim().toUpperCase();
  if (!code) {
    const err = new Error('Missing game code (?g=).');
    err.code = 'NO_GAME_CODE';
    throw err;
  }
  const peer = new Peer();
  await new Promise((resolve, reject) => {
    peer.once('open', resolve);
    peer.once('error', reject);
  });
  const conn = peer.connect(peerIdForGame(code), { metadata: { token }, reliable: true });
  const socket = new PeerSocket(peer, conn);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Timed out reaching the game host.')), 15000);
    conn.once('open', () => { clearTimeout(t); resolve(); });
    peer.once('error', (err) => { clearTimeout(t); reject(err); });
  });
  socket.gameCode = code;
  return socket;
}
