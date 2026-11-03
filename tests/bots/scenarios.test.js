// Scripted scenario tests over the real server. Each scenario seeds bot
// behavior (votes, discards, enacts, veto hooks, plaque placement) to force a
// deterministic outcome. Two test-only levers touch the server-side session
// directly (the "oracle", in-process):
//   - target picking that real players couldn't know (who Hitler is),
//   - forceDeck(): a single-policy draw pile so outcomes are forced regardless
//     of the server engine's time-based shuffle seed.
// EVERY gameplay action still travels through the public Socket.IO API and is
// validated by the server; no gameplay logic is bypassed or changed.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE, POWER, POLICY, VOTE, createRng } from '../../server/engine/index.js';
import { startServer, stopServer, GameTable, tokenFromUrl, emitAck } from './harness.js';
import {
  runGame, pollUntil, verifyGameOver, verifyLogHistory,
  preferEnact, preferDiscard, voteAllJa, voteAllNein, seatAfterPublic,
  oracleRoleOf, oracleHitlerId, forceDeck,
} from './driver.js';

let fixture;

before(async () => { fixture = await startServer(); });
after(async () => { await stopServer(fixture); });

// Helpers ---------------------------------------------------------------------

async function newTable(label, n = 5) {
  const table = new GameTable(fixture, { label });
  await table.addPlayers(n);
  await table.startGame();
  return table;
}

async function drive(tableOrPromise, opts, then) {
  const table = await tableOrPromise; // accept newTable(...) directly
  try {
    if (opts.beforePlay) opts.beforePlay({ table });
    const { stats } = await runGame(table, { rng: createRng(7), ...opts });
    const out = then ? await then({ table, stats }) : null;
    return out;
  } finally {
    await table.dispose();
  }
}

const logOf = (table) => table.board.view.log ?? [];
const hasEvent = (table, type, pred) => logOf(table).some((e) => e.type === type && (!pred || pred(e)));
const countEvents = (table, type, pred) => logOf(table).filter((e) => e.type === type && (!pred || pred(e))).length;

// Nominate anyone but Hitler (fallback: first eligible) — keeps scripted games
// alive until the scenario's target outcome fires.
const avoidHitlerNominee = ({ table, eligible }) => {
  const nonHitler = eligible.filter((id) => oracleRoleOf(table, id) !== 'hitler');
  return nonHitler[0] ?? eligible[0];
};
// Execution powers must never hit Hitler in scenarios that need the game to
// continue; liberals are the safe targets (oracle picks them).
// Vote ja on every government EXCEPT a Hitler chancellorship: when executions
// shrink the table, Hitler can become the only eligible chancellor — electing
// him (≥3 fascists) would end the game before the scenario's target event.
// A nein vote is always legal and sends the election to the tracker.
const jaUnlessHitlerNominee = ({ table, view }) => {
  const nominee = view.nominatedChancellorId;
  return nominee && oracleRoleOf(table, nominee) === 'hitler' ? VOTE.NEIN : VOTE.JA;
};

// Place the manual president plaque on a living non-Hitler player every
// nomination round (a real board feature). This guarantees Hitler is never
// the president when an execute power fires (the president cannot execute
// himself) and cannot term-limit himself out of eligibility.
const plaqueOnLoyal = ({ table, view }) => {
  const loyal = view.players.find((p) => p.alive && oracleRoleOf(table, p.id) !== 'hitler');
  return loyal?.id ?? null;
};

// Investigate / special-election burn: any legal target, but never Hitler
// (a Hitler special presidency would block his nomination next round).
const burnPowerAvoidingHitler = ({ table, power, legal }) => {
  if (power === POWER.SPECIAL_ELECTION || power === POWER.INVESTIGATE) {
    const nonHitler = legal.filter((id) => oracleRoleOf(table, id) !== 'hitler');
    return nonHitler[0] ?? legal[0];
  }
  return executeLiberals({ table, power, legal });
};

