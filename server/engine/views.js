// Public and private views of the game state.
// The public view is safe for the big board (no roles, no hands, no secrets).
// The private view adds everything a given player is entitled to know.

import { EngineError } from './errors.js';
import { PHASE, ROLE, POWERS_BY_PLAYER_COUNT, VETO_UNLOCK_FASCIST } from './constants.js';

export function buildPublicView(engine) {
  const s = engine.state;
  return {
    phase: s.phase,
    playerCount: s.players.length,
    players: s.players.map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      alive: p.alive,
      isPresident: p.id === s.presidentId,
      isChancellor: p.id === s.chancellorId,
      isNominatedChancellor: p.id === s.nominatedChancellorId,
    })),
    presidentId: s.presidentId,
    chancellorId: s.chancellorId,
    nominatedChancellorId: s.nominatedChancellorId,
    // Term-limit markers are public board info.
    lastPresidentId: s.lastPresidentId,
    lastChancellorId: s.lastChancellorId,
    specialElectionActive: s.specialElectionReturnId != null,
    tracker: s.tracker,
    liberalCount: s.liberalCount,
    fascistCount: s.fascistCount,
    drawCount: s.deck.draw.length,
    discardCount: s.deck.discard.length,
    powersTable: POWERS_BY_PLAYER_COUNT[s.players.length] ?? {},
    vetoUnlocked: s.fascistCount >= VETO_UNLOCK_FASCIST,
    vetoRequested: s.vetoRequested,
    pendingPower: s.pendingPower,
    // During voting: who has voted (choices hidden until resolved).
    votesReceived: s.phase === PHASE.VOTE ? [...s.votes.keys()] : [],
    votesExpected: engine.livingCount(),
    lastVote: s.lastVote ? { ...s.lastVote, votes: { ...s.lastVote.votes } } : null,
    investigatedIds: [...s.investigatedIds],
    eligibleChancellors: engine.eligibleChancellors(),
    winner: s.winner,
    winReason: s.winReason,
    log: s.log.slice(),
  };
}

export function buildPrivateView(engine, playerId) {
  const s = engine.state;
  const me = s.players.find((p) => p.id === playerId);
  if (!me) throw new EngineError('UNKNOWN_PLAYER', `No player ${playerId}`);
  const view = buildPublicView(engine);

  view.you = { id: me.id, role: me.role, alive: me.alive };

  // Role-reveal knowledge: fascists always know each other and Hitler;
  // Hitler knows the fascists only in 5–6 player games.
  const fascists = s.players.filter((p) => p.role === ROLE.FASCIST && p.id !== me.id);
  const hitler = s.players.find((p) => p.role === ROLE.HITLER);
  const known = { fascists: [], hitlerId: null };
  if (me.role === ROLE.FASCIST) {
    known.fascists = fascists.map((p) => p.id);
    known.hitlerId = hitler ? hitler.id : null;
  } else if (me.role === ROLE.HITLER && s.players.length <= 6) {
    known.fascists = s.players.filter((p) => p.role === ROLE.FASCIST).map((p) => p.id);
  }
  view.teammates = known;

  // Hands are visible only to their holder (copies — callers cannot mutate state).
  if (s.phase === PHASE.LEGISLATIVE_PRESIDENT && me.id === s.presidentId) {
    view.hand = [...s.hand];
  }
  if (s.phase === PHASE.LEGISLATIVE_CHANCELLOR && me.id === s.chancellorId) {
    view.chancellorHand = [...s.chancellorHand];
  }
  if (s.lastPeek && s.lastPeek.presidentId === me.id) {
    view.lastPeek = [...s.lastPeek.cards];
  }
  if (s.lastInvestigation && s.lastInvestigation.presidentId === me.id) {
    view.lastInvestigation = { ...s.lastInvestigation };
  }
  return view;
}
