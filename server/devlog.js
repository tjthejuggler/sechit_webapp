// DEV-only console game logger (active only when DEV_PLAYERS is set): prints a
// concise, timestamped, one-line-per-event summary of everything happening in
// the game — elections with per-player votes, the full legislative chain with
// actual card identities (dev mode is for testing, so secrets are fine),
// executive powers, chaos, vetoes and the win condition. It is a pure observer:
// wrapped in try/catch so a logging bug can never break the game loop, and it
// mutates nothing.

const initial = (name) => name[0].toUpperCase() + name.slice(1);

/**
 * Wrap the session's engine-event handler with the dev logger.
 * @param {(event: object) => void} delegate session's own engine-event handler
 * @param {GameSession} session the live session (names + engine state access)
 * @returns {(event: object) => void} composed engine-event handler
 */
export function withDevLog(delegate, session) {
  return (event) => {
    try {
      logEvent(session, event);
    } catch {
      /* dev logging must never break the game */
    }
    delegate(event);
  };
}

function ts() {
  return new Date().toISOString().slice(11, 19); // HH:MM:SS
}

function log(line) {
  console.log(`${ts()} [dev] ${line}`);
}

function logEvent(session, e) {
  const s = session.engine?.state;
  const name = (id) => {
    const p = s?.players.find((x) => x.id === id);
    return p ? p.name : String(id ?? '?');
  };
  const L = (card) => (card === 'liberal' ? 'L' : 'F');
  const cards = (list) => `[${(list ?? []).map(L).join('')}]`;
  const piles = () => `deck=${s?.deck.draw.length ?? '?'} discard=${s?.deck.discard.length ?? '?'}`;
  const boards = () => `board L${s?.liberalCount ?? 0}-F${s?.fascistCount ?? 0}`;

  switch (e.type) {
    case 'gameStarted':
      log(`game started: ${e.playerCount} players, first president ${name(e.presidentId)}`);
      break;
    case 'nominationStarted':
      log(`nomination round begins — president ${name(e.presidentId)}`);
      break;
    case 'presidentMoved':
      log(`board plaque: president is now ${name(e.presidentId)}`);
      break;
    case 'chancellorNominated':
      log(`election: ${name(e.presidentId)} nominates ${name(e.chancellorId)} as chancellor`);
      break;
    case 'voteCast': {
      // The event carries no choice — read it from the live tally (the map is
      // cleared only when the election resolves, after the last voteCast).
      const choice = s?.votes.get(e.voterId);
      log(`  vote: ${name(e.voterId)} → ${choice === 'ja' ? 'Ja' : choice === 'nein' ? 'Nein' : '?'}`);
      break;
    }
    case 'voteResolved':
      log(`election ${e.elected ? 'ELECTED' : 'failed'}: Ja=${e.ja} Nein=${e.nein} (${name(e.presidentId)} / ${name(e.chancellorId)})`);
      break;
    case 'electionFailed':
      log(`election tracker ${e.tracker}/3`);
      break;
    case 'governmentFormed':
      log(`government formed: President ${name(e.presidentId)} + Chancellor ${name(e.chancellorId)}`);
      break;
    case 'cardsDrawn':
      log(`legislative: president ${name(e.presidentId)} drew ${cards(s?.hand ?? [])} (${piles()})`);
      break;
    case 'presidentDiscarded': {
      const discarded = s?.deck.discard.at(-1);
      log(`legislative: president discarded ${discarded == null ? '?' : L(discarded)}, chancellor ${name(s?.chancellorId)} receives ${cards(s?.chancellorHand ?? [])}`);
      break;
    }
    case 'chancellorReceived':
      log(`legislative: chancellor ${name(e.chancellorId)} received the 2 policies`);
      break;
    case 'vetoRequested':
      log(`veto: chancellor ${name(e.chancellorId)} requests a veto`);
      break;
    case 'vetoRefused':
      log(`veto: president ${name(e.presidentId)} REFUSED — chancellor must enact`);
      break;
    case 'vetoAgreed':
      log(`veto agreed: all 3 policies discarded, tracker ${e.tracker}/3`);
      break;
    case 'policyEnacted': {
      // chancellorEnact discards the un-enacted card last, so the discard
      // pile's top card at event time is the chancellor's discard.
      const chancellorsDiscard = s?.deck.discard.at(-1);
      log(
        e.chaos
          ? `CHAOS: top policy auto-enacted ${L(e.policy)} — ${boards()} (tracker + term limits reset)`
          : `legislative: ENACTED ${L(e.policy)} (chancellor discarded ${chancellorsDiscard == null ? '?' : L(chancellorsDiscard)}) — ${boards()}, ${piles()}`,
      );
      break;
    }
    case 'reshuffled':
      log(`deck reshuffled: draw=${e.drawCount} discard=${e.discardCount}`);
      break;
    case 'powerGranted':
      log(`power granted (${e.power}) to president ${name(e.presidentId)}`);
      break;
    case 'policyPeek':
      log(`peek: president ${name(e.presidentId)} sees top 3: ${cards(s?.lastPeek?.cards ?? [])}`);
      break;
    case 'investigated':
      log(`investigate: ${name(s?.lastInvestigation?.presidentId)} → ${name(e.targetId)} = ${s?.lastInvestigation?.party ?? '?'} party`);
      break;
    case 'specialElection':
      log(`special election: ${name(e.callerId)} picks ${name(e.newPresidentId)} as next president`);
      break;
    case 'executed': {
      const target = s?.players.find((p) => p.id === e.targetId);
      const hitler = target?.role === 'hitler';
      log(`execution: ${name(e.targetId)} executed${hitler ? ' — HITLER IS DEAD' : ''}`);
      break;
    }
    case 'chaos':
      log(`chaos aftermath: presidency passes to ${name(e.presidentId)}`);
      break;
    case 'gameOver':
      log(`GAME OVER — ${initial(e.winner ?? '?')}s win (${e.reason})`);
      break;
    default:
      break;
  }
}
