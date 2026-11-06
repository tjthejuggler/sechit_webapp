// Pre-game seating rearrangement (board drag-and-drop): the lobby order IS
// the seat order, so reorderLobby must enforce an exact permutation of the
// seated players, only pre-game, and startGame must seat players in the
// reordered arrangement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GameSession } from '../server/session.js';

function makeSession() {
  return new GameSession({ baseUrl: 'http://localhost:3000' });
}

function seat(session, n) {
  for (let i = 1; i <= n; i++) session.joinLobby(`P${i}`);
  return session.lobby.map((p) => p.id);
}

test('reorderLobby swaps lobby order (drags preserved through startGame)', () => {
  const s = makeSession();
  const [a, b, c, d, e] = seat(s, 5);
  s.reorderLobby([e, b, a, d, c]);
  assert.deepEqual(s.lobby.map((p) => p.id), [e, b, a, d, c]);

  // Seat order follows the reordered lobby: seats are assigned in array order.
  s.startGame();
  assert.deepEqual(
    s.engine.state.players.map((p) => p.seat),
    [0, 1, 2, 3, 4],
  );
  assert.equal(s.engine.state.players[0].id, e);
  assert.equal(s.engine.state.players[2].id, a);
});

test('reorderLobby rejects partial, duplicate, unknown or extra ids', () => {
  const s = makeSession();
  const [a, b, c] = seat(s, 5).slice(0, 3);
  assert.throws(() => s.reorderLobby([a, b]), (e) => e.code === 'BAD_ORDER'); // missing players
  assert.throws(() => s.reorderLobby([a, a, b, c, c]), (e) => e.code === 'BAD_ORDER'); // dupes
  assert.throws(() => s.reorderLobby([a, b, c, 'nope', 'x']), (e) => e.code === 'BAD_ORDER'); // unknown
  assert.throws(() => s.reorderLobby('not-an-array'), (e) => e.code === 'BAD_ORDER');
  // Lobby unchanged after the failed attempts.
  assert.deepEqual(s.lobby.map((p) => p.id).slice(0, 3), [a, b, c]);
});

test('reorderLobby during ROLE_REVEAL remaps engine seats', () => {
  const s = makeSession();
  const [a, b, ...rest] = seat(s, 5);
  s.startGame();
  assert.equal(s.engine.state.phase, 'ROLE_REVEAL');
  const seatOf = (id) => s.engine.state.players.find((p) => p.id === id).seat;
  const seatA = seatOf(a), seatB = seatOf(b);
  s.reorderLobby([b, a, ...rest]);
  // Lobby order swapped AND engine seats remapped to match (roles are bound
  // to player ids — pre-nomination rearranging is purely social).
  assert.equal(s.lobby[0].id, b);
  assert.equal(seatOf(b), seatA);
  assert.equal(seatOf(a), seatB);
});

test('reorderLobby is refused once nomination has begun', () => {
  const s = makeSession();
  const [a, b, ...rest] = seat(s, 5);
  s.startGame();
  s.beginNomination();
  assert.notEqual(s.engine.state.phase, 'ROLE_REVEAL');
  assert.throws(() => s.reorderLobby([b, a, ...rest]), (e) => e.code === 'GAME_IN_PROGRESS');
});

test('publicState lobby reflects the reordered arrangement', () => {
  const s = makeSession();
  const [a, b, c] = seat(s, 5).slice(0, 3);
  const rest = s.lobby.slice(3).map((p) => p.id);
  s.reorderLobby([c, a, b, ...rest]);
  const pub = s.publicState();
  assert.deepEqual(pub.lobby.map((p) => p.id), [c, a, b, ...rest]);
});
