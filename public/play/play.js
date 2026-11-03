// Phone client: join, private role cards, voting, legislative flows, veto and
// executive powers. One socket on /play; the session token persists in
// localStorage so a refresh or reconnect resumes the same seat. Dev players
// bind via ?p=<token> (URL param wins over localStorage).
//
// Highlights:
//  - Hold-to-reveal role/party cards (press-and-hold, all game long via the
//    persistent "My Role" button). Cards are COMPLETELY neutral until held:
//    no seal, no team colour, no party imagery anywhere pre-hold.
//  - No QR codes on player phones: the president draws with one tap, the
//    chancellor confirms receipt with one tap, and targeted powers
//    (investigate / special election / execution) pick a name from a list.
//  - All team knowledge stays private to the entitled player's screen.
//  - i18n: all strings via public/shared/i18n.js; the EN|TR toggle in the top
//    bar re-renders the current screen live (role/party art is language-
//    neutral EN art in both languages — no TR variants exist for cards).
import {
  connectPlay,
  sendAction,
  socketEmit,
  showToast,
  loadToken,
  saveToken,
} from '../shared/shared.js';
import {
   t, getLang, setLang, onChange, applyI18n, createLangToggle, errorText,
 } from '../shared/i18n.js';
import {
  initTabs, setTabBarVisible, renderTabs, renderBoardPage, renderHistoryPage,
  setPage, currentPage, needsAttention,
} from './tabs.js';

const $ = (sel) => document.querySelector(sel);

const ROLE_ART = {
  liberal: '/assets/role_liberal.png',
  fascist: '/assets/role_fascist.png',
  hitler: '/assets/role_hitler.png',
};

const PARTY_ART = {
  liberal: '/assets/party_liberal.png',
  fascist: '/assets/party_fascist.png',
};

function roleDesc(role) {
  return t(`play.role.desc.${role}`);
}

function roleTitle(role) {
  return { liberal: t('play.card.liberal'), fascist: t('play.card.fascist'), hitler: 'Hitler' }[role] ?? role;
}

let you = null;          // latest private view for this player
let myToken = loadToken();
let staleToken = false; // set when the server reports our seat vanished
let myId = null;
let myName = null;
let voteCast = false;   // our ballot is locked in for the current election
let shownVoteSig = null; // vote-reveal dedup: only show each result once
let dismissedPeekSig = null; // policy-peek result already dismissed (dedup key)
let dismissedInvestigationSig = null; // investigation result already dismissed (dedup key)
let renderSeq = 0;      // monotonic render counter (staleness guard)
let pendingUrlAction = null; // { kind: 'draw' } from ?d= (board deck QR)
let shownExecuteTarget = null; // execution confirm dedup

// ------------------------------------------------------------------ socket

const socket = connectPlay({ token: myToken });

socket.on('hello', (msg) => {
  if (msg.reconnectedAs) myId = msg.reconnectedAs;
});

socket.on('lobby', (msg) => {
  if (!msg.lobbyOpen) return;
  // A board reset invalidates our stored token — forget it and show join.
  if (msg.seated === false && myToken) {
    staleToken = true;
    myToken = null;
    myId = null;
    myName = null;
    you = null;
    renderLobby();
  }
  if (msg.lobbyOpen) renderRoster(msg.players ?? []);
});

socket.on('state', (state) => {
  if (!state) return;
  if (state.you) {
    you = state;
    myId = state.you.id;
  } else if (state.phase === 'LOBBY') {
    you = null; // lobby broadcasts carry no private data
  }
  render(state);
  firePendingUrlAction(state);
});

socket.on('connect', () => {
  // Re-announce our token so the server re-binds this socket to a seat even
  // if the handshake auth missed (e.g. stale socket after server restart).
  if (myToken) socket.emit('identify', { token: myToken });
});

// Language switch: re-render the current screen live + refresh static chrome.
onChange(() => {
  $('#btn-my-role').textContent = t('play.hold.role');
  applyI18n();
  if (you) render(you);
});

// A new attention badge is easy to miss while the player browses Board or
// History — bounce them back to the Action tab the moment it is THEIR turn.
function snapToActionWhenNeeded(state) {
  if (currentPage() !== 'action' && needsAttention(state, you)) setPage('action');
}

// --------------------------------------------- URL params (?p= / ?d=)

// ?p=<token> binds this tab to a seat WITHOUT the join form (dev players:
// start.sh opens one desktop tab per dev player). It wins over localStorage.
// ?d=<token> is the board's one-time deck QR: scanning it with the phone's
// native camera opens /play?d=<token> and triggers the president's draw.
function identifyAs(token) {
  // Ask the server to bind this socket to the token's seat; on success the
  // ack carries playerId + name, so the tab skips the join form entirely
  // (dev seats are pre-seated — no name entry needed).
  return socketEmit(socket, 'identify', { token })
    .then((res) => {
      if (res && res.ok !== false && res.playerId) {
        staleToken = false;
        myId = res.playerId;
        myName = res.name ?? myName;
        return true;
      }
      return false;
    })
    .catch(() => false);
}

