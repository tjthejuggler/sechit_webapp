// Secret Hitler server: Express + Socket.IO on port 3000 (env PORT).
// Single global game. Board socket gets publicView broadcasts on every engine
// event; player sockets are identified by a session token (localStorage) and
// receive only their own privateView. Every action is validated by the pure
// engine; EngineError codes are forwarded to the originating client only.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketIoServer } from 'socket.io';
import QRCode from 'qrcode';
import { GameSession } from './session.js';
import { withDevLog } from './devlog.js';
import { baseUrl, detectLanIp } from './lan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
// DEV testing mode: DEV_PLAYERS=N (5–10) auto-seats N dev players (P1..PN) in
// the lobby at startup and enables GET /api/dev-players (per-seat /play URLs).
const DEV_PLAYERS = process.env.DEV_PLAYERS ?? 0;
// House rule (start.sh --invest flag): in 5–6 player games the FIRST fascist
// power becomes an investigation instead of the usual policy peek. The board
// art stays the same; only the granted power changes.
const INVESTIGATE_FIRST_POWER = /^(1|true|yes)$/i.test(process.env.INVESTIGATE_FIRST_POWER ?? '');

// --------------------------------------------------------------------- setup

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

const server = http.createServer(app);
const io = new SocketIoServer(server, { maxHttpBufferSize: 1e5 });

const session = new GameSession({
  baseUrl: baseUrl(PORT),
  onState: broadcastState,
  devPlayers: DEV_PLAYERS,
  investigateFirstPower: INVESTIGATE_FIRST_POWER,
  // Dev mode only: log every engine event (elections, votes, cards, powers,
  // win) to the terminal. Production runs pass no wrapper — nothing prints.
  ...(DEV_PLAYERS > 0 ? { engineEventWrapper: (delegate) => withDevLog(delegate, session) } : {}),
});

// --------------------------------------------------------------------- REST

// Pages
app.get('/', (_req, res) => res.redirect('/board'));
app.get('/board', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'board', 'index.html')));
app.get('/play', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'play', 'index.html')));

// LAN URL for QR generation (prefer non-internal IPv4).
app.get('/api/lan-url', (_req, res) => {
  res.json({ url: baseUrl(PORT), ip: detectLanIp(), port: PORT, gameId: session.gameId });
});

// Server-rendered QR PNGs (used by the board page; phones render their own
// transfer QR via the shared client canvas helper — same data either way).
app.get('/api/qr.png', async (req, res) => {
  const text = String(req.query.t ?? session.joinUrl()).slice(0, 512);
  try {
    const png = await QRCode.toBuffer(text, { width: 512, margin: 2, errorCorrectionLevel: 'M' });
    res.type('image/png').send(png);
  } catch {
    res.status(400).json({ error: 'BAD_QR_PAYLOAD' });
  }
});

// JSON join-URL (phones can also just open the QR-encoded URL directly).
app.get('/api/join-url', (_req, res) => res.json({ url: session.joinUrl(), gameId: session.gameId }));

// DEV testing mode only (DEV_PLAYERS=N): per-dev-player name + bound /play URL
// so one desktop browser can open one tab per dev player. Guarded: 404 unless
// dev mode is active.
app.get('/api/dev-players', (_req, res) => {
  if (!session.devPlayers) return res.status(404).json({ error: 'DEV_MODE_INACTIVE' });
  res.json({ devPlayers: session.devPlayers, players: session.devPlayerUrls() });
});

// Vendor browser bundles: jsQR for phone camera scanning. Socket.IO serves its
// own client at /socket.io/socket.io.js.
app.get('/vendor/jsQR.js', (_req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, '..', 'node_modules', 'jsqr', 'dist', 'jsQR.js'));
});

app.use(express.static(PUBLIC_DIR, { index: false, maxAge: 0 }));

// ------------------------------------------------------------------- sockets
// Namespaces: /board for the big screen, /play for phones.

const board = io.of('/board');
const play = io.of('/play');

