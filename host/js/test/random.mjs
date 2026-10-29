// From 3sln.me packages/app/memory-providers.mjs (MIT, Copyright (c) 2026 3sln).
export function createRandom(seed = 1) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = n => Math.floor(next() * n);
  return {
    seed,
    next,
    int,
    pick: list => list[int(list.length)],
    shuffle: list => { const copy = [...list]; for (let i = copy.length - 1; i > 0; i--) { const j = int(i + 1); [copy[i], copy[j]] = [copy[j], copy[i]]; } return copy; },
    chance: p => next() < p,
  };
}
