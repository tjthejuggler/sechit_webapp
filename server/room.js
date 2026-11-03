// Isomorphic game room: wraps a GameSession with the client-facing protocol
// (join / identify / rejoin / action) and state broadcasting — with ZERO
// transport dependencies. The Node server (app.js) drives it with Socket.IO
// connections; the browser host (public/board/host.js) drives it with PeerJS
// data connections. Both therefore run byte-identical game logic.
//
// Client interface expected by GameRoom:
//   {
//     kind: 'board' | 'play',
//     authToken: string | null,     // token captured at connect time
//     data: { token, playerId, name },  // mutable per-connection session binding
//     send(event, payload),         // push an event to that client only
//   }
import { GameSession } from './session.js';

export const ACTIONS = {
  draw: (id, { token } = {}) => (s, actor) => s.presidentDraw(actor, token),
  discard: (id, { cardIndex } = {}) => (s, actor) => s.discard(actor, cardIndex),
  receive: (id) => (s, actor) => s.chancellorReceive(actor),
  enact: (id, { cardIndex } = {}) => (s, actor) => s.enact(actor, cardIndex),
  vote: (id, { vote } = {}) => (s, actor) => s.vote(actor, vote),
  nominate: (id, { targetId } = {}) => (s, actor) => s.nominate(actor, targetId),
  vetoRequest: (id) => (s, actor) => s.vetoRequest(actor),
  vetoRespond: (id, { consent } = {}) => (s, actor) => s.vetoRespond(actor, consent),
  // Investigation transparency ack: every living player must confirm they saw
  // who was investigated before the game continues (see session gate).
  ackInvestigation: (id) => (s, actor) => s.ackInvestigation(actor),
  // Targeted powers pick a target from the picker list on the president's
  // phone (no QR scanning): the engine validates entitlement identically.
  investigate: (id, { targetId } = {}) => (s, actor) => s.investigate(actor, targetId),
  peek: (id) => (s, actor) => s.policyPeek(actor),
  specialElection: (id, { targetId } = {}) => (s, actor) => s.specialElection(actor, targetId),
  execute: (id, { targetId } = {}) => (s, actor) => s.execute(actor, targetId),
};

// Map an action name + args to a session call bound to the actor.
function runAction(session, actorId, type, args) {
  const fn = ACTIONS[type];
  if (!fn) {
    const err = new Error(`Unknown action "${type}".`);
    err.code = 'UNKNOWN_ACTION';
    throw err;
  }
  return fn(actorId, args)(session, actorId);
}

export class GameRoom {
  /**
   * @param {object} opts
   * @param {GameSession} opts.session
   */
  constructor({ session }) {
    this.session = session;
    this.clients = new Set();
    // Every session state change fans out to all attached clients.
    this.session.onState = () => this.broadcast();
  }

  // ------------------------------------------------------------- lifecycle

  addClient(client) {
    this.clients.add(client);
    if (client.kind === 'play') {
      // Late (re)bind via captured connect-time token — mirrors the original
      // socket.io handshake auth reattach.
      const existing = client.authToken ? this.session.reattach(client.authToken) : null;
      if (existing) {
        client.data.playerId = existing.playerId;
        client.data.name = existing.name;
      }
      client.send('hello', {
        reconnectedAs: existing ? existing.playerId : null,
        lobbyOpen: !this.session.inGame(),
        joinUrl: this.session.joinUrl(),
        minPlayers: this.session.minPlayers,
        maxPlayers: this.session.maxPlayers,
      });
      // Immediate view: reconnecting phones must not wait for the next event.
      const initial = existing ? this.session.privateState(existing.playerId) : this.session.publicState();
      client.send('state', initial);
    } else {
      client.send('state', this.session.publicState());
    }
  }

  removeClient(client) {
    this.clients.delete(client);
  }

  playerIdForClient(client) {
    if (client.data.playerId) return client.data.playerId;
    const token = client.authToken;
    if (!token) return null;
    const rec = this.session.reattach(token);
    return rec ? rec.playerId : null;
  }

  // ------------------------------------------------------- play events
  // handlePlay(client, event, payload) → ack object ({ ok, ... } / { ok:false })
  // Exactly the semantics the socket.io server had: {type,...args} actions
  // resolve to { result, you }; identify/rejoin re-bind the connection.

