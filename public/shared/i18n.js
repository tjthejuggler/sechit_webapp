// Shared i18n core: EN/TR dictionaries, per-user language persistence,
// live re-render helpers and localized asset swapping.
//
// - Every user-visible string in both clients lives here under a stable key;
//   JS renders through t(), static HTML carries data-i18n attributes and
//   applyI18n() fills them (no page reload needed on toggle).
// - Server texts (errors, log lines) reach clients as machine codes/types;
//   this module maps them to localized friendly strings (errorText()).
// - Localized art: ASSET_LANG mirrors the manifest.json `lang` maps (the
//   i18n completeness test cross-checks the two). Assets without a TR
//   variant resolve to the language-neutral EN file (localizedAssetPath).
//
// Vote tokens stay authentic PnP German ("Ja!"/"Nein!") in BOTH languages —
// only the surrounding text is translated.

const LANG_KEY = 'sechit.lang';
export const LANGS = ['en', 'tr'];

// ---------------------------------------------------------------- dictionary

export const DICT = {
  en: {
    // app / shared
    'app.title': 'Secret Hitler',
    'board.title': 'Secret Hitler — Board',
    'play.title': 'Secret Hitler — Play',
    'app.tagline': 'A hidden-identity party game for 5–10 players — one shared screen, everyone else on their phones.',
    'app.start': 'Start a New Game',
    'app.joinTitle': 'Joining a friend\'s game?',
    'app.joinPlaceholder': '6-letter game code',
    'app.joinBtn': 'Join Game',
    'app.joinBadCode': 'Enter the 6-letter game code from the host\'s screen.',
    'board.lobby.codeLabel': 'Game code',
    'board.lobby.copy': 'Copy link',
    'board.lobby.copied': 'Link copied — send it to your friends!',
    'board.lobby.copyFailed': 'Could not copy the link.',
    'board.lobby.newCode': 'New code',
    'board.lobby.newCodeConfirm': 'Start a fresh game with a brand-new code and QR? (Current lobby will be cleared.)',
    'board.lobby.share': 'Share',
    'board.lobby.shareText': 'Join my Secret Hitler game! Code: {code}',
    'board.toast.hostFailed': 'Could not start the online host: {msg}',
    'credit.line': 'Secret Hitler by Mike Boxleiter, Tommy Maranges, Mac Schubert — licensed CC BY-NC-SA 4.0 ·',
    'lang.title': 'Language',
    'lang.en': 'EN',
    'lang.tr': 'TR',

    // board — header / phases
    'board.phase.LOBBY.title': 'Lobby',
    'board.phase.LOBBY.sub': 'Waiting for players to join',
    'board.phase.ROLE_REVEAL.title': 'Role Reveal',
    'board.phase.ROLE_REVEAL.sub': 'Everyone: check your secret role on your phone',
    'board.phase.NOMINATION.title': 'Nomination',
    'board.phase.NOMINATION.sub': 'President: pick a chancellor candidate on your phone',
    'board.phase.VOTE.title': 'Election',
    'board.phase.VOTE.sub': 'All players vote Ja! or Nein! on their phones',
    'board.phase.LEGISLATIVE_PRESIDENT.title': 'Legislative Session',
    'board.phase.LEGISLATIVE_PRESIDENT.sub': 'President: scan the deck QR to draw 3 policies',
    'board.phase.LEGISLATIVE_CHANCELLOR.title': 'Legislative Session',
    'board.phase.LEGISLATIVE_CHANCELLOR.sub': 'Chancellor: take the two policies and enact one',
    'board.phase.EXEC_ACTION.title': 'Executive Power',
    'board.phase.EXEC_ACTION.sub': 'President: use the board power on your phone',
    'board.phase.GAME_OVER.title': 'Game Over',
    'board.phase.GAME_OVER.sub': '',

    // board — header buttons
    'board.btn.start': 'Start Game',
    'board.btn.waiting': 'Waiting ({n}+ needed)',
    'board.btn.begin': 'Begin Nomination',
    'board.btn.reset': 'New Game',
    'board.btn.again': 'Play Again',
    'play.btn.continue': 'Continue',

    // play — bottom tab bar
    'play.tab.action': 'Action',
    'play.tab.board': 'Board',
    'play.tab.history': 'History',

    // play — board page
    'play.page.board.title': 'Board',
    'play.page.board.government': 'Government',
    'play.page.board.president': 'President',
    'play.page.board.chancellor': 'Chancellor',
    'play.page.board.policies': 'Policies Enacted',
    'play.page.board.tracker': 'Failed Governments',
    'play.page.board.piles': 'Card Piles',
    'play.page.board.drawPile': 'Draw pile',
    'play.page.board.discardPile': 'Discard pile',
    'play.page.board.cards': '{n} cards',

    // play — history page
    'play.page.history.title': 'History',
    'play.page.history.sub': 'The previous turn',
    'play.page.history.empty': 'Nothing has happened yet.',
    'play.page.history.vote': 'Vote: <b>Ja {ja}</b> – <b>{nein} Nein</b> — {outcome}',

    // board — lobby
    'board.lobby.scanToJoin': 'Scan to join · or open',
    'board.lobby.count': '{n} player{s} — need {min} to {max}',
    'board.lobby.qrAlt': 'QR code: scan to join the game',
    'board.lobby.rearrange': 'Drag a player onto another seat (or tap two players) to swap seats before starting.',

    // board — center labels
    'board.center.ROLE_REVEAL': 'Secret roles are out',
    'board.center.NOMINATION': 'Nomination',
    'board.center.NOMINATION_SPECIAL': 'Special election!',
    'board.center.VOTE': 'Election in progress',
    'board.center.LEGISLATIVE_PRESIDENT': 'Legislative — president draws',
    'board.center.LEGISLATIVE_CHANCELLOR': 'Legislative — chancellor enacts',
    'board.center.EXEC_ACTION': 'Executive power',
    'board.center.GAME_OVER': 'Game over',

    // board — powers / seating
    'board.power.investigate': 'Investigate',
    'board.power.specialElection': 'Special Elect.',
    'board.power.policyPeek': 'Peek',
    'board.power.execute': 'Execute',
    'board.seat.candidate': 'Candidate',
    'board.seat.termLimitP': 'Term-limited P',
    'board.seat.termLimitC': 'Term-limited C',
    'board.seat.investigated': 'Investigated',
    'board.seat.hasVoted': 'Has voted',
    'board.seat.notVoted': 'Not voted yet',
    'board.seat.votedChoice': 'Voted {choice}',
    'board.seat.thinking': 'thinking…',
    'board.plaque.presidentTitle': 'Drag onto another seat to move the presidency manually',
    'board.plaque.presidentAlt': 'President plaque',
    'board.plaque.chancellorAlt': 'Chancellor plaque',

    'board.side.announcer': 'Announcer',

    // board — vote panel / veto
    'board.vote.title': 'Election Vote',
    'board.vote.tallyElected': 'Ja {ja} — {nein} Nein · elected',
    'board.vote.tallyRejected': 'Ja {ja} — {nein} Nein · rejected',
    'board.veto.requested': 'Veto requested!',
    'board.veto.unlocked': 'Veto unlocked',
    'board.veto.locked': 'Veto locked (needs 5 fascist policies)',

    // board — event log
    'board.log.gameStarted': '<b>Game started</b> with {n} players',
    'board.log.nominationStarted': '<b>{name}</b> leads the first nomination',
    'board.log.presidentMoved': 'Presidency manually moved to <b>{name}</b>',
    'board.log.chancellorNominated': '<b>{pres}</b> nominated <b>{chanc}</b>',
    'board.log.voteCast': 'A vote was cast ({received}/{expected})',
    'board.log.voteResolved': 'Vote: <b>Ja {ja}</b> – <b>{nein} Nein</b> — {outcome}',
    'board.log.voteResolvedElected': 'government elected',
    'board.log.voteResolvedRejected': 'rejected',
    'board.log.electionFailed': 'Election failed — tracker at {n}',
    'board.log.governmentFormed': '<b>{pres}</b> + <b>{chanc}</b> form a government',
    'board.log.cardsDrawn': 'President drew {n} policies',
    'board.log.presidentDiscarded': 'President discarded 1, passed 2 on',
    'board.log.chancellorReceived': 'Chancellor received the 2 policies',
    'board.log.policyEnacted': '<b>{party}</b> policy enacted{chaos} — L{l}/F{f}',
    'board.log.chaosSuffix': ' (chaos!)',
    'board.log.vetoRequested': 'Chancellor requested a <b>veto</b>',
    'board.log.vetoAgreed': 'Veto agreed — all 3 discarded, tracker at {n}',
    'board.log.vetoRefused': 'Veto refused — chancellor must enact',
    'board.log.powerGranted': 'President gains power: <b>{power}</b>',
    'board.log.investigated': '<b>{pres}</b> investigated <b>{target}</b>',
    'board.log.policyPeek': '<b>{name}</b> peeked at the top 3 policies',
    'board.log.specialElection': 'Special election: <b>{name}</b> is now president',
    'board.log.executed': '<b>{name}</b> was executed',
    'board.log.reshuffled': 'Deck reshuffled',
    'board.log.chaos': '<b>Chaos!</b> Top policy enacted, tracker & term limits reset',
    'board.log.gameOver': 'Game over — <b>{winner}</b> ({reason})',
    'board.log.winnerLiberal': 'Liberals win',
    'board.log.winnerFascist': 'Fascists win',

    // board — win splash / flash / toasts
    'board.win.liberals': 'Liberals Win!',
    'board.win.fascists': 'Fascists Win!',
    'board.reason.hitlerExecuted': 'Hitler was executed',
    'board.reason.hitlerElectedChancellor': 'Hitler was elected chancellor',
    'board.reason.liberalPoliciesEnacted': '5 liberal policies enacted',
    'board.reason.fascistPoliciesEnacted': '6 fascist policies enacted',
    'board.flash.reshuffle': 'Deck reshuffled!',
    'board.announce.investigated': 'President <b>{pres}</b> investigated <b>{target}</b>',
    'board.announce.acks': 'Acknowledged by {acked}/{total} players — waiting…',
    'board.toast.connFailed': 'Board connection failed: {msg}',
    'board.toast.cannotStart': 'Could not start the game.',
    'board.toast.cannotBegin': 'Could not begin.',
    'board.toast.cannotReset': 'Could not reset.',
    'board.toast.cannotMovePlaque': 'Cannot move the plaque (only during Nomination).',
    'board.toast.plaqueHint': 'Tap another player to send the plaque to them (currently {name})',
    'board.toast.reorderFailed': 'Could not rearrange the seating.',
    'board.toast.presidencyMoved': 'Presidency moved to {name}',
    'board.confirm.reset': 'Abandon this game and return to the lobby?',
    'board.art.liberalAlt': 'Liberal policy track',
    'board.art.fascistAlt': 'Fascist policy track',
    'board.art.summaryAlt': 'Fascist board summary',
    'board.art.drawAlt': 'Draw pile',
    'board.art.discardAlt': 'Discard pile',
    'board.art.drawQrAlt': 'QR: president scans to draw 3 policies',
    'board.art.drawQrCaption': 'President: scan to draw 3',

    // play — top bar / phase chips
    'play.hold.role': 'Hold: My Role',
    'play.chip.LOBBY': 'Lobby',
    'play.chip.ROLE_REVEAL': 'Role Reveal',
    'play.chip.NOMINATION': 'Nomination',
    'play.chip.VOTE': 'Election',
    'play.chip.LEGISLATIVE': 'Legislative',
    'play.chip.EXEC_ACTION': 'Executive Power',
    'play.chip.GAME_OVER': 'Game Over',

    // play — join / lobby
    'play.join.status': 'Enter your name to join the table.',
    'play.join.placeholder': 'Your name',
    'play.join.button': 'Take a Seat',
    'play.join.waiting': 'Waiting for the game to start — watch the big board.',
    'play.join.welcome': 'Welcome, {name}! Waiting for the game to start…',
    'play.join.joinedToast': 'Joined as {name}',
    'play.join.couldNotJoin': 'Could not join.',
    'play.roster.seated': 'Seated: {names}',

    // play — spectator / dead
    'play.spectator.title': 'Spectating',
    'play.spectator.named': '{name}, you are not seated in this game. Watch the big board!',
    'play.spectator.anon': 'You are not seated in this game. Watch the big board!',
    'play.dead.title': 'You Were Executed',
    'play.dead.body': '{name}, you are out of the game — you may no longer speak, vote, or hold office.',
    'play.dead.role': 'Your role was <b>{role}</b>. Watch the board to see how it ends!',

    // play — role reveal
    'play.role.title': 'Your Secret Role',
    'play.role.topSecret': 'Top Secret',
    'play.role.holdToReveal': 'Hold to reveal',
    'play.role.partyMembership': 'Party Membership',
    'play.role.hint': 'Press and hold a card to look at it. The board operator begins the game.',
    'play.role.checkTab': 'Open the 🤫 Secrets tab at the bottom to look at your secret cards — any time, all game long.',
    'play.tab.secret': 'Secrets',
    'play.secret.title': 'Your Secrets',
    'play.secret.sub': 'Hold a card to reveal it — it hides again the moment you let go.',
    'play.secret.teamFront': 'Your Team',
    'play.secret.noTeam': 'You have no secret teammates.',
    'play.role.desc.liberal': 'You are a member of the Liberal party. Win by enacting 5 Liberal policies or executing Hitler.',
    'play.role.desc.fascist': 'You are a Fascist. Win by enacting 6 Fascist policies or electing Hitler as Chancellor.',
    'play.role.desc.hitler': 'You are HITLER. Your goal: be elected Chancellor after 3 Fascist policies, or get 6 Fascist policies enacted.',
    'play.role.teammates.hitler': 'Hitler: <b>{name}</b>',
    'play.role.teammates.fellowFascist': 'Fellow Fascist: <b>{name}</b>',
    'play.role.teammates.yourFascists': 'Your fascists: <b>{names}</b>',
    'play.role.teammates.alone': 'You are alone — the fascists know you, you do not know them.',
    'play.role.altSuffix': 'role card',
    'play.role.partyCardAlt': '{party} party membership card',
    'play.overlay.release': 'Release to hide',
    'play.overlay.roleAlt': 'Your role card',

    // play — mid-game rejoin (scanned the board QR after closing a tab)
    'play.rejoin.title': 'Rejoin the Game',
    'play.rejoin.pick': 'Closed your tab? Pick who you are to get your seat back.',
    'play.rejoin.sub': 'This is me',
    'play.rejoin.deadSub': 'This is me (eliminated)',
    'play.rejoin.welcome': 'Welcome back, {name}!',
    'play.rejoin.failed': 'Could not reclaim that seat.',

    // play — nomination
    'play.nom.title': 'Nominate a Chancellor',
    'play.nom.special': 'Special Election — pick the next President',
    'play.nom.sub': 'nominate',
    'play.nom.none': 'No eligible candidates (term limits).',
    'play.nom.wait': 'A government is being formed.\nPresident: {name}',

    // play — vote
    'play.vote.title': 'Election Vote',
    'play.vote.context': 'President <b>{pres}</b> nominated<br /><b>{chanc}</b> as Chancellor',
    'play.vote.cancel': 'Cancel',
    'play.vote.waiting': 'Vote cast — waiting for others…',
    'play.vote.resultElected': 'The government was <b>elected</b>.',
    'play.vote.resultRejected': 'The government was <b>rejected</b>.',
    'play.vote.tally': '<b>Ja {ja} — {nein} Nein</b>',
    'play.vote.ballotJaAlt': 'Ja ballot',
    'play.vote.ballotNeinAlt': 'Nein ballot',

    // play — legislative (president)
    'play.legisPres.title': 'You Are President',
    'play.legisPres.drawNote': 'Draw <b>3</b> policies from the deck.',
    'play.legisPres.drawBtn': 'Draw 3 Policies',
    'play.legisPres.scanNote': 'Or scan the deck QR on the big board with your camera app.',
    'play.legisPres.discardNote': 'Discard <b>one</b> policy — the other two go to the chancellor.',
    'play.legisPres.transferWait': 'Waiting for the chancellor to confirm the two policies…',
    'play.legis.waitPresident': 'Legislative session in progress.\nPresident: {name}',
    'play.legis.waitChancellor': 'Legislative session in progress.\nChancellor: {name}',

    // play — legislative (chancellor)
    'play.legisChanc.title': 'You Are Chancellor',
    'play.legisChanc.receiveNote': 'The president passed you <b>2 policies</b>.',
    'play.legisChanc.receiveBtn': 'Confirm Receipt',
    'play.legisChanc.enactNote': 'Play <b>one</b> policy onto a board — the other is discarded.',
    'play.legisChanc.vetoBtn': 'Request Veto',
    'play.legisChanc.vetoWait': 'Veto requested — waiting for the president…',
    'play.legisChanc.enactWait': 'Waiting for the chancellor to enact a policy…',

    // play — veto response
    'play.veto.title': 'Veto Request',
    'play.veto.body': 'The chancellor requests a <b>veto</b> — discard all 3 policies?',
    'play.veto.note': '(If you agree, the election tracker moves up.)',
    'play.veto.agree': 'Agree to Veto',
    'play.veto.refuse': 'Refuse',

    // play — cards / shared verbs
    'play.card.liberal': 'Liberal',
    'play.card.fascist': 'Fascist',
    'play.card.policy': 'Policy',
    'play.card.tapTo': 'tap to {verb}',
    'play.card.tapToSelect': 'tap to select',
    'play.card.tapToDiscard': 'discard',
    'play.card.dragToTrash': 'drag to the trash to discard',
    'play.card.dragToBoards': 'drag onto a board to play',
    'play.card.enactZone': 'Play Policy',
    'play.card.discardZone': 'Discard',
    'play.card.tapToEnact': 'enact',

    // play — executive powers
    'play.power.title': 'Executive Power',
    'play.power.investigate': 'Investigate Loyalty',
    'play.power.policyPeek': 'Policy Peek',
    'play.power.specialElection': 'Call Special Election',
    'play.power.execute': 'Execution',
    'play.power.pick': 'Pick a player to {verb}',
    'play.power.verb.investigate': 'investigate their loyalty',
    'play.power.verb.execute': 'mark for execution',
    'play.power.verb.specialElection': 'make the next presidential candidate',
    'play.power.noTargets': 'No valid targets.',
    'play.power.unknown': 'Unknown power.',
    'play.power.peekBtn': 'Peek at Top 3 Policies',
    'play.power.peekResult': 'Top 3 policies, in draw order:',
    'play.power.announceTitle': 'Investigation!',
    'play.power.announceBody': 'President <b>{pres}</b> investigated <b>{target}</b>.',
    'play.power.announceAck': 'Got it',
    'play.power.announceAckNamed': '<b>{pres}</b> investigated <b>{target}</b> — Got it',
    'play.power.announceWaiting': 'Waiting for everyone to acknowledge ({acked}/{total})…',
    'play.power.investResult': 'Investigation result —',
    'play.power.investMember': '{name} is a member of the <b>{party}</b> party.',
    'play.power.executeConfirm': 'Execute <b>{name}</b>?',
    'play.power.executeWarn': '⚠️ This cannot be undone.',
    'play.power.confirmExec': 'Confirm Execution',
    'play.power.wait': 'President {name} is using a board power.',

    // play — wait / game over
    'play.wait.title': 'Waiting…',
    'play.wait.default': 'Waiting…',
    'play.over.won': 'Your team won!',
    'play.over.lost': 'Your team lost.',
    'play.over.yourRole': 'Your role',
    'play.over.notSeated': 'You were not seated in this game.',
    'play.over.again': 'Another game? The board operator starts a new lobby.',

    // toasts (client-side)
    'play.toast.drew': 'Drew 3 policies!',
    'play.toast.drawFailed': 'Draw failed.',
    'play.toast.discarded': 'Discarded — the chancellor got the other two.',
    'play.toast.received': 'Policies received!',
    'play.toast.receiveFailed': 'Could not confirm receipt.',
    'play.toast.vetoFailed': 'Cannot request veto.',
    'play.toast.executed': 'Execution carried out.',
    'play.toast.executeFailed': 'Execution failed.',

    // server error codes → friendly localized strings
    'err.TIMEOUT': 'Server did not respond.',
    'err.SERVER_ERROR': 'Action failed.',
    'err.GAME_IN_PROGRESS': 'A game is already running.',
    'err.BAD_NAME': 'Enter a name.',
    'err.LOBBY_FULL': 'Lobby is full ({max} players).',
    'err.NOT_ENOUGH_PLAYERS': 'Need {min}–{max} players.',
    'err.NOT_PRESIDENT': 'Only the current president may do this.',
    'err.TOKEN_INVALID': 'This is not your valid draw QR.',
    'err.TOKEN_CONSUMED': 'This draw QR was already used.',
    'err.NOT_CHANCELLOR': 'Only the chancellor may do this.',
    'err.BAD_HAND': 'No pending cards to handle.',
    'err.TRANSFER_PENDING': 'Confirm the received policies first.',
    'err.NOT_A_PLAYER': 'You are not seated in this game.',
    'err.NO_GAME': 'No game is running.',
    'err.PRESIDENT_LOCKED': 'Special election in progress; the plaque is fixed.',
    'err.DEAD_TARGET': 'Cannot target a dead player.',
    'err.INELIGIBLE_CHANCELLOR': 'That player is dead, is the current president, or is term-limited.',
    'err.DEAD_VOTER': 'Dead players cannot vote.',
    'err.ALREADY_VOTED': 'You already voted.',
    'err.BAD_VOTE': 'Vote must be "ja" or "nein".',
    'err.HAND_STATE': 'Cards are not in the expected state.',
    'err.BAD_CARD_INDEX': 'Invalid card.',
    'err.VETO_LOCKED': 'Veto unlocks after 5 fascist policies.',
    'err.VETO_ALREADY_REQUESTED': 'Veto already requested.',
    'err.NO_VETO_PENDING': 'No veto request pending.',
    'err.VETO_PENDING': 'Resolve the veto request first.',
    'err.ALREADY_INVESTIGATED': 'That player was already investigated.',
    'err.BAD_TARGET': 'Invalid target.',
    'err.WRONG_POWER': 'A different power is pending.',
    'err.NO_POWER_PENDING': 'No executive power pending.',
    'err.UNKNOWN_ACTION': 'Unknown action.',
    'err.DECK_EXHAUSTED': 'Not enough policy tiles left to draw from.',
    'err.UNKNOWN_PLAYER': 'Unknown player.',
    'err.DUPLICATE_PLAYERS': 'Player ids must be unique.',
    'err.BAD_PLAYER_COUNT': 'Invalid player count.',
    'err.BAD_PLAYER_ID': 'Invalid player id.',
    'err.NO_LIVING_PLAYERS': 'No living players left.',
  },

  tr: {
    // app / shared
    'app.title': 'Gizli Hitler',
    'board.title': 'Gizli Hitler — Masa',
    'play.title': 'Gizli Hitler — Oyna',
    'app.tagline': '5–10 kişilik gizli kimlikli parti oyunu — tek ortak ekran, herkes telefonundan.',
    'app.start': 'Yeni Oyun Başlat',
    'app.joinTitle': "Arkadaşının oyununa mı katılıyorsun?",
    'app.joinPlaceholder': '6 harfli oyun kodu',
    'app.joinBtn': 'Oyuna Katıl',
    'app.joinBadCode': "Ev sahibinin ekranındaki 6 harfli oyun kodunu gir.",
    'board.lobby.codeLabel': 'Oyun kodu',
    'board.lobby.copy': 'Bağlantıyı kopyala',
    'board.lobby.copied': 'Bağlantı kopyalandı — arkadaşlarına gönder!',
    'board.lobby.copyFailed': 'Bağlantı kopyalanamadı.',
    'board.lobby.newCode': 'Yeni kod',
    'board.lobby.newCodeConfirm': 'Yeni bir kod ve QR ile sıfırdan bir oyun başlat? (Mevcut lobi temizlenir.)',
    'board.lobby.share': 'Paylaş',
    'board.lobby.shareText': 'Gizli Hitler oyunuma katıl! Kod: {code}',
    'board.toast.hostFailed': 'Çevrimiçi ev başlatılamadı: {msg}',
    'credit.line': 'Secret Hitler — Mike Boxleiter, Tommy Maranges, Mac Schubert — CC BY-NC-SA 4.0 lisansıyla ·',
    'lang.title': 'Dil',
    'lang.en': 'EN',
    'lang.tr': 'TR',

    // board — header / phases
    'board.phase.LOBBY.title': 'Lobi',
    'board.phase.LOBBY.sub': 'Oyuncuların katılması bekleniyor',
    'board.phase.ROLE_REVEAL.title': 'Rol Açıklaması',
    'board.phase.ROLE_REVEAL.sub': 'Herkes: gizli rolünü telefonundan kontrol et',
    'board.phase.NOMINATION.title': 'Aday Gösterme',
    'board.phase.NOMINATION.sub': 'Başkan: telefonundan bir Şansölye adayı seç',
    'board.phase.VOTE.title': 'Seçim',
    'board.phase.VOTE.sub': 'Tüm oyuncular telefonlarıyla Ja! ya da Nein! oyu verir',
    'board.phase.LEGISLATIVE_PRESIDENT.title': 'Yasama Oturumu',
    'board.phase.LEGISLATIVE_PRESIDENT.sub': 'Başkan: 3 politika çekmek için destedeki QR kodunu okut',
    'board.phase.LEGISLATIVE_CHANCELLOR.title': 'Yasama Oturumu',
    'board.phase.LEGISLATIVE_CHANCELLOR.sub': 'Şansölye: iki politikayı al ve birini yürürlüğe koy',
    'board.phase.EXEC_ACTION.title': 'Yürütme Yetkisi',
    'board.phase.EXEC_ACTION.sub': 'Başkan: masadaki yetkiyi telefonundan kullan',
    'board.phase.GAME_OVER.title': 'Oyun Bitti',
    'board.phase.GAME_OVER.sub': '',

    // board — header buttons
    'board.btn.start': 'Oyunu Başlat',
    'board.btn.waiting': 'Bekleniyor ({n}+ oyuncu gerekli)',
    'board.btn.begin': 'Aday Göstermeyi Başlat',
    'board.btn.reset': 'Yeni Oyun',
    'board.btn.again': 'Tekrar Oyna',
    'play.btn.continue': 'Devam',

    // play — bottom tab bar
    'play.tab.action': 'Eylem',
    'play.tab.board': 'Tahta',
    'play.tab.history': 'Geçmiş',

    // play — board page
    'play.page.board.title': 'Tahta',
    'play.page.board.government': 'Hükümet',
    'play.page.board.president': 'Başkan',
    'play.page.board.chancellor': 'Şansölye',
    'play.page.board.policies': 'Yürürlükteki Politikalar',
    'play.page.board.tracker': 'Başarısız Hükümetler',
    'play.page.board.piles': 'Desteler',
    'play.page.board.drawPile': 'Çekme destesi',
    'play.page.board.discardPile': 'Atma destesi',
    'play.page.board.cards': '{n} kart',

    // play — history page
    'play.page.history.title': 'Geçmiş',
    'play.page.history.sub': 'Önceki tur',
    'play.page.history.empty': 'Henüz bir şey olmadı.',
    'play.page.history.vote': 'Oylama: <b>Ja {ja}</b> – <b>{nein} Nein</b> — {outcome}',

    // board — lobby
    'board.lobby.scanToJoin': 'Katılmak için okut · ya da aç',
    'board.lobby.count': '{n} oyuncu — {min} ile {max} arası gerekli',
    'board.lobby.qrAlt': 'QR kodu: katılmak için okut',
    'board.lobby.rearrange': 'Oyuna başlamadan önce koltuk değiştirmek için bir oyuncuyu başka bir koltuğa sürükleyin (veya iki oyuncuya dokunun).',

    // board — center labels
    'board.center.ROLE_REVEAL': 'Gizli roller dağıtıldı',
    'board.center.NOMINATION': 'Aday Gösterme',
    'board.center.NOMINATION_SPECIAL': 'Özel seçim!',
    'board.center.VOTE': 'Seçim sürüyor',
    'board.center.LEGISLATIVE_PRESIDENT': 'Yasama — başkan çekiyor',
    'board.center.LEGISLATIVE_CHANCELLOR': 'Yasama — şansölye yürürlüğe koyuyor',
    'board.center.EXEC_ACTION': 'Yürütme yetkisi',
    'board.center.GAME_OVER': 'Oyun bitti',

    // board — powers / seating
    'board.power.investigate': 'Tetkik Et',
    'board.power.specialElection': 'Özel Seçim',
    'board.power.policyPeek': 'Yokla',
    'board.power.execute': 'İdam Et',
    'board.seat.candidate': 'Aday',
    'board.seat.termLimitP': 'Limitli B',
    'board.seat.termLimitC': 'Limitli Ş',
    'board.seat.investigated': 'Tetkik Edildi',
    'board.seat.hasVoted': 'Oy verdi',
    'board.seat.notVoted': 'Henüz oy vermedi',
    'board.seat.votedChoice': 'Oyu: {choice}',
    'board.seat.thinking': 'düşünüyor…',
    'board.plaque.presidentTitle': 'Başkanlığı elle taşımak için başka bir koltuğa sürükleyin',
    'board.plaque.presidentAlt': 'Başkan plaketi',
    'board.plaque.chancellorAlt': 'Şansölye plaketi',

    'board.side.announcer': 'Duyurucu',

    // board — vote panel / veto
    'board.vote.title': 'Seçim Oylaması',
    'board.vote.tallyElected': 'Ja {ja} — {nein} Nein · seçildi',
    'board.vote.tallyRejected': 'Ja {ja} — {nein} Nein · reddedildi',
    'board.veto.requested': 'Veto talep edildi!',
    'board.veto.unlocked': 'Veto açıldı',
    'board.veto.locked': 'Veto kilitli (5 faşist politikası gereklidir)',

    // board — event log
    'board.log.gameStarted': 'Oyun <b>{n}</b> oyuncuyla başladı',
    'board.log.nominationStarted': '<b>{name}</b> ilk aday göstermeye liderlik ediyor',
    'board.log.presidentMoved': 'Başkanlık elle <b>{name}</b> adlı oyuncuya geçirildi',
    'board.log.chancellorNominated': '<b>{pres}</b>, <b>{chanc}</b> adını aday gösterdi',
    'board.log.voteCast': 'Bir oy verildi ({received}/{expected})',
    'board.log.voteResolved': 'Oylama: <b>Ja {ja}</b> – <b>{nein} Nein</b> — {outcome}',
    'board.log.voteResolvedElected': 'hükümet seçildi',
    'board.log.voteResolvedRejected': 'reddedildi',
    'board.log.electionFailed': 'Seçim başarısız — sayaç: {n}',
    'board.log.governmentFormed': '<b>{pres}</b> + <b>{chanc}</b> hükümeti kuruyor',
    'board.log.cardsDrawn': 'Başkan {n} politika çekti',
    'board.log.presidentDiscarded': 'Başkan 1 politikayı eldi, 2 tanesini iletti',
    'board.log.chancellorReceived': 'Şansölye 2 politikayı aldı',
    'board.log.policyEnacted': '<b>{party}</b> politikası yürürlüğe girdi{chaos} — L{l}/F{f}',
    'board.log.chaosSuffix': ' (kaos!)',
    'board.log.vetoRequested': 'Şansölye <b>veto</b> talep etti',
    'board.log.vetoAgreed': 'Veto onaylandı — 3 politika da eldi, sayaç: {n}',
    'board.log.vetoRefused': 'Veto reddedildi — şansölyenin yürürlüğe koyması gerekir',
    'board.log.powerGranted': 'Başkan yetki kazandı: <b>{power}</b>',
    'board.log.investigated': '<b>{pres}</b>, <b>{target}</b> adlı oyuncuyu tetkik etti',
    'board.log.policyPeek': '<b>{name}</b> en üstteki 3 politikaya baktı',
    'board.log.specialElection': 'Özel seçim: <b>{name}</b> artık başkan',
    'board.log.executed': '<b>{name}</b> idam edildi',
    'board.log.reshuffled': 'Deste yeniden karıldı',
    'board.log.chaos': '<b>Kaos!</b> En üstteki politika yürürlüğe girdi, sayaç ve görev limitleri sıfırlandı',
    'board.log.gameOver': 'Oyun bitti — <b>{winner}</b> ({reason})',
    'board.log.winnerLiberal': 'Liberaller kazanır',
    'board.log.winnerFascist': 'Faşistler kazanır',

    // board — win splash / flash / toasts
    'board.win.liberals': 'Liberaller Kazandı!',
    'board.win.fascists': 'Faşistler Kazandı!',
    'board.reason.hitlerExecuted': 'Hitler idam edildi',
    'board.reason.hitlerElectedChancellor': 'Hitler şansölye seçildi',
    'board.reason.liberalPoliciesEnacted': '5 liberal politika yürürlüğe girdi',
    'board.reason.fascistPoliciesEnacted': '6 faşist politika yürürlüğe girdi',
    'board.flash.reshuffle': 'Deste yeniden karıldı!',
    'board.announce.investigated': 'Cumhurbaşkanı <b>{pres}</b>, <b>{target}</b> kişisini tetkik etti',
    'board.announce.acks': '{acked}/{total} oyuncu onayladı — bekleniyor…',
    'board.toast.connFailed': 'Masa bağlantısı başarısız: {msg}',
    'board.toast.cannotStart': 'Oyun başlatılamadı.',
    'board.toast.cannotBegin': 'Başlatılamadı.',
    'board.toast.cannotReset': 'Sıfırlanamadı.',
    'board.toast.cannotMovePlaque': 'Plaket taşınamaz (yalnızca Aday Gösterme aşamasında).',
    'board.toast.plaqueHint': 'Plaketi ona göndermek için başka bir oyuncuya dokunun (şu an {name})',
    'board.toast.reorderFailed': 'Oturum düzeni değiştirilemedi.',
    'board.toast.presidencyMoved': 'Başkanlık {name} adlı oyuncuya geçti',
    'board.confirm.reset': 'Bu oyunu bırakıp lobiye dönmek istiyor musunuz?',
    'board.art.liberalAlt': 'Liberal politika yolu',
    'board.art.fascistAlt': 'Faşist politika yolu',
    'board.art.summaryAlt': 'Faşist masa özeti',
    'board.art.drawAlt': 'Çekim destesi',
    'board.art.discardAlt': 'Elenen kartlar',
    'board.art.drawQrAlt': 'QR: başkan 3 politika çekmek için okutur',
    'board.art.drawQrCaption': 'Başkan: 3 politika çekmek için okut',

    // play — top bar / phase chips
    'play.hold.role': 'Bas: Rolüm',
    'play.chip.LOBBY': 'Lobi',
    'play.chip.ROLE_REVEAL': 'Rol Açıklaması',
    'play.chip.NOMINATION': 'Aday Gösterme',
    'play.chip.VOTE': 'Seçim',
    'play.chip.LEGISLATIVE': 'Yasama',
    'play.chip.EXEC_ACTION': 'Yürütme Yetkisi',
    'play.chip.GAME_OVER': 'Oyun Bitti',

    // play — join / lobby
    'play.join.status': 'Masaya katılmak için adını yaz.',
    'play.join.placeholder': 'Adın',
    'play.join.button': 'Koltuğunu Kap',
    'play.join.waiting': 'Oyunun başlaması bekleniyor — büyük masayı izle.',
    'play.join.welcome': 'Hoş geldin {name}! Oyunun başlaması bekleniyor…',
    'play.join.joinedToast': '{name} olarak katıldın',
    'play.join.couldNotJoin': 'Katılım başarısız.',
    'play.roster.seated': 'Oturanlar: {names}',

    // play — spectator / dead
    'play.spectator.title': 'İzleyici',
    'play.spectator.named': '{name}, bu oyunda koltuğun yok. Büyük masayı izle!',
    'play.spectator.anon': 'Bu oyunda koltuğun yok. Büyük masayı izle!',
    'play.dead.title': 'İdam Edildin',
    'play.dead.body': '{name}, oyundan çıktın — artık konuşamaz, oy veremez veya görev yapamazsın.',
    'play.dead.role': 'Rolün <b>{role}</b> idi. Nasıl bittiğini görmek için masayı izle!',

    // play — role reveal
    'play.role.title': 'Gizli Rolün',
    'play.role.topSecret': 'Çok Gizli',
    'play.role.holdToReveal': 'Açmak için basılı tut',
    'play.role.partyMembership': 'Parti Üyeliği',
    'play.role.hint': 'Karta bakmak için basılı tut. Oyunu masa ekranı başlatır.',
    'play.role.checkTab': 'Gizli kartlarına bakmak için alttaki 🤫 Sırlar sekmesini aç — oyun boyunca her zaman.',
    'play.tab.secret': 'Sırlar',
    'play.secret.title': 'Sırların',
    'play.secret.sub': 'Kartı açmak için basılı tut — bıraktığın an yeniden gizlenir.',
    'play.secret.teamFront': 'Takımın',
    'play.secret.noTeam': 'Gizli takım arkadaşın yok.',
    'play.role.desc.liberal': 'Liberal partinin bir üyesisin. 5 Liberal politika yürürlüğe koyarak ya da Hitler’i idam ederek kazanırsın.',
    'play.role.desc.fascist': 'Bir Faşistsin. 6 Faşist politika yürürlüğe koyarak ya da Hitler’i Şansölye seçtirerek kazanırsın.',
    'play.role.desc.hitler': 'HİTLER’sin. Hedefin: 3 Faşist politikadan sonra Şansölye seçilmek ya da 6 Faşist politikanın yürürlüğe girmesini sağlamak.',
    'play.role.teammates.hitler': 'Hitler: <b>{name}</b>',
    'play.role.teammates.fellowFascist': 'Faşist Arkadaşın: <b>{name}</b>',
    'play.role.teammates.yourFascists': 'Faşistlerin: <b>{names}</b>',
    'play.role.teammates.alone': 'Yalnızsın — faşistler seni tanır, sen onları tanımazsın.',
    'play.role.altSuffix': 'rol kartı',
    'play.role.partyCardAlt': '{party} parti üyelik kartı',
    'play.overlay.release': 'Gizlemek için bırak',

    // play — oyun ortasında geri dönme (sekme kapanınca board QR'ı okutuldu)
    'play.rejoin.title': 'Oyuna Geri Dön',
    'play.rejoin.pick': 'Sekmen mi kapandı? Koltuğuna dönmek için kim olduğunu seç.',
    'play.rejoin.sub': 'Bu benim',
    'play.rejoin.deadSub': 'Bu benim (elendi)',
    'play.rejoin.welcome': 'Tekrar hoş geldin, {name}!',
    'play.rejoin.failed': 'Bu koltuk geri alınamadı.',
    'play.overlay.roleAlt': 'Rol kartın',

    // play — nomination
    'play.nom.title': 'Şansölye Aday Göster',
    'play.nom.special': 'Özel Seçim — bir sonraki Başkanı seç',
    'play.nom.sub': 'aday göster',
    'play.nom.none': 'Uygun aday yok (görev limitleri).',
    'play.nom.wait': 'Hükümet kuruluyor.\nBaşkan: {name}',

    // play — vote
    'play.vote.title': 'Seçim Oylaması',
    'play.vote.context': 'Başkan <b>{pres}</b>, <b>{chanc}</b> adını Şansölye olarak aday gösterdi',
    'play.vote.cancel': 'Vazgeç',
    'play.vote.waiting': 'Oyun verildi — diğerleri bekleniyor…',
    'play.vote.resultElected': 'Hükümet <b>seçildi</b>.',
    'play.vote.resultRejected': 'Hükümet <b>reddedildi</b>.',
    'play.vote.tally': '<b>Ja {ja} — {nein} Nein</b>',
    'play.vote.ballotJaAlt': 'Ja pusulası',
    'play.vote.ballotNeinAlt': 'Nein pusulası',

    // play — legislative (president)
    'play.legisPres.title': 'Başkansın',
    'play.legisPres.drawNote': 'Desteden <b>3</b> politika çek.',
    'play.legisPres.drawBtn': '3 Politika Çek',
    'play.legisPres.scanNote': 'Ya da büyük masadaki deste QR kodunu kamera uygulamanla okut.',
    'play.legisPres.discardNote': 'Politikalardan <b>birini</b> el, diğer ikisi şansölyeye gider.',
    'play.legisPres.transferWait': 'Şansölyenin iki politikayı onaylaması bekleniyor…',
    'play.legis.waitPresident': 'Yasama oturumu sürüyor.\nBaşkan: {name}',
    'play.legis.waitChancellor': 'Yasama oturumu sürüyor.\nŞansölye: {name}',

    // play — legislative (chancellor)
    'play.legisChanc.title': 'Şansölyesin',
    'play.legisChanc.receiveNote': 'Başkan sana <b>2 politika</b> iletti.',
    'play.legisChanc.receiveBtn': 'Alımı Onayla',
    'play.legisChanc.enactNote': '<b>Bir</b> politikayı bir tahtaya oyna — diğeri ele atılır.',
    'play.legisChanc.vetoBtn': 'Veto Talep Et',
    'play.legisChanc.vetoWait': 'Veto talep edildi — başkan bekleniyor…',
    'play.legisChanc.enactWait': 'Şansölyenin politika yürürlüğe koyması bekleniyor…',

    // play — veto response
    'play.veto.title': 'Veto Talebi',
    'play.veto.body': 'Şansölye <b>veto</b> talep ediyor — 3 politika da elinsin mi?',
    'play.veto.note': '(Onaylarsan seçim sayacı ilerler.)',
    'play.veto.agree': 'Vetoyu Onayla',
    'play.veto.refuse': 'Reddet',

    // play — cards / shared verbs
    'play.card.liberal': 'Liberal',
    'play.card.fascist': 'Faşist',
    'play.card.policy': 'Politika',
    'play.card.tapTo': '{verb} için dokun',
    'play.card.tapToSelect': 'seçmek için dokun',
    'play.card.tapToDiscard': 'at',
    'play.card.dragToTrash': 'atmak için çöpe sürükle',
    'play.card.dragToBoards': 'oynamak için tahtaya sürükle',
    'play.card.enactZone': 'Politika Oyna',
    'play.card.discardZone': 'Ele',
    'play.card.tapToEnact': 'yürürlüğe koymak',

    // play — executive powers
    'play.power.title': 'Yürütme Yetkisi',
    'play.power.investigate': 'Sadakati Tetkik Et',
    'play.power.policyPeek': 'Politika Yoklaması',
    'play.power.specialElection': 'Özel Seçim Yap',
    'play.power.execute': 'İdam',
    'play.power.pick': '{verb} için bir oyuncu seç',
    'play.power.verb.investigate': 'sadakatini tetkik etmek',
    'play.power.verb.execute': 'idam için işaretlemek',
    'play.power.verb.specialElection': 'bir sonraki başkan adayı yapmak',
    'play.power.noTargets': 'Geçerli hedef yok.',
    'play.power.unknown': 'Bilinmeyen yetki.',
    'play.power.peekBtn': 'Üstteki 3 Politikaya Bak',
    'play.power.peekResult': 'Çekim sırasına göre üstteki 3 politika:',
    'play.power.announceTitle': 'Tetkik!',
    'play.power.announceBody': 'Cumhurbaşkanı <b>{pres}</b>, <b>{target}</b> kişisini tetkik etti.',
    'play.power.announceAck': 'Anladım',
    'play.power.announceAckNamed': '<b>{pres}</b>, <b>{target}</b> kişisini tetkik etti — Anladım',
    'play.power.announceWaiting': 'Herkesin onaylaması bekleniyor ({acked}/{total})…',
    'play.power.investResult': 'Tetkik sonucu —',
    'play.power.investMember': '{name}, <b>{party}</b> partisinin üyesi.',
    'play.power.executeConfirm': '<b>{name}</b> idam edilsin mi?',
    'play.power.executeWarn': '⚠️ Bu işlem geri alınamaz.',
    'play.power.confirmExec': 'İdamı Onayla',
    'play.power.wait': 'Başkan {name} bir masa yetkisi kullanıyor.',

    // play — wait / game over
    'play.wait.title': 'Bekleniyor…',
    'play.wait.default': 'Bekleniyor…',
    'play.over.won': 'Takımın kazandı!',
    'play.over.lost': 'Takımın kaybetti.',
    'play.over.yourRole': 'Rolün',
    'play.over.notSeated': 'Bu oyunda koltuğun yoktu.',
    'play.over.again': 'Başka bir oyun? Masa ekranı yeni bir lobi başlatır.',

    // toasts (client-side)
    'play.toast.drew': '3 politika çekildi!',
    'play.toast.drawFailed': 'Çekim başarısız.',
    'play.toast.discarded': 'Eldi — şansölye diğer ikisini aldı.',
    'play.toast.received': 'Politikalar alındı!',
    'play.toast.receiveFailed': 'Alım onaylanamadı.',
    'play.toast.vetoFailed': 'Veto talep edilemedi.',
    'play.toast.executed': 'İdam gerçekleştirildi.',
    'play.toast.executeFailed': 'İdam başarısız.',

    // server error codes → friendly localized strings
    'err.TIMEOUT': 'Sunucu yanıt vermedi.',
    'err.SERVER_ERROR': 'İşlem başarısız.',
    'err.GAME_IN_PROGRESS': 'Zaten bir oyun sürüyor.',
    'err.BAD_NAME': 'Bir ad gir.',
    'err.LOBBY_FULL': 'Lobi dolu ({max} oyuncu).',
    'err.NOT_ENOUGH_PLAYERS': '{min}–{max} oyuncu gerekli.',
    'err.NOT_PRESIDENT': 'Bunu yalnızca şu anki başkan yapabilir.',
    'err.TOKEN_INVALID': 'Bu senin geçerli çekim QR kodun değil.',
    'err.TOKEN_CONSUMED': 'Bu çekim QR kodu zaten kullanıldı.',
    'err.NOT_CHANCELLOR': 'Bunu yalnızca şansölye yapabilir.',
    'err.BAD_HAND': 'İşlenecek bekleyen kart yok.',
    'err.TRANSFER_PENDING': 'Önce alınan politikaları onayla.',
    'err.NOT_A_PLAYER': 'Bu oyunda koltuğun yok.',
    'err.NO_GAME': 'Şu an bir oyun yok.',
    'err.PRESIDENT_LOCKED': 'Özel seçim sürüyor; plaket sabittir.',
    'err.DEAD_TARGET': 'Ölü bir oyuncu hedeflenemez.',
    'err.INELIGIBLE_CHANCELLOR': 'Bu oyuncu ölü, şu anki başkan ya da görev limitli.',
    'err.DEAD_VOTER': 'Ölü oyuncular oy veremez.',
    'err.ALREADY_VOTED': 'Zaten oy verdin.',
    'err.BAD_VOTE': 'Oy "ja" ya da "nein" olmalı.',
    'err.HAND_STATE': 'Kartlar beklenen durumda değil.',
    'err.BAD_CARD_INDEX': 'Geçersiz kart.',
    'err.VETO_LOCKED': 'Veto, 5 faşist politikasından sonra açılır.',
    'err.VETO_ALREADY_REQUESTED': 'Veto zaten talep edildi.',
    'err.NO_VETO_PENDING': 'Bekleyen veto talebi yok.',
    'err.VETO_PENDING': 'Önce veto talebini çöz.',
    'err.ALREADY_INVESTIGATED': 'Bu oyuncu zaten tetkik edildi.',
    'err.BAD_TARGET': 'Geçersiz hedef.',
    'err.WRONG_POWER': 'Bekleyen yetki farklı.',
    'err.NO_POWER_PENDING': 'Bekleyen yürütme yetkisi yok.',
    'err.UNKNOWN_ACTION': 'Bilinmeyen işlem.',
    'err.DECK_EXHAUSTED': 'Çekilecek yeterli politika kalmadı.',
    'err.UNKNOWN_PLAYER': 'Bilinmeyen oyuncu.',
    'err.DUPLICATE_PLAYERS': 'Oyuncu kimlikleri benzersiz olmalı.',
    'err.BAD_PLAYER_COUNT': 'Geçersiz oyuncu sayısı.',
    'err.BAD_PLAYER_ID': 'Geçersiz oyuncu kimliği.',
    'err.NO_LIVING_PLAYERS': 'Yaşayan oyuncu kalmadı.',
  },
};

