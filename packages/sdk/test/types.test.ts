import { describe, expect, it } from 'vitest';

import {
  ManifestParseError,
  findManifestEntry,
  isValidContractId,
  isValidStellarAddress,
  parseManifest,
  parseVesting,
} from '../src/index.js';
import { ADDRESS_A, ADDRESS_B, CONTRIBUTORS, GOLDEN } from './fixtures.js';

const RAW = {
  version: 1,
  cycleId: 7,
  poolAmount: '40000000',
  totalPoints: 40,
  tokenDecimals: 7,
  root: GOLDEN.root3,
  generatedAt: '2026-09-01T00:00:00.000Z',
  dust: '12',
  contributors: CONTRIBUTORS.map((entry) => ({
    github: entry.github,
    address: entry.address,
    points: entry.points,
    amount: entry.amount.toString(),
  })),
};

describe('parseManifest', () => {
  it('parses the canonical shape and converts amounts to bigint', () => {
    const manifest = parseManifest(RAW);
    expect(manifest.cycleId).toBe(7);
    expect(typeof manifest.poolAmount).toBe('bigint');
    expect(manifest.poolAmount).toBe(40_000_000n);
    expect(manifest.dust).toBe(12n);
    expect(manifest.contributors[0]?.amount).toBe(10_000_000n);
    expect(manifest.tokenDecimals).toBe(7);
  });

  it('accepts the alias spellings splitstream-actions has emitted', () => {
    const manifest = parseManifest({
      ...RAW,
      cycleId: undefined,
      cycle: 9,
      root: undefined,
      merkleRoot: GOLDEN.root3.toUpperCase(),
      contributors: undefined,
      entries: RAW.contributors.map((entry) => ({ ...entry, handle: entry.github, github: undefined })),
    });
    expect(manifest.cycleId).toBe(9);
    // Roots are normalized to lowercase so hex comparison is case-insensitive.
    expect(manifest.root).toBe(GOLDEN.root3);
    expect(manifest.contributors).toHaveLength(3);
  });

  it('derives totalPoints when it is absent', () => {
    const manifest = parseManifest({ ...RAW, totalPoints: undefined });
    expect(manifest.totalPoints).toBe(40);
  });

  it('defaults tokenDecimals and dust when absent', () => {
    const manifest = parseManifest({ ...RAW, tokenDecimals: undefined, dust: undefined });
    expect(manifest.tokenDecimals).toBe(7);
    expect(manifest.dust).toBe(0n);
  });

  it('rejects a numeric amount outside the safe integer range', () => {
    expect(() =>
      parseManifest({
        ...RAW,
        contributors: [{ github: 'ada', address: ADDRESS_A, points: 1, amount: 9007199254740993 }],
      }),
    ).toThrow(ManifestParseError);
  });

  it('rejects a non-integer string amount', () => {
    expect(() =>
      parseManifest({
        ...RAW,
        contributors: [{ github: 'ada', address: ADDRESS_A, points: 1, amount: '1.5' }],
      }),
    ).toThrow(/integer string/);
  });

  it('rejects invalid Stellar addresses', () => {
    expect(() =>
      parseManifest({
        ...RAW,
        contributors: [{ github: 'ada', address: 'nope', points: 1, amount: '1' }],
      }),
    ).toThrow(/not a valid Stellar account/);
  });

  it('rejects duplicate contributor addresses', () => {
    expect(() =>
      parseManifest({
        ...RAW,
        contributors: [
          { github: 'ada', address: ADDRESS_A, points: 1, amount: '1' },
          { github: 'grace', address: ADDRESS_A, points: 2, amount: '2' },
        ],
      }),
    ).toThrow(/duplicate contributor addresses/);
  });

  it('rejects a missing required field', () => {
    expect(() => parseManifest({ ...RAW, cycleId: undefined })).toThrow(/cycleId/);
    expect(() => parseManifest({ ...RAW, root: undefined })).toThrow(/root/);
    expect(() => parseManifest('not an object')).toThrow(/must be a JSON object/);
  });
});

describe('findManifestEntry', () => {
  it('matches by address first, then by GitHub handle', () => {
    const manifest = parseManifest(RAW);
    expect(findManifestEntry(manifest, ADDRESS_B)?.github).toBe('grace');
    expect(findManifestEntry(manifest, '@grace')?.address).toBe(ADDRESS_B);
    expect(findManifestEntry(manifest, 'nobody')).toBeUndefined();
  });
});

describe('parseVesting', () => {
  it('returns null for a missing schedule', () => {
    expect(parseVesting(null)).toBeNull();
    expect(parseVesting(undefined)).toBeNull();
    expect(parseVesting(false)).toBeNull();
  });

  it('parses the snake_case struct shape returned by Soroban', () => {
    expect(
      parseVesting({
        total: 1_000_000n,
        claimed: 250_000n,
        start_ledger: 100,
        duration_ledgers: 17280,
      }),
    ).toEqual({ total: 1_000_000n, claimed: 250_000n, startLedger: 100, durationLedgers: 17280 });
  });

  it('parses the camelCase struct shape', () => {
    expect(
      parseVesting({ totalAmount: 10n, claimedAmount: 0n, startLedger: 5, durationLedgers: 9 }),
    ).toEqual({ total: 10n, claimed: 0n, startLedger: 5, durationLedgers: 9 });
  });

  it('parses a positional tuple', () => {
    expect(parseVesting([100n, 25n, 7, 1000])).toEqual({
      total: 100n,
      claimed: 25n,
      startLedger: 7,
      durationLedgers: 1000,
    });
  });

  it('parses a Map as Soroban sometimes returns', () => {
    const map = new Map<string, unknown>([
      ['total', 5n],
      ['claimed', 1n],
      ['start_ledger', 2],
      ['duration_ledgers', 3],
    ]);
    expect(parseVesting(map)).toEqual({ total: 5n, claimed: 1n, startLedger: 2, durationLedgers: 3 });
  });
});

describe('address validators', () => {
  it('validates Stellar account addresses', () => {
    expect(isValidStellarAddress(ADDRESS_A)).toBe(true);
    expect(isValidStellarAddress('not-an-address')).toBe(false);
  });

  it('validates contract ids', () => {
    expect(isValidContractId('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC')).toBe(true);
    expect(isValidContractId(ADDRESS_A)).toBe(false);
  });
});