(function captureUrlParams() {
  const params = new URLSearchParams(location.search);
  const devToken = params.get('p');
  const draw = params.get('d');
  if (devToken && /^[a-f0-9]{8,64}$/i.test(devToken)) {
    myToken = devToken;
    saveToken(myToken);
    identifyAs(myToken).then(() => renderLobby());
  }
  if (draw) pendingUrlAction = { kind: 'draw', token: draw };
  if (draw) history.replaceState(null, '', location.pathname); // one-shot
})();

function firePendingUrlAction(state) {
  if (!pendingUrlAction) return;
  if (state.phase === 'LOBBY' || !you) return; // wait until seated
  const { token } = pendingUrlAction;
  pendingUrlAction = null;
  act('draw', token ? { token } : {})
    .then(() => showToast(t('play.toast.drew')))
    .catch((err) => showToast(errText(err, t('play.toast.drawFailed')), { error: true }));
}

// ------------------------------------------------------------------ boot

$('#lang-toggle-play').replaceChildren(createLangToggle());
$('#btn-my-role').dataset.i18n = 'play.hold.role';
$('#join-name').dataset.i18nPlaceholder = 'play.join.placeholder';
$('#btn-join').dataset.i18n = 'play.join.button';
$('#join-status').dataset.i18n = 'play.join.status';
$('#wait-title').dataset.i18n = 'play.wait.default';
applyI18n();

// ------------------------------------------------------------------ router

// Tab bar (Action / Board / History) boots hidden; it appears once a game is
// running. The Action tab is the default and the only one that auto-opens.
initTabs();

function show(screenId) {
  // Scope to the Action page's screens: the Board/History pages are their
  // own top-level pages toggled by setPage(), never by this router.
  document.querySelectorAll('#page-action .screen').forEach((s) => s.classList.add('hidden'));
  if (screenId) $(screenId).classList.remove('hidden');
}

function render(state) {
  const seq = ++renderSeq;
  renderPhaseChip(state);

  if (state.phase === 'LOBBY') {
    setTabBarVisible(false);
    renderLobby();
    return;
  }

  // Secondary pages always track live state, whichever tab is on top.
  setTabBarVisible(true);
  renderTabs(state, you);
  renderBoardPage(state);
  renderHistoryPage(state);
  snapToActionWhenNeeded(state);

  if (state.phase === 'GAME_OVER') {
    renderGameOver(state);
    return;
  }

  if (!you) {
    // Mid-game without a seat: someone's tab closed and they rescanned the
    // board's persistent join QR — offer the "which player are you?" rejoin
    // picker instead of a dead spectator screen.
    if (state.players?.length && state.phase !== 'GAME_OVER') {
      renderRejoinPicker(state);
      return;
    }
    // No game running (spectator, or token lost after a reset).
    $('#spectator-title').textContent = t('play.spectator.title');
    $('#spectator-text').innerHTML = myName
      ? esc(t('play.spectator.named', { name: myName }))
      : t('play.spectator.anon');
    show('#screen-spectator');
    return;
  }

  $('#me-label').textContent = myName ?? you.you.id;

  // Vote reveal: show each resolved election once (before resuming the flow).
  // The result frame is often the ONLY broadcast after an election resolves
  // (the next one arrives only after someone acts), so after a brief pause we
  // re-render the same state — otherwise the president would never see the
  // draw/discard screen and the legislative session would stall forever.
  const sig = voteSig(state);
  if (sig && sig !== shownVoteSig && state.phase !== 'VOTE') {
    shownVoteSig = sig;
    voteCast = false; // election resolved — next VOTE phase starts clean
    renderVoteResult(state);
    const isActorFrame = state.phase === 'LEGISLATIVE_PRESIDENT' && you?.you?.id === state.presidentId;
    setTimeout(() => {
      if (seq === renderSeq) render(state); // no newer frame arrived meanwhile
    }, isActorFrame ? 900 : 2200);
    return;
  }

  if (!you.you.alive) {
    renderDead();
    return;
  }

  // Policy Peek result: the peek action is read-only for the engine and the
  // game advances immediately, so the result must render from ANY phase —
  // the president dismisses it with Continue and the flow resumes.
  const peekSig = Array.isArray(you.lastPeek) ? peekSignature(state) : null;
  if (peekSig && peekSig !== dismissedPeekSig) {
    renderPeekResult(state, peekSig);
    return;
  }

  // Investigation result: same situation as the peek — the engine advances
  // the game the moment the investigate action resolves, so the party reveal
  // must render from ANY phase; the president dismisses it with Continue.
  const invSig = you.lastInvestigation ? investigationSignature(state) : null;
  if (invSig && invSig !== dismissedInvestigationSig) {
    renderInvestigationResult(state, invSig);
    return;
  }

  // Investigation announcement: EVERY living player must acknowledge WHO was
  // investigated before the game can move on (server gates all actions).
  if (state.investigationAnnounce) {
    renderInvestigationAnnounce(state);
    return;
  }

  switch (state.phase) {
    case 'ROLE_REVEAL': renderRoleReveal(state); break;
    case 'NOMINATION': renderNomination(state); break;
    case 'VOTE': renderVote(state); break;
    case 'LEGISLATIVE_PRESIDENT': renderLegisPresident(state); break;
    case 'LEGISLATIVE_CHANCELLOR': renderLegisChancellor(state); break;
    case 'EXEC_ACTION': renderPower(state); break;
    default: renderWait(t('play.wait.default'));
  }
}

