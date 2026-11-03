import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine, EngineError, PHASE, ROLE, FASCISTS_PER_COUNT } from '../server/engine/index.js';
import {
  ids,
  makeGame,
  voteAllJa,
  voteAllNein,
  elect,
  pickChancellor,
  hitlerOf,
  roleOf,
  playerOf,
  forceDraw,
  assertThrowsCode,
} from './helpers.js';

describe('setup & role distribution', () => {
  for (let n = 5; n <= 10; n++) {
    test(`${n} players get the official role mix`, () => {
      const e = makeGame(n, 100 + n);
      const roles = e.state.players.map((p) => p.role).sort();
      assert.equal(roles.length, n);
      assert.equal(roles.filter((r) => r === ROLE.FASCIST).length, FASCISTS_PER_COUNT[n]);
      assert.equal(roles.filter((r) => r === ROLE.HITLER).length, 1);
      assert.equal(roles.filter((r) => r === ROLE.LIBERAL).length, n - FASCISTS_PER_COUNT[n] - 1);
    });
  }

  test('rejects bad player counts and duplicate ids', () => {
    assertThrowsCode('BAD_PLAYER_COUNT', () => new GameEngine({ seed: 1 }).startGame(ids(4)));
    assertThrowsCode('BAD_PLAYER_COUNT', () => new GameEngine({ seed: 1 }).startGame(ids(11)));
    assertThrowsCode('DUPLICATE_PLAYERS', () =>
      new GameEngine({ seed: 1 }).startGame(['a', 'b', 'c', 'd', 'a'])
    );
  });

  test('first president can be pinned for deterministic scenarios', () => {
    const e = new GameEngine({ seed: 3 }).startGame(ids(6), { firstPresidentId: 'p4' });
    assert.equal(e.state.presidentId, 'p4');
  });

  test('same seed → identical roles, president and deck order', () => {
    const a = makeGame(7, 99);
    const b = makeGame(7, 99);
    assert.deepEqual(
      a.state.players.map((p) => p.role),
      b.state.players.map((p) => p.role)
    );
    assert.equal(a.state.presidentId, b.state.presidentId);
    assert.deepEqual(a.state.deck.draw, b.state.deck.draw);
  });

  test('game starts in ROLE_REVEAL and moves to NOMINATION', () => {
    const e = new GameEngine({ seed: 5 }).startGame(ids(5));
    assert.equal(e.state.phase, PHASE.ROLE_REVEAL);
    e.beginNomination();
    assert.equal(e.state.phase, PHASE.NOMINATION);
  });
});

describe('role reveal knowledge', () => {
  test('5–6p: Hitler knows fascists, fascists know Hitler', () => {
    const e = makeGame(5, 1);
    const f = e.state.players.find((p) => p.role === ROLE.FASCIST);
    const h = hitlerOf(e);
    assert.deepEqual(e.privateView(f.id).teammates, { fascists: [], hitlerId: h.id });
    assert.deepEqual(e.privateView(h.id).teammates, { fascists: [f.id], hitlerId: null });
  });

  test('7–10p: fascists know Hitler, Hitler knows nobody', () => {
    const e = makeGame(7, 2);
    const fs = e.state.players.filter((p) => p.role === ROLE.FASCIST).map((p) => p.id);
    const h = hitlerOf(e);
    const fv = e.privateView(fs[0]);
    assert.equal(fv.teammates.hitlerId, h.id);
    assert.deepEqual(fv.teammates.fascists.sort(), fs.filter((id) => id !== fs[0]).sort());
    const hv = e.privateView(h.id);
    assert.deepEqual(hv.teammates.fascists, []);
    assert.equal(hv.teammates.hitlerId, null);
  });

  test('liberals learn nothing', () => {
    const e = makeGame(6, 3);
    const lib = e.state.players.find((p) => p.role === ROLE.LIBERAL);
    assert.deepEqual(e.privateView(lib.id).teammates, { fascists: [], hitlerId: null });
  });
});

