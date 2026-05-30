export interface Rng {
  next(): number;
  randInt(min: number, max: number): number;
  randFloat(min: number, max: number, decimals?: number): number;
  pick<T>(arr: T[]): T;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  function next(): number {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function randInt(min: number, max: number): number {
    return Math.floor(next() * (max - min + 1)) + min;
  }

  function randFloat(min: number, max: number, decimals = 1): number {
    const val = next() * (max - min) + min;
    const factor = Math.pow(10, decimals);
    return Math.round(val * factor) / factor;
  }

  function pick<T>(arr: T[]): T {
    return arr[Math.floor(next() * arr.length)];
  }

  return { next, randInt, randFloat, pick };
}