const executeLiberals = ({ table, power, legal }) => {
  if (power === POWER.EXECUTE) {
    const libs = legal.filter((id) => oracleRoleOf(table, id) === 'liberal');
    // Prefer liberals; never fall back to Hitler (executing him ends the game
    // with a liberal win). Fascists are the safe fallback.
    if (libs.length > 0) return libs[0];
    const nonHitler = legal.filter((id) => oracleRoleOf(table, id) !== 'hitler');
    return nonHitler[0] ?? legal.find((id) => oracleRoleOf(table, id) === 'hitler');
  }
  return legal[0];
};

// (a) veto path: request + consent → 3 discarded, tracker +1 -------------------

describe('scenario (a): veto agreed', () => {
  test('request + consent discards the session and bumps the tracker', { timeout: 120_000 }, async () => {
    await drive(
      newTable('veto-agreed', 5),
      {
        chooseVote: jaUnlessHitlerNominee,
        chooseNominee: avoidHitlerNominee,
        chooseEnact: preferEnact(POLICY.FASCIST),
        chooseDiscard: preferDiscard(POLICY.LIBERAL),
        choosePowerTarget: executeLiberals,
        wantVeto: () => true,     // chancellor requests veto whenever unlocked
        vetoConsent: () => true,  // president always agrees
        beforePlay: ({ table }) => forceDeck(table, POLICY.FASCIST), // fast unlock at 5 fascists
      },
      ({ table }) => {
        assert.ok(hasEvent(table, 'vetoRequested'), 'no veto was requested (veto never unlocked)');
        assert.ok(hasEvent(table, 'vetoAgreed'), 'president never consented to a veto');
        for (const bump of logOf(table).filter((e) => e.type === 'vetoAgreed')) {
          assert.ok(bump.tracker >= 1, `tracker not incremented by veto: ${JSON.stringify(bump)}`);
          assert.ok(bump.tracker <= 3, 'tracker exceeded 3 via veto');
        }
        verifyLogHistory(table.board.view);
      }
    );
  });
});

// (b) veto refused → chancellor must enact -------------------------------------

describe('scenario (b): veto refused', () => {
  test('refused veto forces the chancellor to enact', { timeout: 120_000 }, async () => {
    await drive(
      newTable('veto-refused', 5),
      {
        chooseVote: jaUnlessHitlerNominee,
        chooseNominee: avoidHitlerNominee,
        chooseEnact: preferEnact(POLICY.FASCIST),
        chooseDiscard: preferDiscard(POLICY.LIBERAL),
        choosePowerTarget: executeLiberals,
        // Request the veto exactly once — after a refusal the chancellor must
        // enact (requesting again would loop forever: a refused veto keeps
        // the same government in session).
        wantVeto: ({ stats }) => stats.vetoRequests === 0,
        vetoConsent: () => false, // president always refuses
        beforePlay: ({ table }) => forceDeck(table, POLICY.FASCIST),
      },
      ({ table }) => {
        const requested = countEvents(table, 'vetoRequested');
        const refused = countEvents(table, 'vetoRefused');
        assert.ok(requested >= 1, 'chancellor never requested a veto (never unlocked)');
        assert.equal(refused, requested, 'every request must be refused by script');
        const log = logOf(table);
        for (let i = 0; i < log.length; i++) {
          if (log[i].type === 'vetoRefused') {
            assert.ok(log[i + 1]?.type === 'chancellorActed',
              `vetoRefused at seq ${log[i].seq} not immediately followed by enactment: ${JSON.stringify(log[i + 1])}`);
          }
        }
        assert.ok(!hasEvent(table, 'vetoAgreed'), 'president consented despite refusing script');
        verifyLogHistory(table.board.view);
      }
    );
  });
});

// (c) execution of Hitler → liberal win ----------------------------------------

