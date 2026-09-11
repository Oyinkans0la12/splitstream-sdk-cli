/**
 * Token amount formatting.
 *
 * Token amounts are `bigint` base units everywhere in this SDK and the CLI.
 * Decimal strings exist only at the display boundary and in JSON. There is
 * deliberately no `Number` conversion anywhere in this module, so amounts
 * larger than `Number.MAX_SAFE_INTEGER` survive intact.
 */

const MAX_DECIMALS = 38;

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new Error(`token decimals must be an integer between 0 and ${MAX_DECIMALS}, got ${decimals}`);
  }
}

/**
 * Formats base units as a human-readable decimal string, trimming trailing
 * zeros in the fractional part (`12345000n` at 7 decimals -> `1.2345`).
 */
export function formatTokenAmount(value: bigint, decimals: number): string {
  assertDecimals(decimals);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = absolute / base;
  const fraction = absolute % base;

  let fractionText = fraction.toString().padStart(decimals, '0');
  fractionText = fractionText.replace(/0+$/, '');

  const text = fractionText === '' ? whole.toString() : `${whole.toString()}.${fractionText}`;
  return negative ? `-${text}` : text;
}

/**
 * Parses a human-readable decimal string into base units.
 *
 * Rejects values with more fractional digits than the token supports rather
 * than silently rounding - a silently rounded payout is a wrong payout.
 */
export function parseTokenAmount(input: string, decimals: number): bigint {
  assertDecimals(decimals);
  const trimmed = input.trim();
  if (!/^-?(\d+)(\.\d+)?$/.test(trimmed)) {
    throw new Error(`"${input}" is not a valid token amount`);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholePart = '0', fractionPart = ''] = unsigned.split('.');
  if (fractionPart.length > decimals) {
    throw new Error(
      `"${input}" has ${fractionPart.length} decimal places but the token only supports ${decimals}`,
    );
  }
  const paddedFraction = fractionPart.padEnd(decimals, '0');
  const baseUnits = BigInt(wholePart) * 10n ** BigInt(decimals) + BigInt(paddedFraction || '0');
  return negative ? -baseUnits : baseUnits;
}

/** Formats base units with thousands separators, e.g. `1,234.5000000`. */
export function formatTokenAmountWithSeparators(value: bigint, decimals: number): string {
  const formatted = formatTokenAmount(value, decimals);
  const negative = formatted.startsWith('-');
  const unsigned = negative ? formatted.slice(1) : formatted;
  const [wholePart = '0', fractionPart] = unsigned.split('.');
  const grouped = wholePart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const text = fractionPart === undefined ? grouped : `${grouped}.${fractionPart}`;
  return negative ? `-${text}` : text;
}

/** Shortens an address for table output: `GABCDE…WXYZ`. */
export function truncateAddress(address: string, leading = 6, trailing = 6): string {
  if (address.length <= leading + trailing + 1) return address;
  return `${address.slice(0, leading)}\u2026${address.slice(-trailing)}`;
}

/**
 * Percentage of `part` relative to `total`, truncated to `digits` places and
 * with trailing zeros trimmed. Pure bigint: no float rounding, no drift.
 */
export function percentOf(part: bigint, total: bigint, digits = 2): string {
  if (total === 0n) return '0';
  const scaled = (part * 100n * 10n ** BigInt(digits)) / total;
  const formatted = formatTokenAmount(scaled, digits);
  return formatted.includes('.') ? formatted.replace(/0+$/, '').replace(/\.$/, '') : formatted;
}
