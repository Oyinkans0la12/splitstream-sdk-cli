import { StrKey, hash, xdr } from '@stellar/stellar-sdk';

import {
  MERKLE_HASH_BYTES,
  bytesEqual,
  bytesToHex,
  compareBytes,
  concatBytes,
  hexToBytes,
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
 * pre-image, a different leaf order, a different odd-node rule - every claim
 * fails `InvalidProof` even though the manifest is perfectly correct.
 *
 * The scheme implemented here is the frozen cross-repo contract used by
 * splitstream-actions' `merkle.ts` and splitstream-core's `merkle.rs`:
 *
 *   leaf(stellar, amount) =
 *     SHA-256( ScVal(Address(stellar)).toXDR() || ScVal(i128(amount)).toXDR() )
 *
 * where both halves are the full ScVal-form XDR produced by soroban-sdk's
 * `ToXdr`:
 *
 *   Address (44 bytes): u32(SCV_ADDRESS=18) | u32(SC_ADDRESS_TYPE_ACCOUNT=0)
 *                       | u32(publickey ED25519=0) | ed25519(32)
 *   i128    (20 bytes): u32(SCV_I128=10) | int64 hi | uint64 lo
 *
 * There are no domain-separation prefixes: unlike a generic Merkle library, the
 * leaf pre-image carries the ScVal union discriminants itself.
 *
 * Internal nodes use the sorted-pair convention:
 *
 *   node(a, b) = SHA-256( min(a, b) || max(a, b) )   // ascending byte order
 *
 * Leaves are ordered by **ascending Stellar public-key bytes** (not by leaf
 * hash, and not by manifest row order), so the root is reproducible from the
 * manifest alone. An unpaired node is **promoted unchanged** to the next level
 * (it is not hashed with itself), which is why a proof may skip a level.
 *
 * `computeManifestRoot` recomputes the root from the manifest's own rows: if it
 * does not equal the `merkleRoot` published by actions, the two schemes have
 * diverged and {@link buildClaimProof} flags it via `rootMatches: false`. The
 * CLI treats that as fatal unless explicitly overridden, because submitting
 * such a proof burns a fee to fail on-chain.
 *
 * SHA-256 comes from `@stellar/stellar-sdk`'s `hash`, which is pure JS and
 * browser-safe - no `node:crypto` in this package.
 */

/** A contribution that becomes one leaf: a Stellar account and its amount. */
export interface MerkleLeafInput {
  readonly stellar: string;
  readonly amount: bigint;
}

/** A fully built Merkle tree. */
export interface MerkleTree {
  /** Leaf hashes in canonical order (ascending Stellar public-key bytes). */
  readonly leaves: readonly Uint8Array[];
  /** `layers[0]` is the canonical leaves; each subsequent layer is half the size. */
  readonly layers: readonly (readonly Uint8Array[])[];
  readonly root: Uint8Array;
}

/** Everything the CLI needs to sign a `credit_claim` for one contributor. */
export interface ClaimProof {
  readonly cycleId: number;
  /** Address whose leaf this proof is for. */
  readonly contributor: string;
  readonly github: string;
  /** Distinct issues closed this cycle, as recorded in the manifest. */
  readonly issuesClosed: number;
  /** Amount committed to in the leaf, in base units. */
  readonly amount: bigint;
  /** Position of the leaf in the canonical (pubkey-ordered) leaf set. */
  readonly leafIndex: number;
  /** Leaf hash, lowercase hex. */
  readonly leaf: string;
  /** Sibling hashes from the leaf to the root, lowercase hex. */
  readonly proof: readonly string[];
  /** Root recomputed from this manifest's rows. */
  readonly computedRoot: string;
  /** Root published in the manifest (`merkleRoot`). */
  readonly manifestRoot: string;
  /** Whether the recomputed root matches the manifest's published root. */
  readonly rootMatches: boolean;
}

const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;

function sha256(bytes: Uint8Array): Uint8Array {
  return hash(bytes);
}

/** The 44-byte ScVal XDR encoding of a Stellar account address. */
function addressScValBytes(stellar: string): Uint8Array {
  if (!StrKey.isValidEd25519PublicKey(stellar)) {
    throw new SplitStreamError(`cannot build a Merkle leaf for an invalid Stellar address: ${stellar}`);
  }
  const payload = StrKey.decodeEd25519PublicKey(stellar);
  if (payload.length !== 32) {
    throw new SplitStreamError(
      `expected a 32-byte Ed25519 public key payload, received ${payload.length} bytes`,
    );
  }
  return xdr.ScVal.scvAddress(
    xdr.ScAddress.scAddressTypeAccount(xdr.PublicKey.publicKeyTypeEd25519(payload)),
  ).toXDR();
}

/** The 20-byte ScVal XDR encoding of a signed 128-bit amount. */
function amountScValBytes(amount: bigint): Uint8Array {
  if (amount < I128_MIN || amount > I128_MAX) {
    throw new SplitStreamError(`amount ${amount.toString()} does not fit in an i128`);
  }
  const hi = BigInt.asIntN(64, amount >> 64n);
  const lo = amount & 0xffffffffffffffffn;
  return xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64(hi), lo: xdr.Uint64(lo) })).toXDR();
}