describe('scenario (c): Hitler executed', () => {
  test('liberals win with hitlerExecuted splash state', { timeout: 120_000 }, async () => {
    await drive(
      newTable('hitler-executed', 7),
      {
        chooseVote: jaUnlessHitlerNominee,
        chooseNominee: avoidHitlerNominee,
        chooseEnact: preferEnact(POLICY.FASCIST),
        chooseDiscard: preferDiscard(POLICY.LIBERAL),
        placePlaque: plaqueOnLoyal, // Hitler must not hold the plaque at execution time
        // 7p board: 2=investigate, 3=special election, 4/5=execute — burn the
        // non-execution powers without special-electing Hitler; execute him.
        choosePowerTarget: ({ table, power, legal, view }) => {
          if (power === POWER.EXECUTE) {
            const hitler = oracleHitlerId(table);
            if (hitler && hitler !== view.presidentId && legal.includes(hitler)) return hitler;
            return executeLiberals({ table, power, legal });
          }
          return burnPowerAvoidingHitler({ table, power, legal });
        },
        beforePlay: ({ table }) => forceDeck(table, POLICY.FASCIST),
      },
      ({ table }) => {
        const hitlerId = oracleHitlerId(table);
        verifyGameOver(table, { expectWinner: 'liberal', expectReason: 'hitlerExecuted' });
        assert.ok(hasEvent(table, 'executed', (e) => e.targetId === hitlerId), 'Hitler was never executed');
        assert.ok(hasEvent(table, 'powerGranted', (e) => e.power === POWER.EXECUTE), 'no execution power was granted');
        // The first killing power lands at 4 fascists on the 7p board.
        assert.ok(table.board.view.fascistCount >= 4, `execution power expected at ≥4 fascists: ${table.dump()}`);
      }
    );
  });
});

// (d) Hitler elected chancellor after ≥3 fascist → fascist win ------------------

describe('scenario (d): Hitler elected chancellor with ≥3 fascist policies', () => {
  test('fascists win immediately via hitlerElectedChancellor', { timeout: 120_000 }, async () => {
    await drive(
      newTable('hitler-chancellor-win', 7),
      {
        // All-ja ON PURPOSE: electing Hitler at ≥3 fascists is the goal.
        // (Before the 3rd fascist tile the nominee hook never picks Hitler,
        // so early all-ja elections are safe.)
        chooseVote: voteAllJa,
        chooseEnact: preferEnact(POLICY.FASCIST),
        chooseDiscard: preferDiscard(POLICY.LIBERAL),
        placePlaque: plaqueOnLoyal, // keep the plaque off Hitler so he stays nominable
        // Burn investigate/special-election on the first legal target, but
        // NEVER execute Hitler — he must stay alive and nominable to win via
        // hitlerElectedChancellor (executing him would hand liberals the win).
        choosePowerTarget: burnPowerAvoidingHitler,
        // Nominate Hitler as soon as ≥3 fascists are up; libs otherwise.
        chooseNominee: ({ table, view, eligible }) => {
          if (view.fascistCount >= 3) {
            const hitler = eligible.find((id) => oracleRoleOf(table, id) === 'hitler');
            if (hitler) return hitler;
          }
          return avoidHitlerNominee({ table, eligible });
        },
        beforePlay: ({ table }) => forceDeck(table, POLICY.FASCIST),
      },
      ({ table }) => {
        verifyGameOver(table, { expectWinner: 'fascist', expectReason: 'hitlerElectedChancellor' });
        assert.ok(table.board.view.fascistCount >= 3, 'win requires ≥3 fascist policies');
        assert.ok(hasEvent(table, 'gameOver', (e) => e.reason === 'hitlerElectedChancellor'),
          'win must be recorded as hitlerElectedChancellor');
      }
    );
  });
});

// (e) Hitler elected chancellor with <3 fascist → game continues ----------------

