// Pure Secret Hitler game engine: complete state machine, no sockets, no HTTP.
// Deterministic under a fixed seed. Every action validates phase, actor and
// eligibility; violations emit an `invalidAction` event and throw EngineError
// with a machine-readable code.

import { Deck } from './deck.js';
import { createRng } from './rng.js';
import { EngineError } from './errors.js';
import {
  ROLE,
  PARTY,
  POLICY,
  PHASE,
  POWER,
  MIN_PLAYERS,
  MAX_PLAYERS,
  FASCISTS_PER_COUNT,
  ELECTION_TRACKER_MAX,
  VETO_UNLOCK_FASCIST,
  HITLER_CHANCELLOR_FASCIST_MIN,
  LIBERAL_WIN_COUNT,
  FASCIST_WIN_COUNT,
  powerForCount,
} from './constants.js';
import { buildPublicView, buildPrivateView } from './views.js';

const VOTE_OPTIONS = { ja: true, nein: true };

export class GameEngine {
  constructor({ seed = null, onEvent = null, investigateFirstPower = false } = {}) {
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    // House-rule flag: in 5–6 player games the first fascist power slot is
    // normally POLICY_PEEK; with this flag it becomes INVESTIGATE instead.
    // (Only the 5–6 boards contain a POLICY_PEEK slot, so remapping
    // POLICY_PEEK → INVESTIGATE affects exactly that first power.)
    this.investigateFirstPower = Boolean(investigateFirstPower);
    this.seed = seed == null ? (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0 : seed >>> 0;
    this.rng = createRng(this.seed);
    this.state = null;
    this._seq = 0;
  }

  // ---------------------------------------------------------------- lifecycle

  startGame(playerIds, opts = {}) {
    if (!Array.isArray(playerIds) || playerIds.length < MIN_PLAYERS || playerIds.length > MAX_PLAYERS) {
      this.#fail('BAD_PLAYER_COUNT', `Need ${MIN_PLAYERS}–${MAX_PLAYERS} players.`);
    }
    const ids = playerIds.map(String);
    if (new Set(ids).size !== ids.length) this.#fail('DUPLICATE_PLAYERS', 'Player ids must be unique.');
    if (ids.some((id) => id.length === 0)) this.#fail('BAD_PLAYER_ID', 'Player ids must be non-empty.');

    const n = ids.length;
    const roles = [];
    for (let i = 0; i < FASCISTS_PER_COUNT[n]; i++) roles.push(ROLE.FASCIST);
    roles.push(ROLE.HITLER);
    while (roles.length < n) roles.push(ROLE.LIBERAL);
    for (let i = roles.length - 1; i > 0; i--) {
      const j = this.rng.int(i + 1);
      [roles[i], roles[j]] = [roles[j], roles[i]];
    }

    let presidentId = ids[this.rng.int(n)];
    if (opts.firstPresidentId != null) {
      presidentId = String(opts.firstPresidentId);
      if (!ids.includes(presidentId)) this.#fail('UNKNOWN_PLAYER', 'firstPresidentId is not a player.');
    }

    this.state = {
      phase: PHASE.ROLE_REVEAL,
      players: ids.map((id, seat) => ({
        id,
        name: opts.names?.[id] ?? id,
        seat,
        role: roles[seat],
        alive: true,
      })),
      presidentId,
      chancellorId: null,
      nominatedChancellorId: null,
      lastPresidentId: null, // term limits: last ELECTED president
      lastChancellorId: null, // term limits: last ELECTED chancellor
      specialElectionReturnId: null,
      tracker: 0,
      liberalCount: 0,
      fascistCount: 0,
      deck: new Deck(this.rng),
      hand: [],
      chancellorHand: [],
      pendingPower: null,
      vetoRequested: false,
      votes: new Map(),
      lastVote: null,
      investigatedIds: new Set(),
      lastInvestigation: null,
      lastPeek: null,
      winner: null,
      winReason: null,
      log: [],
    };
    this.#logEvent('gameStarted', { playerCount: n, presidentId });
    return this;
  }

  // ROLE_REVEAL → NOMINATION once players have seen their roles on their phones.
  beginNomination() {
    this.#requirePhase(PHASE.ROLE_REVEAL, 'NOT_ROLE_REVEAL');
    this.state.phase = PHASE.NOMINATION;
    this.#logEvent('nominationStarted', { presidentId: this.state.presidentId });
  }

  // Board convenience: manual placement of the president plaque.
  setPresidentManually(playerId) {
    const s = this.#s();
    this.#requirePhase(PHASE.NOMINATION, 'PLAQUE_ONLY_IN_NOMINATION');
    if (s.specialElectionReturnId != null) {
      this.#fail('PRESIDENT_LOCKED', 'Special election in progress; the plaque is fixed.');
    }
    const p = this.#p(playerId);
    if (!p.alive) this.#fail('DEAD_TARGET', 'Cannot place the plaque on a dead player.');
    s.presidentId = p.id;
    this.#logEvent('presidentMoved', { presidentId: p.id });
    return p.id;
  }

  // -------------------------------------------------------------- nomination

  eligibleChancellors() {
    const s = this.#s();
    if (s.phase !== PHASE.NOMINATION) return [];
    return s.players.filter((p) => p.alive && this.#isEligibleChancellor(p.id)).map((p) => p.id);
  }

  nominateChancellor(presidentId, targetId) {
    const s = this.#s();
    this.#requirePhase(PHASE.NOMINATION, 'NOT_NOMINATION');
    const actor = this.#p(presidentId);
    if (actor.id !== s.presidentId) this.#fail('NOT_PRESIDENT', 'Only the current president may nominate.');
    const target = this.#p(targetId);
    if (!this.#isEligibleChancellor(target.id)) {
      this.#fail('INELIGIBLE_CHANCELLOR', `${target.id} is dead, is the current president, or is term-limited.`);
    }
    s.nominatedChancellorId = target.id;
    s.lastVote = null;
    s.votes = new Map();
    s.phase = PHASE.VOTE;
    this.#logEvent('chancellorNominated', { presidentId: actor.id, chancellorId: target.id });
    return target.id;
  }

  #isEligibleChancellor(id) {
    const s = this.#s();
    const p = this.#p(id);
    if (!p.alive) return false;
    if (p.id === s.presidentId) return false;
    // Term limits: last elected P & C ineligible — but with ≤5 LIVING players
    // only the last chancellor stays ineligible.
    const fewLiving = this.livingCount() <= 5;
    if (!fewLiving && p.id === s.lastPresidentId) return false;
    if (p.id === s.lastChancellorId) return false;
    return true;
  }

  // -------------------------------------------------------------------- vote

  castVote(playerId, vote) {
    const s = this.#s();
    this.#requirePhase(PHASE.VOTE, 'NOT_VOTING');
    const voter = this.#p(playerId);
    if (!voter.alive) this.#fail('DEAD_VOTER', 'Dead players cannot vote.');
    if (s.votes.has(voter.id)) this.#fail('ALREADY_VOTED', `${voter.id} already voted.`);
    const choice = String(vote).toLowerCase();
    if (!VOTE_OPTIONS[choice]) this.#fail('BAD_VOTE', 'Vote must be "ja" or "nein".');
    s.votes.set(voter.id, choice);
    this.#logEvent('voteCast', {
      voterId: voter.id,
      votesReceived: s.votes.size,
      votesExpected: this.livingCount(),
    });
    // Completes when every living player (candidates included) has voted.
    if (s.votes.size === this.livingCount()) this.#resolveElection();
  }

  #resolveElection() {
    const s = this.#s();
    let ja = 0;
    let nein = 0;
    const tally = {};
    for (const [pid, choice] of s.votes) {
      tally[pid] = choice;
      if (choice === 'ja') ja++;
      else nein++;
    }
    const elected = ja > nein; // tie or majority-no fails
    s.lastVote = { presidentId: s.presidentId, chancellorId: s.nominatedChancellorId, votes: tally, ja, nein, elected };
    this.#logEvent('voteResolved', { presidentId: s.presidentId, chancellorId: s.nominatedChancellorId, ja, nein, elected });
    s.votes = new Map();
    const chancellorId = s.nominatedChancellorId;
    s.nominatedChancellorId = null;

    if (!elected) {
      s.tracker += 1;
      this.#logEvent('electionFailed', { tracker: s.tracker });
      if (s.tracker >= ELECTION_TRACKER_MAX) {
        this.#chaosEnact();
        return;
      }
      this.#resolvePresidencyAfterRound();
      s.chancellorId = null;
      s.phase = PHASE.NOMINATION;
      this.#logEvent('presidencyPassed', { presidentId: s.presidentId });
      return;
    }

    const chancellor = this.#p(chancellorId);
    // Hitler elected chancellor after ≥3 fascist policies → Fascists win.
    if (chancellor.role === ROLE.HITLER && s.fascistCount >= HITLER_CHANCELLOR_FASCIST_MIN) {
      this.#gameOver('fascist', 'hitlerElectedChancellor');
      return;
    }
    s.chancellorId = chancellor.id;
    s.lastPresidentId = s.presidentId;
    s.lastChancellorId = chancellor.id;
    s.hand = [];
    s.chancellorHand = [];
    s.vetoRequested = false;
    s.phase = PHASE.LEGISLATIVE_PRESIDENT;
    this.#logEvent('governmentFormed', { presidentId: s.presidentId, chancellorId: chancellor.id });
  }

  // ------------------------------------------------------------- legislative

  presidentDraw() {
    const s = this.#s();
    this.#requirePhase(PHASE.LEGISLATIVE_PRESIDENT, 'NOT_PRESIDENT_LEGISLATIVE');
    if (s.hand.length !== 0) this.#fail('HAND_STATE', 'President already drew.');
    s.hand = s.deck.drawCards(3); // deck auto-reshuffles if < 3 available
    this.#checkReshuffle();
    this.#logEvent('cardsDrawn', { presidentId: s.presidentId, count: s.hand.length });
    return s.hand;
  }

  presidentDiscard(cardIndex) {
    const s = this.#s();
    this.#requirePhase(PHASE.LEGISLATIVE_PRESIDENT, 'NOT_PRESIDENT_LEGISLATIVE');
    if (s.hand.length !== 3) this.#fail('HAND_STATE', 'President must hold 3 cards.');
    const idx = Number(cardIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx > 2) this.#fail('BAD_CARD_INDEX', 'cardIndex must be 0, 1 or 2.');
    const [discarded] = s.hand.splice(idx, 1);
    s.deck.discardCards([discarded]);
    s.chancellorHand = s.hand.splice(0); // remaining 2
    s.hand = [];
    s.vetoRequested = false;
    s.phase = PHASE.LEGISLATIVE_CHANCELLOR;
    this.#logEvent('presidentDiscarded', { presidentId: s.presidentId, transferCount: s.chancellorHand.length });
    return s.chancellorHand; // live transfer-hand reference (QR flow in Subtask 2)
  }

  // Chancellor acknowledges receipt of the 2 transferred cards.
  chancellorReceive() {
    const s = this.#s();
    this.#requirePhase(PHASE.LEGISLATIVE_CHANCELLOR, 'NOT_CHANCELLOR_LEGISLATIVE');
    if (s.chancellorHand.length !== 2) this.#fail('HAND_STATE', 'Chancellor must hold 2 cards.');
    this.#logEvent('chancellorReceived', { chancellorId: s.chancellorId });
    return s.chancellorHand;
  }

  // -------------------------------------------------------------------- veto

  vetoUnlocked() {
    return this.#s().fascistCount >= VETO_UNLOCK_FASCIST;
  }

  vetoRequest(chancellorId) {
    const s = this.#s();
    this.#requirePhase(PHASE.LEGISLATIVE_CHANCELLOR, 'NOT_CHANCELLOR_LEGISLATIVE');
    const actor = this.#p(chancellorId);
    if (actor.id !== s.chancellorId) this.#fail('NOT_CHANCELLOR', 'Only the chancellor may request a veto.');
    if (!this.vetoUnlocked()) this.#fail('VETO_LOCKED', 'Veto unlocks after 5 fascist policies.');
    if (s.vetoRequested) this.#fail('VETO_ALREADY_REQUESTED', 'Veto already requested.');
    if (s.chancellorHand.length !== 2) this.#fail('HAND_STATE', 'Chancellor must hold 2 cards.');
    s.vetoRequested = true;
    this.#logEvent('vetoRequested', { chancellorId: actor.id });
    return true;
  }

  vetoRespond(presidentId, consent) {
    const s = this.#s();
    this.#requirePhase(PHASE.LEGISLATIVE_CHANCELLOR, 'NOT_CHANCELLOR_LEGISLATIVE');
    const actor = this.#p(presidentId);
    if (actor.id !== s.presidentId) this.#fail('NOT_PRESIDENT', 'Only the president may respond to a veto.');
    if (!s.vetoRequested) this.#fail('NO_VETO_PENDING', 'No veto request pending.');
    s.vetoRequested = false;
    if (consent) {
      s.deck.discardCards(s.chancellorHand.splice(0)); // all 3 of the session now discarded
      s.tracker += 1;
      this.#logEvent('vetoAgreed', { tracker: s.tracker });
      if (s.tracker >= ELECTION_TRACKER_MAX) {
        this.#chaosEnact();
        return true;
      }
      s.chancellorId = null;
      this.#resolvePresidencyAfterRound(); // presidency passes on
      s.phase = PHASE.NOMINATION;
      this.#logEvent('presidencyPassed', { presidentId: s.presidentId });
    } else {
      this.#logEvent('vetoRefused', { presidentId: actor.id }); // chancellor must enact
    }
    return Boolean(consent);
  }

  // ------------------------------------------------------------------- enact

  chancellorEnact(chancellorId, cardIndex) {
    const s = this.#s();
    this.#requirePhase(PHASE.LEGISLATIVE_CHANCELLOR, 'NOT_CHANCELLOR_LEGISLATIVE');
    const actor = this.#p(chancellorId);
    if (actor.id !== s.chancellorId) this.#fail('NOT_CHANCELLOR', 'Only the chancellor may enact.');
    if (s.vetoRequested) this.#fail('VETO_PENDING', 'Resolve the veto request first.');
    if (s.chancellorHand.length !== 2) this.#fail('BAD_HAND', 'Chancellor must hold 2 cards.');
    const idx = Number(cardIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx > 1) this.#fail('BAD_CARD_INDEX', 'cardIndex must be 0 or 1.');
    const [enacted] = s.chancellorHand.splice(idx, 1);
    s.deck.discardCards(s.chancellorHand.splice(0)); // the other card
    s.chancellorHand = [];
    this.#logEvent('chancellorActed', { chancellorId: actor.id });
    this.#applyEnact(enacted, { chaos: false });
    return enacted;
  }

  #applyEnact(policy, { chaos = false }) {
    const s = this.#s();
    if (policy === POLICY.LIBERAL) s.liberalCount++;
    else s.fascistCount++;
    this.#logEvent('policyEnacted', { policy, chaos, liberalCount: s.liberalCount, fascistCount: s.fascistCount });
    // Win checks everywhere.
    if (s.liberalCount >= LIBERAL_WIN_COUNT) {
      this.#gameOver('liberal', 'liberalPoliciesEnacted');
      return;
    }
    if (s.fascistCount >= FASCIST_WIN_COUNT) {
      this.#gameOver('fascist', 'fascistPoliciesEnacted');
      return;
    }
    if (chaos) return; // chaos never grants a power
    // Board powers trigger only when a FASCIST policy lands on a power slot.
    if (policy === POLICY.FASCIST) {
      let power = powerForCount(s.players.length, s.fascistCount);
      // House rule (start.sh flag): the first fascist power in a 5–6 player
      // game becomes an investigation instead of the policy peek. The board
      // art stays the same — only the granted power changes.
      if (this.investigateFirstPower && power === POWER.POLICY_PEEK) {
        power = POWER.INVESTIGATE;
      }
      if (power) {
        s.pendingPower = power;
        s.phase = PHASE.EXEC_ACTION;
        this.#logEvent('powerGranted', { power, presidentId: s.presidentId });
        return;
      }
    }
    this.#completeLegislative();
  }

  #completeLegislative() {
    const s = this.#s();
    s.pendingPower = null;
    s.hand = [];
    s.chancellorHand = [];
    s.vetoRequested = false;
    s.chancellorId = null;
    this.#resolvePresidencyAfterRound();
    s.phase = PHASE.NOMINATION;
    this.#logEvent('presidencyPassed', { presidentId: s.presidentId });
  }

  // Chaos: top policy enacted (power ignored), tracker AND term limits reset.
  #chaosEnact() {
    const s = this.#s();
    const policy = this.#drawTop();
    this.#applyEnact(policy, { chaos: true });
    if (s.phase === PHASE.GAME_OVER) return; // the chaos tile ended the game
    s.tracker = 0;
    s.lastPresidentId = null;
    s.lastChancellorId = null;
    s.nominatedChancellorId = null;
    s.chancellorId = null;
    this.#resolvePresidencyAfterRound();
    s.phase = PHASE.NOMINATION;
    this.#logEvent('chaos', { trackerReset: true, termLimitsReset: true, presidentId: s.presidentId });
  }

  // ------------------------------------------------------------------ powers

  investigate(presidentId, targetId) {
    const s = this.#s();
    this.#requirePower(POWER.INVESTIGATE, presidentId);
    const target = this.#p(targetId);
    if (!target.alive) this.#fail('DEAD_TARGET', 'Cannot investigate a dead player.');
    if (target.id === s.presidentId) this.#fail('BAD_TARGET', 'The president cannot investigate himself.');
    if (s.investigatedIds.has(target.id)) this.#fail('ALREADY_INVESTIGATED', `${target.id} was already investigated this game.`);
    s.investigatedIds.add(target.id);
    s.lastInvestigation = {
      presidentId: s.presidentId,
      targetId: target.id,
      party: target.role === ROLE.LIBERAL ? PARTY.LIBERAL : PARTY.FASCIST,
    };
    this.#logEvent('investigated', { targetId: target.id });
    this.#finishPowerAction();
    return s.lastInvestigation;
  }

  policyPeek(presidentId) {
    const s = this.#s();
    this.#requirePower(POWER.POLICY_PEEK, presidentId);
    s.deck.ensureDrawable(3); // may reshuffle
    this.#checkReshuffle();
    const cards = s.deck.draw.slice(-3).reverse(); // top 3, draw order preserved
    s.lastPeek = { presidentId: s.presidentId, cards: [...cards] };
    this.#logEvent('policyPeek', { presidentId: s.presidentId });
    this.#finishPowerAction();
    return [...cards];
  }

  specialElection(presidentId, targetId) {
    const s = this.#s();
    this.#requirePower(POWER.SPECIAL_ELECTION, presidentId);
    const target = this.#p(targetId);
    if (!target.alive) this.#fail('DEAD_TARGET', 'Cannot pick a dead player.');
    if (target.id === s.presidentId) this.#fail('BAD_TARGET', 'Pick someone other than the current president.');
    const callerId = s.presidentId;
    s.pendingPower = null;
    s.specialElectionReturnId = callerId; // rotation resumes here after this round
    s.presidentId = target.id;
    s.nominatedChancellorId = null;
    s.chancellorId = null;
    s.phase = PHASE.NOMINATION;
    this.#logEvent('specialElection', { callerId, newPresidentId: target.id });
    return target.id;
  }

  execute(presidentId, targetId) {
    const s = this.#s();
    this.#requirePower(POWER.EXECUTE, presidentId);
    const target = this.#p(targetId);
    if (!target.alive) this.#fail('DEAD_TARGET', 'Player is already dead.');
    if (target.id === s.presidentId) this.#fail('BAD_TARGET', 'The president cannot execute himself.');
    target.alive = false;
    this.#logEvent('executed', { targetId: target.id });
    if (target.role === ROLE.HITLER) {
      this.#gameOver('liberal', 'hitlerExecuted');
      return target.id;
    }
    this.#finishPowerAction();
    return target.id;
  }

  #requirePower(power, actorId) {
    const s = this.#s();
    this.#requirePhase(PHASE.EXEC_ACTION, 'NO_POWER_PENDING');
    if (s.pendingPower !== power) this.#fail('WRONG_POWER', `Pending power is ${s.pendingPower}, not ${power}.`);
    const actor = this.#p(actorId);
    if (actor.id !== s.presidentId) this.#fail('NOT_PRESIDENT', 'Only the president may use the power.');
    return actor;
  }

  #finishPowerAction() {
    const s = this.#s();
    s.pendingPower = null;
    s.chancellorId = null;
    this.#resolvePresidencyAfterRound();
    s.phase = PHASE.NOMINATION;
    this.#logEvent('presidencyPassed', { presidentId: s.presidentId });
  }

  // ---------------------------------------------------------------- rotation

  // Normal rotation: next living player. If a special election is pending, the
  // round ends at the player left of the president who used the power.
  #resolvePresidencyAfterRound() {
    const s = this.#s();
    if (s.specialElectionReturnId != null) {
      const anchor = s.specialElectionReturnId;
      s.specialElectionReturnId = null;
      s.presidentId = this.seatAfter(anchor);
    } else {
      s.presidentId = this.seatAfter(s.presidentId);
    }
  }

  seatAfter(playerId) {
    const s = this.#s();
    const start = this.#p(playerId).seat;
    for (let i = 1; i <= s.players.length; i++) {
      const candidate = s.players[(start + i) % s.players.length];
      if (candidate.alive) return candidate.id;
    }
    this.#fail('NO_LIVING_PLAYERS', 'No living players left.');
  }

  // ------------------------------------------------------------------- views

  publicView() {
    this.#s();
    return buildPublicView(this);
  }

  privateView(playerId) {
    this.#s();
    return buildPrivateView(this, String(playerId));
  }

  // ----------------------------------------------------------------- helpers

  livingPlayers() {
    return this.#s().players.filter((p) => p.alive).map((p) => p.id);
  }

  livingCount() {
    return this.livingPlayers().length;
  }

  playerCount() {
    return this.#s().players.length;
  }

  #drawTop() {
    const s = this.#s();
    const card = s.deck.drawTop(); // deck auto-reshuffles if empty
    this.#checkReshuffle();
    return card;
  }

  #checkReshuffle() {
    const s = this.#s();
    if (s.deck.reshuffled) {
      s.deck.reshuffled = false;
      this.#logEvent('reshuffled', { drawCount: s.deck.draw.length, discardCount: s.deck.discard.length });
    }
  }

  #gameOver(winner, reason) {
    const s = this.#s();
    s.phase = PHASE.GAME_OVER;
    s.winner = winner;
    s.winReason = reason;
    this.#logEvent('gameOver', { winner, reason });
  }

  #s() {
    if (!this.state) this.#fail('NO_GAME', 'Call startGame() first.');
    return this.state;
  }

  #p(id) {
    const s = this.#s();
    const p = s.players.find((pl) => pl.id === String(id));
    if (!p) this.#fail('UNKNOWN_PLAYER', `No player ${id}`);
    return p;
  }

  #requirePhase(phase, code) {
    const s = this.#s();
    if (s.phase !== phase) this.#fail(code || 'WRONG_PHASE', `Expected phase ${phase}, but game is in ${s.phase}.`);
  }

  #fail(code, message) {
    this.#emit('invalidAction', { code, message });
    throw new EngineError(code, message);
  }

  #emit(type, data) {
    const event = { seq: ++this._seq, type, ...data };
    if (this.onEvent) this.onEvent(event);
    return event;
  }

  #logEvent(type, data) {
    const event = this.#emit(type, data);
    this.#s().log.push(event);
  }
}