function renderPhaseChip(state) {
  const key = (state.phase === 'LEGISLATIVE_PRESIDENT' || state.phase === 'LEGISLATIVE_CHANCELLOR')
    ? 'play.chip.LEGISLATIVE'
    : `play.chip.${state.phase}`;
  $('#phase-chip').textContent = t(key) ?? state.phase;
}

function voteSig(state) {
  if (!state.lastVote) return null;
  const v = state.lastVote;
  return `${v.ja}-${v.nein}-${v.elected ? 1 : 0}-${v.chancellorId ?? ''}-${v.presidentId ?? ''}`;
}

// ------------------------------------------------------------------- lobby

function renderLobby() {
  show('#screen-join');
  if (myToken && myId && !staleToken) {
    $('#join-status').textContent = t('play.join.waiting');
    $('#join-form').classList.add('hidden');
  } else {
    $('#join-status').textContent = t('play.join.status');
    $('#join-form').classList.remove('hidden');
  }
}

function renderRoster(players) {
  $('#lobby-roster').textContent = players.length
    ? t('play.roster.seated', { names: players.map((p) => p.name).join(' · ') })
    : '';
}

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#join-name').value.trim();
  if (!name) return;
  try {
    const res = await socketEmit(socket, 'join', { name });
    staleToken = false;
    myToken = res.token;
    myId = res.playerId;
    myName = res.name;
    saveToken(myToken);
    $('#join-form').classList.add('hidden');
    $('#join-status').textContent = t('play.join.welcome', { name: res.name });
    showToast(t('play.join.joinedToast', { name: res.name }));
  } catch (err) {
    showToast(errText(err, t('play.join.couldNotJoin')), { error: true });
  }
});

// ------------------------------------------------- hold-to-reveal role cards

// Build a card whose back shows the official art. Reveal ONLY while held
// (pointerdown → reveal; pointerup/leave/cancel → hide). The FRONT (pre-hold
// state) is generic: no seal, no team colour — nothing leaks the role.
function makeHoldCard(cardEl, backEl, html) {
  backEl.replaceChildren();
  backEl.innerHTML = html;
  const reveal = () => cardEl.classList.add('revealed');
  const hide = () => cardEl.classList.remove('revealed');
  cardEl.onpointerdown = (e) => { e.preventDefault(); reveal(); };
  cardEl.onpointerup = hide;
  cardEl.onpointerleave = hide;
  cardEl.onpointercancel = hide;
  // Context-menu / long-press suppression on mobile.
  cardEl.oncontextmenu = (e) => e.preventDefault();
}

// The persistent "My Role" hold-button works in EVERY phase (and for the
// dead), so players can privately re-check their secret role all game.
// The overlay starts EMPTY: art is injected only at pointerdown, so nothing
// about role/team is ever in the DOM (or visible) before the press.
// Wipe art and hide; registered at the WINDOW level so the release is caught
// no matter which element the pointer ends up over once the overlay opens.
function hideMyRole() {
  $('#my-role-art').removeAttribute('src'); // wipe art on release
  $('#my-role-party-art').removeAttribute('src');
  $('#my-role-overlay').classList.add('hidden');
}
$('#btn-my-role').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!you) return;
  const role = you.you.role;
  const party = role === 'hitler' ? 'fascist' : role;
  $('#my-role-art').src = ROLE_ART[role] ?? '';
  $('#my-role-art').alt = `${roleTitle(role)} ${t('play.role.altSuffix')}`;
  $('#my-role-party-art').src = PARTY_ART[party] ?? '';
  $('#my-role-party-art').alt = t('play.role.partyCardAlt', { party: partyTitle(party) });
  $('#my-role-overlay').classList.remove('hidden');
});
['pointerup', 'pointercancel'].forEach((ev) => {
  window.addEventListener(ev, hideMyRole, true); // capture: fires first, any target
});
// Long-press suppression on BOTH button and overlay — without this, mobile
// browsers fire contextmenu/pointercancel on the held button and the reveal
// dies instantly (the big role-reveal cards suppress it via makeHoldCard).
$('#btn-my-role').oncontextmenu = (e) => e.preventDefault();
$('#my-role-overlay').oncontextmenu = (e) => e.preventDefault();

// ------------------------------------------------------------------- role

