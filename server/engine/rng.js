// Deterministic, seedable RNG (mulberry32) so every game is reproducible in tests.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Returns a callable rng() augmented with rng.int(maxExclusive) helpers.
export function createRng(seed) {
  const next = mulberry32(seed);
  const rng = () => next();
  rng.int = (maxExclusive) => Math.floor(rng() * maxExclusive);
  rng.seed = seed >>> 0;
  return rng;
}

// In-place Fisher–Yates shuffle driven by the rng.
export function shuffle(array, rng) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}
