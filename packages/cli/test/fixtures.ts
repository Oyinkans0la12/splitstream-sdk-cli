import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bytesToHex, computeMerkleRoot, parseManifest, type Manifest } from '@splitstream/sdk';
import { Keypair, StrKey } from '@stellar/stellar-sdk';

/**
 * Deterministic fixtures shared by the CLI tests.
 *
 * Addresses come from fixed Ed25519 seeds so a failure is reproducible, and the
 * manifest root is *computed* with the SDK's own Merkle code rather than copied,
 * so these fixtures cannot drift away from `merkleProof.ts`.
 */

export const KEYPAIR_A = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 21));
export const KEYPAIR_B = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 22));
export const KEYPAIR_C = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 23));

export const ADDRESS_A = KEYPAIR_A.publicKey();
export const ADDRESS_B = KEYPAIR_B.publicKey();
export const ADDRESS_C = KEYPAIR_C.publicKey();
export const SECRET_A = KEYPAIR_A.secret();

/** Address that appears in no manifest. */
export const ADDRESS_STRANGER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 99)).publicKey();

/**
 * Real `C...` contract ids. `requireChainConfig` validates them with the SDK's
 * `StrKey` check (which includes the CRC16 checksum), so a hand-rolled `'CD'`
 * prefix is not enough - encode them the way the SDK does.
 */
export const VAULT_ID = StrKey.encodeContract(new Uint8Array(32).fill(1));
export const TOKEN_ID = StrKey.encodeContract(new Uint8Array(32).fill(2));

export const TOKEN_DECIMALS = 7;

/** 100 tokens funded, split 50/30/20 by points. */
export const ROWS = [
  { github: 'ada', address: ADDRESS_A, points: 50, amount: 50_000_000n },
  { github: 'grace', address: ADDRESS_B, points: 30, amount: 30_000_000n },
  { github: 'linus', address: ADDRESS_C, points: 20, amount: 20_000_000n },
] as const;

export const TOTAL_POINTS = ROWS.reduce((sum, row) => sum + row.points, 0);

/** Root recomputed from the fixture rows. */
export function fixtureRoot(rows: typeof ROWS = ROWS): string {
  return bytesToHex(
    computeMerkleRoot(rows.map((row) => ({ address: row.address, amount: row.amount }))),
  );
}

export interface ManifestOverrides {
  cycleId?: number;
  /** Overrides the published root, which is how "tampered manifest" is set up. */
  root?: string;
  poolAmount?: string;
  tokenDecimals?: number;
  dust?: string;
}

function rawManifest(overrides: ManifestOverrides = {}): Record<string, unknown> {
  return {
    version: 1,
    cycleId: overrides.cycleId ?? 7,
    poolAmount: overrides.poolAmount ?? '100000000',
    totalPoints: TOTAL_POINTS,
    tokenDecimals: overrides.tokenDecimals ?? TOKEN_DECIMALS,
    root: overrides.root ?? fixtureRoot(),
    generatedAt: '2026-09-01T00:00:00.000Z',
    dust: overrides.dust ?? '0',
    contributors: ROWS.map((row) => ({
      github: row.github,
      address: row.address,
      points: row.points,
      amount: row.amount.toString(),
    })),
  };
}

/** A parsed fixture manifest whose published root matches its rows. */
export function buildManifest(overrides: ManifestOverrides = {}): Manifest {
  return parseManifest(rawManifest(overrides));
}

/** Writes a fixture manifest to a fresh temp directory and returns its path. */
export function writeManifestFile(overrides: ManifestOverrides = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'splitstream-cli-'));
  const path = join(directory, `cycle-${overrides.cycleId ?? 7}.json`);
  writeFileSync(path, JSON.stringify(rawManifest(overrides), null, 2), 'utf8');
  return path;
}

/** Creates a fresh repository checkout containing `manifests/cycle-<id>.json`. */
export function manifestDirectory(cycleIds: readonly number[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'splitstream-repo-'));
  const manifests = join(directory, 'manifests');
  mkdirSync(manifests, { recursive: true });
  for (const cycleId of cycleIds) {
    writeFileSync(
      join(manifests, `cycle-${cycleId}.json`),
      JSON.stringify(rawManifest({ cycleId }), null, 2),
      'utf8',
    );
  }
  return directory;
}
