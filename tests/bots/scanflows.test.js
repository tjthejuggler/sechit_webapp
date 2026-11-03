// Targeting-flow tests over the real server. Player phones carry NO QR codes:
// targeted powers (investigate / special election / execution) pick a target
// from the picker list and travel as plain `targetId` actions — the engine
// validates entitlement exactly as before.
//
// Covered:
//   1. investigate: party result delivered ONLY to the president.
//   2. special election: picked player becomes the next president.
//   3. execution: direct `execute` action (client-side confirm gate); wrong
//      actors rejected; Hitler-execution liberal win.
//   4. No QR surfaces remain on private views: no myQrUrl / transferTokenUrl,
//      unseated connections rejected, wrong actors can't act.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE, POWER, POLICY, VOTE, createRng } from '../../server/engine/index.js';
import { startServer, stopServer, GameTable, tokenFromUrl, emitAck } from './harness.js';
import { runGame, pollUntil, verifyLogHistory, preferEnact, preferDiscard, oracleRoleOf } from './driver.js';

let fixture;

before(async () => { fixture = await startServer(); });
after(async () => { await stopServer(fixture); });

async function newTable(label, n = 5) {
  const table = new GameTable(fixture, { label });
  await table.addPlayers(n);
  await table.startGame();
  // Bot views can lag the board broadcast by a tick — wait for private data.
  await pollUntil(table, () => table.bots.every((b) => typeof b.view?.you?.role === 'string'),
    'all bots hold private role data');
  return table;
}

// Play until EXEC_ACTION with the wanted pending power; force fascist tiles.
// Votes are ja EXCEPT for a Hitler chancellorship once ≥3 fascists are up —
// electing Hitler would end the game before the target power arrives.
const voteJaUnlessHitlerNominee = ({ table: t, view }) => {
  const nominee = view.nominatedChancellorId;
  return nominee && oracleRoleOf(t, nominee) === 'hitler' && view.fascistCount >= 3
    ? VOTE.NEIN
    : VOTE.JA;
};

// Keep the president plaque off Hitler every nomination round (a real board
// feature) so Hitler can never be the president when an execute power fires
// (the engine forbids self-execution). Roles are time-seeded server-side, so
// this guard is REQUIRED for deterministic Hitler-execution scenarios.
const plaqueOffHitler = ({ table, view }) => {
  const loyal = view.players.find((p) => p.alive && oracleRoleOf(table, p.id) !== 'hitler');
  return loyal?.id ?? null;
};

async function runToPower(table, wantPower, opts = {}) {
  let hit = null;
  await runGame(table, {
    rng: createRng(opts.seed ?? 101),
    chooseVote: opts.chooseVote ?? voteJaUnlessHitlerNominee,
    chooseEnact: preferEnact(POLICY.FASCIST),
    chooseDiscard: preferDiscard(POLICY.LIBERAL),
    // Burn any non-target power that fires first — but never hand a special
    // election to Hitler (he would become president with the plaque locked,
    // breaking the execute scenarios when the target power then arrives).
    choosePowerTarget: ({ power, legal }) => {
      if (power === wantPower) return legal[0];
      const nonHitler = legal.filter((id) => oracleRoleOf(table, id) !== 'hitler');
      return nonHitler[0] ?? legal[0] ?? undefined;
    },
    placePlaque: opts.placePlaque,
    stopWhen: ({ view }) => {
      if (view.phase === PHASE.EXEC_ACTION && view.pendingPower === wantPower) {
        hit = { presidentId: view.presidentId, power: view.pendingPower };
        return true;
      }
      return false;
    },
    beforePlay: ({ table: t }) => {
      // All-fascist draw pile guarantees the needed power arrives quickly.
      t.fixture.session.engine.state.deck.draw = Array(17).fill(POLICY.FASCIST);
      t.fixture.session.engine.state.deck.discard = [];
    },
    maxSteps: 200,
  });
  assert.ok(hit, `never reached EXEC_ACTION with power ${wantPower}\n${table.dump()}`);
  return hit;
}