// ------------------------------------------------------- localized art map
// Mirrors the `lang` maps in public/assets/manifest.json (built by
// scripts/build_assets.py). Base asset name (no extension) -> TR file.
// Keys absent here are language-neutral (EN art shown for both languages).
export const ASSET_LANG = {
  board_liberal: 'board_liberal_tr',
  'board_fascist_5-6': 'board_fascist_5-6_tr',
  'board_fascist_7-8': 'board_fascist_7-8_tr',
  'board_fascist_9-10': 'board_fascist_9-10_tr',
  'board_fascist_summary_5-6': 'board_fascist_summary_5-6_tr',
  'board_fascist_summary_7-8': 'board_fascist_summary_7-8_tr',
  'board_fascist_summary_9-10': 'board_fascist_summary_9-10_tr',
  logo_transparent: 'logo_transparent_tr',
};

// ------------------------------------------------------------- lang state

let listeners = [];
let currentLang = detectLang();

function detectLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    return LANGS.includes(saved) ? saved : 'en';
  } catch {
    return 'en'; // Node (tests) / privacy mode
  }
}

export function getLang() {
  return currentLang;
}

export function setLang(lang) {
  if (!LANGS.includes(lang) || lang === currentLang) return;
  currentLang = lang;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch { /* persistence is best-effort */ }
  document.documentElement.lang = lang === 'tr' ? 'tr' : 'en';
  applyI18n();
  for (const fn of listeners) fn(lang);
}

