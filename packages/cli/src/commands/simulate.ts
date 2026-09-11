import { readFileSync } from 'node:fs';

import {
  formatTokenAmountWithSeparators,
  parseTokenAmount,
  truncateAddress,
} from '@splitstream/sdk';
import type { Command } from 'commander';
import chalk from 'chalk';

import { loadConfig } from '../config.js';
import { loadManifest } from '../manifest.js';
import { heading, label, note, renderTable, warn } from '../output.js';
import {
  DEFAULT_POINTS_RULES,
  estimateAllocations,
  estimatePostCycleRootCost,
  fetchPullRequests,
  inferRepoSlug,
  parseRepoSlug,
  summarizeByContributor,
  type CostEstimate,
  type EstimatedAllocation,
  type PullRequestSummary,
} from '../points.js';

/**
 * `splitstream simulate` - a dry run that never touches the chain.
 *
 * It reads pull requests, applies the documented points rules, and estimates
 * the resulting pro-rata payout plus the cost of the eventual
 * `post_cycle_root` call. No RPC endpoint, no contract ids, no signing.
 */

export interface SimulateFlags {
  cycle?: string;
  manifest?: string;
  repo?: string;
  ref?: string;
  pool?: string;
  decimals?: string;
  map?: string;
  maxPrs?: string;
  json?: boolean;
  verbose?: boolean;
}

/** The full result of a dry run, independent of any I/O. */
export interface SimulationResult {
  readonly repo: string;
  readonly cycleId: number | null;
  readonly poolAmount: bigint;
  readonly tokenDecimals: number;
  readonly totalPoints: number;
  readonly allocations: readonly EstimatedAllocation[];
  readonly dust: bigint;
  readonly cost: CostEstimate;
  readonly unmappedContributors: readonly string[];
  readonly openPullRequests: number;
  readonly mergedPullRequests: number;
}

