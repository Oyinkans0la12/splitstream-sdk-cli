import { describe, expect, it } from 'vitest';

import {
  ManifestParseError,
  findManifestEntry,
  isValidContractId,
  isValidStellarAddress,
  parseManifest,
  parseVesting,
} from '../src/index.js';
import { ADDRESS_A, ADDRESS_B, ENTRIES, GOLDEN } from './fixtures.js';

const RAW = {
  cycleId: 7,
  generatedAt: '2026-09-01T00:00:00.000Z',
  poolAmount: '40000000',
  totalIssuesClosed: 40,
  dustRemainder: '12',
  merkleRoot: GOLDEN.root3,
  entries: ENTRIES.map((entry) => ({
    github: entry.github,
    stellar: entry.stellar,
    issuesClosed: entry.issuesClosed,
    amount: entry.amount.toString(),
  })),
};

describe('parseManifest', () => {
  it('parses the canonical shape and converts amounts to bigint', () => {
    const manifest = parseManifest(RAW);
    expect(manifest.cycleId).toBe(7);
    expect(typeof manifest.poolAmount).toBe('bigint');
    expect(manifest.poolAmount).toBe(40_000_000n);
    expect(manifest.dustRemainder).toBe(12n);
    expect(manifest.totalIssuesClosed).toBe(40);
    expect(manifest.entries[0]?.amount).toBe(10_000_000n);
    expect(manifest.entries[0]?.issuesClosed).toBe(10);
    expect(manifest.entries[0]?.stellar).toBe(ADDRESS_A);
    expect(manifest.merkleRoot).toBe(GOLDEN.root3);
  });

  it('reads merkleRoot as the canonical field and root only as an alias', () => {
    // If both are present, the field splitstream-actions actually writes wins.
    const manifest = parseManifest({ ...RAW, merkleRoot: GOLDEN.root3, root: 'ff'.repeat(32) });
    expect(manifest.merkleRoot).toBe(GOLDEN.root3);

    const aliasOnly = parseManifest({ ...RAW, merkleRoot: undefined, root: GOLDEN.root3.toUpperCase() });
    // Roots are normalized to lowercase so hex comparison is case-insensitive.
    expect(aliasOnly.merkleRoot).toBe(GOLDEN.root3);
  });

  it('makes merkleRoot required even when the legacy root alias is absent', () => {
    expect(() => parseManifest({ ...RAW, merkleRoot: undefined })).toThrow(/merkleRoot/);
  });

  it('derives totalIssuesClosed from the entries when it is absent', () => {
    const manifest = parseManifest({ ...RAW, totalIssuesClosed: undefined });
    expect(manifest.totalIssuesClosed).toBe(40);
  });

  it('defaults dustRemainder to zero when absent', () => {
    const manifest = parseManifest({ ...RAW, dustRemainder: undefined });
    expect(manifest.dustRemainder).toBe(0n);
  });

  it('rejects the invented field names this repo used to read', () => {
    expect(() => parseManifest({ ...RAW, entries: undefined })).toThrow(/entries/);
    expect(() =>
      parseManifest({
        ...RAW,
        entries: [{ github: 'ada', address: ADDRESS_A, points: 1, amount: '1' }],
      }),
    ).toThrow(/stellar/);
  });

  it('rejects a numeric amount outside the safe integer range', () => {
    expect(() =>
      parseManifest({
        ...RAW,
        entries: [{ github: 'ada', stellar: ADDRESS_A, issuesClosed: 1, amount: 9007199254740993 }],
      }),
    ).toThrow(ManifestParseError);
  });

  it('rejects a non-integer string amount', () => {
    expect(() =>
      parseManifest({
        ...RAW,
        entries: [{ github: 'ada', stellar: ADDRESS_A, issuesClosed: 1, amount: '1.5' }],
      }),
    ).toThrow(/integer string/);
  });

  it('rejects invalid Stellar addresses', () => {
    expect(() =>
      parseManifest({
        ...RAW,
        entries: [{ github: 'ada', stellar: 'nope', issuesClosed: 1, amount: '1' }],
      }),
    ).toThrow(/not a valid Stellar account/);
  });

  it('rejects duplicate contributor addresses', () => {
    expect(() =>
      parseManifest({
        ...RAW,
        entries: [
          { github: 'ada', stellar: ADDRESS_A, issuesClosed: 1, amount: '1' },
          { github: 'grace', stellar: ADDRESS_A, issuesClosed: 2, amount: '2' },
        ],
      }),
    ).toThrow(/duplicate contributor addresses/);
  });

  it('rejects a missing required field', () => {
    expect(() => parseManifest({ ...RAW, cycleId: undefined })).toThrow(/cycleId/);
    expect(() => parseManifest('not an object')).toThrow(/must be a JSON object/);
  });
});

describe('findManifestEntry', () => {
  it('matches by address first, then by GitHub handle', () => {
    const manifest = parseManifest(RAW);
    expect(findManifestEntry(manifest, ADDRESS_B)?.github).toBe('grace');
    expect(findManifestEntry(manifest, '@grace')?.stellar).toBe(ADDRESS_B);
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
