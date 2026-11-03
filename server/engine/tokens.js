// One-time QR token service (pure): createToken(purpose, payload, boundPlayerId?)
// with single-use consume(). Used for join, deck-draw and card transfer flows in
// Subtask 2 — here it is pure data with no sockets or HTTP.

import { createRng } from './rng.js';

export class TokenService {
  constructor({ rng } = {}) {
    // Independent rng so token ids never perturb game-deck determinism.
    this.rng = rng ?? createRng((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
    this.tokens = new Map(); // id -> { purpose, payload, boundPlayerId, consumed }
  }

  createToken(purpose, payload = null, boundPlayerId = null) {
    const id = this._randomId();
    this.tokens.set(id, { purpose, payload, boundPlayerId, consumed: false });
    return id;
  }

  // Single use: first consume succeeds; further consumes, wrong purposes or
  // wrong bound players throw. Returns the stored token record.
  consume(id, { purpose = null, playerId = null } = {}) {
    const token = this.tokens.get(id);
    if (!token) throw new Error('TOKEN_INVALID');
    if (token.consumed) throw new Error('TOKEN_CONSUMED');
    if (purpose !== null && token.purpose !== purpose) throw new Error('TOKEN_PURPOSE_MISMATCH');
    if (token.boundPlayerId !== null && token.boundPlayerId !== playerId) {
      throw new Error('TOKEN_PLAYER_MISMATCH');
    }
    token.consumed = true;
    return { purpose: token.purpose, payload: token.payload, boundPlayerId: token.boundPlayerId };
  }

  peek(id) {
    const token = this.tokens.get(id);
    if (!token) return null;
    return { purpose: token.purpose, boundPlayerId: token.boundPlayerId, consumed: token.consumed };
  }

  // Non-mutating lookup that also exposes the payload (used to resolve
  // per-player scan QR tokens back to the player they identify).
  payload(id) {
    const token = this.tokens.get(id);
    if (!token) return null;
    return { purpose: token.purpose, payload: token.payload, boundPlayerId: token.boundPlayerId, consumed: token.consumed };
  }

  // Invalidate a token immediately (used when per-player QR tokens rotate).
  revoke(id) {
    this.tokens.delete(String(id ?? ''));
  }

  _randomId() {
    // 12 hex chars from the seeded rng — collision-safe for game-session scale.
    let s = '';
    for (let i = 0; i < 12; i++) s += Math.floor(this.rng() * 16).toString(16);
    return s;
  }
}
