import { StrKey, hash } from '@stellar/stellar-sdk';

import {
  MERKLE_HASH_BYTES,
  bytesEqual,
  bytesToHex,
  compareBytes,
  concatBytes,
  hexToBytes,
  i128ToBytes,
} from './bytes.js';
import { SplitStreamError } from './errors.js';
import { findManifestEntry, type Manifest, type ManifestEntry } from './types.js';

/**
 * Client-side Merkle reconstruction for `credit_claim` proofs.
 *
 * ## This is a port, and the port must stay byte-exact
 *
 * The vault verifies the proof against a root that `splitstream-actions`
 * computed. If this file hashes even one byte differently - a different leaf
 * prefix, a different amount width, a different odd-node rule - every claim
 * fails `InvalidProof` even though the manifest is perfectly correct.
 *
 * The scheme implemented here is the one splitstream-actions' `merkle.ts` uses:
 *
 *   leaf(node) = SHA-256( 0x00 || recipient(32 bytes, strkey payload) || amount_i128_be(16 bytes) )
 *   node(a, b) = SHA-256( 0x01 || min(a, b) || max(a, b) )      // sorted pair
 *
 * with leaves sorted ascending by hash before the tree is built (canonical
 * ordering, so the root does not depend on manifest row order), and an
 * unpaired node hashed with itself (`node(n, n)`).
 *
 * `computeManifestRoot` recomputes the root from the manifest's own rows: if it
 * does not equal the `root` field published by actions, the two schemes have
 * diverged and {@link buildClaimProof} flags it via `rootMatches: false`. The
 * CLI treats that as fatal unless explicitly overridden, because submitting
 * such a proof burns a fee to fail on-chain.
 *
 * SHA-256 comes from `@stellar/stellar-sdk`'s `hash`, which is pure JS and
 * browser-safe - no `node:crypto` in this package.
 */

/** Domain-separation prefix for leaf hashes. */
export const LEAF_PREFIX = 0x00;
/** Domain-separation prefix for internal nodes. */
export const NODE_PREFIX = 0x01;

/** A contribution that becomes one leaf: an address and its amount. */
export interface MerkleLeafInput {
  readonly address: string;
  readonly amount: bigint;
}

/** A fully built Merkle tree. */
export interface MerkleTree {
  /** Leaf hashes, sorted ascending (canonical order). */
  readonly leaves: readonly Uint8Array[];
  /** `layers[0]` is the sorted leaves; each subsequent layer is half the size. */
  readonly layers: readonly (readonly Uint8Array[])[];
  readonly root: Uint8Array;
}

/** Everything the CLI needs to sign a `credit_claim` for one contributor. */
export interface ClaimProof {
  readonly cycleId: number;
  /** Address whose leaf this proof is for. */
  readonly contributor: string;
  readonly github: string;
  readonly points: number;
  /** Amount committed to in the leaf, in base units. */
  readonly amount: bigint;
  /** Position of the leaf in the sorted leaf set. */
  readonly leafIndex: number;
  /** Leaf hash, lowercase hex. */
  readonly leaf: string;
  /** Sibling hashes from the leaf to the root, lowercase hex. */
  readonly proof: readonly string[];
  /** Root recomputed from this manifest's rows. */
  readonly computedRoot: string;
  /** Root published in the manifest. */
  readonly manifestRoot: string;
  /** Whether the recomputed root matches the manifest's published root. */
  readonly rootMatches: boolean;
}

function sha256(bytes: Uint8Array): Uint8Array {
  return hash(bytes);
}

/** Hashes one `(address, amount)` pair into a Merkle leaf. */
export function merkleLeaf(address: string, amount: bigint): Uint8Array {
  if (!StrKey.isValidEd25519PublicKey(address)) {
    throw new SplitStreamError(`cannot build a Merkle leaf for an invalid Stellar address: ${address}`);
  }
  const recipient = StrKey.decodeEd25519PublicKey(address);
  if (recipient.length !== 32) {
    throw new SplitStreamError(
      `expected a 32-byte Ed25519 public key payload, received ${recipient.length} bytes`,
    );
  }
  return sha256(concatBytes(new Uint8Array([LEAF_PREFIX]), recipient, i128ToBytes(amount)));
}

/** Hashes two child nodes, sorting the pair so the tree is order-independent. */
export function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [left, right] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(concatBytes(new Uint8Array([NODE_PREFIX]), left, right));
}

function assertHashSize(value: Uint8Array, what: string): void {
  if (value.length !== MERKLE_HASH_BYTES) {
    throw new SplitStreamError(`${what} must be ${MERKLE_HASH_BYTES} bytes, received ${value.length}`);
  }
}

