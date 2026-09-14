import { StrKey } from '@stellar/stellar-sdk';

/**
 * Shared data shapes.
 *
 * The `Manifest` shape is the contract between `splitstream-actions` (which
 * writes it) and this SDK/CLI (which consumes it). Token amounts cross the JSON
 * boundary as decimal strings and are converted to `bigint` at parse time -
 * JSON numbers are never used for token amounts anywhere in this codebase.
 */

/**
 * One payout row, exactly as `splitstream-actions` writes it.
 *
 * The field names mirror the writer verbatim: `stellar` (not `address`) and
 * `issuesClosed` (not `points`). The payout rule counts distinct issues closed
 * by a contributor's merged PRs; there are no points.
 */
export interface RawManifestEntry {
  github: string;
  stellar: string;
  issuesClosed: number | string;
  amount: string;
}

/**
 * The on-disk manifest, as `splitstream-actions` writes it.
 *
 * The authoritative field names are `entries`, `totalIssuesClosed`,
 * `dustRemainder` and `merkleRoot`. There is deliberately no `version` field
 * and no `tokenDecimals`: token decimals are a property of the SEP-41 token
 * contract, read at runtime with `SplitStreamClient.getTokenDecimals`, not
 * something a manifest should invent. `root` is accepted only as a
 * read-compatibility alias for `merkleRoot`; the canonical field written by
 * `splitstream-actions` is `merkleRoot`.
 */
export interface RawManifest {
  cycleId?: number | string;
  generatedAt?: string;
  poolAmount?: string | number;
  totalIssuesClosed?: number | string;
  entries?: readonly RawManifestEntry[];
  dustRemainder?: string | number;
  merkleRoot?: string;
  /** Read-compatibility alias for `merkleRoot` only. */
  root?: string;
}

/** A single payout entry with amounts already parsed to bigint. */
export interface ManifestEntry {
  /** GitHub handle, without the leading `@`. */
  readonly github: string;
  /** Contributor's Stellar account (`G...`). */
  readonly stellar: string;
  /** Distinct issues closed by this contributor's merged PRs this cycle. */
  readonly issuesClosed: number;
  /** Payout amount in the token's base units. */
  readonly amount: bigint;
}

/** A parsed, validated cycle manifest. */
export interface Manifest {
  readonly cycleId: number;
  readonly generatedAt: string;
  /** Total amount funded into the cycle pool, in base units. */
  readonly poolAmount: bigint;
  /** Payout denominator: the sum of `entries[].issuesClosed`. */
  readonly totalIssuesClosed: number;
  readonly entries: readonly ManifestEntry[];
  /** Pool remainder that did not divide evenly; left in the vault. */
  readonly dustRemainder: bigint;
  /** Merkle root, lowercase hex (no `0x`), exactly as actions wrote it. */
  readonly merkleRoot: string;
}

/** Result of a single contributor's `has_claimed` lookup. */
export interface CycleInfo {
  readonly cycleId: number;
  /** Merkle root for the cycle, lowercase hex, or `null` if not posted. */
  readonly root: string | null;
  readonly hasClaimed: boolean;
}

/** Vesting schedule as returned by the vault's `get_vesting`. */
export interface VestingInfo {
  readonly total: bigint;
  readonly claimed: bigint;
  readonly startLedger: number;
  readonly durationLedgers: number;
}

/** Raised when a manifest cannot be parsed. Never swallows the offending field. */
export class ManifestParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestParseError';
  }
}

/** True when `value` is a valid `G...` Stellar account address. */
export function isValidStellarAddress(value: string): boolean {
  return typeof value === 'string' && StrKey.isValidEd25519PublicKey(value);
}

/** True when `value` is a valid `C...` Soroban contract id. */
export function isValidContractId(value: string): boolean {
  return typeof value === 'string' && StrKey.isValidContract(value);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ManifestParseError(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function pick(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function asInteger(value: unknown, what: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new ManifestParseError(`${what} must be an integer, received ${String(value)}`);
    }
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (!Number.isSafeInteger(parsed)) {
      throw new ManifestParseError(`${what} is out of range: ${value}`);
    }
    return parsed;
  }
  throw new ManifestParseError(`${what} must be an integer, received ${JSON.stringify(value)}`);
}

function asBigIntAmount(value: unknown, what: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new ManifestParseError(
        `${what} must be an integer string of base units, received ${JSON.stringify(value)}`,
      );
    }
    return BigInt(trimmed);
  }
  if (typeof value === 'number') {
    // Only safe integers are accepted: anything larger has already lost
    // precision by the time JSON.parse hands it to us.
    if (!Number.isSafeInteger(value)) {
      throw new ManifestParseError(
        `${what} must be encoded as a string; the number ${String(value)} exceeds the safe integer range`,
      );
    }
    return BigInt(value);
  }
  throw new ManifestParseError(`${what} is missing or is not an integer amount`);
}

