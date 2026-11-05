// Browser game host (P2P / online mode).
//
// On static hosting (GitHub Pages) there is no server — the BOARD page
// becomes the authoritative host: it runs the same GameSession + GameRoom
// code the Node server runs (imported straight from server/), listens over
// PeerJS (peer id derived from the public game code), and keeps a full
// snapshot in localStorage so a reloaded/crashed board tab can resume the
// game in progress with all seats and tokens intact.
//
// Phones on the SAME WiFi connect directly over the LAN (WebRTC host
// candidates) — as fast as the old socket server; remote players traverse
// the internet.
// NOTE: exactly ONE ../ — host.js is served at <site>/board/host.js, so
// ../server/ resolves to <site>/server/ in every deployment: GitHub Pages
// project sub-paths (/repo/board/ → /repo/server/), domain roots (/board/ →
// /server/) and the LAN server (which serves server/ at /server). The
// previous ../../ climbed OUT of a project sub-path and 404'd, killing the
// whole module graph (symptom: static HTML shell with an empty white QR).
import { GameSession } from '../server/session.js';
import { GameRoom } from '../server/room.js';
import { NetSocket, peerIdForGame, generateGameCode } from '../shared/net.js';

const SNAPSHOT_PREFIX = 'sechit.host.';
const RESUMABLE_PHASES = new Set(['ROLE_REVEAL', 'NOMINATION', 'VOTE', 'GAME_OVER']);

// Site base for shareable URLs: page lives at <base>/board/, so the site
// root is one level up (works at a domain root AND a GitHub Pages sub-path).
export function siteBase() {
  const p = location.pathname.replace(/board\/?$/, '');
  return `${location.origin}${p}`.replace(/\/$/, '');
}

function snapshotKey(code) {
  return SNAPSHOT_PREFIX + code;
}

// Persistence itself lives in GameSession.snapshot()/fromSnapshot() (pure,
// unit-tested); this file only handles localStorage I/O + resume policy.
function loadSnapshot(code) {
  try {
    const raw = localStorage.getItem(snapshotKey(code));
    if (!raw) return null;
    const snap = JSON.parse(raw);
    return snap?.v === 1 ? snap : null;
  } catch {
    return null;
  }
}

function clearSnapshot(code) {
  localStorage.removeItem(snapshotKey(code));
}

// ------------------------------------------------------------------ loopback

// The board page's own "socket": a trusted local client of the room. Its
// board:* emits are handled synchronously; state broadcasts arrive as events.
class LoopbackBoardSocket extends NetSocket {
  constructor(room) {
    super();
    this.room = room;
    this._send = () => { throw new Error('loopback board socket never fire-and-forgets'); };
  }

  _call(event, payload, ack, _ms) {
    ack(this.room.handleBoard(this.clientRef, event, payload));
  }
}

// ---------------------------------------------------------------------- host

let activePeer = null;

export async function startHost() {
  if (typeof window.Peer !== 'function') {
    throw new Error('PeerJS failed to load — check public/vendor/peerjs.min.js.');
  }

  const params = new URLSearchParams(location.search);
  let code = (params.get('host') ?? '').trim().toUpperCase();

  // Fresh visit (no ?host=): any leftover snapshot for an OLD code is stale —
  // a new game gets a brand-new random code + QR, by design.
  if (!code) code = generateGameCode();

  const snap = loadSnapshot(code);
  const resumable = !!snap?.engine?.state
    && (snap.engine.state.phase === 'LOBBY' || RESUMABLE_PHASES.has(snap.engine.state.phase));

  const opts = { baseUrl: siteBase(), gameId: code };
  const session = snap
    ? GameSession.fromSnapshot(snap, opts)
    : new GameSession(opts);
  const room = new GameRoom({ session });
  const boardSocket = new LoopbackBoardSocket(room);
  const boardClient = {
    kind: 'board',
    authToken: null,
    data: {},
    send: (event, payload) => boardSocket.fire(event, payload),
  };
  boardSocket.clientRef = boardClient;

  // Persist after every state change (cheap: state is small JSON).
  session.onState = () => {
    room.broadcast();
    try {
      localStorage.setItem(snapshotKey(code), JSON.stringify(session.snapshot()));
    } catch { /* storage full/blocked — game continues unsaved */ }
  };

  // Claim the code-namespaced peer id; on the (astronomically rare) id
  // collision, regenerate the code once and rebuild.
  const peer = await new Promise((resolve, reject) => {
    let settled = false;
    const p = new Peer(peerIdForGame(code));
    const to = setTimeout(() => { if (!settled) { settled = true; reject(new Error('Signaling server unreachable.')); p.destroy(); } }, 15000);
    p.once('open', () => { if (!settled) { settled = true; clearTimeout(to); resolve(p); } });
    p.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(to);
      p.destroy();
      reject(err);
    });
  }).catch(async (err) => {
    if (err?.type === 'unavailable-id') {
      // Extremely rare: the random code is taken. New code, new snapshot key.
      clearSnapshot(code);
      const newCode = generateGameCode();
      const url = new URL(location.href);
      url.searchParams.set('host', newCode);
      history.replaceState(null, '', url);
      return startHost();
    }
    throw err;
  });
  activePeer = peer;

  // Phone connections → room clients over the req/res + ev wire protocol.
  peer.on('connection', (conn) => {
    conn.on('open', () => {
      const client = {
        kind: 'play',
        authToken: conn.metadata?.token ?? null,
        data: {},
        send: (event, payload) => {
          try { conn.send({ k: 'ev', event, payload }); } catch { /* closed */ }
        },
      };
      conn.on('data', (msg) => {
        if (!msg || typeof msg !== 'object' || msg.k !== 'req') return;
        const res = room.handlePlay(client, msg.event, msg.payload);
        try { conn.send({ k: 'res', id: msg.id, res }); } catch { /* closed */ }
      });
      conn.on('close', () => room.removeClient(client));
      conn.on('error', () => room.removeClient(client));
      room.addClient(client);
    });
  });

  // Signaling hiccups (e.g. laptop sleep) must not kill established P2P
  // connections — reconnect the broker link transparently.
  peer.on('disconnected', () => { try { peer.reconnect(); } catch { /* peer gone */ } });

  // Warn before closing the tab mid-game: the host tab IS the server.
  window.addEventListener('beforeunload', (e) => {
    if (session.inGame() && session.engine?.state?.phase !== 'GAME_OVER') {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Reflect the active code in the URL (copyable, bookmarkable, resumable).
  const url = new URL(location.href);
  if (url.searchParams.get('host') !== code) {
    url.searchParams.set('host', code);
    history.replaceState(null, '', url);
  }

  room.addClient(boardClient); // initial state push to the board UI
  return { socket: boardSocket, session, room, code, peer, resumed: !!snap };
}

export function stopHost() {
  try { activePeer?.destroy(); } catch { /* already destroyed */ }
  activePeer = null;
}
