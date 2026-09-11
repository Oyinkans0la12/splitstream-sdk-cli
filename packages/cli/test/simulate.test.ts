import { writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildSimulation, readAddressMap, serializeSimulation } from '../src/commands/simulate.js';
import type { PullRequestSummary } from '../src/points.js';
import { ADDRESS_A, ADDRESS_B, writeManifestFile } from './fixtures.js';

function pullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 1,
    title: 'a change',
    author: 'ada',
    state: 'closed',
    merged: true,
    mergedAt: '2026-08-01T00:00:00Z',
    labels: ['points:50'],
    additions: 10,
    deletions: 10,
    url: 'https://github.com/splitstream/splitstream-actions/pull/1',
    ...overrides,
  };
}

describe('buildSimulation', () => {
  it('estimates a pro-rata payout per contributor plus the post_cycle_root cost', () => {
    const result = buildSimulation({
      repo: 'splitstream/splitstream-actions',
      cycleId: 3,
      poolAmount: 100_000_000n,
      tokenDecimals: 7,
      pullRequests: [
        pullRequest({ number: 1, author: 'ada', labels: ['points:50'] }),
        pullRequest({ number: 2, author: 'grace', labels: ['points:25'] }),
        pullRequest({ number: 3, author: 'linus', labels: ['points:25'] }),
      ],
      addressByHandle: { grace: ADDRESS_B },
    });

    expect(result.totalPoints).toBe(100);
    expect(result.mergedPullRequests).toBe(3);
    expect(result.openPullRequests).toBe(0);
    expect(result.allocations.map((entry) => entry.amount)).toEqual([
      50_000_000n,
      25_000_000n,
      25_000_000n,
    ]);
    expect(result.dust).toBe(0n);

    const ada = result.allocations.find((entry) => entry.github === 'ada');
    expect(ada?.address).toBeNull();
    expect(result.unmappedContributors).toEqual(['ada', 'linus']);

    const grace = result.allocations.find((entry) => entry.github === 'grace');
    expect(grace?.address).toBe(ADDRESS_B);
    expect(grace?.sharePercent).toBe('25');

    expect(result.cost.contributorCount).toBe(3);
    expect(result.cost.writeEntries).toBe(4);
  });

  it('counts open and merged pull requests separately', () => {
    const result = buildSimulation({
      repo: 'splitstream/splitstream-actions',
      cycleId: null,
      poolAmount: 10n,
      tokenDecimals: 7,
      pullRequests: [
        pullRequest({ number: 1, merged: true }),
        pullRequest({ number: 2, merged: false, state: 'open', mergedAt: null }),
      ],
    });
    expect(result.mergedPullRequests).toBe(1);
    expect(result.openPullRequests).toBe(1);
  });

  it('produces nothing but dust when no pull request scores', () => {
    const result = buildSimulation({
      repo: 'splitstream/splitstream-actions',
      cycleId: 1,
      poolAmount: 1_000n,
      tokenDecimals: 7,
      pullRequests: [pullRequest({ author: null })],
    });
    expect(result.allocations).toEqual([]);
    expect(result.dust).toBe(1_000n);
  });
});

describe('serializeSimulation', () => {
  it('encodes every amount as a decimal string, never as a JSON number', () => {
    const result = buildSimulation({
      repo: 'splitstream/splitstream-actions',
      cycleId: 4,
      poolAmount: 900_719_925_474_099_300n,
      tokenDecimals: 7,
      pullRequests: [pullRequest({ labels: ['points:10'] })],
      addressByHandle: { ada: ADDRESS_A },
    });

    const parsed = JSON.parse(serializeSimulation(result)) as Record<string, unknown>;
    expect(parsed.poolAmount).toBe('900719925474099300');
    expect(parsed.dust).toBe('0');

    const allocations = parsed.allocations as Record<string, unknown>[];
    expect(allocations[0]?.amount).toBe('900719925474099300');
    expect(typeof allocations[0]?.amount).toBe('string');

    const cost = parsed.cost as Record<string, unknown>;
    expect(typeof cost.totalStroops).toBe('string');
  });
});

describe('readAddressMap', () => {
  it('returns an empty map when no path is given', () => {
    expect(readAddressMap(undefined)).toEqual({});
  });

  it('reads a handle -> address object', () => {
    const path = writeManifestFile({ cycleId: 1 });
    const mapPath = `${path}.map.json`;
    writeFileSync(mapPath, JSON.stringify({ ada: ADDRESS_A, '@grace': ADDRESS_B }), 'utf8');
    expect(readAddressMap(mapPath)).toEqual({ ada: ADDRESS_A, '@grace': ADDRESS_B });
  });

  it('rejects a JSON array or a non-string address', () => {
    const path = writeManifestFile({ cycleId: 2 });
    writeFileSync(`${path}.arr.json`, JSON.stringify([ADDRESS_A]), 'utf8');
    expect(() => readAddressMap(`${path}.arr.json`)).toThrow(/must be a JSON object/);

    writeFileSync(`${path}.bad.json`, JSON.stringify({ ada: 12 }), 'utf8');
    expect(() => readAddressMap(`${path}.bad.json`)).toThrow(/non-string address/);
  });
});