export function onChange(fn) {
  listeners.push(fn);
  return () => { listeners = listeners.filter((f) => f !== fn); };
}

// ---------------------------------------------------------------- translate

// t('key', { name: 'Ada' }) — {param} interpolation; missing key → the key.
export function t(key, params = {}) {
  const dict = DICT[currentLang] ?? DICT.en;
  let text = dict[key] ?? DICT.en[key] ?? key;
  for (const [name, value] of Object.entries(params)) {
    text = text.split(`{${name}}`).join(String(value));
  }
  return text;
}

// Localized message for a server error code; falls back to the server's own
// message (English) when the code is unknown here.
export function errorText(code, fallback) {
  const key = `err.${code}`;
  const dict = DICT[currentLang] ?? DICT.en;
  if (dict[key] != null) return t(key, { min: 5, max: 10 });
  return fallback ?? t('err.SERVER_ERROR');
}

// ------------------------------------------------- localized asset swapping

// Asset directory resolved from THIS module's URL — correct under a domain
// root and a GitHub Pages project sub-path alike.
const ASSET_BASE = new URL('../assets/', import.meta.url);

// '../assets/board_liberal.png' -> absolute TR variant URL when one exists;
// unchanged otherwise. Works on any assets/<name>.<ext> reference.
export function localizedAssetPath(src) {
  if (currentLang !== 'tr' || typeof src !== 'string') return src;
  const file = src.split('/').pop();
  const m = file.match(/^(.+)\.(png|svg|jpg|webp)$/i);
  if (!m) return src;
  const trName = ASSET_LANG[m[1]];
  return trName ? new URL(`${trName}.${m[2]}`, ASSET_BASE).href : src;
}

