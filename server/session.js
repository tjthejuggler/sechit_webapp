// Server-side game session: wraps the pure engine with lobby management,
// the one-time board draw token and view assembly. No sockets here — app.js
// owns the transport; this class owns the state.
//
// Player phones carry NO QR codes: targeting (investigate / special election /
// execution) is pick-from-list on the entitled player's phone, and the 2-card
// hand is delivered to the chancellor's phone at discard time (receive is a
// plain ack). Only the BOARD's deck QR remains (president draws 3).
import { randomHex, sha256HexSync } from './engine/random.js';
import {
  GameEngine,
  Deck,
  TokenService,
  EngineError,
  PHASE,
  MIN_PLAYERS,
  MAX_PLAYERS,
} from './engine/index.js';

const PURPOSE = { DRAW: 'draw' };

export class GameSession {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl absolute LAN base URL, e.g. http://192.168.1.10:3000
   * @param {(payload: object) => void} [opts.onState] called after every state change
   * @param {number} [opts.devPlayers] DEV_PLAYERS: auto-create N dev seats (P1..PN)
   */
  constructor({ baseUrl, gameId = null, onState = null, devPlayers = 0, engineEventWrapper = null, investigateFirstPower = false } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.onState = typeof onState === 'function' ? onState : null;
    // Optional observer wrapper for engine events (dev-mode console logger).
    // It receives the session's own handler and must never replace its logic.
    this.engineEventWrapper = typeof engineEventWrapper === 'function' ? engineEventWrapper : null;
    // Short public game id. The browser host passes its own randomly generated
    // game code (it doubles as the PeerJS peer id); the Node server lets one
    // be generated here.
    this.gameId = String(gameId || randomHex(3));
    this.fixedGameId = gameId ? this.gameId : null; // survives reset() (browser host peer id)
    this.lobby = [];           // [{ id, name, dev }] in join (seat) order
    this.sessions = new Map(); // sessionToken -> { playerId, name }
    this.engine = null;
    this.tokens = new TokenService();
    this.drawToken = null;     // one-time "president draws 3" token (bound to president)
    this.presidentDrew = false;
    this.transferPending = false; // chancellor ack still outstanding
    this.investigationAnnounce = null; // {presidentId, targetId, ackedIds:Set} gate
    this.flash = {};           // transient flags consumed by the next publicState()
    this.minPlayers = MIN_PLAYERS;
    this.maxPlayers = MAX_PLAYERS;
    this.investigateFirstPower = Boolean(investigateFirstPower);
    this.devPlayers = GameSession.normalizeDevPlayers(devPlayers);
    if (this.devPlayers > 0) this.#createDevSeats();
  }

