import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_POINTS_RULES,
  estimateAllocations,
  estimatePostCycleRootCost,
  fetchPullRequests,
  formatStroops,
  parseRepoSlug,
  pointsForPullRequest,
  pointsFromLabels,
  sizeBucket,
  summarizeByContributor,
  type FetchLike,
  type PullRequestSummary,
} from '../src/points.js';

function pullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 1,
    title: 'a change',
    author: 'ada',
    state: 'closed',
    merged: true,
    mergedAt: '2026-08-01T00:00:00Z',
    labels: [],
    additions: 5,
    deletions: 5,
    url: 'https://github.com/splitstream/splitstream-actions/pull/1',
    ...overrides,
  };
}

describe('sizeBucket', () => {
  it('maps churn onto the documented buckets, inclusive at the boundary', () => {
    expect(sizeBucket(5, 5)).toBe('XS');
    expect(sizeBucket(10, 0)).toBe('XS');
    expect(sizeBucket(11, 0)).toBe('S');
    expect(sizeBucket(50, 0)).toBe('S');
    expect(sizeBucket(51, 0)).toBe('M');
    expect(sizeBucket(200, 0)).toBe('M');
    expect(sizeBucket(201, 0)).toBe('L');
    expect(sizeBucket(500, 0)).toBe('L');
    expect(sizeBucket(501, 0)).toBe('XL');
  });
});

describe('pointsFromLabels', () => {
  it('prefers a configured points label', () => {
    expect(pointsFromLabels(['points:100'])).toBe(100);
    expect(pointsFromLabels(['POINTS:150'])).toBe(150);
  });

  it('accepts the loose points label spellings the actions repo emits', () => {
    expect(pointsFromLabels(['pts-25'])).toBe(25);
    expect(pointsFromLabels(['point 50'])).toBe(50);
  });

  it('falls back to a size label', () => {
    expect(pointsFromLabels(['size/L'])).toBe(DEFAULT_POINTS_RULES.sizePoints.L);
    expect(pointsFromLabels(['size:xs'])).toBe(DEFAULT_POINTS_RULES.sizePoints.XS);
  });

  it('returns null when nothing scores', () => {
    expect(pointsFromLabels(['docs', 'good first issue'])).toBeNull();
  });
});

describe('pointsForPullRequest', () => {
  it('uses the label when present and the size bucket otherwise', () => {
    expect(pointsForPullRequest(pullRequest({ labels: ['points:200'] }))).toBe(200);
    expect(pointsForPullRequest(pullRequest({ additions: 4, deletions: 1 }))).toBe(
      DEFAULT_POINTS_RULES.sizePoints.XS,
    );
  });

  it('scales unmerged work by the configured multiplier', () => {
    const rules = { ...DEFAULT_POINTS_RULES, openMultiplier: 0.5 };
    expect(pointsForPullRequest(pullRequest({ merged: false, labels: ['points:100'] }), rules)).toBe(50);
  });
});

describe('summarizeByContributor', () => {
  it('aggregates per handle, highest first, and skips authorless PRs', () => {
    const summary = summarizeByContributor([
      pullRequest({ number: 1, author: 'ada', labels: ['points:50'] }),
      pullRequest({ number: 2, author: 'ada', labels: ['points:25'] }),
      pullRequest({ number: 3, author: 'grace', labels: ['points:200'] }),
      pullRequest({ number: 4, author: null }),
    ]);

    expect(summary.map((entry) => entry.github)).toEqual(['grace', 'ada']);
    const ada = summary.find((entry) => entry.github === 'ada');
    expect(ada?.points).toBe(75);
    expect(ada?.pullRequests).toHaveLength(2);
  });
});

describe('estimateAllocations', () => {
  it('splits the pool pro-rata with integer math and reports the dust', () => {
    const contributors = [
      { github: 'ada', points: 1, pullRequests: [] },
      { github: 'grace', points: 1, pullRequests: [] },
      { github: 'linus', points: 1, pullRequests: [] },
    ];
    const { allocations, dust, totalPoints } = estimateAllocations(contributors, 100n);

    expect(totalPoints).toBe(3);
    expect(allocations.map((entry) => entry.amount)).toEqual([33n, 33n, 33n]);
    expect(dust).toBe(1n);
    expect(allocations[0]?.sharePercent).toBe('33.33');
  });

  it('resolves addresses from either "@handle" or "handle" keys', () => {
    const contributors = [{ github: 'ada', points: 10, pullRequests: [] }];
    const { allocations } = estimateAllocations(contributors, 10n, { '@ada': 'GADA' });
    expect(allocations[0]?.address).toBe('GADA');
  });

  it('leaves the whole pool as dust when nobody scored', () => {
    const { allocations, dust, totalPoints } = estimateAllocations([], 500n);
    expect(allocations).toEqual([]);
    expect(totalPoints).toBe(0);
    expect(dust).toBe(500n);
  });
});

