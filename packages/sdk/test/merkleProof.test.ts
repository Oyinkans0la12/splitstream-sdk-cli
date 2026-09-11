import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  SplitStreamError,
  buildClaimProof,
  buildMerkleTree,
  computeManifestRoot,
  hashPair,
  merkleLeaf,
  merkleProofForLeaf,
  verifyMerkleProof,
} from '../src/index.js';
import {
  ADDRESS_A,
  ADDRESS_B,
  ADDRESS_C,
  AMOUNT_A,
  AMOUNT_B,
  AMOUNT_C,
  GOLDEN,
  goldenManifest,
} from './fixtures.js';

describe('merkleLeaf', () => {
  it('matches the golden leaf hashes', () => {
    // These values lock the exact byte layout of the leaf preimage:
    // 0x00 || 32-byte strkey payload || 16-byte big-endian i128 amount.
    // If this test fails after an intentional change, splitstream-actions'
    // merkle.ts must change in the same way or claims break.
    expect(merkleLeaf(ADDRESS_A, AMOUNT_A)).toHaveLength(32);
    expect(Buffer.from(merkleLeaf(ADDRESS_A, AMOUNT_A)).toString('hex')).toBe(GOLDEN.leafA);
    expect(Buffer.from(merkleLeaf(ADDRESS_B, AMOUNT_B)).toString('hex')).toBe(GOLDEN.leafB);
  });

  it('produces different leaves for different amounts', () => {
    const a = Buffer.from(merkleLeaf(ADDRESS_A, AMOUNT_A)).toString('hex');
    const b = Buffer.from(merkleLeaf(ADDRESS_A, AMOUNT_B)).toString('hex');
    expect(a).not.toBe(b);
  });

  it('rejects an invalid Stellar address', () => {
    expect(() => merkleLeaf('not-an-address', 1n)).toThrow(SplitStreamError);
  });
});

describe('buildMerkleTree', () => {
  it('matches the golden root for a three-leaf tree', () => {
    const tree = buildMerkleTree([
      { address: ADDRESS_A, amount: AMOUNT_A },
      { address: ADDRESS_B, amount: AMOUNT_B },
      { address: ADDRESS_C, amount: AMOUNT_C },
    ]);
    expect(Buffer.from(tree.root).toString('hex')).toBe(GOLDEN.root3);
    expect(tree.layers).toHaveLength(3);
  });

  it('uses the leaf itself as the root for a single leaf', () => {
    const tree = buildMerkleTree([{ address: ADDRESS_A, amount: 1n }]);
    expect(Buffer.from(tree.root).toString('hex')).toBe(GOLDEN.root1);
    expect(Buffer.from(tree.root).toString('hex')).toBe(GOLDEN.leaf1);
  });

  it('is independent of insertion order', () => {
    const orderA = buildMerkleTree([
      { address: ADDRESS_A, amount: AMOUNT_A },
      { address: ADDRESS_B, amount: AMOUNT_B },
      { address: ADDRESS_C, amount: AMOUNT_A },
    ]);
    const orderB = buildMerkleTree([
      { address: ADDRESS_C, amount: AMOUNT_A },
      { address: ADDRESS_B, amount: AMOUNT_B },
      { address: ADDRESS_A, amount: AMOUNT_A },
    ]);
    expect(Buffer.from(orderA.root).toString('hex')).toBe(Buffer.from(orderB.root).toString('hex'));
  });

  it('handles an odd leaf count by hashing the last node with itself', () => {
    // 5 leaves forces two rounds of odd-node promotion, and every leaf must
    // still produce a proof that verifies against the same root.
    const entries = [1n, 2n, 3n, 4n, 5n].map((seed) => ({ address: ADDRESS_A, amount: seed }));
    const tree = buildMerkleTree(entries);
    expect(tree.leaves).toHaveLength(5);

    for (const entry of entries) {
      const leaf = merkleLeaf(entry.address, entry.amount);
      const proof = merkleProofForLeaf(tree, leaf);
      expect(
        verifyMerkleProof(
          proof.map((sibling) => Buffer.from(sibling).toString('hex')),
          Buffer.from(leaf).toString('hex'),
          Buffer.from(tree.root).toString('hex'),
        ),
      ).toBe(true);
    }
  });

  it('refuses to build an empty tree', () => {
    expect(() => buildMerkleTree([])).toThrow(SplitStreamError);
  });
});

