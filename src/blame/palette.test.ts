import { describe, expect, it } from 'vitest';
import { BUCKET_COUNT, bucketFor, fnv1a, paletteFor } from './palette';

describe('fnv1a', () => {
  it('matches the FNV-1a reference values', () => {
    // Reference: empty string hashes to the offset basis.
    expect(fnv1a('')).toBe(0x811c9dc5);
    // FNV-1a('a') = 0xe40c292c, FNV-1a('foobar') = 0xbf9cf968 (well-known vectors).
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(fnv1a('foobar')).toBe(0xbf9cf968);
  });

  it('is stable across calls (same input → same bucket, forever)', () => {
    for (const email of ['t@t', 'someone@example.org', 'Ünïcödé@dev.io']) {
      const first = bucketFor(email);
      for (let i = 0; i < 5; i++) {
        expect(bucketFor(email)).toBe(first);
      }
    }
  });
});

describe('bucketFor', () => {
  it('always lands inside [0, BUCKET_COUNT)', () => {
    for (let i = 0; i < 200; i++) {
      const bucket = bucketFor(`user${i}@example.com`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(BUCKET_COUNT);
    }
  });

  it('treats emails case-insensitively and trims (same person = same bucket)', () => {
    expect(bucketFor('Alice@Example.COM')).toBe(bucketFor('alice@example.com'));
    expect(bucketFor('  bob@x.io  ')).toBe(bucketFor('bob@x.io'));
  });

  it('spreads authors across more than one bucket', () => {
    const buckets = new Set<number>();
    for (let i = 0; i < 50; i++) {
      buckets.add(bucketFor(`dev${i}@team.io`));
    }
    expect(buckets.size).toBeGreaterThan(1);
  });
});

describe('paletteFor', () => {
  it('returns 8 distinct colors for dark and light themes', () => {
    for (const kind of ['dark', 'light'] as const) {
      const palette = paletteFor(kind);
      expect(palette).toHaveLength(BUCKET_COUNT);
      expect(new Set(palette).size).toBe(BUCKET_COUNT);
      for (const color of palette) {
        expect(color).toMatch(/^rgba\(/);
      }
    }
  });

  it('gives high-contrast themes NO line backgrounds (accessibility)', () => {
    expect(paletteFor('high-contrast')).toHaveLength(0);
  });
});
