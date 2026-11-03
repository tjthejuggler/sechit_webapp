import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../server/engine/index.js';
import { makeGame, playPolicy, enactFascists, elect, hitlerOf, forceDraw } from './helpers.js';

// Rotates (via forced liberal sessions) until Hitler is a legal chancellor
// nominee for the current president. Deterministic: sessions never grant
// powers or hit a win because only liberals are enacted.
function rotateUntilHitlerNominal(e, maxRounds = 10) {
  const h = hitlerOf(e);
  for (let i = 0; i < maxRounds; i++) {
    if (e.state.presidentId !== h.id && e.eligibleChancellors().includes(h.id)) return;
    playPolicy(e, 'liberal');
  }
  throw new Error('could not reach a Hitler-nominatable state');
}

describe('win conditions', () => {
  test('5 liberal policies enacted → liberals win', () => {
    const e = makeGame(5, 101);
    e.state.liberalCount = 4;
    playPolicy(e, 'liberal');
    assert.equal(e.state.phase, PHASE.GAME_OVER);
    assert.equal(e.state.winner, 'liberal');
    assert.equal(e.state.winReason, 'liberalPoliciesEnacted');
  });

  test('6 fascist policies enacted → fascists win', () => {
    const e = makeGame(5, 102);
    e.state.fascistCount = 5;
    playPolicy(e, 'fascist');
    assert.equal(e.state.phase, PHASE.GAME_OVER);
    assert.equal(e.state.winner, 'fascist');
    assert.equal(e.state.winReason, 'fascistPoliciesEnacted');
  });

  test('Hitler executed → liberals win instantly', () => {
    const e = makeGame(5, 103);
    enactFascists(e, 4); // execution power pending
    e.execute(e.state.presidentId, hitlerOf(e).id);
    assert.equal(e.state.phase, PHASE.GAME_OVER);
    assert.equal(e.state.winner, 'liberal');
    assert.equal(e.state.winReason, 'hitlerExecuted');
  });

  test('Hitler elected chancellor with ≥3 fascist policies → fascists win', () => {
    const e = makeGame(5, 104);
    e.state.fascistCount = 3;
    const h = hitlerOf(e);
    rotateUntilHitlerNominal(e);
    elect(e, h.id);
    assert.equal(e.state.phase, PHASE.GAME_OVER);
    assert.equal(e.state.winner, 'fascist');
    assert.equal(e.state.winReason, 'hitlerElectedChancellor');
  });

  test('Hitler elected chancellor with <3 fascist policies does NOT win', () => {
    const e = makeGame(5, 105);
    e.state.fascistCount = 2;
    const h = hitlerOf(e);
    rotateUntilHitlerNominal(e);
    elect(e, h.id);
    assert.equal(e.state.phase, PHASE.LEGISLATIVE_PRESIDENT);
    assert.equal(e.state.chancellorId, h.id);
    assert.equal(e.state.winner, null);
    // the game continues normally: Hitler's government passes a policy
    forceDraw(e, ['liberal', 'liberal', 'liberal']);
    e.presidentDraw();
    e.presidentDiscard(0);
    e.chancellorEnact(h.id, 0);
    assert.equal(e.state.phase, PHASE.NOMINATION);
  });
});
