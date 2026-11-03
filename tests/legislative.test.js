import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../server/engine/index.js';
import {
  makeGame,
  voteAllNein,
  elect,
  pickChancellor,
  forceDraw,
  assertConservation,
  assertThrowsCode,
  playRandomGame,
  ids,
} from './helpers.js';

describe('legislative session', () => {
  test('president draws 3, discards 1, chancellor receives 2 and enacts 1', () => {
    const e = makeGame(5, 40);
    forceDraw(e, ['fascist', 'liberal', 'liberal']); // hand becomes [liberal, liberal, fascist]
    elect(e, pickChancellor(e));
    const hand = e.presidentDraw();
    assert.equal(hand.length, 3);
    const transfer = e.presidentDiscard(2); // discard the fascist
    assert.deepEqual(transfer, ['liberal', 'liberal']);
    assert.equal(e.state.chancellorHand.length, 2);
    e.chancellorReceive();
    const enacted = e.chancellorEnact(e.state.chancellorId, 0);
    assert.equal(enacted, 'liberal');
    assert.equal(e.state.liberalCount, 1);
    assert.equal(e.state.fascistCount, 0);
    assert.equal(e.state.phase, PHASE.NOMINATION);
    assertConservation(e, 'tile conservation (3 tiles force-drawn)', 20);
  });

  test('auto-reshuffle when draw pile < 3; piles stay consistent', () => {
    const e = makeGame(5, 41);
    const d = e.state.deck;
    while (d.draw.length > 2) d.discard.push(d.draw.pop()); // 2 draw / 15 discard
    elect(e, pickChancellor(e));
    e.presidentDraw();
    assert.ok(e.state.log.some((ev) => ev.type === 'reshuffled'), 'reshuffle logged');
    assert.equal(d.discard.length, 0); // discard was folded into the draw pile
    assert.equal(e.state.hand.length, 3);
    assert.equal(d.draw.length + d.discard.length + e.state.hand.length, 17);
    e.presidentDiscard(0);
    e.chancellorEnact(e.state.chancellorId, 0);
    assertConservation(e);
  });

  test('card index validation on discard and enact', () => {
    const e = makeGame(5, 42);
    forceDraw(e, ['fascist', 'fascist', 'liberal']); // hand [liberal, fascist, fascist]
    elect(e, pickChancellor(e));
    e.presidentDraw();
    assertThrowsCode('BAD_CARD_INDEX', () => e.presidentDiscard(3));
    assertThrowsCode('BAD_CARD_INDEX', () => e.presidentDiscard(-1));
    e.presidentDiscard(0); // liberal gone; chancellor holds two fascists
    assertThrowsCode('BAD_CARD_INDEX', () => e.chancellorEnact(e.state.chancellorId, 2));
  });

  test('actor validation: only the chancellor enacts, only the president responds to vetoes', () => {
    const e = makeGame(7, 43);
    forceDraw(e, ['fascist', 'fascist', 'liberal']);
    elect(e, pickChancellor(e));
    e.presidentDraw();
    e.presidentDiscard(0);
    const c = e.state.chancellorId;
    assertThrowsCode('NOT_CHANCELLOR', () => e.chancellorEnact('p1', 0));
    assertThrowsCode('NOT_CHANCELLOR', () => e.vetoRequest('p1'));
    assertThrowsCode('NOT_PRESIDENT', () => e.vetoRespond(c, true));
  });
});

