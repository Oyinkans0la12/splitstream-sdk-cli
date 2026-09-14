import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildClaimProof,
  buildMerkleTree,
  bytesToHex,
  computeManifestRoot,
  computeMerkleRoot,
  merkleLeaf,
  merkleProofForLeaf,
  parseManifest,
  verifyMerkleProof,
} from '../src/index.js';

/**
 * Cross-repo golden test.
 *
 * `test/fixtures/merkle.golden.json` is copied verbatim from
 * `splitstream-actions/test/fixtures/merkle.golden.json` (the repo that
 * generates and commits real `manifests/cycle-<id>.json` in production), and
 * `test/fixtures/cycle-3.manifest.json` is a manifest in the exact shape that
 * repo writes, whose `merkleRoot` is the golden `tree3` root.
 *
 * These tests do not check this repo against itself: they check it against the
 * other repo's actual committed output. If they fail, this SDK's Merkle
 * reconstruction has diverged from the deployed one and every on-chain claim
 * built from it would fail `InvalidProof`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

interface GoldenLeaf {
  stellar: string;
  amount: string;
}

interface GoldenFixture {
  leaf: GoldenLeaf & { leafPayloadHex: string; leafHex: string };
  tree3: { leaves: GoldenLeaf[]; rootHex: string };
  tree4: { leaves: GoldenLeaf[]; rootHex: string };
}

const GOLDEN = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'merkle.golden.json'), 'utf8'),
) as GoldenFixture;

const MANIFEST_JSON = readFileSync(join(HERE, 'fixtures', 'cycle-3.manifest.json'), 'utf8');

function toInputs(leaves: readonly GoldenLeaf[]): { stellar: string; amount: bigint }[] {
  return leaves.map((leaf) => ({ stellar: leaf.stellar, amount: BigInt(leaf.amount) }));
}

describe('cross-repo golden fixture (splitstream-actions)', () => {
  it('reproduces the golden leaf hash byte-for-byte', () => {
    const leaf = merkleLeaf(GOLDEN.leaf.stellar, BigInt(GOLDEN.leaf.amount));
    expect(bytesToHex(leaf)).toBe(GOLDEN.leaf.leafHex);
  });

  it('reproduces the golden tree3 and tree4 roots', () => {
    expect(bytesToHex(computeMerkleRoot(toInputs(GOLDEN.tree3.leaves)))).toBe(
      GOLDEN.tree3.rootHex,
    );
    expect(bytesToHex(computeMerkleRoot(toInputs(GOLDEN.tree4.leaves)))).toBe(
      GOLDEN.tree4.rootHex,
    );
  });

  it('builds a proof for every tree3 leaf that verifies against the golden root', () => {
    const tree = buildMerkleTree(toInputs(GOLDEN.tree3.leaves));
    expect(bytesToHex(tree.root)).toBe(GOLDEN.tree3.rootHex);

    for (const leaf of GOLDEN.tree3.leaves) {
      const hash = merkleLeaf(leaf.stellar, BigInt(leaf.amount));
      const proof = merkleProofForLeaf(tree, hash).map(bytesToHex);
      expect(verifyMerkleProof(proof, bytesToHex(hash), GOLDEN.tree3.rootHex)).toBe(true);
    }
  });

  it('builds a proof for every tree4 leaf that verifies against the golden root', () => {
    const tree = buildMerkleTree(toInputs(GOLDEN.tree4.leaves));
    for (const leaf of GOLDEN.tree4.leaves) {
      const hash = merkleLeaf(leaf.stellar, BigInt(leaf.amount));
      const proof = merkleProofForLeaf(tree, hash).map(bytesToHex);
      expect(verifyMerkleProof(proof, bytesToHex(hash), GOLDEN.tree4.rootHex)).toBe(true);
    }
  });

  it('orders tree3 leaves by ascending public-key bytes, not by StrKey string order', () => {
    const tree = buildMerkleTree(toInputs(GOLDEN.tree3.leaves));
    const ordered = GOLDEN.tree3.leaves.map((leaf) => leaf.stellar);
    // Both orders put the all-zero address first, but they disagree on the
    // next leaf: StrKey string order says GC3…, the frozen byte order says
    // GCW…. The golden root above only reproduces with byte ordering.
    expect([...ordered].sort()[1]).toBe('GC3BLRQMHJGDIBAVHA2WQOY6Q7CBLAZUNZPIR5NYAX6XTQZUSTVRHHPK');
    const gcw = GOLDEN.tree3.leaves.find((leaf) => leaf.stellar.startsWith('GCW')) as GoldenLeaf;
    expect(bytesToHex(tree.leaves[1] as Uint8Array)).toBe(
      bytesToHex(merkleLeaf(gcw.stellar, BigInt(gcw.amount))),
    );
    expect(tree.leaves).toHaveLength(3);
    expect(bytesToHex(tree.root)).toBe(GOLDEN.tree3.rootHex);
  });
});

describe('a real splitstream-actions manifest', () => {
  it('parses the real field names splitstream-actions writes', () => {
    const manifest = parseManifest(JSON.parse(MANIFEST_JSON));
    expect(manifest.cycleId).toBe(3);
    expect(manifest.poolAmount).toBe(10_000_000_000n);
    expect(manifest.totalIssuesClosed).toBe(19);
    expect(manifest.dustRemainder).toBe(6_315_789_476n);
    expect(manifest.merkleRoot).toBe(GOLDEN.tree3.rootHex);
    expect(manifest.entries).toHaveLength(3);
    expect(manifest.entries[0]).toEqual({
      github: 'octocat',
      stellar: 'GC3BLRQMHJGDIBAVHA2WQOY6Q7CBLAZUNZPIR5NYAX6XTQZUSTVRHHPK',
      issuesClosed: 1,
      amount: 526_315_789n,
    });
  });

  it('recomputes the manifest root to exactly the root splitstream-actions published', () => {
    const manifest = parseManifest(JSON.parse(MANIFEST_JSON));
    expect(computeManifestRoot(manifest)).toBe(manifest.merkleRoot);
  });

  it('builds claim proofs that verify against the published root for every entry', () => {
    const manifest = parseManifest(JSON.parse(MANIFEST_JSON));
    for (const entry of manifest.entries) {
      const proof = buildClaimProof(manifest, entry.stellar);
      expect(proof.rootMatches).toBe(true);
      expect(proof.manifestRoot).toBe(GOLDEN.tree3.rootHex);
      expect(proof.issuesClosed).toBe(entry.issuesClosed);
      expect(verifyMerkleProof(proof.proof, proof.leaf, GOLDEN.tree3.rootHex)).toBe(true);
    }
  });

  it('matches the amount splitstream-actions computes with the frozen floor formula', () => {
    const manifest = parseManifest(JSON.parse(MANIFEST_JSON));
    for (const entry of manifest.entries) {
      const expected = (manifest.poolAmount * BigInt(entry.issuesClosed)) / BigInt(manifest.totalIssuesClosed);
      expect(entry.amount).toBe(expected);
    }
  });
});