describe('public vs private views', () => {
  test('public view leaks no roles, hands or secrets', () => {
    const e = makeGame(6, 4);
    elect(e, pickChancellor(e));
    e.presidentDraw();
    const json = JSON.stringify(e.publicView());
    assert.equal(json.includes('"role"'), false);
    assert.equal(json.includes('hand'), false);
    assert.equal(json.includes('lastPeek'), false);
    assert.equal(json.includes('lastInvestigation'), false);
    // board gets live counts and vote status (3 cards in the private hand)
    assert.equal(e.publicView().drawCount + e.publicView().discardCount, 14);
    assert.ok(e.publicView().votesExpected >= 5);
  });

  test('private view: own role, own hand only', () => {
    const e = makeGame(6, 5);
    elect(e, pickChancellor(e));
    e.presidentDraw();
    const pid = e.state.presidentId;
    const pv = e.privateView(pid);
    assert.ok(pv.you.role);
    assert.equal(pv.hand.length, 3);
    const other = e.livingPlayers().find((id) => id !== pid);
    assert.equal(e.privateView(other).hand, undefined);
    assertThrowsCode('UNKNOWN_PLAYER', () => e.privateView('nobody'));
  });
});

describe('elections & voting', () => {
  test('majority ja elects the government and records term limits', () => {
    const e = makeGame(7, 6);
    e.nominateChancellor('p1', 'p3');
    assert.equal(e.state.phase, PHASE.VOTE);
    assert.equal(e.publicView().votesExpected, e.livingCount());
    voteAllJa(e);
    assert.equal(e.state.chancellorId, 'p3');
    assert.equal(e.state.phase, PHASE.LEGISLATIVE_PRESIDENT);
    assert.equal(e.state.lastPresidentId, 'p1');
    assert.equal(e.state.lastChancellorId, 'p3');
  });

  test('vote tie fails and bumps the election tracker', () => {
    const e = makeGame(6, 7);
    e.nominateChancellor('p1', 'p3');
    e.castVote('p1', 'ja');
    e.castVote('p2', 'ja');
    e.castVote('p3', 'ja');
    e.castVote('p4', 'nein');
    e.castVote('p5', 'nein');
    e.castVote('p6', 'nein');
    assert.equal(e.state.lastVote.elected, false);
    assert.equal(e.state.lastVote.ja, 3);
    assert.equal(e.state.lastVote.nein, 3);
    assert.equal(e.state.tracker, 1);
    assert.equal(e.state.phase, PHASE.NOMINATION);
  });

  test('majority nein fails; double voting rejected', () => {
    const e = makeGame(7, 8);
    e.nominateChancellor('p1', 'p3');
    voteAllNein(e);
    assert.equal(e.state.tracker, 1);
    const pres2 = e.state.presidentId;
    const t = pickChancellor(e);
    e.nominateChancellor(pres2, t);
    e.castVote(t, 'ja');
    assertThrowsCode('ALREADY_VOTED', () => e.castVote(t, 'nein'));
  });

  test('every living player votes, candidates included', () => {
    const e = makeGame(5, 9);
    e.nominateChancellor('p1', 'p2');
    e.castVote('p1', 'ja');
    e.castVote('p2', 'ja'); // candidate votes
    e.castVote('p3', 'nein');
    e.castVote('p4', 'nein');
    e.castVote('p5', 'nein');
    assert.equal(e.state.lastVote.elected, false);
    assert.equal(Object.keys(e.state.lastVote.votes).length, 5);
  });

  test('bad vote values and dead voters are rejected', () => {
    const e = makeGame(5, 10);
    playerOf(e, 'p5').alive = false;
    e.nominateChancellor('p1', 'p2');
    assertThrowsCode('BAD_VOTE', () => e.castVote('p3', 'maybe'));
    assertThrowsCode('DEAD_VOTER', () => e.castVote('p5', 'ja'));
    assert.equal(e.publicView().votesExpected, 4);
    voteAllJa(e);
    assert.equal(e.state.phase, PHASE.LEGISLATIVE_PRESIDENT);
  });

  test('president cannot nominate self; dead players are ineligible', () => {
    const e = makeGame(7, 11);
    assertThrowsCode('INELIGIBLE_CHANCELLOR', () => e.nominateChancellor('p1', 'p1'));
    playerOf(e, 'p4').alive = false;
    assert.equal(e.eligibleChancellors().includes('p4'), false);
    assertThrowsCode('INELIGIBLE_CHANCELLOR', () => e.nominateChancellor('p1', 'p4'));
  });
});