// Swap every <img data-localizable> under `root` to the active language's
// variant. The EN base path must be in data-base-src so switching back to EN
// restores the original file.
export function swapLocalizedImages(root = document) {
  for (const img of root.querySelectorAll('img[data-localizable]')) {
    const base = img.dataset.baseSrc ?? img.getAttribute('src');
    img.dataset.baseSrc = base;
    const next = localizedAssetPath(base);
    if (!img.src.endsWith(next)) img.src = next;
  }
}

// ----------------------------------------------------- static DOM rendering

// Fill [data-i18n] (textContent), [data-i18n-html] (innerHTML, our trusted
// dictionary markup), [data-i18n-placeholder], [data-i18n-title],
// [data-i18n-alt]. Called automatically on setLang and once at boot.
export function applyI18n(root = document) {
  const q = (attr) => root.querySelectorAll(`[${attr}]`);
  for (const el of q('data-i18n')) el.textContent = t(el.dataset.i18n);
  for (const el of q('data-i18n-html')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of q('data-i18n-placeholder')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of q('data-i18n-title')) el.title = t(el.dataset.i18nTitle);
  for (const el of q('data-i18n-alt')) el.alt = t(el.dataset.i18nAlt);
  document.documentElement.lang = currentLang === 'tr' ? 'tr' : 'en';
  swapLocalizedImages(root);
}

// --------------------------------------------- language toggle (EN | TR pill)

// Build a compact segmented EN|TR control. `onPick` defaults to setLang so the
// board and phone clients just mount it where they want it.
export function createLangToggle() {
  const wrap = document.createElement('div');
  wrap.className = 'lang-toggle';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', t('lang.title'));
  for (const lang of LANGS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `lang-btn lang-${lang}`;
    btn.dataset.lang = lang;
    btn.textContent = lang === 'en' ? t('lang.en') : t('lang.tr');
    btn.title = t('lang.title');
    btn.setAttribute('aria-pressed', String(currentLang === lang));
    btn.addEventListener('click', () => setLang(lang));
    wrap.appendChild(btn);
  }
  const sync = () => {
    for (const btn of wrap.querySelectorAll('.lang-btn')) {
      btn.classList.toggle('active', btn.dataset.lang === currentLang);
      btn.setAttribute('aria-pressed', String(btn.dataset.lang === currentLang));
    }
  };
  sync();
  onChange(sync);
  return wrap;
}
