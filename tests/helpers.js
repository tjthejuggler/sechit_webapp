// Shared helpers for engine unit tests: seeded games, scenario drivers and
// invariant checks. All drivers are deterministic per seed.
import assert from 'node:assert/strict';
import { GameEngine, EngineError } from '../server/engine/index.js';

export const ids = (n) => Array.from({ length: n }, (_, i) => `p${i + 1}`);

export function makeGame(n, seed = 42, opts = {}, engineOpts = {}) {
  const e = new GameEngine({ seed, ...engineOpts });
  e.startGame(ids(n), { firstPresidentId: 'p1', ...opts });
  e.beginNomination();
  return e;
}

export const hitlerOf = (e) => e.state.players.find((p) => p.role === 'hitler');
export const roleOf = (e, id) => e.state.players.find((p) => p.id === id).role;
export const playerOf = (e, id) => e.state.players.find((p) => p.id === id);

export function voteAll(e, choice) {
  for (const pid of e.livingPlayers()) {
    if (e.state.phase !== 'VOTE') break;
    e.castVote(pid, choice);
  }
}
export const voteAllJa = (e) => voteAll(e, 'ja');
export const voteAllNein = (e) => voteAll(e, 'nein');

export function pickChancellor(e, { avoidHitler = true } = {}) {
  const eligible = e.eligibleChancellors();
  assert.ok(eligible.length > 0, 'no eligible chancellor available');
  const pool = avoidHitler ? eligible.filter((id) => roleOf(e, id) !== 'hitler') : eligible;
  return pool[0] ?? eligible[0];
}

export function elect(e, targetId) {
  e.nominateChancellor(e.state.presidentId, targetId ?? pickChancellor(e));
  voteAllJa(e);
}

// Place cards on top of the draw pile (the last pushed card is drawn first).
export function forceDraw(e, cards) {
  e.state.deck.draw.push(...cards);
}

// Consume whatever power is pending, in a neutral, rule-abiding way.
export function resolvePower(e) {
  if (e.state.phase !== 'EXEC_ACTION') return;
  const power = e.state.pendingPower;
  const p = e.state.presidentId;
  if (power === 'investigate') {
    const t = e.livingPlayers().find((id) => id !== p && !e.state.investigatedIds.has(id));
    e.investigate(p, t);
  } else if (power === 'specialElection') {
    e.specialElection(p, e.seatAfter(e.seatAfter(p)));
  } else if (power === 'policyPeek') {
    e.policyPeek(p);
  } else if (power === 'execute') {
    const t = e.livingPlayers().find((id) => roleOf(e, id) === 'liberal');
    e.execute(p, t);
  }
}

// Play exactly one legislative session enacting `policy` (deck top is forced).
export function playPolicy(e, policy) {
  resolvePower(e); // clear any pending power from the previous enactment
  forceDraw(e, [policy, policy, policy]);
  elect(e, pickChancellor(e));
  e.presidentDraw();
  e.presidentDiscard(0);
  e.chancellorEnact(e.state.chancellorId, 0);
}

export function enactFascists(e, count) {
  for (let i = 0; i < count; i++) playPolicy(e, 'fascist');
}
export function enactLiberals(e, count) {
  for (let i = 0; i < count; i++) playPolicy(e, 'liberal');
}

// Tiles are always split between draw pile, discard pile, enact track and hands.
// `total` is 17 for a pristine deck; tests that force extra cards pass the sum.
export function assertConservation(e, msg = 'policy tile conservation', total = 17) {
  const s = e.state;
  const onTable = s.hand.length + s.chancellorHand.length;
  assert.equal(
    s.deck.draw.length + s.deck.discard.length + s.liberalCount + s.fascistCount + onTable,
    total,
    msg
  );
}

export function assertThrowsCode(code, fn) {
  assert.throws(fn, (err) => err instanceof EngineError && err.code === code, `expected EngineError ${code}`);
}

// Complete random game with invariant checks after every step.
export function playRandomGame(seed, n) {
  const e = new GameEngine({ seed });
  e.startGame(ids(n));
  e.beginNomination();
  let steps = 0;
  while (e.state.phase !== 'GAME_OVER') {
    if (++steps > 500) throw new Error('random game did not terminate');
    assertConservation(e);
    assert.ok(e.state.tracker >= 0 && e.state.tracker <= 3, 'tracker within 0..3');
    const s = e.state;
    switch (s.phase) {
      case 'NOMINATION': {
        const eligible = e.eligibleChancellors();
        assert.ok(eligible.length > 0, 'eligible chancellors must always exist');
        e.nominateChancellor(s.presidentId, eligible[e.rng.int(eligible.length)]);
        break;
      }
      case 'VOTE': {
        for (const pid of e.livingPlayers()) {
          if (e.state.phase !== 'VOTE') break;
          if (e.state.votes.has(pid)) continue;
          e.castVote(pid, e.rng() < 0.65 ? 'ja' : 'nein');
        }
        break;
      }
      case 'LEGISLATIVE_PRESIDENT':
        e.presidentDraw();
        assert.equal(e.state.hand.length, 3);
        e.presidentDiscard(e.rng.int(3));
        break;
      case 'LEGISLATIVE_CHANCELLOR':
        if (s.vetoRequested) {
          e.vetoRespond(s.presidentId, e.rng() < 0.5);
        } else if (e.vetoUnlocked() && e.rng() < 0.25) {
          e.vetoRequest(s.chancellorId);
        } else {
          e.chancellorEnact(s.chancellorId, e.rng.int(2));
        }
        break;
      case 'EXEC_ACTION':
        resolvePowerRandom(e);
        break;
      default:
        throw new Error(`unexpected phase ${s.phase}`);
    }
  }
  assertConservation(e);
  return e;
}

function resolvePowerRandom(e) {
  const power = e.state.pendingPower;
  const p = e.state.presidentId;
  if (power === 'investigate') {
    const cands = e.livingPlayers().filter((id) => id !== p && !e.state.investigatedIds.has(id));
    e.investigate(p, cands[e.rng.int(cands.length)]);
  } else if (power === 'specialElection') {
    const cands = e.livingPlayers().filter((id) => id !== p);
    e.specialElection(p, cands[e.rng.int(cands.length)]);
  } else if (power === 'policyPeek') {
    e.policyPeek(p);
  } else if (power === 'execute') {
    const cands = e.livingPlayers().filter((id) => id !== p);
    e.execute(p, cands[e.rng.int(cands.length)]);
  } else {
    throw new Error(`unknown power ${power}`);
  }
}
