import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE, POWERS_BY_PLAYER_COUNT, powerForCount } from '../server/engine/index.js';
import {
  makeGame,
  enactFascists,
  hitlerOf,
  roleOf,
  playerOf,
  forceDraw,
  assertThrowsCode,
  playPolicy,
  resolvePower,
} from './helpers.js';

// The current president for a pending power; investigations/peek/execution
// scenarios below never assume it differs from Hitler.
describe('fascist board powers per player count', () => {
  test('official power table', () => {
    const expected = {
      5: [null, null, 'policyPeek', 'execute', 'execute'],
      6: [null, null, 'policyPeek', 'execute', 'execute'],
      7: [null, 'investigate', 'specialElection', 'execute', 'execute'],
      8: [null, 'investigate', 'specialElection', 'execute', 'execute'],
      9: ['investigate', 'investigate', 'specialElection', 'execute', 'execute'],
      10: ['investigate', 'investigate', 'specialElection', 'execute', 'execute'],
    };
    for (const [n, slots] of Object.entries(expected)) {
      for (let k = 1; k <= 5; k++) {
        assert.equal(powerForCount(Number(n), k), slots[k - 1], `${n}p, slot ${k}`);
      }
    }
    assert.deepEqual(POWERS_BY_PLAYER_COUNT, {
      5: { 3: 'policyPeek', 4: 'execute', 5: 'execute' },
      6: { 3: 'policyPeek', 4: 'execute', 5: 'execute' },
      7: { 2: 'investigate', 3: 'specialElection', 4: 'execute', 5: 'execute' },
      8: { 2: 'investigate', 3: 'specialElection', 4: 'execute', 5: 'execute' },
      9: { 1: 'investigate', 2: 'investigate', 3: 'specialElection', 4: 'execute', 5: 'execute' },
      10: { 1: 'investigate', 2: 'investigate', 3: 'specialElection', 4: 'execute', 5: 'execute' },
    });
  });

  const cases = [
    [5, [null, null, 'policyPeek', 'execute', 'execute']],
    [7, [null, 'investigate', 'specialElection', 'execute', 'execute']],
    [9, ['investigate', 'investigate', 'specialElection', 'execute', 'execute']],
  ];
  for (const [n, expectedPowers] of cases) {
    test(`${n}-player game grants powers at the correct slots`, () => {
      const e = makeGame(n, 50 + n);
      for (let k = 1; k <= 5; k++) {
        enactFascists(e, 1);
        assert.equal(e.state.fascistCount, k);
        assert.equal(e.state.pendingPower, expectedPowers[k - 1], `slot ${k}`);
      }
      assert.notEqual(e.state.phase, PHASE.GAME_OVER); // 5th fascist is a power, not a win
    });
  }
});

// House rule (--invest / INVESTIGATE_FIRST_POWER=1): in 5–6 player games the
// first fascist power slot grants INVESTIGATE instead of POLICY_PEEK; later
// slots (execution) and other player counts are untouched.
describe('investigateFirstPower house rule', () => {
  test('5–6p: slot 3 grants investigate instead of policy peek; slot 4/5 still execute', () => {
    for (const n of [5, 6]) {
      const e = makeGame(n, 50 + n, {}, { investigateFirstPower: true });
      for (const [k, expected] of [[3, 'investigate'], [4, 'execute'], [5, 'execute']]) {
        while (e.state.fascistCount < k) playPolicy(e, 'fascist');
        assert.equal(e.state.pendingPower, expected, `${n}p slot ${k}`);
        resolvePower(e);
      }
    }
  });

  test('without the flag everything stays normal', () => {
    const e = makeGame(5, 55);
    while (e.state.fascistCount < 3) playPolicy(e, 'fascist');
    assert.equal(e.state.pendingPower, 'policyPeek');
  });
});

describe('investigate loyalty', () => {
  test('reveals party membership only (Hitler reads as fascist), never twice', () => {
    const e = makeGame(7, 60);
    enactFascists(e, 2); // 7p slot 2 = investigate
    assert.equal(e.state.pendingPower, 'investigate');
    const p = e.state.presidentId;
    const h = hitlerOf(e);
    if (h.id === p) throw new Error('seed assumption broken: Hitler is president'); // guard, tests re-seeded below
    const res = e.investigate(p, h.id);
    assert.equal(res.party, 'fascist', 'Hitler investigates as fascist party');
    assert.equal('role' in res, false, 'role is never revealed');
    assert.equal(res.targetId, h.id);
    assert.equal(e.state.phase, PHASE.NOMINATION); // power consumed → next nomination
    // failed action consumes nothing: force the power back and retry
    e.state.pendingPower = 'investigate';
    e.state.phase = PHASE.EXEC_ACTION;
    e.state.presidentId = p; // restore presidency rotated away by the first action
    assertThrowsCode('ALREADY_INVESTIGATED', () => e.investigate(p, h.id));
    assert.equal(e.state.pendingPower, 'investigate');
    assert.equal(e.state.phase, PHASE.EXEC_ACTION);
  });

  test('result is private to the investigating president; listed as investigated', () => {
    const e = makeGame(7, 61);
    enactFascists(e, 2);
    const p = e.state.presidentId;
    const lib = e.livingPlayers().find((id) => roleOf(e, id) === 'liberal' && id !== p);
    e.investigate(p, lib);
    assert.equal(e.privateView(p).lastInvestigation.party, 'liberal');
    const other = e.livingPlayers().find((id) => id !== p);
    assert.equal(e.privateView(other).lastInvestigation, undefined);
    assert.equal('lastInvestigation' in e.publicView(), false);
    assert.ok(e.publicView().investigatedIds.includes(lib));
  });

  test('dead and self targets rejected', () => {
    const e = makeGame(7, 62);
    enactFascists(e, 2);
    const p = e.state.presidentId;
    playerOf(e, 'p7').alive = false;
    assertThrowsCode('DEAD_TARGET', () => e.investigate(p, 'p7'));
    assertThrowsCode('BAD_TARGET', () => e.investigate(p, p));
  });
});