function renderRoleReveal(state) {
  show('#screen-role');
  $('#me-label').textContent = myName ?? you.you.id;
  const roleCard = $('#role-card');
  const partyCard = $('#party-card');

  // Front faces stay generic regardless of role (no team class on the shell —
  // only the hidden back face may carry team styling).
  roleCard.className = 'tap-card';
  partyCard.className = 'tap-card';

  makeHoldCard(roleCard, $('#role-card-back'), `
    <img class="card-art" src="${ROLE_ART[you.you.role]}" alt="${roleTitle(you.you.role)} ${t('play.role.altSuffix')}" draggable="false" />
    <div class="role-desc">${roleDesc(you.you.role)}</div>`);

  const party = you.you.role === 'hitler' ? 'fascist' : you.you.role;
  makeHoldCard(partyCard, $('#party-card-back'), `
    <img class="card-art slim" src="${PARTY_ART[party]}" alt="${t('play.role.partyCardAlt', { party: partyTitle(party) })}" draggable="false" />`);

  const tm = you.teammates ?? { fascists: [], hitlerId: null };
  const box = $('#teammates-box');
  const lines = [];
  if (you.you.role === 'fascist') {
    lines.push(t('play.role.teammates.hitler', { name: esc(nameOf(state, tm.hitlerId)) }));
    for (const f of tm.fascists) {
      if (f !== you.you.id) lines.push(t('play.role.teammates.fellowFascist', { name: esc(nameOf(state, f)) }));
    }
  } else if (you.you.role === 'hitler') {
    if (tm.fascists.length) {
      lines.push(t('play.role.teammates.yourFascists', {
        names: tm.fascists.map((f) => esc(nameOf(state, f))).join(', '),
      }));
    } else {
      lines.push(t('play.role.teammates.alone'));
    }
  }
  box.innerHTML = lines.join('<br />');
  box.classList.toggle('hidden', lines.length === 0);

  $('#role-hint').textContent = t('play.role.hint');
}

function partyTitle(party) {
  return party === 'liberal' ? t('play.card.liberal') : t('play.card.fascist');
}

// -------------------------------------------------------------- nomination

function renderNomination(state) {
  if (you.you.id !== state.presidentId) {
    renderWait(t('play.nom.wait', { name: nameOf(state, state.presidentId) }));
    return;
  }
  show('#screen-nominate');
  $('#nominate-title').textContent = state.specialElectionActive
    ? t('play.nom.special')
    : t('play.nom.title');
  $('#nominate-list').replaceChildren(...state.eligibleChancellors.map((pid) => {
    const btn = document.createElement('button');
    btn.className = 'picker-btn';
    const nm = document.createElement('span');
    nm.textContent = nameOf(state, pid);
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = t('play.nom.sub');
    btn.append(nm, sub);
    btn.onclick = () => act('nominate', { targetId: pid }).catch(() => {});
    return btn;
  }));
  if (!state.eligibleChancellors.length) {
    $('#nominate-list').innerHTML = `<p class="muted center">${esc(t('play.nom.none'))}</p>`;
  }
}

// ------------------------------------------------------------------- vote

function renderVote(state) {
  show('#screen-vote');
  $('#vote-context').innerHTML = t('play.vote.context', {
    pres: esc(nameOf(state, state.presidentId)),
    chanc: esc(nameOf(state, state.nominatedChancellorId)),
  });
  // The server is authoritative: every new election resets votesReceived, so
  // a fresh ballot ALWAYS unlocks here — even if the previous result frame
  // was never shown (e.g. identical back-to-back election signatures, which
  // used to leave the local voteCast flag stuck and required a refresh).
  const serverVoted = state.votesReceived.includes(you.you.id);
  if (!serverVoted) voteCast = false;
  const voted = voteCast || serverVoted;
  $('#vote-buttons').classList.toggle('hidden', voted);
  $('#vote-waiting').classList.toggle('hidden', !voted);
  if (!voted) $('#vote-result').classList.add('hidden');
}

// One tap on a ballot casts the vote immediately — no confirm step. The
// buttons hide (vote locked) right away; the server rejects double-votes
// anyway (ALREADY_VOTED), which we treat as "already locked in".
async function castVote(choice) {
  if (voteCast) return;
  voteCast = true;
  $('#vote-buttons').classList.add('hidden');
  $('#vote-waiting').classList.remove('hidden');
  try {
    await act('vote', { vote: choice });
  } catch (err) {
    if (err?.code !== 'ALREADY_VOTED') {
      voteCast = false; // transient failure — let the player tap again
      $('#vote-buttons').classList.remove('hidden');
      $('#vote-waiting').classList.add('hidden');
      showToast(errText(err, err?.message ?? ''), { error: true });
    }
  }
}

$('#btn-ja').onclick = () => castVote('ja');
$('#btn-nein').onclick = () => castVote('nein');