describe('scenario (e): Hitler elected chancellor with <3 fascist policies', () => {
  test('government forms normally and the game does NOT end', { timeout: 120_000 }, async () => {
    const table = await newTable('hitler-early-chancellor', 7);
    try {
      forceDeck(table, POLICY.LIBERAL); // deterministically keep fascists < 3
      let hitlerNominated = false;
      await runGame(table, {
        rng: createRng(21),
        chooseVote: voteAllJa,
        chooseEnact: preferEnact(POLICY.LIBERAL), // keep fascists < 3
        chooseDiscard: preferDiscard(POLICY.FASCIST),
        choosePowerTarget: executeLiberals,
        chooseNominee: ({ table: t, view, eligible }) => {
          if (!hitlerNominated && view.fascistCount < 3) {
            const hitler = eligible.find((id) => oracleRoleOf(t, id) === 'hitler');
            if (hitler) {
              hitlerNominated = true;
              return hitler;
            }
          }
          return avoidHitlerNominee({ table: t, eligible });
        },
        stopWhen: ({ view }) => hitlerNominated
          && view.chancellorId !== null
          && (view.phase === PHASE.LEGISLATIVE_PRESIDENT || view.phase === PHASE.LEGISLATIVE_CHANCELLOR)
          && oracleRoleOf(table, view.chancellorId) === 'hitler',
      });
      const v = table.board.view;
      assert.notEqual(v.phase, PHASE.GAME_OVER, `game ended early: ${v.winner}/${v.winReason}\n${table.dump()}`);
      assert.ok(v.fascistCount < 3, 'scenario requires <3 fascist policies');
      assert.ok(hasEvent(table, 'governmentFormed', (e) => oracleRoleOf(table, e.chancellorId) === 'hitler'),
        'Hitler never formed a government');
      assert.ok(!hasEvent(table, 'gameOver'), 'a gameOver event fired for an early Hitler chancellorship');
      verifyLogHistory(v, { requireGameOver: false });
    } finally {
      await table.dispose();
    }
  });
});

// (f) special election, then rotation returns left of the caller ----------------

describe('scenario (f): special election rotation', () => {
  test('after the special round, presidency resumes at the caller\'s next seat', { timeout: 120_000 }, async () => {
    const table = await newTable('special-election', 7);
    try {
      let specialCaller = null;
      let specialPick = null;
      await runGame(table, {
        rng: createRng(31),
        chooseVote: voteAllJa,
        chooseNominee: avoidHitlerNominee,
        chooseEnact: preferEnact(POLICY.FASCIST),
        chooseDiscard: preferDiscard(POLICY.LIBERAL),
        choosePowerTarget: ({ table: t, power, legal, view }) => {
          if (power === POWER.SPECIAL_ELECTION && !specialCaller) {
            specialCaller = view.presidentId;
            specialPick = legal[0];
            return specialPick;
          }
          return executeLiberals({ table: t, power, legal });
        },
        beforePlay: ({ table }) => forceDeck(table, POLICY.FASCIST),
        stopWhen: ({ view }) => specialCaller !== null
          && view.phase === PHASE.NOMINATION
          && view.specialElectionActive === false
          && view.presidentId === seatAfterPublic(view, specialCaller),
        maxSteps: 120, // scenario target only; no need to play to game over
      });
      const v = table.board.view;
      assert.ok(specialCaller, 'special election power never came up\n' + table.dump());
      assert.ok(hasEvent(table, 'specialElection', (e) => e.callerId === specialCaller && e.newPresidentId === specialPick),
        'special election event chain mismatch');
      if (v.phase !== PHASE.GAME_OVER) {
        assert.equal(v.presidentId, seatAfterPublic(v, specialCaller),
          `rotation must resume left of caller ${specialCaller}`);
        assert.equal(v.specialElectionActive, false, 'special election flag stuck on');
      } else {
        assert.equal(v.winReason, 'fascistPoliciesEnacted', 'unexpected end for rotation scenario');
      }
      verifyLogHistory(v, { requireGameOver: false });
    } finally {
      await table.dispose();
    }
  });
});

// (g) chaos election: 3 failed votes → auto-enact --------------------------------