describe('policy peek', () => {
  test('president sees the top 3 in draw order, cards are not consumed', () => {
    const e = makeGame(5, 70);
    enactFascists(e, 3); // 5p slot 3 = policy peek
    assert.equal(e.state.pendingPower, 'policyPeek');
    forceDraw(e, ['liberal', 'liberal', 'fascist']);
    const drawBefore = e.state.deck.draw.length;
    const p = e.state.presidentId;
    const top3 = e.policyPeek(p);
    assert.deepEqual(top3, ['fascist', 'liberal', 'liberal']); // top card first
    assert.equal(e.state.deck.draw.length, drawBefore); // peek does not draw
    assert.deepEqual(e.privateView(p).lastPeek, top3);
    const other = e.livingPlayers().find((id) => id !== p);
    assert.equal(e.privateView(other).lastPeek, undefined);
    assert.equal('lastPeek' in e.publicView(), false);
  });
});

describe('special election', () => {
  test('chosen player presides once; rotation resumes left of the caller', () => {
    const e = makeGame(7, 80);
    enactFascists(e, 3); // 7p slot 3 = special election
    assert.equal(e.state.pendingPower, 'specialElection');
    const caller = e.state.presidentId;
    const target = e.seatAfter(e.seatAfter(caller));
    e.specialElection(caller, target);
    assert.equal(e.state.presidentId, target);
    assert.equal(e.state.specialElectionReturnId, caller);
    assert.equal(e.state.phase, PHASE.NOMINATION);
    assertThrowsCode('PRESIDENT_LOCKED', () => e.setPresidentManually('p1'));
    // the special president's government round (forced liberal, no power)
    forceDraw(e, ['liberal', 'liberal', 'liberal']);
    const chancellor = e.eligibleChancellors()[0];
    e.nominateChancellor(target, chancellor);
    for (const pid of e.livingPlayers()) e.castVote(pid, 'ja');
    e.presidentDraw();
    e.presidentDiscard(0);
    e.chancellorEnact(chancellor, 0);
    // rotation resumes from the player left of the caller
    assert.equal(e.state.specialElectionReturnId, null);
    assert.equal(e.state.presidentId, e.seatAfter(caller));
    assert.equal(e.state.phase, PHASE.NOMINATION);
  });

  test('dead or self targets rejected', () => {
    const e = makeGame(7, 81);
    enactFascists(e, 3);
    const caller = e.state.presidentId;
    playerOf(e, 'p7').alive = false;
    assertThrowsCode('DEAD_TARGET', () => e.specialElection(caller, 'p7'));
    assertThrowsCode('BAD_TARGET', () => e.specialElection(caller, caller));
  });
});

describe('execution', () => {
  test('executed players lose vote, office and eligibility; Hitler execution wins for liberals', () => {
    const e = makeGame(5, 90);
    enactFascists(e, 4); // slot 4 = execute pending
    const p = e.state.presidentId;
    const victim = e.livingPlayers().find((id) => roleOf(e, id) === 'liberal');
    e.execute(p, victim);
    assert.equal(playerOf(e, victim).alive, false);
    assert.equal(e.livingPlayers().includes(victim), false);
    assert.equal(e.eligibleChancellors().includes(victim), false);
    assert.equal(e.publicView().players.find((pl) => pl.id === victim).alive, false);
    // slot 5 grants a second execution: shoot Hitler → liberals win
    enactFascists(e, 1);
    assert.equal(e.state.pendingPower, 'execute');
    const h = hitlerOf(e);
    e.execute(e.state.presidentId, h.id);
    assert.equal(e.state.phase, PHASE.GAME_OVER);
    assert.equal(e.state.winner, 'liberal');
    assert.equal(e.state.winReason, 'hitlerExecuted');
  });

  test('cannot execute the president or a dead player; wrong power rejected', () => {
    const e = makeGame(5, 91);
    enactFascists(e, 4);
    const p = e.state.presidentId;
    assertThrowsCode('BAD_TARGET', () => e.execute(p, p));
    playerOf(e, 'p2').alive = false;
    assertThrowsCode('DEAD_TARGET', () => e.execute(p, 'p2'));
    assertThrowsCode('WRONG_POWER', () => e.investigate(p, 'p3'));
    e.execute(p, 'p3'); // consume the power on p3
    assertThrowsCode('NO_POWER_PENDING', () => e.execute(p, 'p4'));
  });
});
