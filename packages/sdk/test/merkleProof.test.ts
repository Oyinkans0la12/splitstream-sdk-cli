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
    // These values lock the exact leaf pre-image: the full ScVal-form XDR of
    // `Address` (44 bytes) followed by the ScVal-form XDR of `i128` (20 bytes),
    // with no domain-separation prefix. The crossing check against
    // splitstream-actions' own fixture lives in `merkleGolden.test.ts`.
    expect(merkleLeaf(ADDRESS_A, AMOUNT_A)).toHaveLength(32);
    expect(Buffer.from(merkleLeaf(ADDRESS_A, AMOUNT_A)).toString('hex')).toBe(GOLDEN.leafA);
    expect(Buffer.from(merkleLeaf(ADDRESS_B, AMOUNT_B)).toString('hex')).toBe(GOLDEN.leafB);
    expect(Buffer.from(merkleLeaf(ADDRESS_C, AMOUNT_C)).toString('hex')).toBe(GOLDEN.leafC);
  });

  it('produces different leaves for different amounts', () => {
    const a = Buffer.from(merkleLeaf(ADDRESS_A, AMOUNT_A)).toString('hex');
    const b = Buffer.from(merkleLeaf(ADDRESS_A, AMOUNT_B)).toString('hex');
    expect(a).not.toBe(b);
  });

  it('rejects an invalid Stellar address', () => {
    expect(() => merkleLeaf('not-an-address', 1n)).toThrow(SplitStreamError);
  });

  it('rejects an amount outside the i128 range', () => {
    expect(() => merkleLeaf(ADDRESS_A, 1n << 127n)).toThrow(SplitStreamError);
  });
});