board.on('connection', (socket) => {
  socket.emit('state', session.publicState());
  socket.on('board:start', (payload, ack = noop) => {
    const cb = typeof payload === 'function' ? payload : typeof ack === 'function' ? ack : noop;
    guarded(cb, () => session.startGame());
  });
  socket.on('board:beginNomination', (payload, ack = noop) => {
    const cb = typeof payload === 'function' ? payload : typeof ack === 'function' ? ack : noop;
    guarded(cb, () => session.beginNomination());
  });
  socket.on('board:president', (targetId, ack = noop) => {
    const cb = typeof ack === 'function' ? ack : noop;
    guarded(cb, () => session.setPresident(targetId));
  });
  socket.on('board:reset', (payload, ack = noop) => {
    const cb = typeof payload === 'function' ? payload : typeof ack === 'function' ? ack : noop;
    guarded(cb, () => session.reset());
  });
});

function playerIdForSocket(socket) {
  const token = socket.handshake.auth?.token ?? socket.handshake.query?.token ?? null;
  if (!token) return null;
  const rec = session.reattach(token);
  return rec ? rec.playerId : null;
}

play.on('connection', (socket) => {
  const existingId = playerIdForSocket(socket);
  if (existingId) {
    socket.data.playerId = existingId;
    socket.data.name = session.reattach(playerIdForSocket(socket))?.name;
  }
  socket.emit('hello', {
    reconnectedAs: existingId,
    lobbyOpen: !session.inGame(),
    joinUrl: session.joinUrl(),
    minPlayers: session.minPlayers,
    maxPlayers: session.maxPlayers,
  });
  // Immediate view: reconnecting phones must not wait for the next event.
  const initial = existingId ? session.privateState(existingId) : session.publicState();
  socket.emit('state', initial);

  // Late re-bind: a phone that kept its localStorage token but reconnected
  // without handshake auth (or joined before this socket existed) — also the
  // primary path for dev tabs (?p=<seat token>): acks with playerId+name so
  // the client can skip the join form immediately.
  socket.on('identify', ({ token } = {}, cb = noop) => {
    guarded(cb, () => {
      const rec = session.reattach(token);
      if (!rec) {
        const err = new Error('Unknown session token.');
        err.code = 'TOKEN_INVALID';
        throw err;
      }
      socket.data.token = token;
      socket.data.playerId = rec.playerId;
      socket.data.name = rec.name;
      const priv = session.privateState(rec.playerId);
      if (priv) {
        socket.emit('state', priv);
      } else if (!session.inGame()) {
        // Lobby: confirm the seat + push roster so the tab leaves the join form.
        socket.emit('state', session.publicState());
        socket.emit('lobby', {
          lobbyOpen: true,
          seated: true,
          players: session.lobby.map((p) => ({ id: p.id, name: p.name })),
        });
      }
      return { playerId: rec.playerId, name: rec.name };
    });
  });

  // Mid-game rejoin: the phone scanned the board's persistent join QR and
  // picked "which player am I?" — hand back that seat's session token and
  // re-bind this socket, then push the seat's private view immediately.
  socket.on('rejoin', ({ playerId } = {}, cb = noop) => {
    guarded(cb, () => {
      const rec = session.reclaimSeat(playerId);
      socket.data.token = rec.token;
      socket.data.playerId = rec.playerId;
      socket.data.name = rec.name;
      const priv = session.privateState(rec.playerId);
      if (priv) socket.emit('state', priv);
      return { token: rec.token, playerId: rec.playerId, name: rec.name };
    });
  });

  socket.on('join', ({ name } = {}, cb = noop) => {
    guarded(cb, () => {
      const { token, playerId, name: joined } = session.joinLobby(name);
      socket.data.token = token;
      socket.data.playerId = playerId;
      socket.data.name = joined;
      return { token, playerId, name: joined };
    });
  });

  // Every action: resolve session token -> playerId, engine validates the rest.
  socket.on('action', ({ type, ...args } = {}, cb = noop) => {
    guarded(cb, () => {
      const playerId = socket.data.playerId ?? playerIdForSocket(socket);
      if (!playerId || !session.isPlayer(playerId)) {
        const err = new Error('Not seated in this game.');
        err.code = 'NOT_A_PLAYER';
        throw err;
      }
      const fn = ACTIONS[type];
      if (!fn) {
        const err = new Error(`Unknown action "${type}".`);
        err.code = 'UNKNOWN_ACTION';
        throw err;
      }
      const result = fn(playerId, args);
      // Deliver the actor's fresh private state with the ack.
      return { result, you: session.privateState(playerId) };
    });
  });
});