describe('private view hygiene (no player QRs)', () => {
  test('private views carry no myQrUrl / transferTokenUrl in any phase', { timeout: 60_000 }, async () => {
    const table = await newTable('no-qr-views', 5);
    try {
      for (const bot of table.bots) {
        assert.equal(bot.view.myQrUrl, undefined, 'myQrUrl must be gone from private views');
        assert.equal(bot.view.transferTokenUrl, undefined, 'transferTokenUrl must be gone');
      }

      // Drive one full legislative session and re-check.
      const beginAck = await emitAck(table.board.socket, 'board:beginNomination', {});
      assert.ok(beginAck?.ok);
      await pollUntil(table, () => table.board.view?.phase === PHASE.NOMINATION, 'NOMINATION');
      const pres = table.bot(table.board.view.presidentId);
      const eligible = table.board.view.eligibleChancellors;
      const nomAck = await pres.action('nominate', { targetId: eligible[0] });
      assert.ok(nomAck?.ok);
      await pollUntil(table, () => table.board.view?.phase === PHASE.VOTE, 'VOTE');
      for (const voter of [...table.board.view.players].filter((p) => p.alive)) {
        if (table.board.view.phase !== PHASE.VOTE) break;
        await table.bot(voter.id).action('vote', { vote: VOTE.JA });
      }
      await pollUntil(table, () => table.board.view?.phase === PHASE.LEGISLATIVE_PRESIDENT, 'LEGISLATIVE');
      await pollUntil(table, () => typeof table.board.view?.drawTokenUrl === 'string', 'draw token url');
      const drawAck = await table.bot(table.board.view.presidentId).action('draw', { token: tokenFromUrl(table.board.view.drawTokenUrl) });
      assert.ok(drawAck?.ok, `draw failed: ${JSON.stringify(drawAck)}`);
      const discardAck = await table.bot(table.board.view.presidentId).action('discard', { cardIndex: 0 });
      assert.ok(discardAck?.ok, `discard failed: ${JSON.stringify(discardAck)}`);
      assert.equal(discardAck.you?.transferTokenUrl, undefined, 'transferTokenUrl reappeared after discard');

      // The board still exposes the deck draw QR (board ↔ phone flow only).
      await pollUntil(table, () => table.board.view?.phase === PHASE.LEGISLATIVE_CHANCELLOR, 'chancellor stage');
      assert.equal(table.board.view.transferPending, true, 'transferPending flag missing');

      // Unseated connections are rejected at the action layer (NOT_A_PLAYER).
      const { io: clientIo } = await import('socket.io-client');
      const ghost = clientIo(`${table.fixture.url}/play`);
      await new Promise((res, rej) => {
        const t0 = setTimeout(() => rej(new Error('ghost connect timeout')), 5000);
        ghost.once('connect', () => { clearTimeout(t0); res(); });
        ghost.once('connect_error', (e) => { clearTimeout(t0); rej(e); });
      });
      const ghostAct = await emitAck(ghost, 'action', { type: 'investigate', targetId: table.bots[1].id });
      assert.equal(ghostAct.ok, false, 'unseated actor accepted');
      assert.equal(ghostAct.code, 'NOT_A_PLAYER', `unexpected code ${ghostAct.code}`);
      ghost.disconnect();
    } finally {
      await table.dispose();
    }
  });
});

