import { readFileSync } from 'node:fs';

import {
  formatTokenAmountWithSeparators,
  parseTokenAmount,
  truncateAddress,
} from '@splitstream/sdk';
import type { Command } from 'commander';
import chalk from 'chalk';

import { loadConfig } from '../config.js';
import {
  countIssuesByContributor,
  estimateAllocations,
  estimatePostCycleRootCost,
  fetchMergedPullRequests,
  inferRepoSlug,
  parseRepoSlug,
  type CostEstimate,
  type EstimatedAllocation,
  type MergedPullRequest,
} from '../contributions.js';
import { loadManifest } from '../manifest.js';
import { heading, label, note, renderTable, warn } from '../output.js';

/**
 * `splitstream simulate` - a dry run that never touches the chain.
 *
 * It reads merged pull requests, counts the distinct issues each contributor
 * closed (the same count-based rule the deployed `splitstream-actions` action
 * uses), and estimates the resulting pro-rata payout plus the cost of the
 * eventual `post_cycle_root` call. No RPC endpoint, no contract ids, no signing.
 *
 * A qualifying issue is any issue closed via a merged PR containing a
 * recognized closing keyword (`Closes #N` / `Fixes #N` / `Resolves #N`,
 * case-insensitive). No label of any kind is read, and every qualifying issue
 * counts equally.
 */

export interface SimulateFlags {
  cycle?: string;
  manifest?: string;
  repo?: string | string[];
  ref?: string;
  since?: string;
  pool?: string;
  decimals?: string;
  map?: string;
  maxPrs?: string;
  json?: boolean;
  verbose?: boolean;
}

/** The full result of a dry run, independent of any I/O. */
export interface SimulationResult {
  readonly repos: readonly string[];
  readonly cycleId: number | null;
  readonly poolAmount: bigint;
  readonly tokenDecimals: number;
  readonly totalIssuesClosed: number;
  readonly allocations: readonly EstimatedAllocation[];
  readonly dustRemainder: bigint;
  readonly cost: CostEstimate;
  readonly unmappedContributors: readonly string[];
  readonly mergedPullRequests: number;
  /** Lower bound on `merged_at`, when a window was applied. */
  readonly since: string | null;
}

/** Computes everything `simulate` prints. Pure: takes the PRs as input. */
export function buildSimulation(input: {
  repos: readonly string[];
  pullRequests: readonly MergedPullRequest[];
  poolAmount: bigint;
  tokenDecimals: number;
  cycleId: number | null;
  since?: string;
  addressByHandle?: Readonly<Record<string, string>>;
  recordsPerContributor?: boolean;
}): SimulationResult {
  const contributors = countIssuesByContributor(input.pullRequests);
  const { allocations, dustRemainder, totalIssuesClosed } = estimateAllocations(
    contributors,
    input.poolAmount,
    input.addressByHandle ?? {},
  );

  return {
    repos: input.repos,
    cycleId: input.cycleId,
    poolAmount: input.poolAmount,
    tokenDecimals: input.tokenDecimals,
    totalIssuesClosed,
    allocations,
    dustRemainder,
    cost: estimatePostCycleRootCost(
      contributors.length,
      input.recordsPerContributor === undefined
        ? {}
        : { recordsPerContributor: input.recordsPerContributor },
    ),
    unmappedContributors: allocations.filter((entry) => entry.address === null).map((e) => e.github),
    mergedPullRequests: input.pullRequests.length,
    since: input.since ?? null,
  };
}

/** Reads a `{ "handle": "G..." }` address map, when one is supplied. */
export function readAddressMap(path: string | undefined): Record<string, string> {
  if (!path) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`the address map at ${path} must be a JSON object of handle -> Stellar address`);
  }
  const map: Record<string, string> = {};
  for (const [handle, address] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof address !== 'string') {
      throw new Error(`the address map at ${path} has a non-string address for "${handle}"`);
    }
    map[handle] = address;
  }
  return map;
}

function parsePositiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received "${value}"`);
  }
  return parsed;
}

function parseDecimals(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 38) {
    throw new Error(`--decimals must be an integer between 0 and 38, received "${value}"`);
  }
  return parsed;
}

/** Collects repeated `--repo` flags into one list. */
export function collectRepos(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function requestedRepos(flags: SimulateFlags): string[] {
  const raw = flags.repo === undefined ? [] : Array.isArray(flags.repo) ? flags.repo : [flags.repo];
  if (raw.length > 0) {
    return raw.map((entry) => {
      const slug = parseRepoSlug(entry);
      if (!slug) throw new Error(`--repo must look like "owner/name", received "${entry}"`);
      return slug;
    });
  }
  const inferred = inferRepoSlug();
  if (!inferred) {
    throw new Error(
      'could not determine the repository. Pass --repo owner/name (no network calls are made by simulate).',
    );
  }
  return [inferred];
}

/**
 * The cycle window's lower bound.
 *
 * An explicit `--since` wins. Otherwise, for cycle *N* the boundary is the
 * `generatedAt` of cycle *N-1*'s manifest - the same source of truth
 * splitstream-actions uses. When that manifest cannot be read, no window is
 * applied and every merged PR is considered.
 */
async function resolveSince(
  flags: SimulateFlags,
  cycleId: number | null,
  repos: readonly string[],
): Promise<string | undefined> {
  if (flags.since !== undefined) {
    if (Number.isNaN(Date.parse(flags.since))) {
      throw new Error(`--since must be a valid ISO 8601 timestamp, received "${flags.since}"`);
    }
    return flags.since;
  }
  if (cycleId === null || cycleId <= 0) return undefined;
  try {
    const previous = await loadManifest({
      cycleId: cycleId - 1,
      ...(repos[0] ? { repo: repos[0] } : {}),
      ...(flags.ref ? { gitRef: flags.ref } : {}),
    });
    return previous.manifest.generatedAt === '' ? undefined : previous.manifest.generatedAt;
  } catch {
    return undefined;
  }
}

export async function runSimulate(flags: SimulateFlags): Promise<SimulationResult> {
  const config = loadConfig({ verbose: flags.verbose === true });
  const repos = requestedRepos(flags);

  let cycleId: number | null = null;
  let poolAmount: bigint | null = null;

  if (flags.cycle !== undefined) {
    const parsed = Number.parseInt(flags.cycle, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`--cycle must be a non-negative integer, received "${flags.cycle}"`);
    }
    cycleId = parsed;
  }

  // A manifest supplies the cycle id and pool. It never supplies token
  // decimals: those belong to the token contract, which simulate never reads.
  if (flags.manifest || cycleId !== null) {
    try {
      const loaded = await loadManifest({
        cycleId: cycleId ?? 0,
        ...(flags.manifest ? { manifestPath: flags.manifest } : {}),
        ...(repos[0] ? { repo: repos[0] } : {}),
        ...(flags.ref ? { gitRef: flags.ref } : {}),
      });
      cycleId = loaded.manifest.cycleId;
      poolAmount = loaded.manifest.poolAmount;
      process.stderr.write(
        note(`Using manifest ${loaded.source} (cycle ${loaded.manifest.cycleId}).\n`),
      );
    } catch (error) {
      if (flags.manifest) throw error;
    }
  }

  const tokenDecimals = parseDecimals(flags.decimals) ?? 7;

  if (flags.pool !== undefined) {
    poolAmount = parseTokenAmount(flags.pool, tokenDecimals);
  }

  if (poolAmount === null) {
    throw new Error(
      'no pool amount known. Pass --pool <amount> (whole tokens) or --manifest <path> to read it from a cycle manifest.',
    );
  }

  const since = await resolveSince(flags, cycleId, repos);
  const maxPrs = parsePositiveInt(flags.maxPrs, '--max-prs') ?? 300;

  const pullRequests = await fetchMergedPullRequests({
    repos,
    ...(since ? { since } : {}),
    ...(config.githubToken ? { token: config.githubToken } : {}),
    maxPrs,
    onProgress: (message) => process.stderr.write(note(`${message}\n`)),
  });

  const addressByHandle = readAddressMap(flags.map);

  return buildSimulation({
    repos,
    pullRequests,
    poolAmount,
    tokenDecimals,
    cycleId,
    ...(since ? { since } : {}),
    ...(Object.keys(addressByHandle).length > 0 ? { addressByHandle } : {}),
  });
}

function printSimulation(result: SimulationResult): void {
  const decimals = result.tokenDecimals;
  process.stdout.write(`\n${heading(`Simulation - ${result.repos.join(', ')}`)}\n`);
  process.stdout.write(
    `${label('cycle:')} ${result.cycleId ?? 'unreleased'}   ` +
      `${label('pool:')} ${formatTokenAmountWithSeparators(result.poolAmount, decimals)}\n`,
  );
  process.stdout.write(
    `${label('window since:')} ${result.since ?? 'all merged PRs'}   ` +
      `${label('merged PRs:')} ${result.mergedPullRequests}\n`,
  );
  process.stdout.write(`${label('issues closed:')} ${result.totalIssuesClosed}\n\n`);

  if (result.allocations.length === 0) {
    process.stdout.write(
      warn('no merged pull request closed an issue with a closing keyword; nothing to simulate.\n'),
    );
    return;
  }

  const rows = result.allocations.map((entry, index) => [
    String(index + 1),
    `@${entry.github}`,
    entry.address ? truncateAddress(entry.address) : chalk.yellow('unmapped'),
    String(entry.issuesClosed),
    `${entry.sharePercent}%`,
    formatTokenAmountWithSeparators(entry.amount, decimals),
  ]);

  process.stdout.write(
    `${renderTable(
      ['#', 'contributor', 'stellar address', 'issues closed', 'share', 'est. amount'],
      rows,
    )}\n`,
  );

  process.stdout.write(
    `\n${label('dust remainder:')} ${formatTokenAmountWithSeparators(result.dustRemainder, decimals)}\n`,
  );

  if (result.unmappedContributors.length > 0) {
    process.stdout.write(
      warn(
        `${result.unmappedContributors.length} contributor(s) have no Stellar address: ` +
          `${result.unmappedContributors.map((handle) => `@${handle}`).join(', ')}. ` +
          'Pass --map handles.json to resolve them before the cycle is posted.',
      ) + '\n',
    );
  }

  process.stdout.write(`\n${heading('Estimated post_cycle_root cost')}\n`);
  process.stdout.write(
    renderTable(
      ['metric', 'estimate'],
      [
        ['instructions', result.cost.instructions.toLocaleString('en-US')],
        ['ledger-entry reads', String(result.cost.readEntries)],
        ['ledger-entry writes', String(result.cost.writeEntries)],
        ['classic fee', `${result.cost.classicFeeStroops.toString()} stroops`],
        ['resource fee', `${result.cost.resourceFeeStroops.toString()} stroops`],
        ['total', `${result.cost.totalStroops.toString()} stroops (${result.cost.totalXlm} XLM)`],
      ],
    ) + '\n',
  );
  process.stdout.write(note('Assumptions:\n'));
  for (const assumption of result.cost.assumptions) {
    process.stdout.write(note(`  - ${assumption}\n`));
  }
  process.stdout.write(
    note('\nThis is an estimate to plan with; the authoritative fee comes from simulating the real transaction.\n'),
  );
}

/** Registers `splitstream simulate`. */
export function registerSimulateCommand(program: Command): void {
  program
    .command('simulate')
    .description('dry-run payout calculations against merged PRs (never touches the chain)')
    .option('--cycle <id>', 'cycle id to simulate')
    .option('--manifest <path>', 'read cycle id and pool from a manifest file')
    .option(
      '--repo <owner/name>',
      'repository to read merged pull requests from (repeatable; defaults to origin)',
      collectRepos,
      [],
    )
    .option('--ref <ref>', 'git ref to read manifests from when --repo is remote', 'main')
    .option('--since <iso>', 'cycle window lower bound (ISO 8601); defaults to the previous cycle manifest')
    .option('--pool <amount>', 'pool size in whole tokens (overrides the manifest)')
    .option('--decimals <n>', 'token decimals for display and --pool parsing', '7')
    .option('--map <path>', 'JSON map of github handle -> Stellar address')
    .option('--max-prs <n>', 'maximum number of merged pull requests to consider', '300')
    .option('--json', 'print the result as JSON instead of a table')
    .action(async (options: SimulateFlags) => {
      const result = await runSimulate(options);
      if (options.json) {
        process.stdout.write(`${serializeSimulation(result)}\n`);
        return;
      }
      printSimulation(result);
    });
}

/** JSON-safe projection of a simulation result (bigints become strings). */
export function serializeSimulation(result: SimulationResult): string {
  return JSON.stringify(
    {
      repos: result.repos,
      cycleId: result.cycleId,
      poolAmount: result.poolAmount.toString(),
      tokenDecimals: result.tokenDecimals,
      totalIssuesClosed: result.totalIssuesClosed,
      dustRemainder: result.dustRemainder.toString(),
      mergedPullRequests: result.mergedPullRequests,
      since: result.since,
      allocations: result.allocations.map((entry) => ({
        github: entry.github,
        address: entry.address,
        issuesClosed: entry.issuesClosed,
        sharePercent: entry.sharePercent,
        amount: entry.amount.toString(),
      })),
      unmappedContributors: result.unmappedContributors,
      cost: {
        ...result.cost,
        classicFeeStroops: result.cost.classicFeeStroops.toString(),
        resourceFeeStroops: result.cost.resourceFeeStroops.toString(),
        totalStroops: result.cost.totalStroops.toString(),
      },
    },
    null,
    2,
  );
}