describe('veto', () => {
  function session(e, topThree) {
    forceDraw(e, topThree);
    elect(e, pickChancellor(e));
    e.presidentDraw();
    e.presidentDiscard(0);
    return e.state.chancellorId;
  }

  test('veto locked before 5 fascist policies', () => {
    const e = makeGame(7, 44);
    const c = session(e, ['fascist', 'fascist', 'liberal']);
    assert.equal(e.vetoUnlocked(), false);
    assertThrowsCode('VETO_LOCKED', () => e.vetoRequest(c));
  });

  test('refused veto → chancellor must enact', () => {
    const e = makeGame(7, 45);
    e.state.fascistCount = 5; // unlock veto (enacting here would end the game)
    const c = session(e, ['liberal', 'fascist', 'fascist']); // chancellor hand [fascist, liberal]
    e.vetoRequest(c);
    assert.equal(e.state.vetoRequested, true);
    assertThrowsCode('VETO_ALREADY_REQUESTED', () => e.vetoRequest(c));
    assert.equal(e.vetoRespond('p1', false), false);
    assert.equal(e.state.vetoRequested, false);
    const enacted = e.chancellorEnact(c, 1); // must enact the liberal
    assert.equal(enacted, 'liberal');
    assert.equal(e.state.liberalCount, 1);
    assert.ok(e.state.log.some((ev) => ev.type === 'vetoRefused'));
  });

  test('consented veto → all 3 discarded, tracker +1, presidency passes', () => {
    const e = makeGame(7, 46);
    e.state.fascistCount = 5;
    const c = session(e, ['fascist', 'fascist', 'liberal']);
    const discardBefore = e.state.deck.discard.length;
    e.vetoRequest(c);
    assert.equal(e.vetoRespond('p1', true), true);
    assert.equal(e.state.chancellorHand.length, 0);
    assert.equal(e.state.deck.discard.length, discardBefore + 2);
    assert.equal(e.state.tracker, 1);
    assert.equal(e.state.phase, PHASE.NOMINATION);
    assert.equal(e.state.presidentId, e.seatAfter('p1'));
    assert.ok(e.state.log.some((ev) => ev.type === 'vetoAgreed'));
  });

  test('consent at tracker 2 → chaos enactment', () => {
    const e = makeGame(7, 47);
    e.state.fascistCount = 5;
    forceDraw(e, ['liberal']); // the chaos tile, sits under the session cards
    for (let i = 0; i < 2; i++) {
      e.nominateChancellor(e.state.presidentId, pickChancellor(e));
      voteAllNein(e);
    }
    assert.equal(e.state.tracker, 2);
    const c = session(e, ['fascist', 'fascist', 'liberal']);
    e.vetoRequest(c);
    e.vetoRespond(e.state.presidentId, true);
    assert.equal(e.state.tracker, 0);
    assert.ok(e.state.log.some((ev) => ev.type === 'chaos'));
    assert.equal(e.state.phase, PHASE.NOMINATION);
  });

  test('responding without request rejected; enactment blocked while veto pending', () => {
    const e = makeGame(7, 48);
    e.state.fascistCount = 5;
    const c = session(e, ['fascist', 'fascist', 'liberal']);
    assertThrowsCode('NO_VETO_PENDING', () => e.vetoRespond('p1', true));
    e.vetoRequest(c);
    assertThrowsCode('VETO_PENDING', () => e.chancellorEnact(c, 0));
  });
});

describe('chaos election (tracker at 3)', () => {
  test('top policy enacted, power ignored, tracker AND term limits reset', () => {
    const e = makeGame(7, 49);
    e.state.fascistCount = 2; // the chaos tile is the 3rd fascist → slot-3 power must be ignored
    forceDraw(e, ['fascist']);
    for (let i = 0; i < 2; i++) {
      e.nominateChancellor(e.state.presidentId, pickChancellor(e));
      voteAllNein(e);
    }
    assert.equal(e.state.tracker, 2);
    e.nominateChancellor(e.state.presidentId, pickChancellor(e));
    voteAllNein(e);
    assert.equal(e.state.fascistCount, 3);
    assert.equal(e.state.pendingPower, null, 'chaos ignores board powers');
    assert.equal(e.state.tracker, 0);
    assert.equal(e.state.lastPresidentId, null);
    assert.equal(e.state.lastChancellorId, null);
    assert.equal(e.state.chancellorId, null);
    assert.equal(e.state.phase, PHASE.NOMINATION);
    assert.ok(e.state.log.some((ev) => ev.type === 'chaos'));
    // term-limit reset: previous officers are eligible again
    assert.ok(e.eligibleChancellors().length >= e.livingCount() - 1);
  });
});

describe('random full games (seeded, all player counts)', () => {
  for (let n = 5; n <= 10; n++) {
    for (const seed of [1, 2, 3]) {
      test(`n=${n} seed=${seed} terminates via a legal win with intact invariants`, () => {
        const e = playRandomGame(seed, n);
        assert.equal(e.state.phase, PHASE.GAME_OVER);
        assert.ok(['liberal', 'fascist'].includes(e.state.winner));
        assert.ok(
          ['liberalPoliciesEnacted', 'fascistPoliciesEnacted', 'hitlerExecuted', 'hitlerElectedChancellor'].includes(
            e.state.winReason
          )
        );
        if (e.state.winReason === 'liberalPoliciesEnacted') assert.ok(e.state.liberalCount >= 5);
        if (e.state.winReason === 'fascistPoliciesEnacted') assert.ok(e.state.fascistCount >= 6);
        if (e.state.winReason === 'hitlerExecuted') assert.equal(hitlerAlive(e), false);
        if (e.state.winReason === 'hitlerElectedChancellor') assert.ok(e.state.fascistCount >= 3);
        // deck counts always add up
        const s = e.state;
        assert.equal(s.deck.draw.length + s.deck.discard.length + s.liberalCount + s.fascistCount, 17);
      });
    }
  }
});

function hitlerAlive(e) {
  return e.state.players.find((p) => p.role === 'hitler').alive;
}