describe('investigate (pick-from-list)', () => {
  test('president picks target; party revealed only to the president', { timeout: 120_000 }, async () => {
    const table = await newTable('investigate-pick', 7);
    try {
      const hit = await runToPower(table, POWER.INVESTIGATE, { seed: 7 });
      const presidentBot = table.bot(hit.presidentId);
      const bv = table.board.view;
      const targetBot = table.bots.find((b) => b.id !== presidentBot.id
        && b.view.you.alive && !bv.investigatedIds.includes(b.id));
      assert.ok(targetBot, 'no legal investigate target');

      // Wrong actor acting: rejected, power still pending.
      const notPres = table.bots.find((b) => b.id !== presidentBot.id && b.view.you.alive);
      const wrongAck = await notPres.action('investigate', { targetId: targetBot.id });
      assert.equal(wrongAck.ok, false, 'non-president accepted by investigate');
      assert.ok(['NOT_PRESIDENT', 'WRONG_POWER', 'NO_POWER_PENDING'].includes(wrongAck.code),
        `unexpected code ${wrongAck.code}`);
      assert.equal(table.board.view.phase, PHASE.EXEC_ACTION, 'rejected action mutated state');

      // Entitled pick: president targets the player.
      const ack = await presidentBot.action('investigate', { targetId: targetBot.id });
      assert.equal(ack.ok, true, `investigate failed: ${JSON.stringify(ack)}`);
      assert.ok(['liberal', 'fascist'].includes(ack.you?.lastInvestigation?.party),
        `no private investigation result: ${JSON.stringify(ack.you?.lastInvestigation)}`);
      assert.equal(ack.you.lastInvestigation.targetId, targetBot.id);

      // Board never sees the party; the target got no private result.
      assert.equal(table.board.view.lastInvestigation, undefined, 'party leaked to the board');
      const tv = targetBot.view;
      assert.equal(tv.lastInvestigation, undefined, 'party leaked to the target');
      assert.ok(table.board.view.investigatedIds.includes(targetBot.id), 'investigated marker missing publicly');

      verifyLogHistory(table.board.view, { requireGameOver: false });
    } finally {
      await table.dispose();
    }
  });
});

describe('special election (pick-from-list)', () => {
  test('president picks target; picked player becomes the next president', { timeout: 120_000 }, async () => {
    const table = await newTable('special-pick', 7);
    try {
      const hit = await runToPower(table, POWER.SPECIAL_ELECTION, { seed: 11 });
      const presidentBot = table.bot(hit.presidentId);
      const targetBot = table.bots.find((b) => b.id !== presidentBot.id && b.view.you.alive);

      // Non-entitled action rejected first.
      const notPres = table.bots.find((b) => b.id !== presidentBot.id && b.view.you.alive);
      const wrongAck = await notPres.action('specialElection', { targetId: targetBot.id });
      assert.equal(wrongAck.ok, false, 'non-president accepted by specialElection');

      // Entitled pick: the chosen target becomes president candidate.
      const ack = await presidentBot.action('specialElection', { targetId: targetBot.id });
      assert.equal(ack.ok, true, `specialElection failed: ${JSON.stringify(ack)}`);
      await pollUntil(table, () => table.board.view?.phase === PHASE.NOMINATION
        && table.board.view?.presidentId === targetBot.id, 'picked player is president');
      assert.equal(table.board.view.specialElectionActive, true, 'special election flag not active');

      verifyLogHistory(table.board.view, { requireGameOver: false });
    } finally {
      await table.dispose();
    }
  });
});

describe('execution (pick + client confirm)', () => {
  test('execute kills outright on the entitled action; wrong actor rejected', { timeout: 120_000 }, async () => {
    const table = await newTable('execute-pick', 7);
    try {
      const hit = await runToPower(table, POWER.EXECUTE, { seed: 13, placePlaque: plaqueOffHitler });
      const presidentBot = table.bot(hit.presidentId);
      const targetBot = table.bots.find((b) => b.id !== presidentBot.id && b.view.you.alive);

      // Non-president cannot execute.
      const notPres = table.bots.find((b) => b.id !== presidentBot.id && b.view.you.alive);
      const wrongExec = await notPres.action('execute', { targetId: targetBot.id });
      assert.equal(wrongExec.ok, false, 'non-president executed a player');
      assert.ok(['NOT_PRESIDENT', 'WRONG_POWER', 'NO_POWER_PENDING'].includes(wrongExec.code),
        `unexpected code ${wrongExec.code}`);
      assert.ok(!hasExecuted(table, targetBot.id), 'target died via wrong actor');

      // President executes (the phone client adds its own confirm step).
      const ack = await presidentBot.action('execute', { targetId: targetBot.id });
      assert.equal(ack.ok, true, `execute failed: ${JSON.stringify(ack)}`);
      await pollUntil(table, () => !table.board.view.players.find((p) => p.id === targetBot.id)?.alive,
        'target alive after entitled execution');
      assert.notEqual(table.board.view.phase, PHASE.EXEC_ACTION, 'power did not resolve');

      verifyLogHistory(table.board.view, { requireGameOver: false });
    } finally {
      await table.dispose();
    }
  });

  test('executing Hitler wins the game for liberals', { timeout: 120_000 }, async () => {
    const table = await newTable('execute-hitler-pick', 7);
    try {
      // Plaque guard: Hitler must never BE the president when execute fires.
      const hit = await runToPower(table, POWER.EXECUTE, { seed: 17, placePlaque: plaqueOffHitler });
      const presidentBot = table.bot(hit.presidentId);
      const hitlerId = table.fixture.session.engine.state.players.find((p) => p.role === 'hitler').id;
      assert.ok(table.bot(hitlerId).view.you.alive, 'Hitler already dead?');
      assert.notEqual(hit.presidentId, hitlerId, 'Hitler cannot execute himself');

      const ack = await presidentBot.action('execute', { targetId: hitlerId });
      assert.equal(ack.ok, true, `execute failed: ${JSON.stringify(ack)}`);
      await pollUntil(table, () => table.board.view?.phase === PHASE.GAME_OVER, 'game over after Hitler execution');
      assert.equal(table.board.view.winner, 'liberal');
      assert.equal(table.board.view.winReason, 'hitlerExecuted');
    } finally {
      await table.dispose();
    }
  });
});