describe('buildMerkleTree', () => {
  it('matches the golden root for a three-leaf tree', () => {
    const tree = buildMerkleTree([
      { stellar: ADDRESS_A, amount: AMOUNT_A },
      { stellar: ADDRESS_B, amount: AMOUNT_B },
      { stellar: ADDRESS_C, amount: AMOUNT_C },
    ]);
    expect(Buffer.from(tree.root).toString('hex')).toBe(GOLDEN.root3);
    expect(tree.layers).toHaveLength(3);
  });

  it('orders leaves by ascending public-key bytes, not by leaf hash or input order', () => {
    const tree = buildMerkleTree([
      { stellar: ADDRESS_C, amount: AMOUNT_C },
      { stellar: ADDRESS_A, amount: AMOUNT_A },
      { stellar: ADDRESS_B, amount: AMOUNT_B },
    ]);
    // ADDRESS_B is the smallest pubkey, so its leaf comes first.
    expect(Buffer.from(tree.leaves[0] as Uint8Array).toString('hex')).toBe(GOLDEN.leafB);
    expect(Buffer.from(tree.leaves[1] as Uint8Array).toString('hex')).toBe(GOLDEN.leafA);
    expect(Buffer.from(tree.leaves[2] as Uint8Array).toString('hex')).toBe(GOLDEN.leafC);
  });

  it('uses the leaf itself as the root for a single leaf', () => {
    const tree = buildMerkleTree([{ stellar: ADDRESS_A, amount: 1n }]);
    expect(Buffer.from(tree.root).toString('hex')).toBe(GOLDEN.root1);
    expect(Buffer.from(tree.root).toString('hex')).toBe(GOLDEN.leaf1);
  });

  it('is independent of insertion order', () => {
    const orderA = buildMerkleTree([
      { stellar: ADDRESS_A, amount: AMOUNT_A },
      { stellar: ADDRESS_B, amount: AMOUNT_B },
      { stellar: ADDRESS_C, amount: AMOUNT_C },
    ]);
    const orderB = buildMerkleTree([
      { stellar: ADDRESS_C, amount: AMOUNT_C },
      { stellar: ADDRESS_B, amount: AMOUNT_B },
      { stellar: ADDRESS_A, amount: AMOUNT_A },
    ]);
    expect(Buffer.from(orderA.root).toString('hex')).toBe(Buffer.from(orderB.root).toString('hex'));
  });

  it('promotes an unpaired node unchanged and still proves every leaf', () => {
    // 5 leaves forces two rounds of odd-node promotion; every leaf must still
    // produce a proof that verifies against the same root.
    const entries = [1n, 2n, 3n, 4n, 5n].map((amount) => ({ stellar: ADDRESS_A, amount }));
    const tree = buildMerkleTree(entries);
    expect(tree.leaves).toHaveLength(5);

    for (const entry of entries) {
      const leaf = merkleLeaf(entry.stellar, entry.amount);
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
  it('is order-independent and is a bare SHA-256 of the sorted concatenation', () => {
    const left = merkleLeaf(ADDRESS_A, AMOUNT_A);
    const right = merkleLeaf(ADDRESS_B, AMOUNT_B);
    const ab = Buffer.from(hashPair(left, right)).toString('hex');
    const ba = Buffer.from(hashPair(right, left)).toString('hex');
    expect(ab).toBe(ba);

    // The frozen scheme adds no domain-separation prefix at internal nodes,
    // unlike the previous (incorrect) implementation.
    const sorted =
      Buffer.compare(Buffer.from(left), Buffer.from(right)) <= 0
        ? Buffer.concat([Buffer.from(left), Buffer.from(right)])
        : Buffer.concat([Buffer.from(right), Buffer.from(left)]);
    const undecorated = createHash('sha256').update(sorted).digest('hex');
    expect(ab).toBe(undecorated);
  });
});

describe('buildClaimProof', () => {
  it('produces the golden sibling hashes and verifies locally', () => {
    const manifest = goldenManifest();
    const proofB = buildClaimProof(manifest, ADDRESS_B);

    expect(proofB.github).toBe('grace');
    expect(proofB.amount).toBe(AMOUNT_B);
    expect(proofB.issuesClosed).toBe(25);
    expect(proofB.proof).toEqual([...GOLDEN.proofB]);
    expect(proofB.computedRoot).toBe(GOLDEN.root3);
    expect(proofB.manifestRoot).toBe(GOLDEN.root3);
    expect(proofB.rootMatches).toBe(true);
    expect(verifyMerkleProof(proofB.proof, proofB.leaf, proofB.computedRoot)).toBe(true);

    const proofA = buildClaimProof(manifest, ADDRESS_A);
    expect(proofA.proof).toEqual([...GOLDEN.proofA]);
    expect(verifyMerkleProof(proofA.proof, proofA.leaf, proofA.computedRoot)).toBe(true);

    // ADDRESS_C's leaf node was promoted unchanged, so its proof is shorter
    // than the tree height but still verifies.
    const proofC = buildClaimProof(manifest, ADDRESS_C);
    expect(proofC.proof).toEqual([...GOLDEN.proofC]);
    expect(proofC.proof).toHaveLength(1);
    expect(verifyMerkleProof(proofC.proof, proofC.leaf, proofC.computedRoot)).toBe(true);
  });

  it('recomputes the root from the manifest rows', () => {
    expect(computeManifestRoot(goldenManifest())).toBe(GOLDEN.root3);
  });

  it('flags a manifest whose published root does not match its rows', () => {
    const tampered = goldenManifest({ merkleRoot: 'ff'.repeat(32) });
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
  it('returns one sibling per hashing level and every sibling is a 32-byte hash', () => {
    const tree = buildMerkleTree([
      { stellar: ADDRESS_A, amount: AMOUNT_A },
      { stellar: ADDRESS_B, amount: AMOUNT_B },
      { stellar: ADDRESS_C, amount: AMOUNT_C },
      { stellar: ADDRESS_A, amount: AMOUNT_B },
    ]);
    const leaf = merkleLeaf(ADDRESS_A, AMOUNT_A);
    const proof = merkleProofForLeaf(tree, leaf);
    expect(proof.length).toBeGreaterThan(0);
    expect(proof.length).toBeLessThanOrEqual(tree.layers.length - 1);
    for (const sibling of proof) {
      expect(sibling).toHaveLength(32);
    }
  });
});
