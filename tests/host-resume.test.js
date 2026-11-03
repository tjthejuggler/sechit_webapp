// Browser-host resume: GameSession.snapshot() → JSON → fromSnapshot() must
// roundtrip every piece of state needed to continue the exact same game —
// including the engine's Map/Set fields (votes, investigatedIds) that JSON
// serializes as {} if not converted explicitly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameSession } from '../server/session.js';

function makeSession(n = 5, gameId = 'RESUME1') {
  const s = new GameSession({ gameId });
  const joined = [];
  for (let i = 0; i < n; i++) joined.push(s.joinLobby(`P${i + 1}`));
  s.startGame();
  return { s, joined };
}

function roundtrip(s) {
  return GameSession.fromSnapshot(JSON.parse(JSON.stringify(s.snapshot())));
}

test('snapshot is plain-JSON serializable at every stage', () => {
  const { s } = makeSession(5);
  s.beginNomination();
  const state = s.engine.state;
  const chancellor = s.engine.eligibleChancellors().find((id) => id !== state.presidentId);
  s.nominate(state.presidentId, chancellor);
  // A partially cast vote exercises the votes Map.
  s.vote(state.presidentId, 'ja');
  s.vote(state.players.find((p) => p.id !== state.presidentId).id, 'nein');
  assert.doesNotThrow(() => JSON.stringify(s.snapshot()));
});

test('lobby-phase snapshot restores seats and tokens', () => {
  const s = new GameSession({ gameId: 'RESUME2' });
  const a = s.joinLobby('Ada');
  const b = s.joinLobby('Bob');
  const r = roundtrip(s);
  assert.equal(r.gameId, 'RESUME2');
  assert.deepEqual(r.lobby.map((p) => p.name), ['Ada', 'Bob']);
  assert.ok(r.reattach(a.token), 'token reattaches after restore');
  assert.equal(r.reattach(b.token).playerId, b.playerId);
  assert.equal(r.engine, null);
  // Game can start from the restored session.
  r.joinLobby('Cid');
  r.joinLobby('Dee');
  r.joinLobby('Eve');
  r.startGame();
  assert.ok(r.engine);
});

test('mid-game snapshot restores public state exactly', () => {
  const { s } = makeSession(5, 'RESUME3');
  s.beginNomination();
  const st = s.engine.state;
  const chancellor = s.engine.eligibleChancellors().find((id) => id !== st.presidentId);
  s.nominate(st.presidentId, chancellor);
  const r = roundtrip(s);
  // Public board view identical (roles, boards, tracker, phase, chancellor).
  assert.deepEqual(r.engine.publicView(), s.engine.publicView());
});

test('mid-vote snapshot preserves the votes Map and continues the game', () => {
  const { s } = makeSession(5, 'RESUME4');
  s.beginNomination();
  const st = s.engine.state;
  const chancellor = s.engine.eligibleChancellors().find((id) => id !== st.presidentId);
  s.nominate(st.presidentId, chancellor);
  const voters = [st.players[0], st.players[1]];
  s.vote(voters[0].id, 'ja');
  s.vote(voters[1].id, 'ja');

  const snap = JSON.parse(JSON.stringify(s.snapshot()));
  const r = GameSession.fromSnapshot(snap);

  // votes survived as a real Map with the cast ballots.
  assert.ok(r.engine.state.votes instanceof Map, 'votes is a Map');
  assert.equal(r.engine.state.votes.size, 2);
  assert.equal(r.engine.state.votes.get(voters[0].id), 'ja');
  assert.equal(r.engine.state.votes.get(voters[1].id), 'ja');
  assert.ok(Array.isArray(snap.engine.state.votes), 'wire format votes is an array');
  // investigatedIds survived as a real (empty) Set.
  assert.ok(r.engine.state.investigatedIds instanceof Set, 'investigatedIds is a Set');

  // Remaining voters can finish the election on the restored session.
  for (const p of r.engine.state.players) {
    if (!r.engine.state.votes.has(p.id)) r.vote(p.id, 'ja');
  }
  assert.equal(r.engine.state.chancellorId, chancellor, 'government elected after resume');
  // And legislation proceeds: the president draws.
  r.presidentDraw(r.engine.state.presidentId);
  assert.ok(r.engine.state.hand || r.transferPending !== undefined);
});

test('deck contents survive exactly (policy tile conservation)', () => {
  const { s } = makeSession(5, 'RESUME5');
  s.beginNomination();
  const st = s.engine.state;
  const chancellor = s.engine.eligibleChancellors().find((id) => id !== st.presidentId);
  s.nominate(st.presidentId, chancellor);
  for (const p of st.players) s.vote(p.id, 'ja');
  s.presidentDraw(st.presidentId);
  s.discard(st.presidentId, 0);
  s.chancellorReceive(st.chancellorId);
  s.enact(st.chancellorId, 0);

  const r = roundtrip(s);
  const a = s.engine.state.deck;
  const b = r.engine.state.deck;
  assert.deepEqual(b.draw, a.draw);
  assert.deepEqual(b.discard, a.discard);
  const enacted = s.engine.state.liberalCount + s.engine.state.fascistCount;
  assert.equal(b.draw.length + b.discard.length + enacted, 17, 'conservation after resume');
});

test('session tokens and reattach work after restore', () => {
  const { s, joined } = makeSession(5, 'RESUME6');
  s.beginNomination();
  const r = roundtrip(s);
  for (const j of joined) {
    const rec = r.reattach(j.token);
    assert.ok(rec, `token for ${j.name} reattaches`);
    assert.equal(rec.playerId, j.playerId);
    assert.equal(rec.name, j.name);
  }
  // reclaimSeat also works (mid-game rejoin picker).
  const reclaimed = r.reclaimSeat(joined[2].playerId);
  assert.equal(reclaimed.token, joined[2].token);
});