function renderVoteResult(state) {
  show('#screen-vote');
  $('#vote-context').innerHTML = state.lastVote.elected
    ? t('play.vote.resultElected')
    : t('play.vote.resultRejected');
  $('#vote-buttons').classList.add('hidden');
  $('#vote-waiting').classList.add('hidden');
  $('#vote-result').classList.remove('hidden');
  $('#vote-result').replaceChildren(
    ...Object.entries(state.lastVote.votes).map(([pid, choice]) => {
      const chip = document.createElement('div');
      chip.className = `result-chip ${choice}`;
      const nm = document.createElement('span');
      nm.textContent = nameOf(state, pid);
      const c = document.createElement('span');
      c.className = 'choice';
      c.textContent = choice;
      chip.append(nm, c);
      return chip;
    }),
    (() => {
      const p = document.createElement('p');
      p.className = 'center';
      p.innerHTML = t('play.vote.tally', { ja: state.lastVote.ja, nein: state.lastVote.nein });
      return p;
    })(),
  );
}

// --------------------------------------------------- legislative: president

function renderLegisPresident(state) {
  if (you.you.id !== state.presidentId) {
    renderWait(t('play.legis.waitPresident', { name: nameOf(state, state.presidentId) }));
    return;
  }

  // Step 2: hand of 3 → drag one to the trash to discard it.
  if (Array.isArray(you.hand) && you.hand.length === 3) {
    show('#screen-legis-president');
    $('#draw-box').classList.add('hidden');
    $('#transfer-box').classList.add('hidden');
    $('#discard-box').classList.remove('hidden');
    renderDiscardCards($('#discard-cards'), $('#discard-trash'), you.hand, async (i) => {
      try {
        await act('discard', { cardIndex: i });
        showToast(t('play.toast.discarded'));
      } catch { /* state refresh shows the next step */ }
    });
    return;
  }

  // Step 1: draw with ONE TAP (no QR). The board's deck QR (?d=) also works.
  show('#screen-legis-president');
  $('#discard-box').classList.add('hidden');
  $('#transfer-box').classList.add('hidden');
  $('#draw-box').classList.remove('hidden');
}

$('#btn-draw').onclick = async () => {
  try {
    await act('draw', {});
    showToast(t('play.toast.drew'));
  } catch (err) {
    showToast(errText(err, t('play.toast.drawFailed')), { error: true });
  }
};

// ------------------------------------------------- transfer ack (chancellor)

function renderTransferStep(state) {
  show('#screen-legis-president');
  $('#draw-box').classList.add('hidden');
  $('#discard-box').classList.add('hidden');
  $('#transfer-box').classList.remove('hidden');
}

// ------------------------------------------------- legislative: chancellor

function renderLegisChancellor(state) {
  if (you.you.id === state.presidentId) {
    if (state.vetoRequested) {
      renderVetoRespond();
    } else {
      renderWait(t('play.legisChanc.enactWait'));
    }
    return;
  }

  if (you.you.id !== state.chancellorId) {
    renderWait(t('play.legis.waitChancellor', { name: nameOf(state, state.chancellorId) }));
    return;
  }

  // Step 3: hand of 2 → enact one (or veto). Gate: confirm receipt first.
  if (Array.isArray(you.chancellorHand) && you.chancellorHand.length === 2) {
    show('#screen-legis-chancellor');
    const acked = state.transferPending !== true;
    $('#receive-box').classList.toggle('hidden', acked);
    $('#enact-box').classList.toggle('hidden', !acked);
    if (acked) {
      $('#btn-veto').classList.toggle('hidden', !state.vetoUnlocked || state.vetoRequested);
      $('#btn-veto').disabled = state.vetoRequested;
      $('#veto-waiting').classList.toggle('hidden', !state.vetoRequested);
      // Drag the card to PLAY onto the boards zone (it shows the live policy
      // counts) — the OTHER card is discarded. Tap = play the tapped card.
      $('#enact-lib-count').textContent = `${state.liberalCount}/5`;
      $('#enact-fasc-count').textContent = `${state.fascistCount}/6`;
      renderDiscardCards($('#enact-cards'), $('#enact-boards'), you.chancellorHand, async (i) => {
        try {
          await act('enact', { cardIndex: i });
        } catch { /* state refresh handles it */ }
      }, 'play.card.dragToBoards');
    }
    return;
  }

  // Waiting for the president to discard.
  show('#screen-legis-chancellor');
  $('#enact-box').classList.add('hidden');
  $('#receive-box').classList.add('hidden');
}

$('#btn-receive').onclick = async () => {
  try {
    await act('receive', {});
    showToast(t('play.toast.received'));
  } catch (err) {
    showToast(errText(err, t('play.toast.receiveFailed')), { error: true });
  }
};

// ------------------------------------------------------------------- veto

$('#btn-veto').onclick = async () => {
  try {
    await act('vetoRequest', {});
    $('#btn-veto').classList.add('hidden');
    $('#veto-waiting').classList.remove('hidden');
  } catch (err) {
    showToast(errText(err, t('play.toast.vetoFailed')), { error: true });
  }
};

$('#btn-veto-agree').onclick = async () => {
  try { await act('vetoRespond', { consent: true }); } catch { /* refresh handles */ }
};
$('#btn-veto-refuse').onclick = async () => {
  try { await act('vetoRespond', { consent: false }); } catch { /* refresh handles */ }
};

function renderVetoRespond() {
  show('#screen-veto-respond');
}

// --------------------------------------------------------- executive power

