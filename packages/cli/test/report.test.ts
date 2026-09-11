import { readFileSync } from 'node:fs';

import { truncateAddress } from '@splitstream/sdk';
import { describe, expect, it } from 'vitest';

import { mapWithConcurrency } from '../src/commands/report.js';
import { DEFAULT_REPORT_PATH, generateReport, writeReport, type ReportEntry } from '../src/report.js';
import {
  ADDRESS_A,
  ADDRESS_B,
  ADDRESS_C,
  ROWS,
  VAULT_ID,
  buildManifest,
  writeManifestFile,
} from './fixtures.js';

function entries(): ReportEntry[] {
  return [
    { github: 'ada', address: ADDRESS_A, points: 50, amount: 50_000_000n, claimed: true },
    { github: 'grace', address: ADDRESS_B, points: 30, amount: 30_000_000n, claimed: false },
    { github: 'linus', address: ADDRESS_C, points: 20, amount: 20_000_000n, claimed: false },
  ];
}

function report(overrides: Partial<Parameters<typeof generateReport>[0]> = {}): string {
  return generateReport({
    manifest: buildManifest({ cycleId: 3 }),
    entries: entries(),
    vaultContractId: VAULT_ID,
    network: 'testnet',
    tokenSymbol: 'SPLIT',
    generatedAt: new Date('2026-09-10T12:00:00.000Z'),
    ...overrides,
  });
}

describe('generateReport', () => {
  it('summarizes the cycle', () => {
    const content = report();
    expect(content).toContain('# SplitStream payout report - cycle 3');
    expect(content).toContain('- **Pool funded:** 10 SPLIT');
    expect(content).toContain('- **Contributors:** 3');
    expect(content).toContain('- **Total points:** 100');
    expect(content).toContain('- **Allocated:** 10 SPLIT');
    expect(content).toContain('- **Claimed so far:** 5 SPLIT (1/3 contributors)');
    expect(content).toContain('- **Vault contract:** `' + VAULT_ID + '`');
  });

  it('emits a plain markdown table with one row per contributor, highest first', () => {
    const lines = report().split('\n');
    expect(lines).toContain('| GitHub | Stellar address | Points | Amount | Claimed |');
    expect(lines).toContain('| --- | --- | ---: | ---: | :---: |');

    const rows = lines.filter((line) => line.startsWith('| @'));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('| @ada |');
    expect(rows[0]).toContain('| 50 |');
    expect(rows[0]).toContain('| 5 |');
    expect(rows[0]).toContain('| yes |');
    expect(rows[1]).toContain('| @grace |');
    expect(rows[1]).toContain('| no |');
    expect(rows[2]).toContain('| @linus |');
  });

  it('truncates addresses but keeps enough of them to identify the account', () => {
    const content = report();
    for (const address of [ADDRESS_A, ADDRESS_B, ADDRESS_C]) {
      expect(content).toContain(`\`${truncateAddress(address)}\``);
    }
    expect(content).not.toContain(ADDRESS_A);
  });

  it('reports the dust remainder only when there is dust', () => {
    expect(report()).not.toContain('of dust remains in the vault');
    expect(report({ manifest: buildManifest({ cycleId: 3, dust: '3' }) })).toContain(
      '0.0000003 SPLIT of dust remains in the vault',
    );
  });

  it('escapes table-breaking characters in a GitHub handle', () => {
    const content = report({
      entries: [{ github: 'a|b', address: ADDRESS_A, points: 1, amount: 1n, claimed: false }],
    });
    expect(content).toContain('| @a\\|b |');
  });

  it('contains no HTML', () => {
    const content = report({
      manifest: buildManifest({ cycleId: 3, dust: '1' }),
      accountExplorerUrl: 'https://stellar.expert/explorer/testnet/contract/' + VAULT_ID,
    });
    // Requires a tag-name boundary (`<div>`, `<br/>`, `</div>`), so the
    // `<path-to-manifest.json>` placeholder in the reproduction snippet below
    // is not mistaken for markup.
    expect(content).not.toMatch(/<\/?[a-z][a-z0-9]*[\s/>]/i);
    expect(content).toContain('https://stellar.expert/explorer/testnet/contract/' + VAULT_ID);
  });

  it('tells a reader how to reproduce the numbers', () => {
    expect(report()).toContain('splitstream status --cycle 3 --manifest <path-to-manifest.json>');
    // With no known symbol the report says "tokens" rather than inventing one.
    expect(report({ tokenSymbol: undefined })).toContain('10 tokens');
  });

  it('handles a cycle with no allocations', () => {
    const content = report({ entries: [] });
    expect(content).toContain('- **Contributors:** 0');
    expect(content).toContain('- **Claimed so far:** 0 SPLIT (0/0 contributors)');
  });
});

describe('writeReport', () => {
  it('writes the markdown next to the manifest by default name', () => {
    const manifestPath = writeManifestFile({ cycleId: 9 });
    const outPath = `${manifestPath}.report.md`;
    writeReport(outPath, report());
    expect(readFileSync(outPath, 'utf8')).toContain('# SplitStream payout report - cycle 3');
    expect(DEFAULT_REPORT_PATH).toBe('SPLITSTREAM_REPORT.md');
    expect(ROWS).toHaveLength(3);
  });
});

describe('mapWithConcurrency', () => {
  it('preserves input order however the work interleaves', async () => {
    const results = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value));
      return value * 2;
    });
    expect(results).toEqual([10, 2, 8, 4, 6]);
  });

  it('never exceeds the concurrency limit and handles an empty input', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, index) => index), 3, async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return value;
    });
    expect(peak).toBeLessThanOrEqual(3);
    await expect(mapWithConcurrency([], 4, async () => 1)).resolves.toEqual([]);
  });
});
