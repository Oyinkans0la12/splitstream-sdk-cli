import { writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildSimulation, readAddressMap, serializeSimulation } from '../src/commands/simulate.js';
import type { MergedPullRequest } from '../src/contributions.js';
import { ADDRESS_A, ADDRESS_B, writeManifestFile } from './fixtures.js';

const REPO = 'splitstream/splitstream-actions';

function pullRequest(overrides: Partial<MergedPullRequest> = {}): MergedPullRequest {
  return {
    repo: REPO,
    number: 1,
    title: 'a change',
    author: 'ada',
    mergedAt: '2026-08-01T00:00:00Z',
    body: 'Closes #1',
    url: `https://github.com/${REPO}/pull/1`,
    ...overrides,
  };
}

describe('buildSimulation', () => {
  it('splits the pool by issues closed with the frozen floor formula', () => {
    const result = buildSimulation({
      repos: [REPO],
      cycleId: 3,
      poolAmount: 100_000_000n,
      tokenDecimals: 7,
      pullRequests: [
        pullRequest({ number: 1, author: 'ada', body: 'Closes #1\nCloses #2' }),
        pullRequest({ number: 2, author: 'grace', body: 'Fixes #3' }),
        pullRequest({ number: 3, author: 'linus', body: 'resolves #4' }),
      ],
      addressByHandle: { grace: ADDRESS_B },
    });

    expect(result.totalIssuesClosed).toBe(4);
    expect(result.mergedPullRequests).toBe(3);
    const byHandle = Object.fromEntries(result.allocations.map((entry) => [entry.github, entry.amount]));
    expect(byHandle).toEqual({ ada: 50_000_000n, grace: 25_000_000n, linus: 25_000_000n });
    expect(result.dustRemainder).toBe(0n);

    const ada = result.allocations.find((entry) => entry.github === 'ada');
    expect(ada?.issuesClosed).toBe(2);
    expect(ada?.address).toBeNull();
    expect(ada?.sharePercent).toBe('50');
    expect(result.unmappedContributors).toEqual(['ada', 'linus']);
    expect(result.allocations.find((entry) => entry.github === 'grace')?.address).toBe(ADDRESS_B);

    expect(result.cost.contributorCount).toBe(3);
    expect(result.cost.writeEntries).toBe(4);
  });

  it('ignores issue labels entirely - only closing keywords count', () => {
    const result = buildSimulation({
      repos: [REPO],
      cycleId: 1,
      poolAmount: 1_000n,
      tokenDecimals: 7,
      pullRequests: [
        // A "documentation" PR that closes nothing scores nothing, however big.
        pullRequest({ number: 1, author: 'ada', body: 'no closing keyword', title: '[size/XL] docs' }),
        pullRequest({ number: 2, author: 'grace', body: 'Closes #7' }),
      ],
    });
    expect(result.totalIssuesClosed).toBe(1);
    expect(result.allocations.map((entry) => entry.github)).toEqual(['grace']);
    expect(result.allocations[0]?.amount).toBe(1_000n);
  });

  it('counts a PR with no closing reference as zero and leaves the pool as dust', () => {
    const result = buildSimulation({
      repos: [REPO],
      cycleId: 1,
      poolAmount: 1_000n,
      tokenDecimals: 7,
      pullRequests: [pullRequest({ body: 'no keywords here' })],
    });
    expect(result.allocations).toEqual([]);
    expect(result.totalIssuesClosed).toBe(0);
    expect(result.dustRemainder).toBe(1_000n);
  });

  it('does not double-count the same issue referenced by two PRs from one author', () => {
    const result = buildSimulation({
      repos: [REPO],
      cycleId: 1,
      poolAmount: 100n,
      tokenDecimals: 7,
      pullRequests: [
        pullRequest({ number: 1, author: 'ada', body: 'Closes #5' }),
        pullRequest({ number: 2, author: 'ada', body: 'Fixes #5' }),
      ],
    });
    expect(result.totalIssuesClosed).toBe(1);
    expect(result.allocations[0]?.issuesClosed).toBe(1);
  });

  it('sums counts across every supplied repo', () => {
    const result = buildSimulation({
      repos: ['org/a', 'org/b'],
      cycleId: 1,
      poolAmount: 100n,
      tokenDecimals: 7,
      pullRequests: [
        pullRequest({ repo: 'org/a', number: 1, author: 'ada', body: 'Closes #1' }),
        pullRequest({ repo: 'org/b', number: 1, author: 'ada', body: 'Closes #1' }),
      ],
    });
    // Issue numbers are only unique per repo, so these are two distinct issues.
    expect(result.totalIssuesClosed).toBe(2);
    expect(result.allocations[0]?.issuesClosed).toBe(2);
  });

  it('records the window lower bound when one is supplied', () => {
    const result = buildSimulation({
      repos: [REPO],
      cycleId: 2,
      poolAmount: 10n,
      tokenDecimals: 7,
      since: '2026-08-01T00:00:00Z',
      pullRequests: [pullRequest()],
    });
    expect(result.since).toBe('2026-08-01T00:00:00Z');
  });
});

describe('serializeSimulation', () => {
  it('encodes every amount as a decimal string, never as a JSON number', () => {
    const result = buildSimulation({
      repos: [REPO],
      cycleId: 4,
      poolAmount: 900_719_925_474_099_300n,
      tokenDecimals: 7,
      pullRequests: [pullRequest({ body: 'Closes #1' })],
      addressByHandle: { ada: ADDRESS_A },
    });

    const parsed = JSON.parse(serializeSimulation(result)) as Record<string, unknown>;
    expect(parsed.poolAmount).toBe('900719925474099300');
    expect(parsed.dustRemainder).toBe('0');
    expect(parsed.totalIssuesClosed).toBe(1);

    const allocations = parsed.allocations as Record<string, unknown>[];
    expect(allocations[0]?.amount).toBe('900719925474099300');
    expect(typeof allocations[0]?.amount).toBe('string');
    expect(allocations[0]?.issuesClosed).toBe(1);

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