// Locally remembered execution pick (cleared on cancel / other powers).
let execPick = null;

function renderScanTargets(state, power, { verb }) {
  const body = $('#power-body');
  const wrap = document.createElement('div');
  const note = document.createElement('p');
  note.className = 'muted small center';
  note.textContent = t('play.power.pick', { verb });
  wrap.append(note);

  // Pick-from-list targeting (no QR): every eligible target is a tap.
  // For `execute`, tapping only ARMS the pick — the confirm screen (top of
  // renderPower) fires the irreversible action on the second tap.
  const armOnly = power === 'execute';
  const list = document.createElement('div');
  list.className = 'picker-list';
  const candidates = state.players.filter((p) => p.alive && p.id !== you.you.id
    && !(power === 'investigate' && state.investigatedIds.includes(p.id)));
  for (const p of candidates) {
    const sub = armOnly ? t('play.card.tapToSelect') : t('play.card.tapTo', { verb });
    list.appendChild(pickerBtn(p.name, sub, () => {
      if (armOnly) {
        execPick = p.id;
        render(state); // re-render into the confirm view
      } else {
        act(power, { targetId: p.id }).catch((err) => showToast(errText(err), { error: true }));
      }
    }));
  }
  if (!candidates.length) {
    list.innerHTML = `<p class="muted center">${esc(t('play.power.noTargets'))}</p>`;
  }
  body.replaceChildren(wrap, list);
}

// Dismissible Policy Peek result: shows the top-3 policies as CSS tiles on
// the president's phone from ANY phase (the engine already moved the game on
// — peek is read-only). Continue dismisses it and resumes the live flow.
function renderPeekResult(state, sig) {
  show('#screen-power');
  $('#power-title').textContent = t('play.power.policyPeek');
  const body = $('#power-body');
  body.replaceChildren();
  const note = document.createElement('p');
  note.className = 'center muted';
  note.textContent = t('play.power.peekResult');
  body.appendChild(note);
  const row = document.createElement('div');
  row.className = 'policy-row';
  renderPolicyCards(row, you.lastPeek, null, null);
  body.appendChild(row);
  const btn = document.createElement('button');
  btn.className = 'big';
  btn.id = 'btn-peek-dismiss';
  btn.textContent = t('play.btn.continue');
  btn.onclick = () => {
    dismissedPeekSig = sig;
    render(state);
  };
  body.appendChild(btn);
}

// Unique key per peek: how many peeks have happened + the cards themselves, so
// a dismissed peek never re-shows but a genuinely new peek always does.
function peekSignature(state) {
  const peeks = (state.log ?? []).filter((e) => e && e.type === 'policyPeek').length;
  return `${peeks}:${you.lastPeek.join(',')}`;
}

// Unique key per investigation: how many have happened + target + party, so a
// dismissed result never re-shows but a genuinely new one always does.
function investigationSignature(state) {
  const inv = you.lastInvestigation;
  if (!inv?.targetId) return null;
  const count = (state.log ?? []).filter((e) => e && e.type === 'investigated').length;
  return `${count}:${inv.targetId}:${inv.party}`;
}

// Full-broadcast investigation announcement: everyone sees WHO was
// investigated (not the party) and must tap an acknowledgement button; the
// server blocks all game actions until every living player has done so.
function renderInvestigationAnnounce(state) {
  const a = state.investigationAnnounce;
  show('#screen-power');
  $('#power-title').textContent = t('play.power.announceTitle');
  const body = $('#power-body');
  const note = document.createElement('p');
  note.className = 'center';
  note.innerHTML = t('play.power.announceBody', {
    pres: esc(nameOf(state, a.presidentId)),
    target: esc(nameOf(state, a.targetId)),
  });
  body.replaceChildren(note);
  const living = state.players.filter((p) => p.alive);
  const acked = a.ackedIds.includes(you.you.id);
  if (acked) {
    const wait = document.createElement('p');
    wait.className = 'center muted small';
    wait.textContent = t('play.power.announceWaiting', {
      acked: a.ackedIds.length,
      total: living.length,
    });
    body.appendChild(wait);
    return;
  }
  const btn = document.createElement('button');
  btn.className = 'big';
  btn.innerHTML = t('play.power.announceAckNamed', {
    pres: esc(nameOf(state, a.presidentId)),
    target: esc(nameOf(state, a.targetId)),
  });
  btn.onclick = () => act('ackInvestigation', {}).catch(() => {});
  body.appendChild(btn);
}

