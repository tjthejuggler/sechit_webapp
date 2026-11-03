// Bot driver: plays complete Secret Hitler games over the wire by reacting to
// private/public views, one legal action at a time. Decision hooks let tests
// steer behavior (random-but-legal by default, scripted for scenarios). A
// strict post-game verifier walks the public engine event log to prove vote
// completeness, dead-player exclusion, the full legislative chain per session
// and policy tile conservation across reshuffles.

import assert from 'node:assert/strict';
import { PHASE, POWER, VOTE } from '../../server/engine/index.js';
import { emitAck, tokenFromUrl } from './harness.js';

const POLL_INTERVAL = 5;

/** Poll an in-memory predicate until truthy (broadcast handlers are async). */
export function pollUntil(table, fn, desc, timeout = 10_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v = false;
      try { v = fn(); } catch { v = false; }
      if (v) return resolve(v);
      if (Date.now() - start > timeout) {
        return reject(new Error(`timeout (${timeout}ms) waiting for ${desc}\n${table.dump()}`));
      }
      setTimeout(tick, POLL_INTERVAL);
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// Server-side oracle — SCENARIO TESTS ONLY. Used to pick scripted targets
// (e.g. "execute Hitler") that real players would know socially; every action
// itself still travels through the public Socket.IO API. Random games never
// touch this.
// ---------------------------------------------------------------------------

function oracle(table) {
  const state = table.fixture.session.engine?.state;
  if (!state) throw new Error('oracle: no live game');
  return state;
}
export const oracleRoleOf = (table, id) => oracle(table).players.find((p) => p.id === id)?.role;
export const oracleHitlerId = (table) => oracle(table).players.find((p) => p.role === 'hitler')?.id;

/**
 * TEST-ONLY deck override (server-side oracle, in-process): replace the draw
 * pile with a single-policy deck (same 17-tile total, conservation intact).
 * Used by scripted scenarios to force deterministic outcomes regardless of
 * the server engine's time-based shuffle seed. Wire actions stay real.
 */
export function forceDeck(table, policy) {
  const deck = oracle(table).deck;
  deck.draw = Array(17).fill(policy);
  deck.discard = [];
}

// ---------------------------------------------------------------------------
// Decision helpers shared by scenarios
// ---------------------------------------------------------------------------

/** Enact `policy` when the hand contains it, else the first card. */
export const preferEnact = (policy) => ({ hand }) => {
  const i = hand.indexOf(policy);
  return i === -1 ? 0 : i;
};
/** President discards `policy` when present, else the first card. */
export const preferDiscard = (policy) => ({ hand }) => {
  const i = hand.indexOf(policy);
  return i === -1 ? 0 : i;
};
export const voteAllJa = () => VOTE.JA;
export const voteAllNein = () => VOTE.NEIN;

/** Next living seat after `playerId`, computed from the public board view. */
export function seatAfterPublic(view, playerId) {
  const start = view.players.find((p) => p.id === playerId).seat;
  for (let i = 1; i <= view.players.length; i++) {
    const c = view.players[(start + i) % view.players.length];
    if (c.alive) return c.id;
  }
  return null;
}

function legalTargetsFor(view, power) {
  const alive = view.players.filter((p) => p.alive && p.id !== view.presidentId).map((p) => p.id);
  if (power === POWER.INVESTIGATE) return alive.filter((id) => !view.investigatedIds.includes(id));
  if (power === POWER.SPECIAL_ELECTION || power === POWER.EXECUTE) return alive;
  return []; // policy peek has no target
}

/**
 * Drive a complete game (or a slice of one, via `stopWhen`) over the wire.
 * Returns stats. Every step asserts its ack and expected phase transition.
 */
export async function runGame(table, opts = {}) {
  const {
    rng = Math.random,
    chooseVote = null,
    chooseNominee = null,
    chooseDiscard = null,
    chooseEnact = null,
    wantVeto = null,
    vetoConsent = null,
    choosePowerTarget = null,
    placePlaque = null,
    stopWhen = null,
    maxSteps = 800,
  } = opts;

  const stats = {
    steps: 0, votes: 0, draws: 0, discards: 0, receives: 0, enacts: 0,
    vetoRequests: 0, vetoResponses: 0, powers: 0, elections: 0,
  };
  const phasesVisited = new Set([table.board.view?.phase]);
  let transferUrl = null;
  let receivedThisSession = false;

  // ROLE_REVEAL → NOMINATION (board control, like the real board page).
  // Resume-safe: when called on a game already past role reveal, skip.
  if (table.board.view?.phase === PHASE.ROLE_REVEAL) {
    const beginAck = await emitAck(table.board.socket, 'board:beginNomination', {});
    if (!beginAck?.ok) throw new Error(`board:beginNomination failed: ${JSON.stringify(beginAck)}\n${table.dump()}`);
    await pollUntil(table, () => table.board.view?.phase === PHASE.NOMINATION, 'NOMINATION after begin');
  }

  for (; stats.steps < maxSteps; stats.steps++) {
    const v = table.board.view;
    if (!v) throw new Error('no board view');
    phasesVisited.add(v.phase);
    if (v.phase === PHASE.GAME_OVER) break;
    if (stopWhen && stopWhen({ table, view: v, stats })) break;

    switch (v.phase) {
      // ---------------------------------------------------------- nomination
      case PHASE.NOMINATION: {
        // Optional manual president plaque (board:president), e.g. to force a
        // deterministic presidency for scripted scenarios.
        if (placePlaque) {
          const plaqueTarget = await placePlaque({ table, view: v, rng, stats });
          if (plaqueTarget && plaqueTarget !== v.presidentId && !v.specialElectionActive) {
            const ack = await emitAck(table.board.socket, 'board:president', plaqueTarget);
            if (!ack?.ok) throw new Error(`board:president failed: ${JSON.stringify(ack)}\n${table.dump()}`);
            await pollUntil(table, () => table.board.view?.presidentId === plaqueTarget, 'plaque moved');
          }
        }
        // Re-read the view: the plaque may have moved the presidency, which
        // changes eligibility and the acting president.
        const bv = table.board.view;
        const presidentBot = table.bot(bv.presidentId);
        const eligible = bv.eligibleChancellors ?? [];
        assert.ok(eligible.length > 0, `no eligible chancellor\n${table.dump()}`);
        const targetId = chooseNominee
          ? await chooseNominee({ table, view: bv, eligible, presidentId: bv.presidentId, rng, stats })
          : eligible[Math.floor(rng() * eligible.length)];
        assert.ok(eligible.includes(targetId), `nominee ${targetId} not eligible: [${eligible}]`);
        const ack = await presidentBot.action('nominate', { targetId });
        if (!ack?.ok) throw new Error(`nominate failed: ${JSON.stringify(ack)}\n${table.dump()}`);
        await pollUntil(table, () => {
          const cur = table.board.view;
          return cur?.phase === PHASE.VOTE || cur?.phase === PHASE.GAME_OVER;
        }, 'VOTE after nomination');
        break;
      }

      // ---------------------------------------------------------------- vote
      case PHASE.VOTE: {
        stats.elections += 1;
        const order = [...table.board.view.players].filter((p) => p.alive).sort((a, b) => a.seat - b.seat);
        for (const voter of order) {
          if (table.board.view.phase !== PHASE.VOTE) break; // resolved early? (can't, but guard)
          const bot = table.bot(voter.id);
          const choice = chooseVote
            ? await chooseVote({ table, view: bot.view, voterId: bot.id, rng, stats })
            : rng() < 0.6 ? VOTE.JA : VOTE.NEIN;
          const ack = await bot.action('vote', { vote: choice });
          if (!ack?.ok) {
            // Tolerate only "the election resolved with this very vote".
            const lv = table.board.view?.lastVote;
            if (!(table.board.view.phase !== PHASE.VOTE && lv?.votes?.[bot.id] !== undefined)) {
              throw new Error(`vote failed for ${bot.name}: ${JSON.stringify(ack)}\n${table.dump()}`);
            }
          } else {
            stats.votes += 1;
          }
        }
        await pollUntil(table, () => table.board.view?.phase !== PHASE.VOTE, 'election resolution');
        break;
      }

      // -------------------------------------------- legislative: president
      case PHASE.LEGISLATIVE_PRESIDENT: {
        receivedThisSession = false; // new government, new QR cycle
        const presidentBot = table.bot(v.presidentId);
        // Simulate scanning the board's draw-pile QR: fetch the one-time token
        // from the public board state and consume it via the draw action.
        await pollUntil(table, () => {
          const bv = table.board.view;
          return bv?.phase === PHASE.LEGISLATIVE_PRESIDENT
            && typeof bv.drawTokenUrl === 'string' && bv.drawTokenUrl.length > 0
            && bv.presidentDrew === false
            && presidentBot.view?.phase === PHASE.LEGISLATIVE_PRESIDENT;
        }, 'draw token on board');
        const token = tokenFromUrl(table.board.view.drawTokenUrl);
        assert.ok(token, `no draw token in ${table.board.view.drawTokenUrl}`);
        const drawAck = await presidentBot.action('draw', { token });
        if (!drawAck?.ok) throw new Error(`draw failed: ${JSON.stringify(drawAck)}\n${table.dump()}`);
        stats.draws += 1;
        const hand = drawAck.you?.hand;
        assert.ok(Array.isArray(hand) && hand.length === 3, `president must hold 3 cards, got ${JSON.stringify(drawAck.you)}`);
        // The BROADCAST private view must carry the same hand — this is what
        // the phone UI renders from (the ack path alone once masked a stall).
        await pollUntil(table, () => presidentBot.view?.phase === PHASE.LEGISLATIVE_PRESIDENT
          && Array.isArray(presidentBot.view?.hand) && presidentBot.view.hand.length === 3,
        'president broadcast view with 3-card hand');
        assert.deepEqual(presidentBot.view.hand, hand, 'president broadcast hand must match the ack hand');
        const idx = chooseDiscard ? await chooseDiscard({ table, hand, view: presidentBot.view, rng, stats }) : Math.floor(rng() * 3);
        const discardAck = await presidentBot.action('discard', { cardIndex: idx });
        if (!discardAck?.ok) throw new Error(`discard failed: ${JSON.stringify(discardAck)}\n${table.dump()}`);
        stats.discards += 1;
        transferUrl = discardAck.you?.transferTokenUrl ?? null; // president's phone shows the transfer QR
        await pollUntil(table, () => table.board.view?.phase === PHASE.LEGISLATIVE_CHANCELLOR, 'chancellor legislative phase');
        break;
      }

      // ------------------------------------------- legislative: chancellor
      case PHASE.LEGISLATIVE_CHANCELLOR: {
        const bv = table.board.view;
        // Pending veto request: the president answers on their phone.
        if (bv.vetoRequested) {
          const presidentBot = table.bot(bv.presidentId);
          const consent = vetoConsent
            ? await vetoConsent({ table, view: bv, presidentBot, rng, stats })
            : rng() < 0.5;
          const ack = await presidentBot.action('vetoRespond', { consent });
          if (!ack?.ok) throw new Error(`vetoRespond failed: ${JSON.stringify(ack)}\n${table.dump()}`);
          stats.vetoResponses += 1;
          transferUrl = null;
          await pollUntil(table, () => {
            const cur = table.board.view;
            return cur?.vetoRequested === false || cur?.phase !== PHASE.LEGISLATIVE_CHANCELLOR;
          }, 'veto resolution');
          break;
        }
        const chancellorBot = table.bot(bv.chancellorId);
        // The 2 cards are delivered to the chancellor's phone at discard
        // time; the chancellor confirms receipt with a plain `receive` action
        // (the session gates enact on it via TRANSFER_PENDING). One ack per
        // session keeps mid-session resume safe.
        if (!receivedThisSession && bv.transferPending === true) {
          const recvAck = await chancellorBot.action('receive', {});
          if (!recvAck?.ok) throw new Error(`receive failed: ${JSON.stringify(recvAck)}\n${table.dump()}`);
          stats.receives += 1;
          receivedThisSession = true;
          transferUrl = null;
        }
        await pollUntil(table, () => Array.isArray(chancellorBot.view?.chancellorHand) && chancellorBot.view.chancellorHand.length === 2,
          'chancellor hand of 2 delivered');
        const hand = chancellorBot.view.chancellorHand;
        const unlocked = bv.vetoUnlocked === true;
        const vetoWanted = unlocked
          && (wantVeto ? await wantVeto({ table, hand, view: chancellorBot.view, chancellorBot, rng, stats }) : rng() < 0.05);
        if (vetoWanted) {
          const ack = await chancellorBot.action('vetoRequest', {});
          if (!ack?.ok) throw new Error(`vetoRequest failed: ${JSON.stringify(ack)}\n${table.dump()}`);
          stats.vetoRequests += 1;
          await pollUntil(table, () => table.board.view?.vetoRequested === true, 'vetoRequested flag');
          break; // next iteration: president responds
        }
        const idx = chooseEnact ? await chooseEnact({ table, hand, view: chancellorBot.view, chancellorBot, rng, stats }) : Math.floor(rng() * 2);
        const ack = await chancellorBot.action('enact', { cardIndex: idx });
        if (!ack?.ok) throw new Error(`enact failed: ${JSON.stringify(ack)}\n${table.dump()}`);
        stats.enacts += 1;
        await pollUntil(table, () => table.board.view?.phase !== PHASE.LEGISLATIVE_CHANCELLOR, 'post-enact transition');
        break;
      }

      // ------------------------------------------------------- exec action
      case PHASE.EXEC_ACTION: {
        const presidentBot = table.bot(v.presidentId);
        const power = v.pendingPower;
        const legal = legalTargetsFor(v, power);
        if (power !== POWER.POLICY_PEEK) {
          assert.ok(legal.length > 0, `no legal target for ${power}\n${table.dump()}`);
        }
        const targetId = choosePowerTarget
          ? await choosePowerTarget({ table, power, legal, view: v, presidentBot, rng, stats })
          : (legal.length ? legal[Math.floor(rng() * legal.length)] : undefined);
        const type = power === POWER.POLICY_PEEK ? 'peek' : power;
        const ack = await presidentBot.action(type, targetId ? { targetId } : {});
        if (!ack?.ok) throw new Error(`${type} failed: ${JSON.stringify(ack)}\n${table.dump()}`);
        stats.powers += 1;
        if (power === POWER.INVESTIGATE) {
          assert.ok(['liberal', 'fascist'].includes(ack.you?.lastInvestigation?.party), `bad investigation result: ${JSON.stringify(ack.you)}`);
          // Transparency gate: the actor's PRIVATE ack view must carry the
          // announcement too (phones receive private views, not the public one).
          assert.ok(ack.you?.investigationAnnounce?.targetId, 'investigation announcement missing from private view');
        }
        if (power === POWER.POLICY_PEEK) {
          assert.ok(ack.you?.lastPeek?.length === 3, `peek must reveal 3 cards: ${JSON.stringify(ack.you)}`);
        }
        // Transparency gate: after an investigation, EVERY living bot must
        // acknowledge the announcement before the game may continue.
        if (table.board.view?.investigationAnnounce) {
          for (const bot of table.bots) {
            if (!bot.view?.you?.alive) continue;
            if (!table.board.view.investigationAnnounce) break;
            const ackA = await bot.action('ackInvestigation', {});
            if (!ackA?.ok) throw new Error(`ackInvestigation failed: ${JSON.stringify(ackA)}\n${table.dump()}`);
          }
        }
        await pollUntil(table, () => table.board.view?.phase !== PHASE.EXEC_ACTION, 'power resolution');
        break;
      }

      default:
        throw new Error(`driver: unexpected phase ${v.phase}\n${table.dump()}`);
    }
  }
  if (stats.steps >= maxSteps && table.board.view?.phase !== PHASE.GAME_OVER) {
    throw new Error(`game did not terminate within ${maxSteps} steps\n${table.dump()}`);
  }
  return { stats, phasesVisited };
}

// ---------------------------------------------------------------------------
// Post-game verification from the public event log (board view)
// ---------------------------------------------------------------------------

const WIN_REASONS = {
  liberal: ['liberalPoliciesEnacted', 'hitlerExecuted'],
  fascist: ['fascistPoliciesEnacted', 'hitlerElectedChancellor'],
};

/**
 * Assert GAME_OVER reached legally and exactly once, then walk the whole log:
 * vote completeness per election, dead voters excluded, full legislative chain
 * (form → draw → discard → receive → enact/veto) per government, and policy
 * tile conservation across every reshuffle event.
 */
export function verifyGameOver(table, { expectWinner = null, expectReason = null } = {}) {
  const v = table.board.view;
  assert.equal(v.phase, PHASE.GAME_OVER, `expected GAME_OVER, in ${v.phase}\n${table.dump()}`);
  assert.ok(v.winner === 'liberal' || v.winner === 'fascist', `illegal winner ${v.winner}`);
  assert.ok(WIN_REASONS[v.winner].includes(v.winReason), `illegal win reason ${v.winReason}`);
  if (expectWinner) assert.equal(v.winner, expectWinner, 'unexpected winner');
  if (expectReason) assert.equal(v.winReason, expectReason, 'unexpected win reason');
  verifyLogHistory(v, { requireGameOver: true });
  return { winner: v.winner, winReason: v.winReason };
}

/**
 * Walk the public engine log chronologically with running tile accounting:
 * pileTotal (draw+discard) + enacted + tiles on table === 17 at every step.
 * Vote completeness is measured against the living set *at election time*
 * (executions shrink it legitimately). Legislative chains must be complete.
 */
export function verifyLogHistory(view, { requireGameOver = true } = {}) {
  const log = view.log ?? [];
  const alive = new Set(view.players.map((p) => p.id));
  const voted = new Set();
  const enacted = { liberal: 0, fascist: 0 };
  let pileTotal = 17; // draw + discard whenever no tiles are on the table
  let tableCards = 0; // tiles currently on the table (hand/transfer/flush)
  let gameOvers = 0;
  let session = null; // current legislative session chain

  const assertSum = (label) => {
    assert.equal(
      pileTotal + enacted.liberal + enacted.fascist + tableCards,
      17,
      `policy conservation broken (${label}): piles=${pileTotal} ` +
      `lib=${enacted.liberal} fasc=${enacted.fascist} table=${tableCards}`
    );
  };

  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    switch (e.type) {
      case 'executed':
        assert.ok(alive.has(e.targetId), `executed unknown/dead player ${e.targetId}`);
        alive.delete(e.targetId);
        break;
      case 'chancellorNominated':
        session = { presidentId: e.presidentId, chancellorId: e.chancellorId, drew: false, discarded: false, received: false };
        voted.clear();
        break;
      case 'voteCast':
        assert.ok(alive.has(e.voterId), `dead/unknown voter ${e.voterId} at seq ${e.seq}`);
        assert.ok(!voted.has(e.voterId), `duplicate vote by ${e.voterId} at seq ${e.seq}`);
        voted.add(e.voterId);
        break;
      case 'voteResolved': {
        assert.equal(voted.size, alive.size, `election at seq ${e.seq} incomplete: ${voted.size}/${alive.size} living voted`);
        assert.equal(e.ja + e.nein, alive.size, `tally at seq ${e.seq} does not match voter count`);
        voted.clear();
        break;
      }
      case 'governmentFormed':
        session = { presidentId: e.presidentId, chancellorId: e.chancellorId, drew: false, discarded: false, received: false };
        break;
      case 'cardsDrawn':
        assert.ok(session && !session.drew, `cardsDrawn without open session at seq ${e.seq}`);
        assert.equal(e.presidentId, session.presidentId, `drawer != nominated president at seq ${e.seq}`);
        session.drew = true;
        pileTotal -= 3; // 3 tiles leave the piles into the president's hand
        tableCards = 3;
        assertSum(`cardsDrawn seq ${e.seq}`);
        break;
      case 'presidentDiscarded':
        assert.ok(session?.drew, `presidentDiscarded before draw at seq ${e.seq}`);
        session.discarded = true;
        pileTotal += 1; // the discarded presidential tile enters the discard pile
        tableCards = 2;
        assertSum(`presidentDiscarded seq ${e.seq}`);
        break;
      case 'chancellorReceived':
        assert.ok(session?.discarded, `chancellorReceived before discard at seq ${e.seq}`);
        session.received = true;
        break;
      case 'vetoRequested':
        assert.ok(session?.received, `veto before receive at seq ${e.seq}`);
        break;
      case 'vetoAgreed':
        assert.ok(session?.received, `vetoAgreed before receive at seq ${e.seq}`);
        pileTotal += 2; // the two chancellor tiles join the discard pile
        tableCards = 0;
        session = null;
        assertSum(`vetoAgreed seq ${e.seq}`);
        break;
      case 'chancellorActed':
        assert.ok(session?.received, `enact before receive at seq ${e.seq}`);
        // Both remaining tiles leave the table: the un-enacted card is
        // auto-discarded NOW, the enacted tile is logged by the NEXT event.
        pileTotal += 2;
        tableCards = 0;
        session = null;
        assertSum(`chancellorActed seq ${e.seq}`);
        break;
      case 'policyEnacted':
        enacted[e.policy] += 1;
        pileTotal -= 1; // the enacted tile leaves the piles (drawn or in hand)
        if (e.chaos) {
          tableCards = 0; // chaos draws straight off the pile, never via hands
        } else {
          assert.equal(tableCards, 0, `stray table tiles after enact at seq ${e.seq}`);
        }
        assertSum(`policyEnacted seq ${e.seq}`);
        break;
      case 'reshuffled': {
        // Reshuffle merges draw+discard. Tiles already drawn (but not yet
        // logged as drawn/enacted) are in flight: anticipate them by peeking
        // at the next event, without moving them into piles prematurely.
        const next = log[i + 1];
        let inFlight = 0;
        if (next?.type === 'policyEnacted' && next.chaos) inFlight = 1;
        else if (next?.type === 'cardsDrawn') inFlight = 3;
        assert.equal(e.drawCount + e.discardCount, pileTotal - inFlight,
          `reshuffle at seq ${e.seq} tile mismatch: ${e.drawCount}+${e.discardCount} vs piles=${pileTotal - inFlight}`);
        break;
      }
      case 'gameOver':
        gameOvers += 1;
        break;
      default:
        break;
    }
  }
  assert.equal(enacted.liberal, view.liberalCount, 'log-enacted liberal count mismatch');
  assert.equal(enacted.fascist, view.fascistCount, 'log-enacted fascist count mismatch');
  if (requireGameOver) {
    assert.equal(gameOvers, 1, `expected exactly one gameOver event, got ${gameOvers}`);
  }
  // requireGameOver === false → mid-game verification: gameOver count unchecked.
}
