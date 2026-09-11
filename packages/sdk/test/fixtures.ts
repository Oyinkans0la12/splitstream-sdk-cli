import { Keypair } from '@stellar/stellar-sdk';

import { parseManifest, type Manifest } from '../src/index.js';

/**
 * Deterministic, human-auditable fixtures.
 *
 * Addresses are derived from fixed Ed25519 seeds so the golden hashes below
 * are stable across machines and Node versions.
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
  leafA: 'b7a554b0e1d07b59b33a90974694e4728a53fa0c585c1fe7ede6fde13aa6f8af',
  leafB: 'a55526c9823ba8bcbcec22609f9ee3a6a9759d69f0f7b4ae5cd5a37c9156d15f',
  leafC: 'd82a7650303a46772cfbdfd2491f215b2de9054447e1bc592a4761dc87a2170f',
  root3: '769b01ef00a937b69cf58c26014a49e88db39ef020099c391e66ee987762659c',
  root1: '393e363b6c10ed8db74252283165b6431e2c453a431137d3c82b930c2c7bbafe',
  leaf1: '393e363b6c10ed8db74252283165b6431e2c453a431137d3c82b930c2c7bbafe',
  /** Sibling hashes for leaf B, which sorts first. */
  proofB: [
    'b7a554b0e1d07b59b33a90974694e4728a53fa0c585c1fe7ede6fde13aa6f8af',
    '476b3f6d57fe919daec68901264a6826cf2591e4d321e48a2ab511ad8810b98f',
  ],
  /** Sibling hashes for leaf A (index 1 in the sorted leaf set). */
  proofA: [
    'a55526c9823ba8bcbcec22609f9ee3a6a9759d69f0f7b4ae5cd5a37c9156d15f',
    '476b3f6d57fe919daec68901264a6826cf2591e4d321e48a2ab511ad8810b98f',
  ],
} as const;

export const CONTRIBUTORS = [
  { github: 'ada', address: ADDRESS_A, points: 10, amount: AMOUNT_A },
  { github: 'grace', address: ADDRESS_B, points: 25, amount: AMOUNT_B },
  { github: 'linus', address: ADDRESS_C, points: 5, amount: AMOUNT_C },
] as const;

/** A parsed manifest whose `root` matches the golden root above. */
export function goldenManifest(overrides: Record<string, unknown> = {}): Manifest {
  return parseManifest({
    version: 1,
    cycleId: 7,
    poolAmount: '40000000',
    totalPoints: 40,
    tokenDecimals: 7,
    root: GOLDEN.root3,
    generatedAt: '2026-09-01T00:00:00.000Z',
    dust: '0',
    contributors: CONTRIBUTORS.map((entry) => ({
      github: entry.github,
      address: entry.address,
      points: entry.points,
      amount: entry.amount.toString(),
    })),
    ...overrides,
  });
}
