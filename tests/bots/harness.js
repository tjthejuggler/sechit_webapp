// Wire-level bot harness: boots the REAL server (server/app.js) on an ephemeral
// port inside the test process, then connects socket.io-client bots — one
// "phone" per player plus one big-screen board client — exactly like real
// clients. Every gameplay action travels over Socket.IO with real session
// tokens and QR codes; the harness only adds promise-based waiting, continuous
// invariant monitoring (policy conservation, vote completeness, dead-player
// exclusion) and rich context dumps on failure.

import { once } from 'node:events';
import { io } from 'socket.io-client';
import { PHASE } from '../../server/engine/index.js';

export const ACK_TIMEOUT = 5_000;
export const WAIT_TIMEOUT = 15_000;

/** Boot the real server on an ephemeral port (one instance per test process). */
export async function startServer() {
  process.env.PORT = '0'; // app.js reads PORT at import time; 0 => ephemeral
  const { server, io: sio, session } = await import('../../server/app.js');
  if (!server.listening) await once(server, 'listening');
  const port = server.address().port;
  return { server, io: sio, session, port, url: `http://127.0.0.1:${port}` };
}

/** Gracefully shut the fixture down. */
export async function stopServer(fixture) {
  await new Promise((resolve) => fixture.io.close(() => resolve()));
}

function waitConnect(socket, timeout = ACK_TIMEOUT) {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timeout')), timeout);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Emit an event expecting the server's ack callback; rejects on timeout. */
export function emitAck(socket, event, payload = {}, timeout = ACK_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; reject(new Error(`ack timeout for "${event}"`)); }
    }, timeout);
    socket.timeout(timeout).emit(event, payload, (err, ack) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(new Error(`ack error for "${event}": ${err.message}`));
      else resolve(ack);
    });
  });
}

/** Extract the one-time QR token from a session-generated token URL. */
export function tokenFromUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return u.searchParams.get('d') ?? u.searchParams.get('t');
  } catch {
    return null;
  }
}

// Tiles must always split across draw + discard + enacted tracks + on-table
// hands. The public board view exposes pile counts; on-table tiles are derived
// from the phase (3 while the president holds them, 2 in the chancellor's).
function onTableCards(view) {
  if (view.phase === PHASE.LEGISLATIVE_PRESIDENT) return view.presidentDrew ? 3 : 0;
  if (view.phase === PHASE.LEGISLATIVE_CHANCELLOR) return 2;
  return 0;
}

/** One bot "phone" connected to /play — mirrors public/play/play.js. */
export class PlayerBot {
  constructor(table, name) {
    this.table = table;
    this.name = name;
    this.token = null;
    this.id = null;
    this.view = null; // latest private (or pre-seat public) view
    this.socket = null;
    this.cleanDisconnect = false;
  }

  async connectAndJoin() {
    const s = io(`${this.table.fixture.url}/play`);
    this.socket = s;
    s.on('connect_error', (err) => this.table.socketErrors.push(`${this.name}: ${err.message}`));
    s.on('disconnect', (reason) => {
      if (!this.cleanDisconnect && reason !== 'io client disconnect') {
        this.table.socketErrors.push(`${this.name} disconnected: ${reason}`);
      }
    });
    // Attach before connect resolves: the server emits `hello` immediately.
    const hello = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`hello timeout for ${this.name}`)), ACK_TIMEOUT);
      s.once('hello', () => { clearTimeout(timer); resolve(); });
    });
    await waitConnect(s);
    await hello;
    // Listen before joining so the join broadcast is never missed.
    s.on('state', (view) => {
      this.view = view;
      this.table.bump();
    });
    const ack = await emitAck(s, 'join', { name: this.name });
    if (!ack?.ok) throw new Error(`join failed for ${this.name}: ${JSON.stringify(ack)}`);
    this.token = ack.token;
    this.id = ack.playerId;
    return this;
  }

  /** Send a player action over the wire; returns the raw ack. */
  action(type, args = {}, opts = {}) {
    return emitAck(this.socket, 'action', { type, ...args }, opts.timeout ?? ACK_TIMEOUT);
  }

  disconnect() {
    this.cleanDisconnect = true;
    this.socket?.disconnect();
  }
}

/** The big-screen client connected to /board — mirrors public/board/board.js. */
class BoardClient {
  constructor(table) {
    this.table = table;
    this.view = null;
    this.socket = null;
  }

  async connect() {
    const s = io(`${this.table.fixture.url}/board`);
    this.socket = s;
    s.on('connect_error', (err) => this.table.socketErrors.push(`board: ${err.message}`));
    s.on('state', (view) => {
      this.view = view;
      const states = this.table.boardStates;
      states.push(view);
      if (states.length > 400) states.shift();
      this.table.checkInvariants(view, this.table.prevBoardState);
      this.table.prevBoardState = view;
      this.table.bump();
    });
    await waitConnect(s);
    return s;
  }
}

/**
 * One complete game table: board client + N player bots sharing the real
 * server's single global session. Tables must be used sequentially (the
 * server hosts exactly one game); `dispose()` resets it for the next test.
 */
export class GameTable {
  constructor(fixture, { label = 'table' } = {}) {
    this.fixture = fixture;
    this.label = label;
    this.board = new BoardClient(this);
    this.bots = [];
    this.byPlayer = new Map();
    this.version = 0;
    this.waiters = new Set();
    this.invariantErrors = [];
    this.socketErrors = [];
    this.boardStates = [];
    this.prevBoardState = null;
  }