const ACTIONS = {
  draw: (id, { token } = {}) => session.presidentDraw(id, token),
  discard: (id, { cardIndex } = {}) => session.discard(id, cardIndex),
  receive: (id) => session.chancellorReceive(id),
  enact: (id, { cardIndex } = {}) => session.enact(id, cardIndex),
  vote: (id, { vote } = {}) => session.vote(id, vote),
  nominate: (id, { targetId } = {}) => session.nominate(id, targetId),
  vetoRequest: (id) => session.vetoRequest(id),
  vetoRespond: (id, { consent } = {}) => session.vetoRespond(id, consent),
  // Investigation transparency ack: every living player must confirm they saw
  // who was investigated before the game continues (see session gate).
  ackInvestigation: (id) => session.ackInvestigation(id),
  // Targeted powers pick a target from the picker list on the president's
  // phone (no QR scanning): the engine validates entitlement identically.
  investigate: (id, { targetId } = {}) => session.investigate(id, targetId),
  peek: (id) => session.policyPeek(id),
  specialElection: (id, { targetId } = {}) => session.specialElection(id, targetId),
  execute: (id, { targetId } = {}) => session.execute(id, targetId),
};

function guarded(cb, fn) {
  try {
    const out = fn();
    if (typeof cb === 'function') cb({ ok: true, ...(out ?? {}) });
  } catch (err) {
    if (typeof cb === 'function') {
      cb({ ok: false, code: err.code ?? 'SERVER_ERROR', message: err.message ?? 'Server error.' });
    }
  }
}

function noop() {}

// Broadcast public state to the board and a tailored private state to every
// seated phone. Called after every state change.
function broadcastState() {
  const pub = session.publicState();
  board.emit('state', pub);
  for (const [, socket] of play.sockets) {
    const playerId = socket.data?.playerId ?? playerIdForSocket(socket);
    const priv = playerId ? session.privateState(playerId) : null;
    // Seated phones get their private view; everyone else the public one.
    socket.emit('state', priv ?? pub);
  }
  // Per-socket lobby info: each phone learns whether ITS session is still
  // valid (a board reset invalidates old tokens).
  const lobbyOpen = !session.inGame();
  for (const [, socket] of play.sockets) {
    const playerId = socket.data?.playerId ?? playerIdForSocket(socket);
    socket.emit('lobby', {
      lobbyOpen,
      seated: Boolean(playerId && session.isPlayer(playerId)),
      players: lobbyOpen ? session.lobby.map((p) => ({ id: p.id, name: p.name })) : [],
    });
  }
}

// --------------------------------------------------------------------- start

// Clear one-line failure when the port is taken (e.g. a stale instance that
// start.sh could not reclaim) instead of an unhandled-error stack trace.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] Port ${PORT} is already in use — stop the other process or run: PORT=$((PORT + 1)) ./scripts/start.sh`);
  } else {
    console.error(`[server] ${err.message ?? err}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const lan = detectLanIp();
  console.log(`Secret Hitler server:`);
  console.log(`  Board : http://localhost:${PORT}/board`);
  console.log(`  LAN   : http://${lan}:${PORT}/board`);
  console.log(`  Join  : ${session.joinUrl()}`);
  if (session.devPlayers > 0) {
    console.log(`  DEV   : ${session.devPlayers} dev players seated — GET /api/dev-players for per-player tabs`);
  }
});

export { app, server, io, session };