/** Computes everything `simulate` prints. Pure: takes the PRs as input. */
export function buildSimulation(input: {
  repo: string;
  pullRequests: readonly PullRequestSummary[];
  poolAmount: bigint;
  tokenDecimals: number;
  cycleId: number | null;
  addressByHandle?: Readonly<Record<string, string>>;
  recordsPerContributor?: boolean;
}): SimulationResult {
  const contributors = summarizeByContributor(input.pullRequests, DEFAULT_POINTS_RULES);
  const { allocations, dust, totalPoints } = estimateAllocations(
    contributors,
    input.poolAmount,
    input.addressByHandle ?? {},
  );

  return {
    repo: input.repo,
    cycleId: input.cycleId,
    poolAmount: input.poolAmount,
    tokenDecimals: input.tokenDecimals,
    totalPoints,
    allocations,
    dust,
    cost: estimatePostCycleRootCost(
      contributors.length,
      input.recordsPerContributor === undefined
        ? {}
        : { recordsPerContributor: input.recordsPerContributor },
    ),
    unmappedContributors: allocations.filter((entry) => entry.address === null).map((e) => e.github),
    openPullRequests: input.pullRequests.filter((pr) => pr.state === 'open').length,
    mergedPullRequests: input.pullRequests.filter((pr) => pr.merged).length,
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

export async function runSimulate(flags: SimulateFlags): Promise<SimulationResult> {
  const config = loadConfig({ verbose: flags.verbose === true });

  const repoFlag = flags.repo ?? inferRepoSlug();
  if (!repoFlag) {
    throw new Error(
      'could not determine the repository. Pass --repo owner/name (no network calls are made by simulate).',
    );
  }
  const repo = parseRepoSlug(repoFlag);
  if (!repo) {
    throw new Error(`--repo must look like "owner/name", received "${repoFlag}"`);
  }

  let cycleId: number | null = null;
  let tokenDecimals = 7;
  let poolAmount: bigint | null = null;

  if (flags.cycle !== undefined) {
    const parsed = Number.parseInt(flags.cycle, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`--cycle must be a non-negative integer, received "${flags.cycle}"`);
    }
    cycleId = parsed;
  }

  // A manifest supplies the cycle id, decimals and pool, so the simulation
  // reflects the real cycle when one is available.
  if (flags.manifest || cycleId !== null) {
    try {
      const loaded = await loadManifest({
        cycleId: cycleId ?? 0,
        ...(flags.manifest ? { manifestPath: flags.manifest } : {}),
        repo,
        ...(flags.ref ? { gitRef: flags.ref } : {}),
      });
      cycleId = loaded.manifest.cycleId;
      tokenDecimals = loaded.manifest.tokenDecimals;
      poolAmount = loaded.manifest.poolAmount;
      process.stderr.write(
        note(`Using manifest ${loaded.source} (cycle ${loaded.manifest.cycleId}).\n`),
      );
    } catch (error) {
      if (flags.manifest) throw error;
    }
  }

  const decimalsOverride = parseDecimals(flags.decimals);
  if (decimalsOverride !== undefined) {
    tokenDecimals = decimalsOverride;
  }

  if (flags.pool !== undefined) {
    poolAmount = parseTokenAmount(flags.pool, tokenDecimals);
  }

  if (poolAmount === null) {
    throw new Error(
      'no pool amount known. Pass --pool <amount> (whole tokens) or --manifest <path> to read it from a cycle manifest.',
    );
  }

  const maxPrs = parsePositiveInt(flags.maxPrs, '--max-prs') ?? 300;
  const maxPages = Math.max(1, Math.ceil(maxPrs / 100));

  const pullRequests = await fetchPullRequests({
    repo,
    ...(config.githubToken ? { token: config.githubToken } : {}),
    maxPages,
    maxDetailRequests: maxPrs,
    onProgress: (message) => process.stderr.write(note(`${message}\n`)),
  });

  const addressByHandle = readAddressMap(flags.map);

  return buildSimulation({
    repo,
    pullRequests,
    poolAmount,
    tokenDecimals,
    cycleId,
    ...(Object.keys(addressByHandle).length > 0 ? { addressByHandle } : {}),
  });
}

function printSimulation(result: SimulationResult): void {
  const decimals = result.tokenDecimals;
  process.stdout.write(`\n${heading(`Simulation - ${result.repo}`)}\n`);
  process.stdout.write(
    `${label('cycle:')} ${result.cycleId ?? 'unreleased'}   ` +
      `${label('pool:')} ${formatTokenAmountWithSeparators(result.poolAmount, decimals)}\n`,
  );
  process.stdout.write(
    `${label('pull requests:')} ${result.mergedPullRequests} merged, ${result.openPullRequests} open   ` +
      `${label('total points:')} ${result.totalPoints}\n\n`,
  );

  if (result.allocations.length === 0) {
    process.stdout.write(warn('no pull requests were scored; nothing to simulate.\n'));
    return;
  }

  const rows = result.allocations.map((entry, index) => [
    String(index + 1),
    `@${entry.github}`,
    entry.address ? truncateAddress(entry.address) : chalk.yellow('unmapped'),
    String(entry.points),
    `${entry.sharePercent}%`,
    formatTokenAmountWithSeparators(entry.amount, decimals),
  ]);

  process.stdout.write(
    `${renderTable(
      ['#', 'contributor', 'stellar address', 'points', 'share', 'est. amount'],
      rows,
    )}\n`,
  );

  process.stdout.write(
    `\n${label('dust estimate:')} ${formatTokenAmountWithSeparators(result.dust, decimals)}\n`,
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
    .description('dry-run payout calculations against the repo open/merged PRs (never touches the chain)')
    .option('--cycle <id>', 'cycle id to simulate')
    .option('--manifest <path>', 'read cycle id, pool and decimals from a manifest file')
    .option('--repo <owner/name>', 'repository to read pull requests from (defaults to origin)')
    .option('--ref <ref>', 'git ref to read manifests from when --repo is remote', 'main')
    .option('--pool <amount>', 'pool size in whole tokens (overrides the manifest)')
    .option('--decimals <n>', 'token decimals when no manifest is available', '7')
    .option('--map <path>', 'JSON map of github handle -> Stellar address')
    .option('--max-prs <n>', 'maximum number of pull requests to score', '300')
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
      repo: result.repo,
      cycleId: result.cycleId,
      poolAmount: result.poolAmount.toString(),
      tokenDecimals: result.tokenDecimals,
      totalPoints: result.totalPoints,
      dust: result.dust.toString(),
      mergedPullRequests: result.mergedPullRequests,
      openPullRequests: result.openPullRequests,
      allocations: result.allocations.map((entry) => ({
        github: entry.github,
        address: entry.address,
        points: entry.points,
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