  bump() {
    this.version += 1;
    for (const w of [...this.waiters]) {
      let ok = false;
      try { ok = w.pred(this); } catch { ok = false; }
      if (ok) {
        this.waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve();
      }
    }
  }

  /** Resolve as soon as pred(table) holds (checks now and on every view). */
  waitForView(pred, desc = 'condition', timeout = WAIT_TIMEOUT) {
    let ok = false;
    try { ok = pred(this); } catch { ok = false; }
    if (ok) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const w = { pred, desc, resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        this.waiters.delete(w);
        reject(new Error(`timeout (${timeout}ms) waiting for ${desc}\n${this.dump()}`));
      }, timeout);
      this.waiters.add(w);
    });
  }

  /** Wait until any client receives any view update (version increases). */
  waitChange(timeout = WAIT_TIMEOUT) {
    const v0 = this.version;
    return this.waitForView((t) => t.version > v0, 'any state change', timeout);
  }

  bot(playerId) {
    const b = this.byPlayer.get(playerId);
    if (!b) throw new Error(`no bot seated for player ${playerId}`);
    return b;
  }

  async addPlayers(count) {
    await this.board.connect();
    for (let i = 0; i < count; i++) {
      const bot = new PlayerBot(this, `Bot${i + 1}`);
      await bot.connectAndJoin();
      this.bots.push(bot);
      this.byPlayer.set(bot.id, bot);
    }
    return this.bots;
  }

  async startGame() {
    const ack = await emitAck(this.board.socket, 'board:start', {});
    if (!ack?.ok) throw new Error(`board:start failed: ${JSON.stringify(ack)}\n${this.dump()}`);
    await this.waitForView((t) => t.board.view?.phase === PHASE.ROLE_REVEAL, 'ROLE_REVEAL');
  }

  dump() {
    const v = this.board.view;
    if (!v) return `[${this.label}] no board view yet`;
    const alive = v.players?.filter((p) => p.alive).length ?? 0;
    return [
      `[${this.label}] phase=${v.phase} tracker=${v.tracker} lib=${v.liberalCount} fasc=${v.fascistCount}`,
      `draw=${v.drawCount} discard=${v.discardCount} alive=${alive}/${v.playerCount}`,
      `president=${v.presidentId} chancellor=${v.chancellorId} nominated=${v.nominatedChancellorId}`,
      `pendingPower=${v.pendingPower} veto=${v.vetoRequested} winner=${v.winner}/${v.winReason}`,
      `log tail=${JSON.stringify((v.log ?? []).slice(-4))}`,
    ].join(' | ');
  }

  /** Continuous invariants, checked on every public board state. */
  checkInvariants(v, prev) {
    const errs = [];
    try {
      if (!v || v.phase === PHASE.LOBBY || !Array.isArray(v.players)) return;
      const alive = v.players.filter((p) => p.alive).map((p) => p.id);
      const aliveSet = new Set(alive);
      if (!(v.tracker >= 0 && v.tracker <= 3)) errs.push(`tracker out of range: ${v.tracker}`);
      if (v.presidentId && !aliveSet.has(v.presidentId) && v.phase !== PHASE.GAME_OVER) {
        errs.push(`president ${v.presidentId} is dead`);
      }
      for (const p of v.players) {
        if (!p.alive && (p.isPresident || p.isNominatedChancellor)) {
          errs.push(`dead player ${p.id} holds plaque/nomination`);
        }
      }
      if (v.phase === PHASE.VOTE) {
        for (const id of v.votesReceived) {
          if (!aliveSet.has(id)) errs.push(`dead/unknown voter ${id} in votesReceived`);
        }
        if (v.votesReceived.length > v.votesExpected) {
          errs.push(`votesReceived ${v.votesReceived.length} > expected ${v.votesExpected}`);
        }
      }
      const total = v.drawCount + v.discardCount + v.liberalCount + v.fascistCount + onTableCards(v);
      if (total !== 17) {
        errs.push(`policy conservation broken: draw=${v.drawCount} discard=${v.discardCount} ` +
          `lib=${v.liberalCount} fasc=${v.fascistCount} table=${onTableCards(v)} sum=${total}`);
      }
      // Vote completeness: when a VOTE phase resolves, every living player at
      // that moment must appear exactly once in lastVote.votes.
      if (prev && prev.phase === PHASE.VOTE && v.phase !== PHASE.VOTE && v.lastVote) {
        const prevAlive = prev.players.filter((p) => p.alive).map((p) => p.id);
        const keys = Object.keys(v.lastVote.votes);
        if (keys.length !== prevAlive.length || keys.some((id) => !prevAlive.includes(id))) {
          errs.push(`election votes incomplete: got [${keys}] expected ${prevAlive.length} voters`);
        }
        if (v.lastVote.ja + v.lastVote.nein !== keys.length) errs.push('lastVote tally mismatch');
      }
    } catch (err) {
      errs.push(`invariant monitor crashed: ${err.message}`);
    }
    for (const e of errs) this.invariantErrors.push(`${v.phase}: ${e}`);
  }

  /** Disconnect every client and reset the server session for the next test. */
  async dispose() {
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error('table disposed'));
    }
    this.waiters.clear();
    for (const b of this.bots) b.disconnect();
    this.board.socket?.disconnect();
    this.bots = [];
    this.byPlayer.clear();
    this.fixture.session.reset();
  }
}
