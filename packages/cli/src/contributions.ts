import { execFileSync } from 'node:child_process';

/**
 * Count-based contribution ingest for `splitstream simulate`.
 *
 * This is a *dry run*: it reads merged pull requests from GitHub, resolves the
 * issues they closed, and estimates the pro-rata payout. It never contacts
 * Soroban RPC and never builds or signs anything, so it is safe to run against
 * any repository.
 *
 * The rule is ported from splitstream-actions' `src/ingest.ts` and
 * `src/counts.ts`: a qualifying issue is any issue closed via a merged PR
 * containing a recognized closing keyword (`Closes #N` / `Fixes #N` /
 * `Resolves #N`, case-insensitive). No label of any kind is read, and every
 * qualifying issue counts equally. Credit is attributed to the **PR author**.
 */

/** GitHub's closing-keyword set, identical to splitstream-actions' `ingest.ts`. */
const CLOSING_KEYWORD_RE = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#(\d+)\b/gi;

/**
 * Extracts the issue numbers a PR body closes.
 *
 * Issue references are only ever matched inside the PR's own repo - cross-repo
 * refs like `owner/repo#123` are not matched (GitHub only auto-closes same-repo
 * issues). Distinct numbers only.
 */
export function extractClosingIssueRefs(body: string | null): number[] {
  if (body === null || body === '') return [];
  const refs = new Set<number>();
  CLOSING_KEYWORD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CLOSING_KEYWORD_RE.exec(body)) !== null) {
    refs.add(Number(match[1]));
  }
  return [...refs];
}

/** A merged pull request reduced to the fields the count rule needs. */
export interface MergedPullRequest {
  /** `owner/name` of the repository this PR lives in. */
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly author: string | null;
  /** ISO 8601 merge timestamp. */
  readonly mergedAt: string;
  readonly body: string | null;
  readonly url: string;
}

/** One `(PR, closing issue)` pair that survived ingestion. */
export interface Contribution {
  readonly repo: string;
  readonly prNumber: number;
  readonly prAuthor: string;
  readonly issueNumber: number;
}

/** One contributor's aggregated contribution for the cycle. */
export interface ContributorContribution {
  readonly github: string;
  /** Distinct issues closed by this contributor's merged PRs this cycle. */
  readonly issuesClosed: number;
  readonly repos: readonly string[];
  readonly pullRequests: readonly MergedPullRequest[];
}

/**
 * Counts distinct issues closed per PR author, summed across every repo.
 *
 * Distinctness is per `owner/repo#issueNumber` - issue numbers are only unique
 * within a repo - so the same issue referenced by two PRs from the same author
 * is not double-counted. A PR that closes no issue contributes nothing, so an
 * author who only merged such PRs is absent (exactly as in splitstream-actions'
 * `countIssuesByContributor`). Highest count first, then handle.
 */
export function countIssuesByContributor(
  pullRequests: readonly MergedPullRequest[],
): ContributorContribution[] {
  const totals = new Map<
    string,
    { issues: Set<string>; repos: Set<string>; pullRequests: MergedPullRequest[] }
  >();

  for (const pr of pullRequests) {
    if (!pr.author) continue;
    const refs = extractClosingIssueRefs(pr.body);
    if (refs.length === 0) continue;
    const entry = totals.get(pr.author) ?? {
      issues: new Set<string>(),
      repos: new Set<string>(),
      pullRequests: [],
    };
    for (const issueNumber of refs) {
      entry.issues.add(`${pr.repo}#${issueNumber}`);
    }
    entry.repos.add(pr.repo);
    entry.pullRequests.push(pr);
    totals.set(pr.author, entry);
  }

  return [...totals.entries()]
    .map(([github, { issues, repos, pullRequests: prs }]) => ({
      github,
      issuesClosed: issues.size,
      repos: [...repos],
      pullRequests: prs,
    }))
    .sort((a, b) => b.issuesClosed - a.issuesClosed || a.github.localeCompare(b.github));
}

/** A contributor's estimated payout for a pool. */
export interface EstimatedAllocation {
  readonly github: string;
  readonly address: string | null;
  readonly issuesClosed: number;
  /** Share of the pool, in percent. */
  readonly sharePercent: string;
  /** Estimated amount in base units. */
  readonly amount: bigint;
}

