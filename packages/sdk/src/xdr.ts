import { nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';

import { MERKLE_HASH_BYTES, bytesToHex, hexToBytes } from './bytes.js';
import { SplitStreamError } from './errors.js';

/**
 * Conversions between native JavaScript values and Soroban `ScVal`s.
 *
 * Keeping these in one place means the client code never reaches into the XDR
 * classes directly, which keeps the rest of the package readable and makes the
 * (occasionally significant) stellar-sdk API changes easy to absorb.
 */

/** Encodes a `G...`/`C...` address argument. */
export function addressToScVal(address: string): xdr.ScVal {
  return nativeToScVal(address, { type: 'address' });
}

/** Encodes a `u32` argument (cycle ids, ledger numbers). */
export function u32ToScVal(value: number): xdr.ScVal {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new SplitStreamError(`expected a u32, received ${value}`, { details: `value=${value}` });
  }
  return nativeToScVal(value, { type: 'u32' });
}

/** Encodes an `i128` argument. Token amounts are always bigint. */
export function i128ToScVal(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: 'i128' });
}

/** Encodes a byte slice argument. */
export function bytesToScVal(value: Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvBytes(value);
}

/**
 * Encodes a Merkle proof as the `Vec<Bytes>` the contract's `credit_claim`
 * expects. Each element must be a full 32-byte sibling hash - a truncated
 * proof is rejected here rather than on-chain.
 */
export function proofToScVal(proof: readonly string[]): xdr.ScVal {
  const elements = proof.map((element, index) => {
    const bytes = hexToBytes(element, `merkle proof[${index}]`);
    if (bytes.length !== MERKLE_HASH_BYTES) {
      throw new SplitStreamError(
        `merkle proof[${index}] must be ${MERKLE_HASH_BYTES} bytes, received ${bytes.length}`,
      );
    }
    return bytesToScVal(bytes);
  });
  return xdr.ScVal.scvVec(elements);
}

/** Decodes a struct/map/vec return value into its native JavaScript shape. */
export function scValToNativeValue(value: xdr.ScVal): unknown {
  return scValToNative(value);
}

function nativeOrThrow(value: xdr.ScVal, what: string): unknown {
  try {
    return scValToNative(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SplitStreamError(`could not decode ${what} from the contract response`, {
      details: detail,
    });
  }
}

/** Decodes an integer-typed ScVal (`i128`/`u128`/`u64`/`u32`/...) to bigint. */
export function scValToBigInt(value: xdr.ScVal, what: string): bigint {
  const native = nativeOrThrow(value, what);
  if (typeof native === 'bigint') return native;
  if (typeof native === 'number' && Number.isInteger(native)) return BigInt(native);
  if (typeof native === 'string' && /^-?\d+$/.test(native.trim())) return BigInt(native.trim());
  throw new SplitStreamError(`${what} was expected to be an integer but the contract returned ${typeof native}`);
}

/** Decodes a boolean ScVal. */
export function scValToBool(value: xdr.ScVal, what: string): boolean {
  const native = nativeOrThrow(value, what);
  if (typeof native !== 'boolean') {
    throw new SplitStreamError(`${what} was expected to be a boolean but the contract returned ${typeof native}`);
  }
  return native;
}

/** Decodes an `Option<Bytes>`/`Bytes`/`String` root into lowercase hex, or null. */
export function scValToHexOrNull(value: xdr.ScVal, what: string): string | null {
  const native = nativeOrThrow(value, what);
  if (native === null || native === undefined) return null;
  if (native instanceof Uint8Array) return bytesToHex(native);
  if (typeof native === 'string') {
    const trimmed = native.trim();
    if (trimmed === '') return null;
    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
      return trimmed.toLowerCase();
    }
    return bytesToHex(new TextEncoder().encode(trimmed));
  }
  if (typeof native === 'bigint') return bytesToHex(i128ToHexPadded(native));
  throw new SplitStreamError(`${what} was expected to be bytes but the contract returned ${typeof native}`);
}

function i128ToHexPadded(value: bigint): Uint8Array {
  const out = new Uint8Array(16);
  let remaining = value < 0n ? value + (1n << 128n) : value;
  for (let i = 15; i >= 0; i -= 1) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

/** Decodes the `Option`-shaped value the vault returns for a missing root. */
export function isVoidScVal(value: xdr.ScVal): boolean {
  return value.type === 'scvVoid';
}

/**
 * Walks diagnostic events looking for a `SCE_CONTRACT` error and returns its
 * numeric code.
 *
 * Soroban reports contract failures as `Error(Contract, #N)` in diagnostics,
 * not in the transaction result code, so this scan is the only reliable way to
 * tell a caller *which* custom error the contract raised.
 */
export function findContractErrorCode(
  events: readonly xdr.DiagnosticEvent[] | undefined,
): number | null {
  if (!events) return null;
  for (const event of events) {
    const body = event.event.body;
    const data = scanScValForContractError(body.v0.data);
    if (data !== null) return data;
    for (const topic of body.v0.topics) {
      const found = scanScValForContractError(topic);
      if (found !== null) return found;
    }
  }
  return null;
}

function scanScValForContractError(value: xdr.ScVal | null | undefined): number | null {
  if (!value) return null;
  switch (value.type) {
    case 'scvError':
      return value.error.type === 'sceContract' ? value.error.contractCode : null;
    case 'scvVec': {
      for (const item of value.vec ?? []) {
        const found = scanScValForContractError(item);
        if (found !== null) return found;
      }
      return null;
    }
    case 'scvMap': {
      for (const entry of value.map ?? []) {
        const fromKey = scanScValForContractError(entry.key);
        if (fromKey !== null) return fromKey;
        const fromValue = scanScValForContractError(entry.val);
        if (fromValue !== null) return fromValue;
      }
      return null;
    }
    default:
      return null;
  }
}

/** Re-exported so callers can inspect raw ScVals without importing stellar-sdk. */
export { xdr };