/** The 32-byte Stellar public-key payload, used to order leaves. */
function stellarKeyBytes(stellar: string): Uint8Array {
  if (!StrKey.isValidEd25519PublicKey(stellar)) {
    throw new SplitStreamError(`cannot order leaves by an invalid Stellar address: ${stellar}`);
  }
  return StrKey.decodeEd25519PublicKey(stellar);
}

/** Hashes one `(stellar, amount)` pair into a Merkle leaf. */
export function merkleLeaf(stellar: string, amount: bigint): Uint8Array {
  return sha256(concatBytes(addressScValBytes(stellar), amountScValBytes(amount)));
}

/** Hashes two child nodes, sorting the pair so the tree is order-independent. */
export function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [left, right] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(concatBytes(left, right));
}

function assertHashSize(value: Uint8Array, what: string): void {
  if (value.length !== MERKLE_HASH_BYTES) {
    throw new SplitStreamError(`${what} must be ${MERKLE_HASH_BYTES} bytes, received ${value.length}`);
  }
}

/**
 * Builds the sorted-pair tree from `(stellar, amount)` pairs.
 *
 * Leaves are ordered by ascending Stellar public-key bytes; an unpaired node is
 * promoted unchanged (matching splitstream-core's verifier).
 */
export function buildMerkleTree(inputs: readonly MerkleLeafInput[]): MerkleTree {
  if (inputs.length === 0) {
    throw new SplitStreamError('cannot build a Merkle tree with no leaves');
  }

  const sorted = [...inputs].sort((a, b) =>
    compareBytes(stellarKeyBytes(a.stellar), stellarKeyBytes(b.stellar)),
  );

  let level = sorted.map((input) => merkleLeaf(input.stellar, input.amount));
  for (const [index, leaf] of level.entries()) {
    assertHashSize(leaf, `leaf[${index}]`);
  }
  const layers: Uint8Array[][] = [level];

  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index] as Uint8Array;
      const right = index + 1 < level.length ? (level[index + 1] as Uint8Array) : undefined;
      // An unpaired node is promoted unchanged, never hashed with itself.
      next.push(right === undefined ? left : hashPair(left, right));
    }
    level = next;
    layers.push(level);
  }

  return { leaves: layers[0] as Uint8Array[], layers, root: level[0] as Uint8Array };
}

/** Converts a parsed manifest's rows into leaf inputs. */
export function manifestToLeafInputs(manifest: Manifest): MerkleLeafInput[] {
  return manifest.entries.map((entry: ManifestEntry) => ({
    stellar: entry.stellar,
    amount: entry.amount,
  }));
}

/** Recomputes a Merkle root over `(stellar, amount)` pairs. Returns raw bytes. */
export function computeMerkleRoot(inputs: readonly MerkleLeafInput[]): Uint8Array {
  return buildMerkleTree(inputs).root;
}

/** Recomputes the manifest's Merkle root as lowercase hex. */
export function computeManifestRoot(manifest: Manifest): string {
  return bytesToHex(computeMerkleRoot(manifestToLeafInputs(manifest)));
}

/**
 * Returns the sibling hashes proving `leaf` belongs to `tree`.
 *
 * A level where the node was promoted (no sibling) contributes no element, so
 * the proof may be shorter than the tree's height.
 */
export function merkleProofForLeaf(tree: MerkleTree, leaf: Uint8Array): Uint8Array[] {
  const index = tree.leaves.findIndex((candidate) => bytesEqual(candidate, leaf));
  if (index < 0) {
    throw new SplitStreamError('leaf is not part of this Merkle tree');
  }

  const proof: Uint8Array[] = [];
  let cursor = index;
  for (let level = 0; level < tree.layers.length - 1; level += 1) {
    const row = tree.layers[level] as readonly Uint8Array[];
    if (cursor % 2 === 0) {
      const sibling = row[cursor + 1];
      if (sibling !== undefined) proof.push(sibling);
    } else {
      proof.push(row[cursor - 1] as Uint8Array);
    }
    cursor = Math.floor(cursor / 2);
  }
  return proof;
}

/**
 * Verifies a proof locally before it is submitted.
 *
 * Uses the same sorted-pair fold as the contract's `verify_proof`.
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
      `${identifier} is not present in the cycle ${manifest.cycleId} manifest (${manifest.entries.length} entries)`,
    );
  }

  const leaf = merkleLeaf(entry.stellar, entry.amount);
  const tree = buildMerkleTree(manifestToLeafInputs(manifest));
  const proof = merkleProofForLeaf(tree, leaf);
  const computedRoot = bytesToHex(tree.root);

  return {
    cycleId: manifest.cycleId,
    contributor: entry.stellar,
    github: entry.github,
    issuesClosed: entry.issuesClosed,
    amount: entry.amount,
    leafIndex: tree.leaves.findIndex((candidate) => bytesEqual(candidate, leaf)),
    leaf: bytesToHex(leaf),
    proof: proof.map(bytesToHex),
    computedRoot,
    manifestRoot: manifest.merkleRoot,
    rootMatches: computedRoot === manifest.merkleRoot,
  };
}