describe('scenario (g): chaos election', () => {
  test('3 failed votes auto-enact, ignore powers, reset tracker + term limits', { timeout: 120_000 }, async () => {
    await drive(
      newTable('chaos', 7),
      {
        chooseVote: voteAllNein,
        chooseNominee: avoidHitlerNominee,
      },
      ({ table }) => {
        assert.ok(hasEvent(table, 'chaos'), 'chaos never triggered');
        for (const chaos of logOf(table).filter((e) => e.type === 'chaos')) {
          assert.equal(chaos.trackerReset, true, 'chaos did not reset the tracker');
          assert.equal(chaos.termLimitsReset, true, 'chaos did not reset term limits');
        }
        const v = table.board.view;
        // Tracker semantics: 0 right after each chaos, then it re-climbs with
        // further failed elections. Re-derive from the log and compare.
        let expected = 0;
        let sawChaos = false;
        for (const e of logOf(table)) {
          if (e.type === 'chaos') { expected = 0; sawChaos = true; }
          else if (e.type === 'electionFailed') expected += 1;
        }
        assert.ok(sawChaos, 'no chaos event');
        assert.equal(v.tracker, expected, `tracker ${v.tracker} != replayed ${expected}`);
        assert.equal(v.lastPresidentId, null, 'term limit (last president) not cleared');
        assert.equal(v.lastChancellorId, null, 'term limit (last chancellor) not cleared');
        assert.ok(hasEvent(table, 'policyEnacted', (e) => e.chaos === true), 'no chaos-flagged enactment');
        assert.ok(!hasEvent(table, 'powerGranted'), 'a power was granted from a chaos enactment');
        verifyLogHistory(v, { requireGameOver: false });
      }
    );
  });
});

// (h) draw pile exhaustion mid-session → auto reshuffle --------------------------

describe('scenario (h): deck reshuffle mid-session', () => {
  test('auto reshuffle occurs with correct tile counts', { timeout: 120_000 }, async () => {
    await drive(
      newTable('reshuffle', 5),
      {
        chooseVote: jaUnlessHitlerNominee,
        chooseNominee: avoidHitlerNominee,
        wantVeto: () => true,
        vetoConsent: () => true, // vetoes dump 3 tiles per session → fast exhaustion
        chooseEnact: preferEnact(POLICY.FASCIST),
        chooseDiscard: preferDiscard(POLICY.LIBERAL),
        choosePowerTarget: executeLiberals,
        beforePlay: ({ table }) => forceDeck(table, POLICY.FASCIST), // deterministic exhaustion pace
      },
      ({ table }) => {
        assert.ok(hasEvent(table, 'reshuffled'), 'no reshuffle occurred in the whole game');
        // The log verifier re-derives pile totals around EVERY reshuffled
        // event, including the exhaustion-triggered one.
        verifyLogHistory(table.board.view);
        const v = table.board.view;
        assert.ok(v.drawCount >= 0 && v.discardCount >= 0, 'negative pile counts');
      }
    );
  });
});

// (i) manual president plaque (board:president) ----------------------------------

describe('scenario (i): manual president plaque', () => {
  test('board:president moves the plaque and that player nominates', { timeout: 60_000 }, async () => {
    const table = await newTable('plaque', 5);
    try {
      const beginAck = await emitAck(table.board.socket, 'board:beginNomination', {});
      assert.ok(beginAck?.ok, `beginNomination failed: ${JSON.stringify(beginAck)}`);
      await pollUntil(table, () => table.board.view?.phase === PHASE.NOMINATION, 'NOMINATION');
      const v0 = table.board.view;
      const target = v0.players.find((p) => p.alive && p.id !== v0.presidentId);
      const ack = await emitAck(table.board.socket, 'board:president', target.id);
      assert.ok(ack?.ok, `board:president failed: ${JSON.stringify(ack)}`);
      await pollUntil(table, () => table.board.view?.presidentId === target.id, 'plaque moved');
      await runGame(table, {
        chooseVote: voteAllJa,
        stopWhen: ({ view, stats }) => stats.elections >= 1 && view.phase === PHASE.NOMINATION,
      });
      const v = table.board.view;
      assert.notEqual(v.phase, PHASE.GAME_OVER, 'unexpected game over in plaque scenario');
      assert.ok(hasEvent(table, 'presidentMoved', (e) => e.presidentId === target.id), 'no presidentMoved event');
      assert.ok(hasEvent(table, 'chancellorNominated', (e) => e.presidentId === target.id),
        'the plaque-placed president never nominated');
      verifyLogHistory(v, { requireGameOver: false });
    } finally {
      await table.dispose();
    }
  });
});

