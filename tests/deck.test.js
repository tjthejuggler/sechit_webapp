import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Deck, createRng } from '../server/engine/index.js';

describe('policy deck', () => {
  test('composition: 6 liberal / 11 fascist, shuffled draw, empty discard', () => {
    const d = new Deck(createRng(1));
    const all = [...d.draw, ...d.discard];
    assert.equal(all.length, 17);
    assert.equal(all.filter((c) => c === 'liberal').length, 6);
    assert.equal(all.filter((c) => c === 'fascist').length, 11);
    assert.equal(d.discard.length, 0);
  });

  test('deterministic per seed', () => {
    assert.deepEqual(new Deck(createRng(7)).draw, new Deck(createRng(7)).draw);
    assert.notDeepEqual(new Deck(createRng(7)).draw, new Deck(createRng(8)).draw);
  });

  test('auto-reshuffle folds discard into draw when pile < 3', () => {
    const d = new Deck(createRng(2));
    while (d.draw.length > 2) d.discard.push(d.draw.pop()); // 2 in draw, 15 in discard
    const cards = d.drawCards(3);
    assert.equal(cards.length, 3);
    assert.equal(d.reshuffled, true);
    assert.equal(d.discard.length, 0);
    assert.equal(d.draw.length + d.discard.length + cards.length, 17);
  });

  test('no reshuffle while enough cards remain', () => {
    const d = new Deck(createRng(3));
    d.drawCards(3);
    assert.equal(d.reshuffled, false);
    assert.equal(d.draw.length, 14);
  });

  test('drawCards preserves draw order (index 0 = next off the pile)', () => {
    const d = new Deck(createRng(5));
    d.draw.push('fascist', 'liberal'); // 'liberal' ends up on top and is drawn first
    const cards = d.drawCards(2);
    assert.deepEqual(cards, ['liberal', 'fascist']);
  });

  test('exhaustion throws DECK_EXHAUSTED', () => {
    const d = new Deck(createRng(4));
    const all = d.draw.splice(0);
    d.discard.push(all[0], all[1]);
    assert.throws(() => d.drawCards(3), (err) => err.code === 'DECK_EXHAUSTED');
  });
});
