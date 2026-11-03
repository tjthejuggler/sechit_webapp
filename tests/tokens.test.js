import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TokenService, createRng } from '../server/engine/index.js';

describe('QR token service (one-time, pure)', () => {
  test('create + consume returns payload once; second consume fails', () => {
    const t = new TokenService({ rng: createRng(9) });
    const id = t.createToken('deck-draw', { cards: ['liberal', 'fascist', 'liberal'] }, 'p1');
    const got = t.consume(id, { purpose: 'deck-draw', playerId: 'p1' });
    assert.equal(got.purpose, 'deck-draw');
    assert.equal(got.payload.cards.length, 3);
    assert.equal(got.boundPlayerId, 'p1');
    assert.throws(() => t.consume(id, { purpose: 'deck-draw', playerId: 'p1' }), /TOKEN_CONSUMED/);
  });

  test('purpose mismatch rejected', () => {
    const t = new TokenService({ rng: createRng(10) });
    const id = t.createToken('join', { gameId: 'g1' });
    assert.throws(() => t.consume(id, { purpose: 'transfer' }), /TOKEN_PURPOSE_MISMATCH/);
    assert.doesNotThrow(() => t.consume(id, { purpose: 'join' }));
  });

  test('bound player mismatch rejected; correct player accepted', () => {
    const t = new TokenService({ rng: createRng(11) });
    const id = t.createToken('transfer', { cards: ['fascist', 'liberal'] }, 'p2');
    assert.throws(() => t.consume(id, { playerId: 'p3' }), /TOKEN_PLAYER_MISMATCH/);
    const got = t.consume(id, { playerId: 'p2' });
    assert.deepEqual(got.payload.cards, ['fascist', 'liberal']);
  });

  test('unknown tokens rejected; peek reports state without consuming', () => {
    const t = new TokenService({ rng: createRng(12) });
    assert.throws(() => t.consume('nope'), /TOKEN_INVALID/);
    const id = t.createToken('join', { x: 1 });
    assert.equal(t.peek(id).consumed, false);
    t.consume(id);
    assert.equal(t.peek(id).consumed, true);
    assert.equal(t.peek('nope'), null);
  });

  test('token ids are unique', () => {
    const t = new TokenService({ rng: createRng(13) });
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(t.createToken('join', null));
    assert.equal(seen.size, 500);
  });
});