/**
 * Splits `poolAmount` across contributors with the frozen formula:
 *
 *   contributor_amount = floor(pool * contributor_issues_closed / total_issues_closed)
 *
 * Integer arithmetic only. The remainder that cannot be divided stays in the
 * pool as `dustRemainder`, matching the on-chain behaviour the manifest records.
 */
export function estimateAllocations(
  contributors: readonly ContributorContribution[],
  poolAmount: bigint,
  addressByHandle: Readonly<Record<string, string>> = {},
): { allocations: EstimatedAllocation[]; dustRemainder: bigint; totalIssuesClosed: number } {
  const totalIssuesClosed = contributors.reduce((sum, entry) => sum + entry.issuesClosed, 0);
  if (totalIssuesClosed === 0) {
    return { allocations: [], dustRemainder: poolAmount, totalIssuesClosed: 0 };
  }

  const denominator = BigInt(totalIssuesClosed);
  const allocations = contributors.map((entry) => {
    const sharePer10k = (BigInt(entry.issuesClosed) * 10_000n) / denominator;
    const amount = (poolAmount * BigInt(entry.issuesClosed)) / denominator;
    return {
      github: entry.github,
      address: addressByHandle[entry.github] ?? addressByHandle[`@${entry.github}`] ?? null,
      issuesClosed: entry.issuesClosed,
      sharePercent: formatSharePercent(sharePer10k),
      amount,
    };
  });

  const distributed = allocations.reduce((sum, entry) => sum + entry.amount, 0n);
  return { allocations, dustRemainder: poolAmount - distributed, totalIssuesClosed };
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

export interface FetchMergedPullRequestsOptions {
  /** `owner/name` slugs to crawl; counts are summed across every repo. */
  repos: readonly string[];
  /** ISO 8601 lower bound on `merged_at`; PRs merged before it are skipped. */
  since?: string;
  token?: string;
  /** Stop after this many merged PRs across all repos. */
  maxPrs?: number;
  fetchImpl?: FetchLike;
  /** Called with progress notes; defaults to silence. */
  onProgress?: (message: string) => void;
}

const GITHUB_API = 'https://api.github.com';
const PER_PAGE = 100;
const MAX_PAGES_PER_REPO = 10;

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

function toMergedPullRequest(repo: string, raw: unknown): MergedPullRequest | null {
  const record = asRecord(raw);
  const mergedAt = typeof record.merged_at === 'string' ? record.merged_at : null;
  if (mergedAt === null) return null; // closed without merging
  const user = asRecord(record.user);
  return {
    repo,
    number: typeof record.number === 'number' ? record.number : 0,
    title: typeof record.title === 'string' ? record.title : '',
    author: typeof user.login === 'string' ? user.login : null,
    mergedAt,
    body: typeof record.body === 'string' ? record.body : null,
    url: typeof record.html_url === 'string' ? record.html_url : '',
  };
}

/**
 * Crawls merged pull requests (with their bodies) for every repo.
 *
 * Only the list endpoint is used: it already carries `body`, `merged_at` and
 * the author, so no per-PR detail requests are needed.
 */
export async function fetchMergedPullRequests(
  options: FetchMergedPullRequestsOptions,
): Promise<MergedPullRequest[]> {
  for (const repo of options.repos) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
      throw new Error(`--repo must look like "owner/name", received "${repo}"`);
    }
  }

  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (typeof fetchImpl !== 'function') {
    throw new Error('this Node build has no global fetch; Node 20 or newer is required');
  }

  const maxPrs = options.maxPrs ?? Number.POSITIVE_INFINITY;
  const merged: MergedPullRequest[] = [];

  for (const repo of options.repos) {
    for (let page = 1; page <= MAX_PAGES_PER_REPO; page += 1) {
      if (merged.length >= maxPrs) return merged.slice(0, maxPrs);
      const url = `${GITHUB_API}/repos/${repo}/pulls?state=closed&per_page=${PER_PAGE}&page=${page}&sort=updated&direction=desc`;
      const payload = await getJson(fetchImpl, url, options.token);
      if (!Array.isArray(payload)) {
        throw new Error(`unexpected GitHub response for ${url}: expected an array`);
      }
      for (const raw of payload) {
        const pr = toMergedPullRequest(repo, raw);
        if (pr === null) continue;
        if (options.since !== undefined && pr.mergedAt < options.since) continue;
        merged.push(pr);
      }
      if (payload.length < PER_PAGE) break;
    }
    options.onProgress?.(`read ${merged.length} merged pull request(s) so far...`);
  }

  return merged.slice(0, maxPrs);
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
