// Bottom tab navigation for the player phone: Action (the main game flow),
// Board (public board state) and History (the previous turn, one turn only).
//
// Everything rendered here comes from the PUBLIC view the server already
// broadcasts (board counts, tracker, pile sizes, log, lastVote) — no server
// changes are needed. The Action tab carries a badge dot whenever the player
// is the one who must act (vote, nominate, draw/discard, enact, power, ack).
import { t } from '../shared/i18n.js';

const $ = (sel) => document.querySelector(sel);

const ELECTION_TRACKER_MAX = 3;

let currentTab = 'action';

// ---------------------------------------------------------------- switching

export function initTabs() {
  document.querySelectorAll('#tab-bar button').forEach((btn) => {
    btn.addEventListener('click', () => setPage(btn.dataset.tab));
  });
}

export function setPage(tab) {
  currentTab = tab;
  document.querySelectorAll('#tab-bar button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
  const target = tab === 'board' ? '#page-board' : tab === 'history' ? '#page-history' : '#page-action';
  $(target).classList.remove('hidden');
}

export function currentPage() {
  return currentTab;
}

// The tab bar exists only while a game is actually running (never in the
// lobby / spectator pre-join states).
export function setTabBarVisible(visible) {
  $('#tab-bar').classList.toggle('hidden', !visible);
  if (!visible) setPage('action');
}

// ---------------------------------------------------------------- attention

// True when THIS player is the actor the game is waiting on. Drives the
// badge dot on the Action tab so players notice something needs them.
export function needsAttention(state, you) {
  if (!you || !you.you?.alive) return false;
  const me = you.you.id;
  if (state.investigationAnnounce
      && !state.investigationAnnounce.ackedIds.includes(me)) return true;
  switch (state.phase) {
    case 'NOMINATION': return state.presidentId === me;
    case 'VOTE': return !state.votesReceived?.includes(me);
    case 'LEGISLATIVE_PRESIDENT': return state.presidentId === me;
    case 'LEGISLATIVE_CHANCELLOR': return state.chancellorId === me;
    case 'EXEC_ACTION': return state.presidentId === me;
    default: return false;
  }
}

export function renderTabs(state, you) {
  $('#tab-action-badge').classList.toggle('hidden', !needsAttention(state, you));
}

// ------------------------------------------------------------------- board

function fillSlots(container, filled, total, cls) {
  container.replaceChildren(...Array.from({ length: total }, (_, i) => {
    const s = document.createElement('span');
    s.className = `slot ${cls} ${i < filled ? 'filled' : ''}`;
    return s;
  }));
}

export function renderBoardPage(state) {
  $('#board-pres-name').textContent = state.presidentId
    ? nameOf(state, state.presidentId) : '—';
  $('#board-chanc-name').textContent = state.chancellorId
    ? nameOf(state, state.chancellorId) : '—';

  $('#board-lib-count').textContent = `${state.liberalCount}/5`;
  $('#board-fasc-count').textContent = `${state.fascistCount}/6`;
  fillSlots($('#board-lib-slots'), state.liberalCount, 5, 'liberal');
  fillSlots($('#board-fasc-slots'), state.fascistCount, 6, 'fascist');

  const tracker = $('#board-tracker');
  tracker.replaceChildren(...Array.from({ length: ELECTION_TRACKER_MAX }, (_, i) => {
    const m = document.createElement('span');
    m.className = `tracker-marker ${i < state.tracker ? 'filled' : ''}`;
    return m;
  }));

  $('#board-draw-count').textContent = t('play.page.board.cards', { n: state.drawCount });
  $('#board-discard-count').textContent = t('play.page.board.cards', { n: state.discardCount });
}

// ----------------------------------------------------------------- history

// Event types that make up one "turn" on the history page. voteCast /
// cardsDrawn / presidentDiscarded / chancellorReceived are deliberately
// excluded — the history shows outcomes, not every micro-step.
const TURN_EVENTS = new Set([
  'chancellorNominated', 'voteResolved', 'electionFailed', 'governmentFormed',
  'policyEnacted', 'vetoRequested', 'vetoAgreed', 'vetoRefused', 'powerGranted',
  'investigated', 'policyPeek', 'specialElection', 'executed', 'chaos',
  'reshuffled',
]);

// Slice the log into turns: a turn STARTS at each nomination (the initial
// nominationStarted, then every chancellorNominated) and runs until the next
// one. A failed election is its own short turn — exactly the election result.
export function lastTurnEvents(state) {
  const log = (state.log ?? []).filter((e) => e && e.type !== 'invalidAction');
  let start = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    const ty = log[i].type;
    if (ty === 'chancellorNominated' || ty === 'nominationStarted') { start = i; break; }
  }
  if (start === -1) return [];
  return log.slice(start).filter((e) => TURN_EVENTS.has(e.type));
}

export function renderHistoryPage(state) {
  const box = $('#history-turn');
  const events = lastTurnEvents(state);
  if (!events.length) {
    box.innerHTML = `<p class="muted center">${esc(t('play.page.history.empty'))}</p>`;
    return;
  }
  box.replaceChildren(...events.map((e) => {
    const p = document.createElement('p');
    p.className = 'history-line';
    p.innerHTML = historyLineText(state, e);
    return p;
  }));
}

function historyLineText(state, e) {
  const n = (id) => esc(nameOf(state, id));
  switch (e.type) {
    case 'chancellorNominated':
      return t('board.log.chancellorNominated', { pres: n(e.presidentId), chanc: n(e.chancellorId) });
    case 'nominationStarted':
      return t('board.log.nominationStarted', { name: n(e.presidentId) });
    case 'voteResolved':
      return t('play.page.history.vote', {
        ja: e.ja, nein: e.nein,
        outcome: e.elected ? t('board.log.voteResolvedElected') : t('board.log.voteResolvedRejected'),
      });
    case 'electionFailed':
      return t('board.log.electionFailed', { n: e.tracker });
    case 'governmentFormed':
      return t('board.log.governmentFormed', { pres: n(e.presidentId), chanc: n(e.chancellorId) });
    case 'policyEnacted':
      return t('board.log.policyEnacted', {
        party: e.policy === 'liberal' ? t('play.card.liberal') : t('play.card.fascist'),
        chaos: e.chaos ? t('board.log.chaosSuffix') : '',
        l: e.liberalCount, f: e.fascistCount,
      });
    case 'vetoRequested': return t('board.log.vetoRequested');
    case 'vetoAgreed': return t('board.log.vetoAgreed', { n: e.tracker });
    case 'vetoRefused': return t('board.log.vetoRefused');
    case 'powerGranted':
      return t('board.log.powerGranted', { power: t(`board.power.${e.power}`) ?? e.power });
    case 'investigated':
      return t('board.log.investigated', { pres: n(e.presidentId), target: n(e.targetId) });
    case 'policyPeek': return t('board.log.policyPeek', { name: n(e.presidentId) });
    case 'specialElection': return t('board.log.specialElection', { name: n(e.newPresidentId) });
    case 'executed': return t('board.log.executed', { name: n(e.targetId) });
    case 'reshuffled': return t('board.log.reshuffled');
    case 'chaos': return t('board.log.chaos');
    default: return esc(e.type);
  }
}

// ---------------------------------------------------------------- helpers

function nameOf(state, id) {
  return state.players?.find((p) => p.id === id)?.name ?? id ?? '—';
}

function esc(text) {
  const map = { '&': 'amp;', '<': 'lt;', '>': 'gt;', '"': 'quot;', "'": '#39;' };
  return String(text ?? '').replace(/[&<>"']/g, (c) => `&${map[c]}`);
}