// (j) token security: draw-token replay/wrong-player rejected; receive ack ----

describe('scenario (j): draw token security + receive ack gate', () => {
  test('draw token: wrong player + replay rejected; receive ack enforced', { timeout: 90_000 }, async () => {
    const table = await newTable('token-security', 5);
    try {
      await runGame(table, {
        rng: createRng(51),
        chooseVote: voteAllJa,
        stopWhen: ({ view }) => view.phase === PHASE.LEGISLATIVE_PRESIDENT,
      });
      const v = table.board.view;
      await pollUntil(table, () => typeof table.board.view?.drawTokenUrl === 'string', 'draw token');
      const token = tokenFromUrl(table.board.view.drawTokenUrl);
      const presidentBot = table.bot(v.presidentId);
      const other = table.bots.find((b) => b.id !== presidentBot.id);

      // 1. Wrong player on a president-bound draw token. The server checks
      //    the presidency first (NOT_PRESIDENT) — either way it's rejected
      //    and the token stays unconsumed (the president can still draw).
      const wrongAck = await other.action('draw', { token });
      assert.equal(wrongAck.ok, false, 'wrong player accepted a president-bound draw token');
      assert.ok(['NOT_PRESIDENT', 'TOKEN_INVALID'].includes(wrongAck.code), `unexpected code: ${wrongAck.code}`);
      assert.equal(table.board.view.presidentDrew, false, 'wrong-player attempt consumed the draw');

      // 2. Correct draw works…
      const okAck = await presidentBot.action('draw', { token });
      assert.equal(okAck.ok, true, `valid draw failed: ${JSON.stringify(okAck)}`);
      assert.ok(Array.isArray(okAck.you?.hand) && okAck.you.hand.length === 3, 'draw must yield 3 cards');

      // 3. …and the replay must be rejected (token now consumed). A plain
      //    token-less draw would be legal, so assert via the consumed token.
      const replayAck = await presidentBot.action('draw', { token });
      assert.equal(replayAck.ok, false, 'replayed draw token accepted');

      // 4. Board stops advertising the consumed token; the president then
      //    discards to move the session to the chancellor stage.
      await pollUntil(table, () => table.board.view?.presidentDrew === true, 'presidentDrew flag');
      assert.equal(table.board.view.drawTokenUrl, null, 'board still exposes a draw token after use');
      const discardAck = await presidentBot.action('discard', { cardIndex: 0 });
      assert.equal(discardAck.ok, true, `discard failed: ${JSON.stringify(discardAck)}`);

      // 5. Receive ack: the wrong player may not confirm receipt…
      await pollUntil(table, () => {
        const bv = table.board.view;
        return bv?.phase === PHASE.LEGISLATIVE_CHANCELLOR && bv.transferPending === true;
      }, 'transfer pending state');
      const pv = table.board.view;
      const chancellorBot = table.bot(pv.chancellorId);
      const wrongReceiver = table.bots.find((b) => b.id !== chancellorBot.id);
      const wrongRecv = await wrongReceiver.action('receive', {});
      assert.equal(wrongRecv.ok, false, 'wrong player accepted the receive ack');
      assert.ok(['NOT_CHANCELLOR', 'BAD_HAND'].includes(wrongRecv.code), `unexpected code: ${wrongRecv.code}`);
      assert.ok(!wrongReceiver.view?.chancellorHand, 'wrong receiver obtained cards');

      // 6. …the chancellor's ack clears the gate; a repeat re-acks (idempotent).
      const recvAck = await chancellorBot.action('receive', {});
      assert.equal(recvAck.ok, true, `chancellor receive failed: ${JSON.stringify(recvAck)}`);
      const recvReplay = await chancellorBot.action('receive', {});
      assert.equal(recvReplay.ok, true, 'chancellor re-ack should idempotently re-ack');

      // 7. Enact works only after receive; then the session completes.
      const enactAck = await chancellorBot.action('enact', { cardIndex: 0 });
      assert.equal(enactAck.ok, true, 'enact after receive failed');
    } finally {
      await table.dispose();
    }
  });

  test('enact is rejected while the receive ack is still pending', { timeout: 60_000 }, async () => {
    const table = await newTable('transfer-pending', 5);
    try {
      await runGame(table, {
        rng: createRng(61),
        chooseVote: voteAllJa,
        stopWhen: ({ view }) => view.phase === PHASE.LEGISLATIVE_CHANCELLOR,
      });
      await pollUntil(table, () => {
        const bv = table.board.view;
        return bv?.phase === PHASE.LEGISLATIVE_CHANCELLOR && bv.transferPending === true;
      }, 'transfer pending state');
      const bv = table.board.view;
      const chancellorBot = table.bot(bv.chancellorId);
      const enactAck = await chancellorBot.action('enact', { cardIndex: 0 });
      assert.equal(enactAck.ok, false, 'enact accepted before the receive ack');
      assert.equal(enactAck.code, 'TRANSFER_PENDING', `unexpected code: ${enactAck.code}`);
    } finally {
      await table.dispose();
    }
  });
});