function asNonEmptyString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ManifestParseError(`${what} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Validates and normalizes a raw manifest.
 *
 * @param raw - parsed JSON (or an already-parsed object) from splitstream-actions
 * @throws {ManifestParseError} when a required field is missing or malformed
 */
export function parseManifest(raw: unknown): Manifest {
  const record = asRecord(raw, 'manifest');

  const cycleValue = pick(record, ['cycleId', 'cycle']);
  const poolValue = pick(record, ['poolAmount', 'pool_amount', 'pool']);
  const totalIssuesValue = pick(record, ['totalIssuesClosed', 'total_issues_closed']);
  const rootValue = pick(record, ['merkleRoot', 'merkle_root', 'root']);
  const entriesValue = pick(record, ['entries']);
  const dustValue = pick(record, ['dustRemainder', 'dust_remainder']);
  const generatedAtValue = pick(record, ['generatedAt', 'generated_at']);

  if (entriesValue === undefined) {
    throw new ManifestParseError(
      'manifest.entries is required: splitstream-actions writes the payout rows under "entries"',
    );
  }
  if (!Array.isArray(entriesValue)) {
    throw new ManifestParseError('manifest.entries must be an array');
  }

  const entries: ManifestEntry[] = entriesValue.map((entry, index) => {
    const row = asRecord(entry, `manifest.entries[${index}]`);
    const github = asNonEmptyString(pick(row, ['github', 'handle']), `entries[${index}].github`);
    const stellar = asNonEmptyString(pick(row, ['stellar', 'stellarAddress']), `entries[${index}].stellar`);
    if (!isValidStellarAddress(stellar)) {
      throw new ManifestParseError(
        `entries[${index}].stellar is not a valid Stellar account: ${stellar}`,
      );
    }
    const issuesClosed = asInteger(pick(row, ['issuesClosed']), `entries[${index}].issuesClosed`);
    if (issuesClosed < 0) {
      throw new ManifestParseError(`entries[${index}].issuesClosed must not be negative`);
    }
    const amount = asBigIntAmount(pick(row, ['amount', 'claimable']), `entries[${index}].amount`);
    if (amount < 0n) {
      throw new ManifestParseError(`entries[${index}].amount must not be negative`);
    }
    return { github, stellar, issuesClosed, amount };
  });

  const duplicates = findDuplicateAddresses(entries);
  if (duplicates.length > 0) {
    throw new ManifestParseError(
      `manifest contains duplicate contributor addresses: ${duplicates.join(', ')}`,
    );
  }

  const totalIssuesClosed =
    totalIssuesValue === undefined
      ? entries.reduce((sum, entry) => sum + entry.issuesClosed, 0)
      : asInteger(totalIssuesValue, 'manifest.totalIssuesClosed');
  if (totalIssuesClosed < 0) {
    throw new ManifestParseError('manifest.totalIssuesClosed must not be negative');
  }

  const dustRemainder =
    dustValue === undefined ? 0n : asBigIntAmount(dustValue, 'manifest.dustRemainder');

  return {
    cycleId: asInteger(cycleValue, 'manifest.cycleId'),
    generatedAt: generatedAtValue === undefined ? '' : String(generatedAtValue),
    poolAmount: asBigIntAmount(poolValue, 'manifest.poolAmount'),
    totalIssuesClosed,
    entries,
    dustRemainder,
    merkleRoot: asNonEmptyString(rootValue, 'manifest.merkleRoot').toLowerCase().replace(/^0x/, ''),
  };
}

function findDuplicateAddresses(entries: readonly ManifestEntry[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.stellar)) duplicates.add(entry.stellar);
    seen.add(entry.stellar);
  }
  return [...duplicates];
}

/**
 * Normalizes the value returned by the vault's `get_vesting`.
 *
 * Accepts `null`/`void` (no schedule), a struct-shaped object (the Soroban
 * wire form, with either snake_case or camelCase keys), or a 4-element
 * positional tuple.
 */
export function parseVesting(value: unknown): VestingInfo | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return null;
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'string') {
    return null;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.length < 4) {
      throw new ManifestParseError(
        `get_vesting returned a ${value.length}-element tuple; expected at least 4 elements`,
      );
    }
    return {
      total: asBigIntAmount(value[0], 'vesting.total'),
      claimed: asBigIntAmount(value[1], 'vesting.claimed'),
      startLedger: asInteger(value[2], 'vesting.startLedger'),
      durationLedgers: asInteger(value[3], 'vesting.durationLedgers'),
    };
  }

  if (value instanceof Map) {
    return parseVesting(Object.fromEntries(value));
  }

  const record = asRecord(value, 'get_vesting result');
  const total = pick(record, ['total', 'totalAmount', 'total_amount']);
  const claimed = pick(record, ['claimed', 'claimedAmount', 'claimed_amount']);
  const startLedger = pick(record, ['startLedger', 'start_ledger', 'start']);
  const duration = pick(record, ['durationLedgers', 'duration_ledgers', 'duration']);
  if (total === undefined && claimed === undefined && startLedger === undefined) {
    return null;
  }
  return {
    total: asBigIntAmount(total ?? 0n, 'vesting.total'),
    claimed: asBigIntAmount(claimed ?? 0n, 'vesting.claimed'),
    startLedger: asInteger(startLedger ?? 0, 'vesting.startLedger'),
    durationLedgers: asInteger(duration ?? 0, 'vesting.durationLedgers'),
  };
}

/** Finds a contributor entry by Stellar address, or by GitHub handle as a fallback. */
export function findManifestEntry(
  manifest: Manifest,
  identifier: string,
): ManifestEntry | undefined {
  const byAddress = manifest.entries.find((entry) => entry.stellar === identifier);
  if (byAddress) return byAddress;
  const handle = identifier.replace(/^@/, '').toLowerCase();
  return manifest.entries.find((entry) => entry.github.toLowerCase() === handle);
}
