import { execFileSync } from 'node:child_process';

/**
 * Read-only points estimation for `splitstream simulate`.
 *
 * This is a *dry run*: it reads GitHub, applies a documented points rule set,
 * and estimates a pro-rata payout. It never contacts Soroban RPC and never
 * builds or signs anything, so it is safe to run against any repository.
 *
 * The rule set is deliberately explicit rather than hidden in constants, so a
 * maintainer can see exactly why a contributor got the number they got. Label
 * matches win over size buckets.
 */

/** A pull request reduced to the fields scoring needs. */
export interface PullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly author: string | null;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly mergedAt: string | null;
  readonly labels: readonly string[];
  readonly additions: number;
  readonly deletions: number;
  readonly url: string;
}

/** How points are awarded. */
export interface PointsRuleSet {
  /** `label -> points`, matched case-insensitively. */
  readonly labelPoints: Readonly<Record<string, number>>;
  /** Falling back to PR size when no points label is present. */
  readonly sizePoints: Readonly<Record<SizeBucket, number>>;
  /** Multiplier applied to PRs that are open but not merged yet. */
  readonly openMultiplier: number;
}

/** Size buckets for the fallback rule. */
export type SizeBucket = 'XS' | 'S' | 'M' | 'L' | 'XL';

export const SIZE_BUCKET_UPPER_BOUNDS: Readonly<Record<SizeBucket, number>> = Object.freeze({
  XS: 10,
  S: 50,
  M: 200,
  L: 500,
  XL: Number.POSITIVE_INFINITY,
});

export const DEFAULT_POINTS_RULES: PointsRuleSet = Object.freeze({
  labelPoints: Object.freeze({
    'points:10': 10,
    'points:25': 25,
    'points:50': 50,
    'points:100': 100,
    'points:150': 150,
    'points:200': 200,
  }),
  sizePoints: Object.freeze({ XS: 10, S: 25, M: 50, L: 100, XL: 200 }),
  openMultiplier: 1,
});

const POINTS_LABEL_PATTERN = /^(?:points?|pts)[:\-_ ]?(\d+)$/i;

/** Bucket for a PR based on total churn. */
export function sizeBucket(additions: number, deletions: number): SizeBucket {
  const churn = additions + deletions;
  for (const bucket of ['XS', 'S', 'M', 'L', 'XL'] as const) {
    if (churn <= SIZE_BUCKET_UPPER_BOUNDS[bucket]) return bucket;
  }
  return 'XL';
}

/** Reads a `points:N` label, or a `size/M` label, out of a PR's labels. */
export function pointsFromLabels(
  labels: readonly string[],
  rules: PointsRuleSet = DEFAULT_POINTS_RULES,
): number | null {
  for (const raw of labels) {
    const label = raw.trim();
    const configured = rules.labelPoints[label.toLowerCase()];
    if (configured !== undefined) return configured;

    const match = POINTS_LABEL_PATTERN.exec(label);
    if (match?.[1]) return Number.parseInt(match[1], 10);
  }

  for (const raw of labels) {
    const sizeMatch = /^size[/:\-_ ]?(xs|s|m|l|xl)$/i.exec(raw.trim());
    if (sizeMatch?.[1]) {
      const bucket = sizeMatch[1].toUpperCase() as SizeBucket;
      return rules.sizePoints[bucket];
    }
  }

  return null;
}

/** Points for one PR under the given rules. */
export function pointsForPullRequest(
  pr: PullRequestSummary,
  rules: PointsRuleSet = DEFAULT_POINTS_RULES,
): number {
  const fromLabels = pointsFromLabels(pr.labels, rules);
  const base = fromLabels ?? rules.sizePoints[sizeBucket(pr.additions, pr.deletions)];
  return pr.merged ? base : Math.round(base * rules.openMultiplier);
}

/** One contributor's aggregated points. */
export interface ContributorPoints {
  readonly github: string;
  readonly points: number;
  readonly pullRequests: readonly PullRequestSummary[];
}

/** Aggregates points per GitHub handle, highest first. */
export function summarizeByContributor(
  pullRequests: readonly PullRequestSummary[],
  rules: PointsRuleSet = DEFAULT_POINTS_RULES,
): ContributorPoints[] {
  const byAuthor = new Map<string, { points: number; pullRequests: PullRequestSummary[] }>();

  for (const pr of pullRequests) {
    if (!pr.author) continue;
    const bucket = byAuthor.get(pr.author) ?? { points: 0, pullRequests: [] };
    bucket.points += pointsForPullRequest(pr, rules);
    bucket.pullRequests.push(pr);
    byAuthor.set(pr.author, bucket);
  }

  return [...byAuthor.entries()]
    .map(([github, bucket]) => ({ github, points: bucket.points, pullRequests: bucket.pullRequests }))
    .sort((a, b) => b.points - a.points || a.github.localeCompare(b.github));
}