describe('term limits', () => {
  // Completes the current legislative session with three forced liberals so the
  // presidency rotates and the nomination phase re-opens.
  function finishSession(e) {
    forceDraw(e, ['liberal', 'liberal', 'liberal']);
    e.presidentDraw();
    e.presidentDiscard(0);
    e.chancellorEnact(e.state.chancellorId, 0);
  }

  test('last elected president & chancellor ineligible with >5 living', () => {
    const e = makeGame(7, 12);
    elect(e, 'p2'); // government formed: lastP=p1, lastC=p2; presidency still p1
    assert.equal(e.state.lastPresidentId, 'p1');
    assert.equal(e.state.lastChancellorId, 'p2');
    finishSession(e);
    assert.equal(e.state.presidentId, 'p2'); // rotation: seat after p1
    const eligible = e.eligibleChancellors();
    assert.equal(eligible.includes('p1'), false); // last elected president
    assert.equal(eligible.includes('p2'), false); // president & last elected chancellor
    assert.equal(eligible.includes('p3'), true);
  });

  test('with ≤5 living players only the last chancellor is ineligible', () => {
    const e = makeGame(5, 13);
    elect(e, 'p2'); // lastP=p1, lastC=p2
    playerOf(e, 'p5').alive = false; // 4 living → last-president limit lifted
    finishSession(e);
    assert.equal(e.state.presidentId, 'p2');
    const eligible = e.eligibleChancellors();
    assert.deepEqual(eligible.sort(), ['p1', 'p3', 'p4']); // p1 (last president) eligible again
  });

  test('setPresidentManually: nomination only, living only, locked during special elections', () => {
    const e = makeGame(7, 14);
    e.setPresidentManually('p5');
    assert.equal(e.state.presidentId, 'p5');
    playerOf(e, 'p6').alive = false;
    assertThrowsCode('DEAD_TARGET', () => e.setPresidentManually('p6'));
    elect(e, pickChancellor(e));
    assertThrowsCode('PLAQUE_ONLY_IN_NOMINATION', () => e.setPresidentManually('p2'));
  });
});

describe('actions in wrong phases are rejected', () => {
  test('legislative actions blocked outside legislative phases', () => {
    const e = makeGame(5, 15);
    assertThrowsCode('NOT_PRESIDENT_LEGISLATIVE', () => e.presidentDraw());
    assertThrowsCode('NOT_CHANCELLOR_LEGISLATIVE', () => e.chancellorReceive());
    e.nominateChancellor('p1', 'p2');
    assertThrowsCode('NOT_NOMINATION', () => e.nominateChancellor('p1', 'p3'));
    assertThrowsCode('PLAQUE_ONLY_IN_NOMINATION', () => e.setPresidentManually('p4'));
    assertThrowsCode('NOT_PRESIDENT_LEGISLATIVE', () => e.presidentDraw());
    assertThrowsCode('NO_POWER_PENDING', () => e.investigate('p1', 'p3'));
  });
});

describe('event log & invalid-action events', () => {
  test('onEvent receives lifecycle events; invalid actions emit then throw', () => {
    const events = [];
    const e = new GameEngine({ seed: 1, onEvent: (ev) => events.push(ev) });
    e.startGame(ids(5), { firstPresidentId: 'p1' });
    e.beginNomination();
    assert.equal(events[0].type, 'gameStarted');
    assert.throws(() => e.nominateChancellor('p1', 'p1'), EngineError);
    const invalid = events.filter((ev) => ev.type === 'invalidAction');
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0].code, 'INELIGIBLE_CHANCELLOR');
    assert.ok(e.state.log.some((ev) => ev.type === 'nominationStarted'));
  });
});
