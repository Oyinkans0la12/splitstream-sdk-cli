import { StrKey } from '@stellar/stellar-sdk';

/**
 * Shared data shapes.
 *
 * The `Manifest` shape is the contract between `splitstream-actions` (which
 * writes it) and this SDK/CLI (which consumes it). Token amounts cross the JSON
 * boundary as decimal strings and are converted to `bigint` at parse time -
 * JSON numbers are never used for token amounts anywhere in this codebase.
 */

/** One contributor row as written by splitstream-actions. */
export interface RawManifestContributor {
  github: string;
  address: string;
  points: number | string;
  amount: string;
}

/**
 * The on-disk manifest. Aliases are accepted for a couple of fields because
 * the actions repo has emitted both `cycle`/`cycleId` and `root`/`merkleRoot`
 * spellings; see {@link parseManifest}.
 */
export interface RawManifest {
  version?: number | string;
  cycle?: number | string;
  cycleId?: number | string;
  poolAmount?: string | number;
  totalPoints?: number | string;
  tokenDecimals?: number | string;
  root?: string;
  merkleRoot?: string;
  generatedAt?: string;
  dust?: string | number;
  contributors?: readonly RawManifestContributor[];
}

/** A single contributor payout entry with amounts already parsed to bigint. */
export interface ManifestEntry {
  /** GitHub handle, without the leading `@`. */
  readonly github: string;
  /** Contributor's Stellar account (`G...`). */
  readonly address: string;
  /** Allocated points for the cycle. Integer, never a token amount. */
  readonly points: number;
  /** Payout amount in the token's base units. */
  readonly amount: bigint;
}

/** A parsed, validated cycle manifest. */
export interface Manifest {
  readonly version: number;
  readonly cycleId: number;
  /** Total amount funded into the cycle pool, in base units. */
  readonly poolAmount: bigint;
  readonly totalPoints: number;
  readonly tokenDecimals: number;
  /** Merkle root as lowercase hex (no `0x`), as published by actions. */
  readonly root: string;
  readonly generatedAt: string;
  readonly contributors: readonly ManifestEntry[];
  /** Amount that does not divide evenly across points, in base units. */
  readonly dust: bigint;
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

  const versionValue = pick(record, ['version']);
  const cycleValue = pick(record, ['cycleId', 'cycle', 'id']);
  const poolValue = pick(record, ['poolAmount', 'pool_amount', 'pool']);
  const totalPointsValue = pick(record, ['totalPoints', 'total_points']);
  const decimalsValue = pick(record, ['tokenDecimals', 'token_decimals', 'decimals']);
  const rootValue = pick(record, ['root', 'merkleRoot', 'merkle_root']);
  const contributorsValue = pick(record, ['contributors', 'entries']);
  const dustValue = pick(record, ['dust', 'remainder']);
  const generatedAtValue = pick(record, ['generatedAt', 'generated_at']);

  const contributorsRaw = contributorsValue ?? [];
  if (!Array.isArray(contributorsRaw)) {
    throw new ManifestParseError('manifest.contributors must be an array');
  }

  const contributors: ManifestEntry[] = contributorsRaw.map((entry, index) => {
    const row = asRecord(entry, `manifest.contributors[${index}]`);
    const github = asNonEmptyString(pick(row, ['github', 'handle']), `contributors[${index}].github`);
    const address = asNonEmptyString(pick(row, ['address', 'stellarAddress']), `contributors[${index}].address`);
    if (!isValidStellarAddress(address)) {
      throw new ManifestParseError(
        `contributors[${index}].address is not a valid Stellar account: ${address}`,
      );
    }
    const points = asInteger(pick(row, ['points']), `contributors[${index}].points`);
    if (points < 0) {
      throw new ManifestParseError(`contributors[${index}].points must not be negative`);
    }
    const amount = asBigIntAmount(pick(row, ['amount', 'claimable']), `contributors[${index}].amount`);
    if (amount < 0n) {
      throw new ManifestParseError(`contributors[${index}].amount must not be negative`);
    }
    return { github, address, points, amount };
  });

  const duplicates = findDuplicateAddresses(contributors);
  if (duplicates.length > 0) {
    throw new ManifestParseError(
      `manifest contains duplicate contributor addresses: ${duplicates.join(', ')}`,
    );
  }

  const tokenDecimals = decimalsValue === undefined ? 7 : asInteger(decimalsValue, 'manifest.tokenDecimals');
  if (tokenDecimals < 0 || tokenDecimals > 38) {
    throw new ManifestParseError(`manifest.tokenDecimals is out of range: ${tokenDecimals}`);
  }

  const totalPoints =
    totalPointsValue === undefined
      ? contributors.reduce((sum, entry) => sum + entry.points, 0)
      : asInteger(totalPointsValue, 'manifest.totalPoints');

  const dust = dustValue === undefined ? 0n : asBigIntAmount(dustValue, 'manifest.dust');

  return {
    version: versionValue === undefined ? 1 : asInteger(versionValue, 'manifest.version'),
    cycleId: asInteger(cycleValue, 'manifest.cycleId'),
    poolAmount: asBigIntAmount(poolValue, 'manifest.poolAmount'),
    totalPoints,
    tokenDecimals,
    root: asNonEmptyString(rootValue, 'manifest.root').toLowerCase().replace(/^0x/, ''),
    generatedAt: generatedAtValue === undefined ? '' : String(generatedAtValue),
    contributors,
    dust,
  };
}

function findDuplicateAddresses(entries: readonly ManifestEntry[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.address)) duplicates.add(entry.address);
    seen.add(entry.address);
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
  const byAddress = manifest.contributors.find((entry) => entry.address === identifier);
  if (byAddress) return byAddress;
  const handle = identifier.replace(/^@/, '').toLowerCase();
  return manifest.contributors.find((entry) => entry.github.toLowerCase() === handle);
}