/** A contributor's estimated payout for a pool. */
export interface EstimatedAllocation {
  readonly github: string;
  readonly address: string | null;
  readonly points: number;
  /** Points as a share of the pool, in percent. */
  readonly sharePercent: string;
  /** Estimated amount in base units. */
  readonly amount: bigint;
}

/**
 * Splits `poolAmount` across contributors pro-rata by points, using integer
 * arithmetic only. The remainder that cannot be divided stays in the pool as
 * dust, matching the on-chain behaviour the manifest records.
 */
export function estimateAllocations(
  contributors: readonly ContributorPoints[],
  poolAmount: bigint,
  addressByHandle: Readonly<Record<string, string>> = {},
): { allocations: EstimatedAllocation[]; dust: bigint; totalPoints: number } {
  const totalPoints = contributors.reduce((sum, entry) => sum + entry.points, 0);
  if (totalPoints === 0) {
    return { allocations: [], dust: poolAmount, totalPoints: 0 };
  }

  const allocations = contributors.map((entry) => {
    const sharePer10k = (BigInt(entry.points) * 10_000n) / BigInt(totalPoints);
    const amount = (poolAmount * BigInt(entry.points)) / BigInt(totalPoints);
    return {
      github: entry.github,
      address: addressByHandle[entry.github] ?? addressByHandle[`@${entry.github}`] ?? null,
      points: entry.points,
      sharePercent: formatSharePercent(sharePer10k),
      amount,
    };
  });

  const distributed = allocations.reduce((sum, entry) => sum + entry.amount, 0n);
  return { allocations, dust: poolAmount - distributed, totalPoints };
}

