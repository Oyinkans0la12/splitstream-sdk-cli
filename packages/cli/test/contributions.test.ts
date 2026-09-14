import { describe, expect, it } from 'vitest';

import {
  countIssuesByContributor,
  estimateAllocations,
  extractClosingIssueRefs,
  type MergedPullRequest,
} from '../src/contributions.js';
import { ADDRESS_A } from './fixtures.js';

function pullRequest(overrides: Partial<MergedPullRequest> = {}): MergedPullRequest {
  return {
    repo: 'org/repo',
    number: 1,
    title: 'a change',
    author: 'ada',
    mergedAt: '2026-08-01T00:00:00Z',
    body: null,
    url: 'https://github.com/org/repo/pull/1',
    ...overrides,
  };
}

describe('extractClosingIssueRefs', () => {
  it('matches every closing keyword case-insensitively', () => {
    const body = 'Closes #1, closes #2; FIXES #3 and Resolved #4';
    expect(extractClosingIssueRefs(body).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it('returns distinct issue numbers only', () => {
    expect(extractClosingIssueRefs('Closes #5\nFixes #5')).toEqual([5]);
  });

  it('ignores issue mentions without a closing keyword and cross-repo refs', () => {
    expect(extractClosingIssueRefs('refs #9, see other/repo#10, part of #11')).toEqual([]);
  });

  it('handles an empty or missing body', () => {
    expect(extractClosingIssueRefs(null)).toEqual([]);
    expect(extractClosingIssueRefs('')).toEqual([]);
  });
});

describe('countIssuesByContributor', () => {
  it('attributes distinct closed issues to the PR author', () => {
    const contributors = countIssuesByContributor([
      pullRequest({ number: 1, author: 'ada', body: 'Closes #1\nCloses #2' }),
      pullRequest({ number: 2, author: 'grace', body: 'Fixes #3' }),
    ]);
    expect(contributors.map((entry) => ({
      github: entry.github,
      issuesClosed: entry.issuesClosed,
      repos: [...entry.repos],
      pullRequests: entry.pullRequests.length,
    }))).toEqual([
      { github: 'ada', issuesClosed: 2, repos: ['org/repo'], pullRequests: 1 },
      { github: 'grace', issuesClosed: 1, repos: ['org/repo'], pullRequests: 1 },
    ]);
  });

  it('does not double-count an issue referenced by two PRs from the same author', () => {
    const contributors = countIssuesByContributor([
      pullRequest({ number: 1, author: 'ada', body: 'Closes #5' }),
      pullRequest({ number: 2, author: 'ada', body: 'Fixes #5' }),
    ]);
    expect(contributors).toHaveLength(1);
    expect(contributors[0]?.issuesClosed).toBe(1);
  });

  it('treats the same issue number in different repos as distinct', () => {
    const contributors = countIssuesByContributor([
      pullRequest({ repo: 'org/a', number: 1, author: 'ada', body: 'Closes #1' }),
      pullRequest({ repo: 'org/b', number: 2, author: 'ada', body: 'Closes #1' }),
    ]);
    expect(contributors[0]?.issuesClosed).toBe(2);
    expect([...(contributors[0]?.repos ?? [])].sort()).toEqual(['org/a', 'org/b']);
  });

  it('omits a PR that closes no issue', () => {
    const contributors = countIssuesByContributor([pullRequest({ body: 'no keyword' })]);
    expect(contributors).toEqual([]);
  });

  it('omits a PR with no author', () => {
    const contributors = countIssuesByContributor([pullRequest({ author: null, body: 'Closes #1' })]);
    expect(contributors).toEqual([]);
  });
});

describe('estimateAllocations', () => {
  it('applies the frozen floor formula and reports the remainder as dust', () => {
    const { allocations, dustRemainder, totalIssuesClosed } = estimateAllocations(
      [
        { github: 'ada', issuesClosed: 2, repos: ['org/repo'], pullRequests: [] },
        { github: 'grace', issuesClosed: 1, repos: ['org/repo'], pullRequests: [] },
      ],
      100n,
      { grace: ADDRESS_A },
    );

    expect(totalIssuesClosed).toBe(3);
    // floor(100 * 2 / 3) = 66, floor(100 * 1 / 3) = 33; 1 stroop remains.
    expect(allocations.map((entry) => entry.amount)).toEqual([66n, 33n]);
    expect(dustRemainder).toBe(1n);
    expect(allocations[0]?.address).toBeNull();
    expect(allocations[1]?.address).toBe(ADDRESS_A);
  });

  it('leaves the whole pool as dust when nothing qualified', () => {
    const { allocations, dustRemainder, totalIssuesClosed } = estimateAllocations([], 500n);
    expect(allocations).toEqual([]);
    expect(totalIssuesClosed).toBe(0);
    expect(dustRemainder).toBe(500n);
  });
});