  // Dev mode helper: N in 5..10 (numbers outside the range are clamped; junk → 0).
  static normalizeDevPlayers(value) {
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, n));
  }

  // Auto-create P1..PN dev seats with stable session tokens. Dev seats behave
  // exactly like phone players; each has a deterministic token so a browser
  // tab can bind to its seat via /play?p=<token> (no join form needed).
  #createDevSeats() {
    for (let i = 1; i <= this.devPlayers; i++) {
      this.#addLobbySeat(`P${i}`, { dev: true, tokenSeed: i });
    }
  }

  // Shared seat factory (real joins + dev seats): dedupes names, reserves a
  // player id, registers a session token.
  #addLobbySeat(name, { dev = false, tokenSeed = null } = {}) {
    let unique = String(name).trim().slice(0, 20);
    let n = 2;
    while (this.lobby.some((p) => p.name.toLowerCase() === unique.toLowerCase())) {
      unique = `${name} ${n++}`;
    }
    const playerId = `p${randomHex(4)}`;
    // Dev seats get a DETERMINISTIC token (sha of gameId + index) so start.sh
    // can construct per-player URLs without an API round-trip per seat.
    const token = dev
      ? sha256HexSync(`${this.gameId}:dev:${tokenSeed}`)
      : randomHex(16);
    this.lobby.push({ id: playerId, name: unique, dev });
    this.sessions.set(token, { playerId, name: unique });
    return { token, playerId, name: unique, dev };
  }

  joinUrl() {
    return `${this.baseUrl}/play/?g=${this.gameId}`;
  }

  // ------------------------------------------------------------------ lobby

  joinLobby(name) {
    if (this.engine) this.#fail('GAME_IN_PROGRESS', 'A game is already running.');
    const clean = String(name ?? '').trim().slice(0, 20);
    if (!clean) this.#fail('BAD_NAME', 'Enter a name.');
    if (this.lobby.length >= this.maxPlayers) this.#fail('LOBBY_FULL', `Lobby is full (${this.maxPlayers} players).`);
    const rec = this.#addLobbySeat(clean);
    this.#changed();
    return { token: rec.token, playerId: rec.playerId, name: rec.name };
  }

  // Reattach a phone via its localStorage/session URL token. Returns the
  // session record or null (token unknown — e.g. after a reset).
  // Board-side pre-game seating arrangement: drag-and-drop reorder of the
  // lobby. The lobby array order IS the seat order used by startGame(), so a
  // reorder here directly changes the seating circle. Only valid pre-game.
  reorderLobby(orderedIds) {
    if (this.engine) this.#fail('GAME_IN_PROGRESS', 'A game is already running.');
    const ids = (Array.isArray(orderedIds) ? orderedIds : []).map(String);
    const current = new Set(this.lobby.map((p) => p.id));
    if (ids.length !== current.size
      || new Set(ids).size !== ids.length
      || ids.some((id) => !current.has(id))) {
      this.#fail('BAD_ORDER', 'Order must list every seated player exactly once.');
    }
    const byId = new Map(this.lobby.map((p) => [p.id, p]));
    this.lobby = ids.map((id) => byId.get(id));
    this.#changed();
    return this.lobby.map((p) => p.id);
  }

  reattach(token) {
    return this.sessions.get(String(token ?? '')) ?? null;
  }

  // Mid-game rejoin: a player closed their tab (or lost localStorage), scanned
  // the board's persistent join QR and picked "which player am I?". We hand
  // back that seat's EXISTING session token so the phone re-binds exactly
  // like the ?p=<token> dev flow. Casual-table trust model: anyone who can
  // see the board QR can claim any seat — by design for home/LAN play.
  reclaimSeat(playerId) {
    for (const [token, rec] of this.sessions) {
      if (rec.playerId === playerId) {
        return { token, playerId: rec.playerId, name: rec.name };
      }
    }
    this.#fail('NOT_A_PLAYER', 'No seat matches that player.');
  }

  isPlayer(playerId) {
    if (!this.engine) return this.lobby.some((p) => p.id === playerId);
    return this.engine.state.players.some((p) => p.id === playerId);
  }

  // Dev-mode seat directory: name + bound /play URL per dev player. Only
  // exposed while dev mode is active (app.js guards the endpoint).
  devPlayerUrls() {
    if (this.devPlayers === 0) return [];
    const byToken = new Map();
    for (const [token, rec] of this.sessions) byToken.set(rec.playerId, token);
    return this.lobby
      .filter((p) => p.dev)
      .map((p, i) => ({
        name: p.name,
        url: `${this.baseUrl}/play/?p=${byToken.get(p.id) ?? `dev-${i + 1}`}`,
      }));
  }

  // ------------------------------------------------------------------ board

  startGame() {
    if (this.engine) this.#fail('GAME_IN_PROGRESS', 'A game is already running.');
    if (this.lobby.length < this.minPlayers) {
      this.#fail('NOT_ENOUGH_PLAYERS', `Need ${this.minPlayers}–${this.maxPlayers} players.`);
    }
    const names = {};
    for (const p of this.lobby) names[p.id] = p.name;
    const delegate = (event) => this.#onEngineEvent(event);
    this.engine = new GameEngine({
      onEvent: this.engineEventWrapper ? this.engineEventWrapper(delegate) : delegate,
      investigateFirstPower: this.investigateFirstPower,
    });
    this.engine.startGame(this.lobby.map((p) => p.id), { names });
    this.#changed();
  }

  // Browser-host resume: re-attach a previously serialized engine (see
  // public/board/host.js). Wires the engine event delegate exactly like
  // startGame() would; the engine object itself is rebuilt by the caller.
  attachRestoredEngine(engine) {
    const delegate = (event) => this.#onEngineEvent(event);
    engine.onEvent = this.engineEventWrapper ? this.engineEventWrapper(delegate) : delegate;
    engine.investigateFirstPower = this.investigateFirstPower;
    this.engine = engine;
  }

  // ------------------------------------------------------------- persistence

  // Full serializable snapshot (plain JSON) of everything needed to resume
  // this exact game elsewhere or after a host reload: lobby, seat tokens, the
  // engine state machine, the draw token and session gates.
  snapshot() {
    return {
      v: 1,
      code: this.gameId,
      savedAt: Date.now(),
      lobby: this.lobby,
      sessions: [...this.sessions],
      drawToken: this.drawToken,
      presidentDrew: this.presidentDrew,
      transferPending: this.transferPending,
      investigationAnnounce: this.investigationAnnounce
        ? { ...this.investigationAnnounce, ackedIds: [...this.investigationAnnounce.ackedIds] }
        : null,
      tokens: [...this.tokens.tokens],
      engine: this.engine
        ? {
            seq: this.engine._seq,
            state: {
              ...this.engine.state,
              // Map/Set fields serialize as {} — convert explicitly.
              votes: [...this.engine.state.votes],
              investigatedIds: [...this.engine.state.investigatedIds],
              deck: {
                draw: this.engine.state.deck.draw.slice(),
                discard: this.engine.state.deck.discard.slice(),
                reshuffled: !!this.engine.state.deck.reshuffled,
              },
            },
          }
        : null,
    };
  }

  // Rebuild a session from snapshot() output. The deck is rehydrated with a
  // fresh rng — future draw order differs from the pre-snapshot stream, which
  // is equivalent to a reshuffle of unseen cards (no information leak).
  // onState is NOT restored (the new owner re-registers it).
  static fromSnapshot(snap, opts = {}) {
    if (!snap || snap.v !== 1) throw new Error('BAD_SNAPSHOT');
    const session = new GameSession({ ...opts, gameId: snap.code ?? opts.gameId });
    session.lobby = snap.lobby ?? [];
    session.sessions = new Map(snap.sessions ?? []);
    session.tokens.tokens = new Map(snap.tokens ?? []);
    session.drawToken = snap.drawToken ?? null;
    session.presidentDrew = !!snap.presidentDrew;
    session.transferPending = !!snap.transferPending;
    session.investigationAnnounce = snap.investigationAnnounce
      ? { ...snap.investigationAnnounce, ackedIds: new Set(snap.investigationAnnounce.ackedIds ?? []) }
      : null;
    if (snap.engine?.state) {
      const engine = new GameEngine({});
      engine._seq = snap.engine.seq ?? 0;
      const deck = new Deck(engine.rng);
      const d = snap.engine.state.deck ?? {};
      deck.draw = d.draw ?? [];
      deck.discard = d.discard ?? [];
      deck.reshuffled = !!d.reshuffled;
      engine.state = {
        ...snap.engine.state,
        votes: new Map(snap.engine.state.votes ?? []),
        investigatedIds: new Set(snap.engine.state.investigatedIds ?? []),
        deck,
      };
      session.attachRestoredEngine(engine);
    }
    session.onState = null;
    return session;
  }

  beginNomination() {
    this.#gateAnnounce();
    this.#eng().beginNomination();
    this.#changed();
  }

  reset() {
    this.lobby = [];
    this.sessions = new Map();
    this.engine = null;
    this.tokens = new TokenService();
    this.drawToken = null;
    this.presidentDrew = false;
    this.transferPending = false;
    this.investigationAnnounce = null;
    this.flash = {};
    this.gameId = this.fixedGameId ?? randomHex(3);
    // Dev mode persists across resets: seats are re-created with the new
    // gameId (fresh deterministic tokens; open dev tabs re-bind by URL token).
    if (this.devPlayers > 0) this.#createDevSeats();
    this.#changed();
  }

  // ------------------------------------------------------------ board/plaque

  setPresident(targetId) {
    this.#gateAnnounce();
    this.#eng().setPresidentManually(targetId);
    this.#changed();
  }

  // --------------------------------------------------------- player actions
  // All actions throw EngineError (code, message) on invalid input; app.js
  // forwards these to the originating client only.

  nominate(actorId, targetId) {
    this.#gateAnnounce();
    this.#eng().nominateChancellor(actorId, targetId);
    this.#changed();
  }

  vote(actorId, choice) {
    this.#gateAnnounce();
    this.#eng().castVote(actorId, choice);
    this.#changed();
  }

  // President draws 3. Primary path: a plain tap on the president's phone
  // (no token). The board's deck QR remains an alternative entry: scanning it
  // opens /play?d=<token>, and that one-time token (bound to the president)
  // is validated + consumed here.
  presidentDraw(actorId, token) {
    this.#gateAnnounce();
    const engine = this.#eng();
    if (engine.state.presidentId !== actorId) {
      this.#fail('NOT_PRESIDENT', 'Only the current president may draw.');
    }
    const t = String(token ?? '').trim();
    if (t) {
      // Validate before mutating; consume only after the engine accepted.
      const rec = this.tokens.peek(t);
      if (!rec || rec.purpose !== PURPOSE.DRAW || rec.boundPlayerId !== actorId) {
        this.#fail('TOKEN_INVALID', 'This is not your valid draw QR.');
      }
      if (rec.consumed) this.#fail('TOKEN_CONSUMED', 'This draw QR was already used.');
    }
    engine.presidentDraw();
    if (t) this.tokens.consume(t, { purpose: PURPOSE.DRAW, playerId: actorId });
    this.#changed();
  }

  discard(actorId, cardIndex) {
    this.#gateAnnounce();
    const engine = this.#eng();
    if (engine.state.presidentId !== actorId) {
      this.#fail('NOT_PRESIDENT', 'Only the current president may discard.');
    }
    engine.presidentDiscard(cardIndex);
    // The 2 cards land on the chancellor's phone immediately; the chancellor
    // confirms receipt with the plain `receive` action (no QR any more).
    this.transferPending = true;
    this.#changed();
  }

  // Chancellor acknowledges the 2 delivered policies. Idempotent-friendly:
  // a repeated ack just re-acks while the session is still open.
  chancellorReceive(actorId) {
    this.#gateAnnounce();
    const engine = this.#eng();
    if (engine.state.chancellorId !== actorId) {
      this.#fail('NOT_CHANCELLOR', 'Only the chancellor may receive.');
    }
    if (engine.state.chancellorHand.length !== 2) {
      this.#fail('BAD_HAND', 'No pending hand to receive.');
    }
    this.transferPending = false;
    engine.chancellorReceive();
    this.#changed();
  }

  enact(actorId, cardIndex) {
    this.#gateAnnounce();
    const engine = this.#eng();
    // Receive-ack gate: the chancellor must tap "receive" before enacting
    // (mirrors the old QR gate; keeps mid-session resume safe).
    if (this.transferPending) {
      this.#fail('TRANSFER_PENDING', 'Confirm the received policies first.');
    }
    engine.chancellorEnact(actorId, cardIndex); // remaining card auto-discards
    this.#changed();
  }

  vetoRequest(actorId) {
    this.#gateAnnounce();
    this.#eng().vetoRequest(actorId);
    this.#changed();
  }

  vetoRespond(actorId, consent) {
    this.#gateAnnounce();
    this.#eng().vetoRespond(actorId, Boolean(consent));
    if (consent) {
      this.transferPending = false;
    }
    this.#changed();
  }

  investigate(actorId, targetId) {
    this.#gateAnnounce();
    this.#eng().investigate(actorId, targetId);
    // Transparency gate: every LIVING player must acknowledge WHO was
    // investigated (target only — the party stays private to the president)
    // before any further action can move the game on.
    const inv = this.engine.state.lastInvestigation;
    this.investigationAnnounce = {
      presidentId: inv.presidentId,
      targetId: inv.targetId,
      ackedIds: new Set(),
    };
    this.#changed();
  }

  // Player acknowledges the investigation announcement. The gate lifts as
  // soon as every living player has acknowledged.
  ackInvestigation(actorId) {
    const a = this.investigationAnnounce;
    if (!a) return; // idempotent: gate already lifted
    const engine = this.#eng();
    const player = engine.state.players.find((p) => p.id === actorId);
    if (!player || !player.alive) this.#fail('NOT_A_PLAYER', 'Only living players can acknowledge.');
    if (!a.ackedIds.has(actorId)) a.ackedIds.add(actorId);
    const living = engine.state.players.filter((p) => p.alive);
    if (living.every((p) => a.ackedIds.has(p.id))) this.investigationAnnounce = null;
    this.#changed();
  }

  policyPeek(actorId) {
    this.#gateAnnounce();
    const cards = this.#eng().policyPeek(actorId);
    this.#changed();
    return cards;
  }

  specialElection(actorId, targetId) {
    this.#gateAnnounce();
    this.#eng().specialElection(actorId, targetId);
    this.#changed();
  }

  execute(actorId, targetId) {
    this.#gateAnnounce();
    this.#eng().execute(actorId, targetId);
    this.#changed();
  }

  #requireSeated(playerId) {
    if (!this.isPlayer(playerId)) this.#fail('NOT_A_PLAYER', 'You are not seated in this game.');
  }

  // ------------------------------------------------------------------ views

  inGame() {
    return Boolean(this.engine && this.engine.state);
  }

  phase() {
    return this.inGame() ? this.engine.state.phase : PHASE.LOBBY;
  }

  publicState() {
    const flash = this.flash;
    this.flash = {};
    if (!this.inGame()) {
      return {
        phase: PHASE.LOBBY,
        gameId: this.gameId,
        joinUrl: this.joinUrl(),
        lobby: this.lobby.slice(),
        minPlayers: this.minPlayers,
        maxPlayers: this.maxPlayers,
        lobbyOpen: true,
        flash,
      };
    }
    const view = this.engine.publicView();
    const drawQr = view.phase === PHASE.LEGISLATIVE_PRESIDENT
      && !this.presidentDrew
      && this.drawToken
      ? `${this.baseUrl}/play/?g=${this.gameId}&d=${this.drawToken}`
      : null;
    return {
      ...view,
      gameId: this.gameId,
      lobbyOpen: false,
      presidentDrew: this.presidentDrew,
      drawTokenUrl: drawQr,
      transferPending: this.transferPending,
      // Transparency gate: who was investigated + who has acknowledged it
      // (the party membership itself stays private to the president).
      investigationAnnounce: this.investigationAnnounce
        ? {
            presidentId: this.investigationAnnounce.presidentId,
            targetId: this.investigationAnnounce.targetId,
            ackedIds: [...this.investigationAnnounce.ackedIds],
          }
        : null,
      flash,
    };
  }

  // Private payload for one player, or null for unknown players/spectators.
  privateState(playerId) {
    if (!this.inGame() || !this.engine.state.players.some((p) => p.id === playerId)) return null;
    const view = this.engine.privateView(playerId);
    view.presidentDrew = this.presidentDrew;
    // The chancellor's phone gates its enact UI on this (receive ack pending).
    view.transferPending = this.transferPending;
    // Phones receive the PRIVATE view, so the public investigation
    // announcement (who was investigated + ack progress) must be merged in
    // here as well — otherwise only the board would ever see it.
    view.investigationAnnounce = this.investigationAnnounce
      ? {
          presidentId: this.investigationAnnounce.presidentId,
          targetId: this.investigationAnnounce.targetId,
          ackedIds: [...this.investigationAnnounce.ackedIds],
        }
      : null;
    return view;
  }

  // ---------------------------------------------------------------- private

  #eng() {
    if (!this.engine) this.#fail('NO_GAME', 'No game is running.');
    return this.engine;
  }

  // Block game actions while an investigation announcement is still waiting
  // for acknowledgements from every living player.
  #gateAnnounce() {
    if (this.investigationAnnounce) {
      this.#fail('ANNOUNCE_PENDING', 'Everyone must first acknowledge who was investigated.');
    }
  }

  // Engine event side-effects: draw-token lifecycle + transient board flags.
  #onEngineEvent(event) {
    switch (event.type) {
      case 'invalidAction':
        return; // the thrown EngineError already reached the acting client
      case 'governmentFormed':
        this.presidentDrew = false;
        this.transferPending = false;
        this.drawToken = this.tokens.createToken(PURPOSE.DRAW, { gameId: this.gameId }, event.presidentId ?? null);
        break;
      case 'cardsDrawn':
        this.presidentDrew = true;
        this.transferPending = false;
        break;
      case 'presidentDiscarded':
        this.transferPending = true;
        break;
      case 'chancellorReceived':
        this.transferPending = false;
        break;
      case 'executed':
      case 'powerGranted':
        break;
      case 'vetoAgreed':
        this.transferPending = false;
        break;
      case 'reshuffled':
        this.flash.reshuffle = true;
        break;
      default:
        break;
    }
  }

  #changed() {
    if (this.onState) this.onState();
  }

  #fail(code, message) {
    throw new EngineError(code, message);
  }
}