describe('estimatePostCycleRootCost', () => {
  it('grows with the contributor count and stays in integer stroops', () => {
    const small = estimatePostCycleRootCost(3);
    const large = estimatePostCycleRootCost(50);

    expect(small.writeEntries).toBe(4);
    expect(large.writeEntries).toBe(51);
    expect(large.totalStroops).toBeGreaterThan(small.totalStroops);
    expect(small.totalStroops).toBeTypeOf('bigint');
    expect(small.totalXlm).toMatch(/^\d+(\.\d+)?$/);
    expect(small.assumptions.length).toBeGreaterThan(0);
  });

  it('drops the per-contributor writes when asked to', () => {
    expect(estimatePostCycleRootCost(10, { recordsPerContributor: false }).writeEntries).toBe(1);
  });
});

describe('formatStroops', () => {
  it('formats stroops as XLM without trailing zeros', () => {
    expect(formatStroops(0n)).toBe('0');
    expect(formatStroops(10_000_000n)).toBe('1');
    expect(formatStroops(12_345_678n)).toBe('1.2345678');
    expect(formatStroops(100n)).toBe('0.00001');
  });
});

describe('parseRepoSlug', () => {
  it('accepts every form of GitHub remote', () => {
    expect(parseRepoSlug('git@github.com:splitstream/splitstream-core.git')).toBe(
      'splitstream/splitstream-core',
    );
    expect(parseRepoSlug('https://github.com/splitstream/splitstream-actions.git')).toBe(
      'splitstream/splitstream-actions',
    );
    expect(parseRepoSlug('https://github.com/splitstream/splitstream-actions')).toBe(
      'splitstream/splitstream-actions',
    );
    expect(parseRepoSlug('splitstream/splitstream-actions')).toBe('splitstream/splitstream-actions');
  });

  it('rejects values that are not repositories', () => {
    expect(parseRepoSlug('not a repo')).toBeNull();
  });
});

describe('fetchPullRequests', () => {
  function listPage(count: number, startIndex = 1): unknown[] {
    return Array.from({ length: count }, (_, index) => ({
      number: startIndex + index,
      title: `pr ${startIndex + index}`,
      user: { login: 'ada' },
      state: 'closed',
      merged_at: '2026-08-01T00:00:00Z',
      labels: [{ name: 'points:25' }],
      html_url: `https://github.com/splitstream/splitstream-actions/pull/${startIndex + index}`,
    }));
  }

  it('reads a short page, then hydrates each PR with its churn', async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      seen.push(url);
      if (/\/pulls\/\d+$/.test(url)) {
        return { ok: true, status: 200, json: async () => ({ ...(listPage(1)[0] as object), additions: 3, deletions: 2 }) };
      }
      return { ok: true, status: 200, json: async () => listPage(2) };
    };

    const pullRequests = await fetchPullRequests({
      repo: 'splitstream/splitstream-actions',
      fetchImpl,
      maxDetailRequests: 10,
    });

    expect(pullRequests).toHaveLength(2);
    expect(pullRequests[0]?.additions).toBe(3);
    expect(seen.filter((url) => url.includes('per_page=100'))).toHaveLength(1);
    expect(seen.filter((url) => /\/pulls\/\d+$/.test(url))).toHaveLength(2);
  });

  it('skips detail requests when asked, and never needs them for label scoring', async () => {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => listPage(1) });
    const pullRequests = await fetchPullRequests({
      repo: 'splitstream/splitstream-actions',
      withDetails: false,
      fetchImpl,
    });
    expect(pullRequests).toHaveLength(1);
    expect(pointsForPullRequest(pullRequests[0] as PullRequestSummary)).toBe(25);
  });

  it('turns a rate limit into an actionable message', async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 403, json: async () => ({}) });
    await expect(
      fetchPullRequests({ repo: 'splitstream/splitstream-actions', fetchImpl }),
    ).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it('rejects a repo that is not owner/name before any request', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }));
    await expect(fetchPullRequests({ repo: 'nope', fetchImpl })).rejects.toThrow(/owner\/name/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