describe('rejoin (mid-game seat reclaim via board QR)', () => {
  test('fresh phone picks a name and receives that seat back', { timeout: 120_000 }, async () => {
    const table = await newTable('rejoin-seat', 5);
    try {
      // Simulate a phone whose tab closed: fresh socket, no stored token.
      const { io: clientIo } = await import('socket.io-client');
      const phone = clientIo(`${table.fixture.url}/play`);
      await new Promise((res, rej) => {
        const t0 = setTimeout(() => rej(new Error('phone connect timeout')), 5000);
        phone.once('connect', () => { clearTimeout(t0); res(); });
        phone.once('connect_error', (e) => { clearTimeout(t0); rej(e); });
      });
      try {
        const victim = table.bots[1];

        // Unknown seat ids are rejected.
        const bad = await emitAck(phone, 'rejoin', { playerId: 'pdeadbeef' });
        assert.equal(bad.ok, false, 'rejoin accepted an unknown player');
        assert.equal(bad.code, 'NOT_A_PLAYER', `unexpected code ${bad.code}`);

        // The unseated phone receives the PUBLIC view (players list drives the
        // "which player are you?" picker) — no private data leaks to it.
        const privLeak = new Promise((resolve) => phone.once('state', (s) => resolve(s)));
        await emitAck(table.board.socket, 'board:beginNomination', {});
        const publicFrame = await privLeak;
        assert.ok(Array.isArray(publicFrame.players), 'public frame carries no players list');
        assert.equal(publicFrame.you, undefined, 'private data leaked to an unseated phone');

        // Pick a name → the seat's token comes back and the private view lands.
        const privArrived = new Promise((resolve) => phone.once('state', (s) => resolve(s)));
        const ack = await emitAck(phone, 'rejoin', { playerId: victim.id });
        assert.ok(ack.ok, `rejoin failed: ${JSON.stringify(ack)}`);
        assert.equal(ack.playerId, victim.id);
        assert.ok(/^[a-f0-9]{8,}$/i.test(ack.token ?? ''), 'no seat token returned');
        const priv = await privArrived;
        assert.equal(priv.you?.id, victim.id, 'private view is not the reclaimed seat');
        assert.equal(typeof priv.you?.role, 'string', 'reclaimed seat has no role');
        assert.equal(priv.you.role, victim.view.you.role, 'role mismatch after reclaim');

        // The reclaimed token is the SAME session token the seat always had:
        // binding a second socket with it yields the same player.
        const again = await emitAck(phone, 'identify', { token: ack.token });
        assert.ok(again.ok !== false && again.playerId === victim.id, 'reclaimed token does not re-bind');
      } finally {
        phone.disconnect();
      }
    } finally {
      await table.dispose();
    }
  });
});

function hasExecuted(table, playerId) {
  return (table.board.view.log ?? []).some((e) => e.type === 'executed' && e.targetId === playerId);
}
