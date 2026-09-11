/**
 * SplitStream contract error decoding.
 *
 * ## Keeping this table in sync with splitstream-core
 *
 * The numeric discriminants below MUST match the `SplitStreamError` enum in
 * `splitstream-core`. Soroban only surfaces `Error(Contract, #N)` on the wire,
 * so the only way to print a useful message is to carry a local copy of the
 * enum. When core renumbers an error, update this table in the same PR that
 * bumps the contract - a stale table produces a *misleading* name, which is
 * worse than an unknown code.
 *
 * Anything not present here is reported as `UnknownSplitStreamError(<n>)`
 * rather than being silently guessed.
 */
export const SPLITSTREAM_CONTRACT_ERRORS: Readonly<Record<number, string>> = Object.freeze({
  1: 'NotInitialized',
  2: 'AlreadyInitialized',
  3: 'Unauthorized',
  4: 'Paused',
  5: 'CycleNotFound',
  6: 'CycleAlreadyPosted',
  7: 'InvalidMerkleRoot',
  8: 'InvalidProof',
  9: 'AlreadyClaimed',
  10: 'NothingToClaim',
  11: 'InvalidAmount',
  12: 'Overflow',
  13: 'VestingNotFound',
  14: 'VestingNotStarted',
  15: 'VestingNotComplete',
  16: 'InvalidContributor',
  17: 'InvalidCycleId',
  18: 'ReentrancyDetected',
  19: 'RootNotSet',
  20: 'InsufficientReserve',
});

/** Name for a contract error code, or a clearly-marked unknown name. */
export function splitstreamErrorName(code: number): string {
  return SPLITSTREAM_CONTRACT_ERRORS[code] ?? `UnknownSplitStreamError(${code})`;
}

/** Options accepted by {@link SplitStreamError}. */
export interface SplitStreamErrorOptions {
  /** Soroban contract error code extracted from the failure, when known. */
  code?: number;
  /** Lower-level message or XDR blob that produced this error. */
  details?: string;
}

/**
 * Every error the SDK raises on an expected failure path. The CLI catches this
 * and prints `message`; raw stacks stay behind `--verbose`.
 */
export class SplitStreamError extends Error {
  /** Contract error code, when the failure came from the contract. */
  readonly code: number | undefined;
  /** Human-readable name mapped from {@link code}. */
  readonly codeName: string | undefined;
  /** Extra detail (RPC status, XDR blob) for `--verbose` output. */
  readonly details: string | undefined;

  constructor(message: string, options: SplitStreamErrorOptions = {}) {
    super(message);
    this.name = 'SplitStreamError';
    this.code = options.code;
    this.codeName = options.code === undefined ? undefined : splitstreamErrorName(options.code);
    this.details = options.details;
  }
}

/** Builds a {@link SplitStreamError} for a known contract error code. */
export function contractError(code: number, context: string, details?: string): SplitStreamError {
  const name = splitstreamErrorName(code);
  return new SplitStreamError(
    `${context} failed with contract error ${name} (code ${code})`,
    details === undefined ? { code } : { code, details },
  );
}

const CONTRACT_ERROR_PATTERN = /Error\(Contract,\s*#(\d+)\)/i;

/**
 * Extracts the contract error code from a Soroban diagnostic string such as
 * `HostError: Error(Contract, #9)`.
 */
export function parseContractErrorCode(text: string): number | null {
  const match = CONTRACT_ERROR_PATTERN.exec(text);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Turns an arbitrary RPC/exception message into a {@link SplitStreamError}.
 *
 * If the text carries a contract error code, the code is decoded into a name;
 * otherwise the text is preserved verbatim so nothing is lost.
 */
export function toSplitStreamError(error: unknown, context: string): SplitStreamError {
  if (error instanceof SplitStreamError) return error;
  const text = error instanceof Error ? error.message : String(error);
  const code = parseContractErrorCode(text);
  if (code !== null) {
    return contractError(code, context, text);
  }
  return new SplitStreamError(`${context}: ${text}`, { details: text });
}