  handlePlay(client, event, payload = {}) {
    try {
      switch (event) {
        case 'identify': {
          const rec = this.session.reattach(payload.token);
          if (!rec) {
            const err = new Error('Unknown session token.');
            err.code = 'TOKEN_INVALID';
            throw err;
          }
          client.data.token = payload.token;
          client.data.playerId = rec.playerId;
          client.data.name = rec.name;
          const priv = this.session.privateState(rec.playerId);
          if (priv) {
            client.send('state', priv);
          } else if (!this.session.inGame()) {
            // Lobby: confirm the seat + push roster so the tab leaves the join form.
            client.send('state', this.session.publicState());
            client.send('lobby', {
              lobbyOpen: true,
              seated: true,
              players: this.session.lobby.map((p) => ({ id: p.id, name: p.name })),
            });
          }
          return { ok: true, playerId: rec.playerId, name: rec.name };
        }
        case 'rejoin': {
          const rec = this.session.reclaimSeat(payload.playerId);
          client.data.token = rec.token;
          client.data.playerId = rec.playerId;
          client.data.name = rec.name;
          const priv = this.session.privateState(rec.playerId);
          if (priv) client.send('state', priv);
          return { ok: true, token: rec.token, playerId: rec.playerId, name: rec.name };
        }
        case 'join': {
          const { token, playerId, name } = this.session.joinLobby(payload.name);
          client.data.token = token;
          client.data.playerId = playerId;
          client.data.name = name;
          return { ok: true, token, playerId, name };
        }
        case 'action': {
          const playerId = this.playerIdForClient(client);
          if (!playerId || !this.session.isPlayer(playerId)) {
            const err = new Error('Not seated in this game.');
            err.code = 'NOT_A_PLAYER';
            throw err;
          }
          const { type, ...args } = payload ?? {};
          const result = runAction(this.session, playerId, type, args);
          // Deliver the actor's fresh private state with the ack.
          return { ok: true, result, you: this.session.privateState(playerId) };
        }
        default: {
          const err = new Error(`Unknown event "${event}".`);
          err.code = 'UNKNOWN_EVENT';
          throw err;
        }
      }
    } catch (err) {
      return { ok: false, code: err.code ?? 'SERVER_ERROR', message: err.message ?? 'Server error.' };
    }
  }

  // ------------------------------------------------------ board events
  // The board is a trusted local client (big screen next to the players).
  // Same ack contract; used identically by the socket.io namespace and the
  // browser host's loopback.

  handleBoard(client, event, payload = {}) {
    try {
      switch (event) {
        case 'board:start': return { ok: true, ...this.session.startGame() };
        case 'board:beginNomination': return { ok: true, ...this.session.beginNomination() };
        case 'board:reorder': return { ok: true, ids: this.session.reorderLobby(payload) };
        case 'board:president': return { ok: true, ...this.session.setPresident(payload) };
        case 'board:reset': return { ok: true, ...this.session.reset() };
        default: {
          const err = new Error(`Unknown event "${event}".`);
          err.code = 'UNKNOWN_EVENT';
          throw err;
        }
      }
    } catch (err) {
      return { ok: false, code: err.code ?? 'SERVER_ERROR', message: err.message ?? 'Server error.' };
    }
  }

  // ------------------------------------------------------------- broadcast

  // Public state to the board and a tailored private state to every seated
  // phone. Called after every state change.
  broadcast() {
    const pub = this.session.publicState();
    const lobbyOpen = !this.session.inGame();
    for (const client of this.clients) {
      if (client.kind === 'board') {
        client.send('state', pub);
        continue;
      }
      const playerId = this.playerIdForClient(client);
      const priv = playerId ? this.session.privateState(playerId) : null;
      // Seated phones get their private view; everyone else the public one.
      client.send('state', priv ?? pub);
      // Per-client lobby info: each phone learns whether ITS session is still
      // valid (a board reset invalidates old tokens).
      client.send('lobby', {
        lobbyOpen,
        seated: Boolean(playerId && this.session.isPlayer(playerId)),
        players: lobbyOpen ? this.session.lobby.map((p) => ({ id: p.id, name: p.name })) : [],
      });
    }
  }
}
