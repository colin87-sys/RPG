/**
 * Seeded RNG (sfc32). Never use Math.random() in gameplay or generation.
 * Fork named sub-streams so adding a consumer does not shift other sequences.
 */

/** 32-bit string hash (cyrb53-lite) for deriving stream seeds from labels. */
export function hashString(s: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0) ^ (h1 >>> 0);
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.a = 0x9e3779b9;
    this.b = 0x243f6a88;
    this.c = 0xb7e15162;
    this.d = this.seed;
    for (let i = 0; i < 15; i++) this.nextU32();
  }

  nextU32(): number {
    let a = this.a, b = this.b, c = this.c, d = this.d;
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    this.a = a; this.b = b; this.c = c; this.d = d;
    return t;
  }

  /** Uniform [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Symmetric in [-1, 1). */
  signed(): number {
    return this.next() * 2 - 1;
  }

  /** Approximately normal (sum of 3 uniforms), mean 0, sd ~0.577*scale. */
  gauss(scale = 1): number {
    return (this.next() + this.next() + this.next() - 1.5) * scale;
  }

  /** Independent stream derived from this seed and a label. */
  fork(label: string): Rng {
    return new Rng(hashString(label, this.seed));
  }
}