function formatSharePercent(sharePer10k: bigint): string {
  const whole = sharePer10k / 100n;
  const fraction = (sharePer10k % 100n).toString().padStart(2, '0');
  return fraction === '00' ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/** A local cost estimate for the eventual `post_cycle_root` call. */
export interface CostEstimate {
  readonly contributorCount: number;
  readonly instructions: number;
  readonly readEntries: number;
  readonly writeEntries: number;
  readonly classicFeeStroops: bigint;
  readonly resourceFeeStroops: bigint;
  readonly totalStroops: bigint;
  /** Total in XLM, 7 decimal places. */
  readonly totalXlm: string;
  readonly assumptions: readonly string[];
}

/**
 * Base-network Soroban fee constants, in stroops, as published by the protocol.
 * These are the *base* values: the network can raise them under load, which is
 * exactly why this is labelled an estimate.
 */
export const SOROBAN_FEE_CONSTANTS = Object.freeze({
  classicFeePerOperation: 100n,
  cpuInstructionsPerUnit: 10_000,
  cpuInstructionFeeStroops: 25n,
  readLedgerEntryStroops: 6_250n,
  writeLedgerEntryStroops: 10_000n,
  /** Rough instruction cost of hashing/validating one Merkle leaf. */
  instructionsPerContributor: 15_000,
  /** Fixed instruction cost of the entrypoint bookkeeping. */
  baseInstructions: 50_000,
});

/**
 * Estimates the fee and footprint of `post_cycle_root` from the contributor
 * count alone.
 *
 * This exists so `splitstream simulate` can show a realistic number without
 * touching the chain. It is an estimate, not a quote - the authoritative number
 * comes from simulating the real transaction once the root is built.
 */
export function estimatePostCycleRootCost(
  contributorCount: number,
  options: { recordsPerContributor?: boolean } = {},
): CostEstimate {
  const recordsPerContributor = options.recordsPerContributor ?? true;
  const constants = SOROBAN_FEE_CONSTANTS;

  const instructions =
    constants.baseInstructions + constants.instructionsPerContributor * contributorCount;
  const readEntries = 2;
  const writeEntries = 1 + (recordsPerContributor ? contributorCount : 0);

  const classicFeeStroops = constants.classicFeePerOperation;
  const instructionUnits = BigInt(Math.ceil(instructions / constants.cpuInstructionsPerUnit));
  const resourceFeeStroops =
    instructionUnits * constants.cpuInstructionFeeStroops +
    BigInt(readEntries) * constants.readLedgerEntryStroops +
    BigInt(writeEntries) * constants.writeLedgerEntryStroops;

  const totalStroops = classicFeeStroops + resourceFeeStroops;

  return {
    contributorCount,
    instructions,
    readEntries,
    writeEntries,
    classicFeeStroops,
    resourceFeeStroops,
    totalStroops,
    totalXlm: formatStroops(totalStroops),
    assumptions: [
      `Soroban base fee constants: ${constants.cpuInstructionFeeStroops} stroops per ${constants.cpuInstructionsPerUnit} instructions, ${constants.readLedgerEntryStroops} per ledger-entry read, ${constants.writeLedgerEntryStroops} per write`,
      `${readEntries} ledger-entry reads (vault instance + cycle record)`,
      recordsPerContributor
        ? `${writeEntries} ledger-entry writes (cycle root + one record per contributor)`
        : '1 ledger-entry write (cycle root only)',
      'Inclusion fee of one base operation (100 stroops); the network sets the real inclusion fee at submit time',
    ],
  };
}

/** Formats stroops (1 XLM = 10^7 stroops) as an XLM decimal string. */
export function formatStroops(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const fraction = (stroops % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/** Minimal shape of `fetch` this module needs, so tests can inject a stub. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface FetchPullRequestsOptions {
  /** `owner/name`. */
  repo: string;
  token?: string;
  /** Fetch per-PR details (needed for size buckets); default true. */
  withDetails?: boolean;
  maxPages?: number;
  maxDetailRequests?: number;
  fetchImpl?: FetchLike;
  /** Called with progress notes; defaults to silence. */
  onProgress?: (message: string) => void;
}

const GITHUB_API = 'https://api.github.com';
const DEFAULT_MAX_PAGES = 3;
const DEFAULT_MAX_DETAIL_REQUESTS = 200;
const DETAIL_CONCURRENCY = 5;

function githubHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    // GitHub rejects requests without a User-Agent.
    'user-agent': 'splitstream-cli',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function getJson(fetchImpl: FetchLike, url: string, token: string | undefined): Promise<unknown> {
  const response = await fetchImpl(url, { headers: githubHeaders(token) });
  if (!response.ok) {
    if (response.status === 403 || response.status === 429) {
      throw new Error(
        `GitHub rate limit hit while reading ${url}. Set GITHUB_TOKEN to raise the anonymous limit.`,
      );
    }
    if (response.status === 404) {
      throw new Error(`GitHub could not find ${url}. Check the --repo value (owner/name).`);
    }
    throw new Error(`GitHub returned HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry : (asRecord(entry).name as string | undefined)))
    .filter((name): name is string => typeof name === 'string');
}

function toSummary(raw: unknown): PullRequestSummary {
  const record = asRecord(raw);
  const user = asRecord(record.user);
  const mergedAt = typeof record.merged_at === 'string' ? record.merged_at : null;
  return {
    number: typeof record.number === 'number' ? record.number : 0,
    title: typeof record.title === 'string' ? record.title : '',
    author: typeof user.login === 'string' ? user.login : null,
    state: record.state === 'open' ? 'open' : 'closed',
    merged: mergedAt !== null,
    mergedAt,
    labels: labelNames(record.labels),
    additions: typeof record.additions === 'number' ? record.additions : 0,
    deletions: typeof record.deletions === 'number' ? record.deletions : 0,
    url: typeof record.html_url === 'string' ? record.html_url : '',
  };
}

/**
 * Reads pull requests from GitHub.
 *
 * The list endpoint does not include `additions`/`deletions`, so when size
 * scoring is enabled each PR is hydrated with a detail request, capped and
 * concurrency-limited to stay polite.
 */
export async function fetchPullRequests(
  options: FetchPullRequestsOptions,
): Promise<PullRequestSummary[]> {
  if (!/^[^/\s]+\/[^/\s]+$/.test(options.repo)) {
    throw new Error(`--repo must look like "owner/name", received "${options.repo}"`);
  }

  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (typeof fetchImpl !== 'function') {
    throw new Error('this Node build has no global fetch; Node 20 or newer is required');
  }

  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const summaries: PullRequestSummary[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const url = `${GITHUB_API}/repos/${options.repo}/pulls?state=all&per_page=100&page=${page}&sort=updated&direction=desc`;
    const payload = await getJson(fetchImpl, url, options.token);
    if (!Array.isArray(payload)) {
      throw new Error(`unexpected GitHub response for ${url}: expected an array`);
    }
    summaries.push(...payload.map(toSummary));
    if (payload.length < 100) break;
  }

  if (options.withDetails === false) return summaries;

  const maxDetail = options.maxDetailRequests ?? DEFAULT_MAX_DETAIL_REQUESTS;
  const needsDetail = summaries.slice(0, maxDetail);
  options.onProgress?.(`reading details for ${needsDetail.length} pull requests...`);

  for (let index = 0; index < needsDetail.length; index += DETAIL_CONCURRENCY) {
    const batch = needsDetail.slice(index, index + DETAIL_CONCURRENCY);
    await Promise.all(
      batch.map(async (summary) => {
        const detail = await getJson(
          fetchImpl,
          `${GITHUB_API}/repos/${options.repo}/pulls/${summary.number}`,
          options.token,
        );
        const index = summaries.findIndex((entry) => entry.number === summary.number);
        if (index >= 0) summaries[index] = toSummary(detail);
      }),
    );
  }

  return summaries;
}

/** Extracts `owner/name` from any GitHub remote URL form. */
export function parseRepoSlug(remoteUrl: string): string | null {
  const match =
    /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(remoteUrl.trim()) ??
    /^([^/\s]+)\/([^/\s]+)$/.exec(remoteUrl.trim());
  if (!match?.[1] || !match[2]) return null;
  return `${match[1]}/${match[2]}`;
}

/** Best-effort `origin` remote of the current repository, or null. */
export function inferRepoSlug(cwd: string = process.cwd()): string | null {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseRepoSlug(remote.trim());
  } catch {
    return null;
  }
}