describe('hashPair', () => {
  it('is order-independent and domain separated', () => {
    const left = merkleLeaf(ADDRESS_A, AMOUNT_A);
    const right = merkleLeaf(ADDRESS_B, AMOUNT_B);
    const ab = Buffer.from(hashPair(left, right)).toString('hex');
    const ba = Buffer.from(hashPair(right, left)).toString('hex');
    expect(ab).toBe(ba);

    // Independently confirm the 0x01 domain prefix: a bare SHA-256 over the
    // sorted concatenation - the "obvious" naive implementation - must differ.
    const sorted =
      Buffer.compare(Buffer.from(left), Buffer.from(right)) <= 0
        ? Buffer.concat([Buffer.from(left), Buffer.from(right)])
        : Buffer.concat([Buffer.from(right), Buffer.from(left)]);
    const undecorated = createHash('sha256').update(sorted).digest('hex');
    expect(ab).not.toBe(undecorated);
  });
});

describe('buildClaimProof', () => {
  it('produces the golden sibling hashes and verifies locally', () => {
    const manifest = goldenManifest();
    const proofB = buildClaimProof(manifest, ADDRESS_B);

    expect(proofB.github).toBe('grace');
    expect(proofB.amount).toBe(AMOUNT_B);
    expect(proofB.proof).toEqual([...GOLDEN.proofB]);
    expect(proofB.computedRoot).toBe(GOLDEN.root3);
    expect(proofB.manifestRoot).toBe(GOLDEN.root3);
    expect(proofB.rootMatches).toBe(true);
    expect(verifyMerkleProof(proofB.proof, proofB.leaf, proofB.computedRoot)).toBe(true);

    const proofA = buildClaimProof(manifest, ADDRESS_A);
    expect(proofA.proof).toEqual([...GOLDEN.proofA]);
    expect(verifyMerkleProof(proofA.proof, proofA.leaf, proofA.computedRoot)).toBe(true);
  });

  it('recomputes the root from the manifest rows', () => {
    expect(computeManifestRoot(goldenManifest())).toBe(GOLDEN.root3);
  });

  it('flags a manifest whose published root does not match its rows', () => {
    const tampered = goldenManifest({ root: 'ff'.repeat(32) });
    const proof = buildClaimProof(tampered, ADDRESS_A);
    expect(proof.rootMatches).toBe(false);
    expect(proof.manifestRoot).toBe('ff'.repeat(32));
  });

  it('rejects a contributor that is not in the manifest', () => {
    const manifest = goldenManifest();
    expect(() => buildClaimProof(manifest, 'G'.padEnd(56, 'A'))).toThrow(SplitStreamError);
  });

  it('accepts a GitHub handle as the lookup key', () => {
    const proof = buildClaimProof(goldenManifest(), 'grace');
    expect(proof.contributor).toBe(ADDRESS_B);
  });

  it('verification fails when a sibling is tampered with', () => {
    const proof = buildClaimProof(goldenManifest(), ADDRESS_B);
    const tampered = [...proof.proof];
    tampered[0] = '00'.repeat(32);
    expect(verifyMerkleProof(tampered, proof.leaf, proof.computedRoot)).toBe(false);
  });
});

describe('merkleProofForLeaf', () => {
  it('returns one sibling per level and doubles the hash each level', () => {
    const tree = buildMerkleTree([
      { address: ADDRESS_A, amount: AMOUNT_A },
      { address: ADDRESS_B, amount: AMOUNT_B },
      { address: ADDRESS_C, amount: AMOUNT_A },
      { address: ADDRESS_A, amount: AMOUNT_B },
    ]);
    const leaf = merkleLeaf(ADDRESS_A, AMOUNT_A);
    const proof = merkleProofForLeaf(tree, leaf);
    expect(proof).toHaveLength(tree.layers.length - 1);
    for (const sibling of proof) {
      expect(sibling).toHaveLength(32);
    }
  });
});