/** Builds a tree from already-hashed leaves. */
export function buildMerkleTreeFromLeaves(leaves: readonly Uint8Array[]): MerkleTree {
  if (leaves.length === 0) {
    throw new SplitStreamError('cannot build a Merkle tree with no leaves');
  }
  for (const [index, leaf] of leaves.entries()) {
    assertHashSize(leaf, `leaf[${index}]`);
  }

  const sorted = [...leaves].sort(compareBytes);
  const layers: Uint8Array[][] = [sorted];

  while ((layers[layers.length - 1]?.length ?? 0) > 1) {
    const previous = layers[layers.length - 1] as Uint8Array[];
    const next: Uint8Array[] = [];
    for (let index = 0; index < previous.length; index += 2) {
      const left = previous[index] as Uint8Array;
      const right = index + 1 < previous.length ? (previous[index + 1] as Uint8Array) : left;
      next.push(hashPair(left, right));
    }
    layers.push(next);
  }

  const root = layers[layers.length - 1]?.[0];
  if (!root) {
    throw new SplitStreamError('Merkle tree construction produced no root');
  }
  return { leaves: sorted, layers, root };
}

/** Builds a tree from `(address, amount)` pairs. */
export function buildMerkleTree(inputs: readonly MerkleLeafInput[]): MerkleTree {
  return buildMerkleTreeFromLeaves(inputs.map((input) => merkleLeaf(input.address, input.amount)));
}

/** Converts a parsed manifest's rows into leaf inputs. */
export function manifestToLeafInputs(manifest: Manifest): MerkleLeafInput[] {
  return manifest.contributors.map((entry: ManifestEntry) => ({
    address: entry.address,
    amount: entry.amount,
  }));
}

/** Recomputes the manifest's Merkle root. Returns the raw 32-byte root. */
export function computeMerkleRoot(inputs: readonly MerkleLeafInput[]): Uint8Array {
  return buildMerkleTree(inputs).root;
}

/** Recomputes the manifest's Merkle root as lowercase hex. */
export function computeManifestRoot(manifest: Manifest): string {
  return bytesToHex(computeMerkleRoot(manifestToLeafInputs(manifest)));
}

/** Returns the sibling hashes proving `leaf` belongs to `tree`. */
export function merkleProofForLeaf(tree: MerkleTree, leaf: Uint8Array): Uint8Array[] {
  const index = tree.leaves.findIndex((candidate) => bytesEqual(candidate, leaf));
  if (index < 0) {
    throw new SplitStreamError('leaf is not part of this Merkle tree');
  }

  const proof: Uint8Array[] = [];
  let cursor = index;
  for (let level = 0; level < tree.layers.length - 1; level += 1) {
    const row = tree.layers[level] as readonly Uint8Array[];
    const siblingIndex = cursor % 2 === 0 ? cursor + 1 : cursor - 1;
    const sibling = siblingIndex < row.length ? (row[siblingIndex] as Uint8Array) : (row[cursor] as Uint8Array);
    proof.push(sibling);
    cursor = Math.floor(cursor / 2);
  }
  return proof;
}

/**
 * Verifies a proof locally before it is submitted.
 *
 * @param proof - sibling hashes, lowercase hex
 * @param leaf - leaf hash, lowercase hex
 * @param root - expected root, lowercase hex
 */
export function verifyMerkleProof(proof: readonly string[], leaf: string, root: string): boolean {
  let computed = hexToBytes(leaf, 'leaf');
  for (const [index, sibling] of proof.entries()) {
    computed = hashPair(computed, hexToBytes(sibling, `proof[${index}]`));
  }
  return bytesEqual(computed, hexToBytes(root, 'root'));
}

/**
 * Builds the sibling-hash proof for one contributor.
 *
 * @param manifest - parsed cycle manifest
 * @param identifier - Stellar address, or a GitHub handle as a fallback
 * @throws {SplitStreamError} when the contributor is not in the manifest
 */
export function buildClaimProof(manifest: Manifest, identifier: string): ClaimProof {
  const entry = findManifestEntry(manifest, identifier);
  if (!entry) {
    throw new SplitStreamError(
      `${identifier} is not present in the cycle ${manifest.cycleId} manifest (${manifest.contributors.length} contributors)`,
    );
  }

  const leaf = merkleLeaf(entry.address, entry.amount);
  const tree = buildMerkleTree(manifestToLeafInputs(manifest));
  const proof = merkleProofForLeaf(tree, leaf);
  const computedRoot = bytesToHex(tree.root);

  return {
    cycleId: manifest.cycleId,
    contributor: entry.address,
    github: entry.github,
    points: entry.points,
    amount: entry.amount,
    leafIndex: tree.leaves.findIndex((candidate) => bytesEqual(candidate, leaf)),
    leaf: bytesToHex(leaf),
    proof: proof.map(bytesToHex),
    computedRoot,
    manifestRoot: manifest.root,
    rootMatches: computedRoot === manifest.root,
  };
}