// (p) policy peek: the phone renders the result from the president's PRIVATE
// broadcast view — but the peek action is read-only and advances the phase to
// NOMINATION immediately. The wire contract therefore is: the ack AND the
// subsequent broadcast must both carry lastPeek (3 cards) while the phase has
// already left EXEC_ACTION and pendingPower is cleared. This is exactly the
// data the fixed play.js renders its dismissible peek screen from.
describe('scenario (p): policy peek over the wire', () => {
  const peekHooks = {
    chooseVote: voteAllJa,
    chooseNominee: avoidHitlerNominee,
    chooseDiscard: preferDiscard(POLICY.LIBERAL),
    chooseEnact: preferEnact(POLICY.FASCIST),
    choosePowerTarget: burnPowerAvoidingHitler,
  };

  test('peek ack + broadcast reach the president privately; round continues', { timeout: 120_000 }, async () => {
    const table = await newTable('policy-peek', 5);
    try {
      // Deterministic deck: all-fascist, so the 3rd enacted policy lands on the
      // peek slot and the top 3 at peek time are known.
      forceDeck(table, POLICY.FASCIST);
      // Drive until the Policy Peek power is pending.
      await runGame(table, {
        rng: createRng(11),
        ...peekHooks,
        stopWhen: ({ view }) => view.phase === PHASE.EXEC_ACTION && view.pendingPower === POWER.POLICY_PEEK,
      });
      const bv = table.board.view;
      assert.equal(bv.pendingPower, POWER.POLICY_PEEK, 'scenario must reach a pending policy peek');

      // The president taps "Peek" on the phone (the exact client action).
      const presidentBot = table.bot(bv.presidentId);
      const ack = await presidentBot.action('peek', {});
      assert.ok(ack?.ok, `peek action failed: ${JSON.stringify(ack)}`);
      // The ack view (rendered instantly by the phone) must carry the tiles.
      assert.equal(ack.you?.lastPeek?.length, 3, `ack must include lastPeek: ${JSON.stringify(ack.you)}`);

      // The BROADCAST private view — what the phone renders from once the
      // phase has already advanced — must still carry the peek result.
      await table.waitForView(
        () => presidentBot.view?.phase === PHASE.NOMINATION
          && presidentBot.view?.pendingPower == null
          && presidentBot.view?.lastPeek?.length === 3,
        'president broadcast view with peek result after phase advanced',
      );
      assert.deepEqual(presidentBot.view.lastPeek, [POLICY.FASCIST, POLICY.FASCIST, POLICY.FASCIST]);

      // Privacy: no other phone ever receives the peeked cards.
      for (const b of table.bots) {
        if (b.id !== presidentBot.id) {
          assert.equal(b.view?.lastPeek, undefined, `${b.name} must not see the peeked cards`);
        }
      }

      // The round continues and the game completes legally.
      await runGame(table, { rng: createRng(13), ...peekHooks });
      verifyGameOver(table);
    } finally {
      await table.dispose();
    }
  });
});
