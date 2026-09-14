/**
 * `@splitstream/sdk` - a thin, typed client over the deployed splitstream-core
 * vault contract.
 *
 * Design rules this package holds to:
 * - The SDK never signs. `build*` methods return unsigned transactions.
 * - Token amounts are `bigint` from end to end; decimal strings appear only at
 *   display/parse boundaries.
 * - No CLI-only dependencies: this package is safe to bundle into a browser
 *   dashboard (no `node:crypto`, no `commander`, no `inquirer`).
 */

// --- errors -----------------------------------------------------------------
export {
  SPLITSTREAM_CONTRACT_ERRORS,
  SplitStreamError,
  contractError,
  parseContractErrorCode,
  splitstreamErrorName,
  toSplitStreamError,
  type SplitStreamErrorOptions,
} from './errors.js';

// --- domain types and parsers ----------------------------------------------
export {
  ManifestParseError,
  findManifestEntry,
  isValidContractId,
  isValidStellarAddress,
  parseManifest,
  parseVesting,
  type CycleInfo,
  type Manifest,
  type ManifestEntry,
  type RawManifest,
  type RawManifestEntry,
  type VestingInfo,
} from './types.js';

// --- amount formatting ------------------------------------------------------
export {
  formatTokenAmount,
  formatTokenAmountWithSeparators,
  parseTokenAmount,
  percentOf,
  truncateAddress,
} from './amounts.js';

// --- byte helpers -----------------------------------------------------------
export {
  ED25519_PUBLIC_KEY_BYTES,
  MERKLE_HASH_BYTES,
  bytesToBase64,
  bytesToHex,
  bytesToI128,
  compareBytes,
  concatBytes,
  hexToBytes,
  i128ToBytes,
} from './bytes.js';

// --- Merkle proofs ----------------------------------------------------------
export {
  buildClaimProof,
  buildMerkleTree,
  computeManifestRoot,
  computeMerkleRoot,
  hashPair,
  manifestToLeafInputs,
  merkleLeaf,
  merkleProofForLeaf,
  verifyMerkleProof,
  type ClaimProof,
  type MerkleLeafInput,
  type MerkleTree,
} from './merkleProof.js';

// --- ScVal conversion -------------------------------------------------------
export {
  addressToScVal,
  bytesToScVal,
  findContractErrorCode,
  i128ToScVal,
  isVoidScVal,
  proofToScVal,
  scValToBigInt,
  scValToBool,
  scValToHexOrNull,
  scValToNativeValue,
  u32ToScVal,
  xdr,
} from './xdr.js';

// --- client -----------------------------------------------------------------
export {
  SplitStreamClient,
  TOKEN_METHODS,
  VAULT_METHODS,
  type SplitStreamClientOptions,
  type SubmittedTransaction,
} from './client.js';
