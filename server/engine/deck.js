import { POLICY, DECK_LIBERAL, DECK_FASCIST, DRAW_SIZE } from './constants.js';
import { shuffle } from './rng.js';
import { EngineError } from './errors.js';

// Policy deck with mandatory auto-reshuffle: whenever the draw pile would run
// below the required moment threshold, draw+discard are combined and randomly
// reordered (order randomized, unused/unplayed tiles are never revealed).
export class Deck {
  constructor(rng, { liberal = DECK_LIBERAL, fascist = DECK_FASCIST } = {}) {
    this.rng = rng;
    this.draw = [];
    this.discard = [];
    this.reshuffled = false;
    for (let i = 0; i < liberal; i++) this.draw.push(POLICY.LIBERAL);
    for (let i = 0; i < fascist; i++) this.draw.push(POLICY.FASCIST);
    shuffle(this.draw, rng);
  }

  // Ensures the draw pile can satisfy `needed` cards; reshuffles draw+discard
  // together (Fisher–Yates over the union) whenever it cannot.
  ensureDrawable(needed = DRAW_SIZE) {
    if (this.draw.length < needed) {
      if (this.draw.length + this.discard.length < needed) {
        throw new EngineError('DECK_EXHAUSTED', 'Not enough policy tiles left to draw from.');
      }
      this.draw.push(...this.discard);
      this.discard = [];
      shuffle(this.draw, this.rng);
      this.reshuffled = true; // consumed by caller for logging/indicator
    }
  }

  drawCards(count = DRAW_SIZE) {
    this.ensureDrawable(count);
    // Draw from the top; returned in draw order (index 0 is the next card off the pile).
    return this.draw.splice(this.draw.length - count, count).reverse();
  }

  drawTop() {
    this.ensureDrawable(1);
    return this.draw.pop();
  }

  discardCards(cards) {
    this.discard.push(...cards);
  }
}
