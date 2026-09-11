/**
 * Byte-level helpers shared by the Merkle code and the XDR code.
 *
 * Everything here works on plain `Uint8Array` (never Node's `Buffer`) so the
 * SDK can be bundled for a browser dashboard.
 */

/** Number of bytes in a Stellar Ed25519 public key. */
export const ED25519_PUBLIC_KEY_BYTES = 32;

/** Number of bytes in a Soroban contract Merkle sibling / leaf hash. */
export const MERKLE_HASH_BYTES = 32;

const HEX = '0123456789abcdef';

/** Lowercase, unprefixed hex encoding. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += HEX[byte >> 4] ?? '';
    out += HEX[byte & 0x0f] ?? '';
  }
  return out;
}

/**
 * Decodes a hex string (with or without a `0x` prefix) into bytes.
 *
 * @param value - hex input
 * @param context - what this value is, used in error messages
 */
export function hexToBytes(value: string, context = 'hex value'): Uint8Array {
  const normalized = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  if (normalized.length % 2 !== 0) {
    throw new Error(`${context} must have an even number of hex characters`);
  }
  if (!/^[0-9a-fA-F]*$/.test(normalized)) {
    throw new Error(`${context} contains non-hex characters`);
  }
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Constant-shape byte equality. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** Lexicographic byte comparison, used for canonical Merkle ordering. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return a.length - b.length;
}

/** Concatenates byte arrays into a fresh `Uint8Array`. */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const I128_MIN = -(1n << 127n);
const I128_MAX = 1n << 127n;
const TWO_128 = 1n << 128n;

/**
 * Encodes a bigint as a 16-byte big-endian two's-complement i128 - the same
 * wire representation Soroban uses for `i128` values. Used to build Merkle
 * leaves so the client and the contract hash identical bytes.
 */
export function i128ToBytes(value: bigint): Uint8Array {
  if (value < I128_MIN || value >= I128_MAX) {
    throw new Error(`amount ${value.toString()} does not fit in an i128`);
  }
  const normalized = value < 0n ? value + TWO_128 : value;
  const out = new Uint8Array(16);
  let remaining = normalized;
  for (let i = 15; i >= 0; i -= 1) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

/** Decodes a 16-byte big-endian two's-complement i128. */
export function bytesToI128(bytes: Uint8Array): bigint {
  if (bytes.length !== 16) {
    throw new Error(`expected 16 bytes for an i128, received ${bytes.length}`);
  }
  let out = 0n;
  for (const byte of bytes) {
    out = (out << 8n) | BigInt(byte);
  }
  return out >= I128_MAX ? out - TWO_128 : out;
}

/** Uint8Array -> base64, without depending on Node's Buffer. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  // `btoa` exists in browsers and in Node >= 16 as a global.
  return btoa(binary);
}
