import { describe, expect, it } from 'vitest';

import {
  formatTokenAmount,
  formatTokenAmountWithSeparators,
  parseTokenAmount,
  percentOf,
  truncateAddress,
} from '../src/index.js';

describe('formatTokenAmount', () => {
  it('formats base units at the given decimals', () => {
    expect(formatTokenAmount(10_000_000n, 7)).toBe('1');
    expect(formatTokenAmount(12_345_000n, 7)).toBe('1.2345');
    expect(formatTokenAmount(1n, 7)).toBe('0.0000001');
    expect(formatTokenAmount(0n, 7)).toBe('0');
    expect(formatTokenAmount(-15_000_000n, 7)).toBe('-1.5');
  });

  it('honours non-7 decimals instead of hardcoding them', () => {
    expect(formatTokenAmount(1_500_000n, 6)).toBe('1.5');
    expect(formatTokenAmount(1_500_000n, 7)).toBe('0.15');
    expect(formatTokenAmount(150n, 0)).toBe('150');
  });

  it('preserves amounts far beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = 123_456_789_012_345_678_901_234_567n;
    expect(formatTokenAmount(huge, 7)).toBe('12345678901234567890.1234567');
  });

  it('rejects out-of-range decimals', () => {
    expect(() => formatTokenAmount(1n, -1)).toThrow();
    expect(() => formatTokenAmount(1n, 39)).toThrow();
  });
});

describe('parseTokenAmount', () => {
  it('parses decimal strings into base units', () => {
    expect(parseTokenAmount('1', 7)).toBe(10_000_000n);
    expect(parseTokenAmount('1.2345', 7)).toBe(12_345_000n);
    expect(parseTokenAmount('0.0000001', 7)).toBe(1n);
    expect(parseTokenAmount('-1.5', 7)).toBe(-15_000_000n);
    expect(parseTokenAmount('  42  ', 7)).toBe(420_000_000n);
  });

  it('round-trips with formatTokenAmount', () => {
    for (const value of [0n, 1n, 12_345_678n, 99_999_999_999n, -500_000n]) {
      expect(parseTokenAmount(formatTokenAmount(value, 7), 7)).toBe(value);
    }
  });

  it('rejects values with more precision than the token supports', () => {
    // Rounding here would silently pay the wrong amount.
    expect(() => parseTokenAmount('1.23456789', 7)).toThrow(/decimal places/);
  });

  it('rejects malformed input', () => {
    expect(() => parseTokenAmount('', 7)).toThrow();
    expect(() => parseTokenAmount('1.2.3', 7)).toThrow();
    expect(() => parseTokenAmount('abc', 7)).toThrow();
  });
});

describe('formatTokenAmountWithSeparators', () => {
  it('groups the integer part', () => {
    expect(formatTokenAmountWithSeparators(1_234_567_890_000_000n, 7)).toBe('123,456,789');
    expect(formatTokenAmountWithSeparators(1_234_567_890_500_000n, 7)).toBe('123,456,789.05');
    expect(formatTokenAmountWithSeparators(-1_000_000n, 7)).toBe('-0.1');
  });
});

describe('truncateAddress', () => {
  it('shortens long addresses and leaves short ones alone', () => {
    expect(truncateAddress('GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR')).toBe(
      'GCFIRY\u2026XVYOJR',
    );
    expect(truncateAddress('GABC')).toBe('GABC');
  });
});

describe('percentOf', () => {
  it('returns a trimmed percentage string', () => {
    expect(percentOf(25n, 100n)).toBe('25');
    expect(percentOf(1n, 3n)).toBe('33.33');
    expect(percentOf(0n, 0n)).toBe('0');
  });
});
