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
import { GameRoom } from './room.js';
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
// Distinguish /play from /play/ — the no-slash form must redirect so the
// pages' RELATIVE asset references resolve correctly.
app.set('strict routing', true);
app.use(express.json({ limit: '16kb' }));

const server = http.createServer(app);
const io = new SocketIoServer(server, { maxHttpBufferSize: 1e5 });

const session = new GameSession({
  baseUrl: baseUrl(PORT),
  devPlayers: DEV_PLAYERS,
  investigateFirstPower: INVESTIGATE_FIRST_POWER,
  // Dev mode only: log every engine event (elections, votes, cards, powers,
  // win) to the terminal. Production runs pass no wrapper — nothing prints.
  ...(DEV_PLAYERS > 0 ? { engineEventWrapper: (delegate) => withDevLog(delegate, session) } : {}),
});
const room = new GameRoom({ session });

// --------------------------------------------------------------------- REST

// Pages. Trailing-slash redirects keep the pages' RELATIVE asset references
// (../assets/…, board.css, …) correct under both the local server and static
// hosting sub-paths (GitHub Pages project sites).
app.get('/', (_req, res) => res.redirect('/board/'));
app.get('/board', (_req, res) => res.redirect('/board/'));
app.get('/board/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'board', 'index.html')));
app.get('/play', (_req, res) => res.redirect('/play/'));
app.get('/play/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'play', 'index.html')));
// Join-by-code landing page (online mode's start/join screen; harmless here).
app.get('/join', (_req, res) => res.redirect('/join/'));
app.get('/join/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'join', 'index.html')));

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

// The board page's online host imports the isomorphic engine/session/room
// modules directly from server/ (public/board/host.js → ../../server/*), so
// those sources must be servable in the browser here too.
app.use('/server', express.static(path.join(__dirname), { index: false, maxAge: 0 }));

// Static public/ first — includes public/vendor when `npm run build:vendor`
// has run (start.sh and the Pages workflow both do).
app.use(express.static(PUBLIC_DIR, { index: false, maxAge: 0 }));

// Fallbacks for the vendor bundles when public/vendor was not built yet:
// serve the pure dist files straight from node_modules where possible.
const VENDOR_MAP = {
  'peerjs.min.js': ['peerjs', 'dist', 'peerjs.min.js'],
  'jsQR.js': ['jsqr', 'dist', 'jsQR.js'],
};
for (const [name, rel] of Object.entries(VENDOR_MAP)) {
  app.get(`/vendor/${name}`, (_req, res) => {
    res.type('application/javascript')
      .sendFile(path.join(__dirname, '..', 'node_modules', ...rel));
  });
}
app.get('/vendor/qrcode.min.js', (_req, res) => {
  res.status(500).type('text/plain')
    .send('Missing public/vendor/qrcode.min.js — run: npm run build:vendor');
});

// ------------------------------------------------------------------- sockets
// Namespaces: /board for the big screen, /play for phones. Both just adapt
// Socket.IO connections onto the shared, transport-agnostic GameRoom
// (server/room.js) — the same room implementation the browser host runs.

function socketToClient(kind, socket) {
  const client = {
    kind,
    authToken: socket.handshake.auth?.token ?? socket.handshake.query?.token ?? null,
    data: socket.data,
    send: (event, payload) => socket.emit(event, payload),
  };
  socket.on('disconnect', () => room.removeClient(client));
  return client;
}

io.of('/board').on('connection', (socket) => {
  const client = socketToClient('board', socket);
  room.addClient(client);
  const forward = (event) => socket.on(event, (payload, ack = noop) => {
    const cb = typeof payload === 'function' ? payload : typeof ack === 'function' ? ack : noop;
    const res = room.handleBoard(client, event, payload);
    if (typeof cb === 'function') cb(res);
  });
  forward('board:start');
  forward('board:beginNomination');
  forward('board:reorder');
  forward('board:president');
  forward('board:reset');
});

io.of('/play').on('connection', (socket) => {
  const client = socketToClient('play', socket);
  room.addClient(client);
  const forward = (event) => socket.on(event, (payload, cb = noop) => {
    if (typeof cb !== 'function') cb = noop;
    cb(room.handlePlay(client, event, payload));
  });
  forward('identify');
  forward('rejoin');
  forward('join');
  forward('action');
});

function noop() {}

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
