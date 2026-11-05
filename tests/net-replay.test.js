// Regression: the browser host (board/?host=..., P2P mode) fires the room's
// initial 'state' event SYNCHRONOUSLY inside startHost() — before board.js
// subscribes to socket.on('state'). NetSocket must retain the payload and
// replay it to the first subscriber, or the lobby QR never renders (empty
// white box). This test reproduces the exact ordering.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser shims so shared/net.js (which touches document at import)
// loads under Node.
class FakeElement {
  constructor() { this.dataset = {}; this.handlers = {}; }
  appendChild() {}
}
globalThis.document = {
  baseURI: 'https://example.github.io/repo/board/',
  createElement: () => new FakeElement(),
  head: { appendChild() {} },
};
globalThis.window = { location: { href: 'https://example.github.io/repo/board/' } };
globalThis.location = globalThis.window.location;
globalThis.Peer = class { on() {} destroy() {} };

const { NetSocket } = await import('../shared/net.js');
const { GameSession } = await import('../server/session.js');
const { GameRoom } = await import('../server/room.js');

test('initial state fired before subscription is replayed to the first subscriber', () => {
  const socket = new NetSocket();
  const seen = [];
  // The room pushes state BEFORE any handler exists (the exact board race).
  socket.fire('state', { phase: 'LOBBY', joinUrl: 'https://x/play/?g=ABC234' });
  // ...only afterwards does board.js register its handler.
  socket.on('state', (s) => seen.push(s));
  assert.equal(seen.length, 1, 'replayed exactly once');
  assert.equal(seen[0].phase, 'LOBBY');
  assert.ok(seen[0].joinUrl.includes('ABC234'));
  // Subsequent fires deliver live to ALL subscribers (no duplicate replay).
  socket.fire('state', { phase: 'NOMINATION' });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].phase, 'NOMINATION');
  // A second subscriber does NOT get the replay again (only live events).
  const second = [];
  socket.on('state', (s) => second.push(s));
  assert.deepEqual(second, [], 'no double replay for late subscribers');
  socket.fire('state', { phase: 'VOTE' });
  assert.equal(second.length, 1);
});

test('browser-host race end-to-end: startHost-style addClient then subscribe', () => {
  // Real session + room, wired exactly like board/host.js does.
  const session = new GameSession({ gameId: 'RACE01', baseUrl: 'https://example.github.io/repo' });
  session.joinLobby('Ada');
  const room = new GameRoom({ session });
  const boardSocket = new NetSocket();
  const boardClient = {
    kind: 'board', authToken: null, data: {},
    send: (event, payload) => boardSocket.fire(event, payload),
  };
  // 1) Host adds the board client synchronously → initial state fires NOW.
  room.addClient(boardClient);
  // 2) The UI subscribes only after startHost() resolves (module top-level).
  const seen = [];
  boardSocket.on('state', (s) => seen.push(s));
  assert.equal(seen.length, 1, 'lobby state survived the subscription race');
  assert.equal(seen[0].phase, 'LOBBY');
  assert.equal(seen[0].gameId, 'RACE01');
  assert.ok(seen[0].joinUrl.endsWith('/play/?g=RACE01'), 'join URL present for the QR');
  assert.equal(seen[0].lobby.length, 1);
  // 3) Later changes (each lobby join + startGame) still broadcast live.
  session.joinLobby('Bob'); session.joinLobby('Cid');
  session.joinLobby('Dee'); session.joinLobby('Eve');
  session.startGame();
  // 1 replay + 4 join broadcasts + 1 startGame broadcast = 6 deliveries.
  assert.equal(seen.length, 6);
  assert.notEqual(seen.at(-1).phase, 'LOBBY');
  assert.ok(seen.at(-1).players, 'game view broadcast after start');
});