// Dismissible investigation result: the party reveal is private to the
// president, and the engine has already moved the game on — so this renders
// from ANY phase and Continue dismisses it back into the live flow.
function renderInvestigationResult(state, sig) {
  show('#screen-power');
  $('#power-title').textContent = t('play.power.investigate');
  const inv = you.lastInvestigation;
  const party = inv.party;
  const body = $('#power-body');
  const note = document.createElement('p');
  note.className = 'center muted';
  note.textContent = t('play.power.investResult');
  const img = document.createElement('img');
  img.className = 'invest-card';
  img.src = PARTY_ART[party];
  img.alt = t('play.role.partyCardAlt', { party: partyTitle(party) });
  img.draggable = false;
  const line = document.createElement('p');
  line.className = 'center small';
  line.innerHTML = t('play.power.investMember', {
    name: esc(nameOf(state, inv.targetId)), party: partyTitle(party),
  });
  const btn = document.createElement('button');
  btn.className = 'big';
  btn.textContent = t('play.btn.continue');
  btn.onclick = () => {
    dismissedInvestigationSig = sig;
    render(state);
  };
  body.replaceChildren(note, img, line, btn);
}

function renderPower(state) {
  if (you.you.id !== state.presidentId) {
    renderWait(t('play.power.wait', { name: nameOf(state, state.presidentId) }));
    return;
  }
  show('#screen-power');
  const body = $('#power-body');
  const power = state.pendingPower;
  $('#power-title').textContent = t(`play.power.${power}`) ?? power;

  // (Investigation results render from ANY phase via renderInvestigationResult
  // above — by the time the result exists the engine has already left
  // EXEC_ACTION, so nothing result-related is handled here.)

  // Execution: pick a target, then confirm on the SAME screen (two taps —
  // protects against fat-finger misexecution; the server applies the kill
  // only on the confirmed `execute` action).
  if (power === 'execute' && execPick) {
    body.innerHTML = `
      <p class="center">${t('play.power.executeConfirm', { name: esc(nameOf(state, execPick)) })}</p>
      <p class="center muted small">${esc(t('play.power.executeWarn'))}</p>
      <div class="row">
        <button id="btn-exec-confirm" class="danger big">${esc(t('play.power.confirmExec'))}</button>
        <button id="btn-exec-cancel" class="secondary big">${esc(t('play.vote.cancel'))}</button>
      </div>`;
    $('#btn-exec-confirm').onclick = async () => {
      const targetId = execPick;
      execPick = null;
      try {
        await act('execute', { targetId });
        showToast(t('play.toast.executed'));
      } catch (err) {
        showToast(errText(err, t('play.toast.executeFailed')), { error: true });
        render(state); // refresh back to the picker
      }
    };
    $('#btn-exec-cancel').onclick = () => { execPick = null; render(state); };
    return;
  }
  if (power !== 'execute') execPick = null;

  if (power === 'policyPeek') {
    body.innerHTML = `<button class="big" id="btn-do-peek">${esc(t('play.power.peekBtn'))}</button>`;
    $('#btn-do-peek').onclick = () => act('peek', {}).catch(() => {});
    return;
  }
  if (power === 'investigate') {
    renderScanTargets(state, power, { verb: t('play.power.verb.investigate') });
    return;
  }
  if (power === 'execute') {
    renderScanTargets(state, power, { verb: t('play.power.verb.execute') });
    return;
  }
  if (power === 'specialElection') {
    renderScanTargets(state, power, { verb: t('play.power.verb.specialElection') });
    return;
  }
  body.innerHTML = `<p class="muted center">${esc(t('play.power.unknown'))}</p>`;
}

function pickerBtn(label, sub, onclick) {
  const btn = document.createElement('button');
  btn.className = 'picker-btn';
  const nm = document.createElement('span');
  nm.textContent = label;
  const sb = document.createElement('span');
  sb.className = 'sub';
  sb.textContent = sub;
  btn.append(nm, sb);
  btn.onclick = onclick;
  return btn;
}

// Discard-by-drag: renders the policy cards plus wiring to drag one of them
// onto the trash zone. Pointer-events based, so it works identically with
// touch and mouse. A plain tap on a card is kept as an accessibility fallback
// and performs the SAME discard action as a drag onto the trash.
function renderDiscardCards(container, trashEl, cards, onDiscard, hintKey = 'play.card.dragToTrash') {
  container.replaceChildren(...cards.map((policy, i) => {
    const card = document.createElement('div');
    card.className = `policy-card ${policy}`;
    card.innerHTML = `<div>${partyTitle(policy)}<br />${esc(t('play.card.policy'))}</div>`;
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = t(hintKey);
    card.appendChild(hint);
    makeDiscardDraggable(card, trashEl, () => onDiscard?.(i));
    return card;
  }));
}

function makeDiscardDraggable(card, trashEl, onDiscard) {
  card.style.touchAction = 'none';
  card.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    card.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    card.classList.add('dragging');
    const move = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.hypot(dx, dy) > 6) moved = true;
      card.style.transform = `translate(${dx}px, ${dy}px) scale(1.06)`;
      const over = pointerOver(ev, trashEl);
      card.classList.toggle('over-trash', over);
      trashEl.classList.toggle('armed', over);
    };
    const finish = (ev, dropped) => {
      card.removeEventListener('pointermove', move);
      card.classList.remove('dragging', 'over-trash');
      trashEl.classList.remove('armed');
      card.style.transform = '';
      // Drop on the trash = discard. A plain tap (no movement) is the
      // accessibility fallback and discards the same card.
      if (dropped || !moved) onDiscard();
    };
    card.addEventListener('pointermove', move);
    card.addEventListener('pointerup', (ev) => finish(ev, pointerOver(ev, trashEl)), { once: true });
    card.addEventListener('pointercancel', (ev) => finish(ev, false), { once: true });
  });
  card.oncontextmenu = (e) => e.preventDefault(); // no long-press menu on mobile
}

