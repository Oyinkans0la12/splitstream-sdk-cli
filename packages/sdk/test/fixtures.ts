import { Keypair } from '@stellar/stellar-sdk';

import { parseManifest, type Manifest } from '../src/index.js';

/**
 * Deterministic, human-auditable fixtures.
 *
 * Addresses are derived from fixed Ed25519 seeds so the golden hashes below
 * are stable across machines and Node versions.
 *
 * The golden values encode the frozen cross-repo Merkle scheme
 * (`sha256(ScVal(Address) || ScVal(i128))` leaves, ascending Stellar
 * public-key byte order, sorted-pair internal nodes with odd-node promotion).
 * They are locked independently by `merkleGolden.test.ts` against
 * splitstream-actions' own committed golden fixture.
 */
export const ADDRESS_A = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
export const ADDRESS_B = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
export const ADDRESS_C = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey();

/** Amounts are base units at 7 decimals: 1.0, 2.5 and 0.5 tokens. */
export const AMOUNT_A = 10_000_000n;
export const AMOUNT_B = 25_000_000n;
export const AMOUNT_C = 5_000_000n;

/** Golden values, regenerated only when the hashing scheme intentionally changes. */
export const GOLDEN = {
  leafA: 'ad9c906767144e06c7872fe986b7f8a79113b16cb9515c1ab657507746c4613e',
  leafB: '0eaa9d9e443da9c8ad6b2f669c56fa5ea55416d33de6063fea357890ae14c1dd',
  leafC: 'a3e3b989c7c3201b69baf58b609c1f999af1fe65e2fa498eb89be32e900c56a1',
  root3: 'b93bbc239d5efb077997e74f7f0d4710fb513ad11565b8c5154ff5eca21aa0b0',
  root1: 'ea767ec760b546d7a4b568092762ac612e8883df7fffae9ab21b70e5ebc8da49',
  leaf1: 'ea767ec760b546d7a4b568092762ac612e8883df7fffae9ab21b70e5ebc8da49',
  /**
   * Sibling hashes for ADDRESS_B, which sorts first by public-key bytes
   * (GCAT… < GCFI… < GDWU…). The proof for ADDRESS_C is shorter than the tree
   * height because its node was promoted unchanged at the leaf level.
   */
  proofB: [
    'ad9c906767144e06c7872fe986b7f8a79113b16cb9515c1ab657507746c4613e',
    'a3e3b989c7c3201b69baf58b609c1f999af1fe65e2fa498eb89be32e900c56a1',
  ],
  /** Sibling hashes for ADDRESS_A (index 1 in the sorted leaf set). */
  proofA: [
    '0eaa9d9e443da9c8ad6b2f669c56fa5ea55416d33de6063fea357890ae14c1dd',
    'a3e3b989c7c3201b69baf58b609c1f999af1fe65e2fa498eb89be32e900c56a1',
  ],
  /** The lone sibling for ADDRESS_C, whose leaf node was promoted unchanged. */
  proofC: ['e742df4e0599980d564c85bf9e18602a065b094e4dc083f2faff6d8363c1aedc'],
} as const;

export const ENTRIES = [
  { github: 'ada', stellar: ADDRESS_A, issuesClosed: 10, amount: AMOUNT_A },
  { github: 'grace', stellar: ADDRESS_B, issuesClosed: 25, amount: AMOUNT_B },
  { github: 'linus', stellar: ADDRESS_C, issuesClosed: 5, amount: AMOUNT_C },
] as const;

/** A parsed manifest whose `merkleRoot` matches the golden root above. */
export function goldenManifest(overrides: Record<string, unknown> = {}): Manifest {
  return parseManifest({
    cycleId: 7,
    generatedAt: '2026-09-01T00:00:00.000Z',
    poolAmount: '40000000',
    totalIssuesClosed: 40,
    dustRemainder: '0',
    merkleRoot: GOLDEN.root3,
    entries: ENTRIES.map((entry) => ({
      github: entry.github,
      stellar: entry.stellar,
      issuesClosed: entry.issuesClosed,
      amount: entry.amount.toString(),
    })),
    ...overrides,
  });
}