function pointerOver(ev, el) {
  const r = el.getBoundingClientRect();
  return ev.clientX >= r.left && ev.clientX <= r.right
    && ev.clientY >= r.top && ev.clientY <= r.bottom;
}

function renderPolicyCards(container, cards, verb, onPick) {
  container.replaceChildren(...cards.map((policy, i) => {
    const card = document.createElement('div');
    card.className = `policy-card ${policy}`;
    card.innerHTML = `<div>${partyTitle(policy)}<br />${esc(t('play.card.policy'))}</div>`;
    if (verb) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = t('play.card.tapTo', {
        verb: verb === 'discard' ? t('play.card.tapToDiscard') : t('play.card.tapToEnact'),
      });
      card.appendChild(hint);
      card.onclick = () => onPick?.(i);
    }
    return card;
  }));
}

// ------------------------------------------------------------- wait / dead

// "Which player are you?" rejoin picker for a phone that arrives mid-game
// (closed tab + rescan of the board's join QR). Picking a name swaps this
// socket onto that seat via the server's `rejoin` handler; the server then
// pushes the seat's private state and the game continues on this phone.
function renderRejoinPicker(state) {
  show('#screen-rejoin');
  $('#rejoin-list').replaceChildren(...state.players.map((p) => {
    const sub = p.alive ? t('play.rejoin.sub') : t('play.rejoin.deadSub');
    return pickerBtn(p.name, sub, async () => {
      try {
        const res = await socketEmit(socket, 'rejoin', { playerId: p.id });
        staleToken = false;
        myToken = res.token;
        saveToken(myToken);
        myId = res.playerId;
        myName = res.name;
        showToast(t('play.rejoin.welcome', { name: res.name }));
      } catch (err) {
        showToast(errText(err, t('play.rejoin.failed')), { error: true });
      }
    });
  }));
}

function renderWait(text) {
  show('#screen-wait');
  $('#wait-title').textContent = t('play.wait.title');
  $('#wait-text').innerHTML = esc(text).replace(/\n/g, '<br />');
}

function renderDead() {
  $('#spectator-title').textContent = t('play.dead.title');
  $('#spectator-text').innerHTML =
    `${esc(t('play.dead.body', { name: myName ?? '' }))}<br /><br />` +
    `<span class="small">${t('play.dead.role', { role: roleTitle(you.you.role) })}</span>`;
  show('#screen-spectator');
}

// -------------------------------------------------------------- game over

function renderGameOver(state) {
  show('#screen-gameover');
  $('#gameover-title').textContent = state.winner === 'liberal'
    ? t('board.win.liberals')
    : t('board.win.fascists');
  $('#gameover-card').className = `big-card ${state.winner}`;

  if (!you) {
    $('#gameover-reason').textContent = reasonText(state.winReason);
    $('#gameover-roles').innerHTML = `<p class="muted center small">${esc(t('play.over.notSeated'))}</p>`;
    return;
  }
  const onWinningSide = state.winner === 'liberal'
    ? you.you.role === 'liberal'
    : you.you.role !== 'liberal';
  $('#gameover-reason').textContent =
    `${onWinningSide ? t('play.over.won') : t('play.over.lost')} ${reasonText(state.winReason)}`;
  $('#gameover-roles').innerHTML =
    `<div class="role-row"><span>${esc(t('play.over.yourRole'))}</span><span class="r ${you.you.role}">${roleTitle(you.you.role)}</span></div>`;
}

function reasonText(reason) {
  return {
    hitlerExecuted: t('board.reason.hitlerExecuted'),
    hitlerElectedChancellor: t('board.reason.hitlerElectedChancellor'),
    liberalPoliciesEnacted: t('board.reason.liberalPoliciesEnacted'),
    fascistPoliciesEnacted: t('board.reason.fascistPoliciesEnacted'),
  }[reason] ?? '';
}

// ---------------------------------------------------------------- helpers

// Localized message for a rejected action: prefer the client dictionary for
// the server's machine-readable code; keep unknown codes' server text.
function errText(err, fallback) {
  return errorText(err?.code, err?.message ?? fallback);
}

async function act(type, args) {
  const res = await sendAction(socket, type, args);
  if (res.you) {
    you = res.you; // action acks carry our fresh private state instantly
    render(res.you);
  }
  return res;
}

function nameOf(state, id) {
  return state.players?.find((p) => p.id === id)?.name ?? id ?? '—';
}

function esc(text) {
  const map = { '&': 'amp;', '<': 'lt;', '>': 'gt;', '"': 'quot;', "'": '#39;' };
  return String(text ?? '').replace(/[&<>"']/g, (c) => `&${map[c]}`);
}
