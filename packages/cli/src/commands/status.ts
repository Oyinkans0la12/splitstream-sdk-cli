import {
  SplitStreamClient,
  formatTokenAmount,
  formatTokenAmountWithSeparators,
  truncateAddress,
  type Manifest,
  type VestingInfo,
} from '@splitstream/sdk';
import type { Command } from 'commander';

import { loadConfig, networkLabel, requireChainConfig } from '../config.js';
import { discoverManifestCycleIds, loadManifest } from '../manifest.js';
import { heading, label, note, renderTable, warn } from '../output.js';

/**
 * `splitstream status` - reads the chain and renders an operator view.
 *
 * With `--contributor` it shows that account's claimable amount, vesting
 * schedule and per-cycle claim status. Without one it shows the maintainer
 * aggregate: the vault reserve, the recent cycle roots, and (when a manifest is
 * available locally) the last cycle's distribution summary.
 *
 * It deliberately never enumerates contributors from the chain: the contract
 * does not expose a contributor list, so doing so would be a lie.
 */

export interface StatusFlags {
  contributor?: string;
  cycle?: string;
  cycles?: string;
  manifest?: string;
  repo?: string;
  ref?: string;
  json?: boolean;
  verbose?: boolean;
}

export interface CycleStatus {
  readonly cycleId: number;
  /** Lowercase hex, or null when the cycle has not been posted. */
  readonly root: string | null;
  /** Whether the queried contributor has claimed, or null without one. */
  readonly hasClaimed: boolean | null;
}

export interface ContributorStatus {
  readonly address: string;
  /** Amount sitting in the vault, claimed but not yet withdrawn. */
  readonly balance: bigint;
  readonly vesting: VestingInfo | null;
  readonly claimedCycles: readonly number[];
  readonly pendingCycles: readonly number[];
}

export interface ManifestSummary {
  readonly source: string;
  readonly cycleId: number;
  readonly poolAmount: bigint;
  readonly totalPoints: number;
  readonly contributorCount: number;
  readonly dust: bigint;
  readonly manifest: Manifest;
}

export interface StatusResult {
  readonly network: string;
  readonly rpcUrl: string;
  readonly vaultContractId: string;
  readonly tokenContractId: string;
  readonly tokenDecimals: number;
  readonly reserveBalance: bigint;
  readonly cycles: readonly CycleStatus[];
  readonly contributor: ContributorStatus | null;
  readonly manifest: ManifestSummary | null;
}

/**
 * Chooses which cycles to query.
 *
 * The vault does not expose a cycle counter through the SDK surface, so the
 * anchor comes from the local `manifests/` directory when there is one, and
 * falls back to counting up from cycle 1. `--cycle` pins it exactly.
 */
export function resolveCycleIds(flags: StatusFlags, cwd: string = process.cwd()): number[] {
  if (flags.cycle !== undefined) {
    const parsed = Number.parseInt(flags.cycle, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`--cycle must be a non-negative integer, received "${flags.cycle}"`);
    }
    return [parsed];
  }

  const count = flags.cycles === undefined ? 5 : Number.parseInt(flags.cycles, 10);
  if (!Number.isInteger(count) || count <= 0 || count > 200) {
    throw new Error(`--cycles must be an integer between 1 and 200, received "${flags.cycles}"`);
  }

  const known = discoverManifestCycleIds(cwd);
  const anchor = known.length > 0 ? (known[known.length - 1] as number) : count;

  const ids: number[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const id = anchor - offset;
    if (id >= 0) ids.push(id);
  }
  return ids;
}

/** Reads everything `status` prints. Separated from printing so it is testable. */
export async function collectStatus(
  client: SplitStreamClient,
  flags: StatusFlags,
  meta: { network: string; rpcUrl: string; vaultContractId: string; tokenContractId: string },
  cwd: string = process.cwd(),
): Promise<StatusResult> {
  const tokenDecimals = await client.getTokenDecimals();
  const reserveBalance = await client.getReserveBalance();
  const cycleIds = resolveCycleIds(flags, cwd);

  const cycles: CycleStatus[] = [];
  for (const cycleId of cycleIds) {
    const root = await client.getCycleRoot(cycleId);
    const hasClaimed =
      root !== null && flags.contributor ? await client.hasClaimed(cycleId, flags.contributor) : null;
    cycles.push({ cycleId, root, hasClaimed });
  }

  let contributor: ContributorStatus | null = null;
  if (flags.contributor) {
    const [balance, vesting] = await Promise.all([
      client.getBalance(flags.contributor),
      client.getVesting(flags.contributor),
    ]);
    contributor = {
      address: flags.contributor,
      balance,
      vesting,
      claimedCycles: cycles.filter((entry) => entry.hasClaimed === true).map((entry) => entry.cycleId),
      pendingCycles: cycles
        .filter((entry) => entry.root !== null && entry.hasClaimed === false)
        .map((entry) => entry.cycleId),
    };
  }

  let manifest: ManifestSummary | null = null;
  try {
    const anchoredCycle = cycles[cycles.length - 1]?.cycleId ?? 0;
    const loaded = await loadManifest({
      cycleId: anchoredCycle,
      ...(flags.manifest ? { manifestPath: flags.manifest } : {}),
      ...(flags.repo ? { repo: flags.repo } : {}),
      ...(flags.ref ? { gitRef: flags.ref } : {}),
    });
    manifest = {
      source: loaded.source,
      cycleId: loaded.manifest.cycleId,
      poolAmount: loaded.manifest.poolAmount,
      totalPoints: loaded.manifest.totalPoints,
      contributorCount: loaded.manifest.contributors.length,
      dust: loaded.manifest.dust,
      manifest: loaded.manifest,
    };
  } catch {
    // A manifest is optional context, not a prerequisite for status.
    manifest = null;
  }

  return {
    ...meta,
    tokenDecimals,
    reserveBalance,
    cycles,
    contributor,
    manifest,
  };
}

function shortRoot(root: string | null): string {
  return root === null ? '-' : `${root.slice(0, 10)}...${root.slice(-8)}`;
}

export function printStatus(result: StatusResult): void {
  const decimals = result.tokenDecimals;

  process.stdout.write(`\n${heading(`SplitStream status - ${result.network}`)}\n`);
  process.stdout.write(`${label('rpc:')} ${result.rpcUrl}\n`);
  process.stdout.write(`${label('vault:')} ${result.vaultContractId}\n`);
  process.stdout.write(`${label('token:')} ${result.tokenContractId}\n\n`);

  process.stdout.write(
    `${heading('Vault reserve')}\n${renderTable(
      ['metric', 'value'],
      [
        ['unallocated reserve', formatTokenAmountWithSeparators(result.reserveBalance, decimals)],
        ['token decimals', String(decimals)],
      ],
    )}\n\n`,
  );

  process.stdout.write(`${heading('Cycle distributions')}\n`);
  if (result.cycles.length === 0) {
    process.stdout.write(note('no cycles to show\n\n'));
  } else {
    process.stdout.write(
      `${renderTable(
        ['cycle', 'status', 'root', ...(result.contributor ? ['claimed'] : [])],
        result.cycles.map((cycle) => [
          String(cycle.cycleId),
          cycle.root === null ? 'not posted' : 'posted',
          shortRoot(cycle.root),
          ...(result.contributor
            ? [cycle.hasClaimed === null ? '-' : cycle.hasClaimed ? 'yes' : 'no']
            : []),
        ]),
      )}\n\n`,
    );
  }

  if (result.contributor) {
    const vesting = result.contributor.vesting;
    const vestingText =
      vesting === null
        ? 'none'
        : `${formatTokenAmount(vesting.total - vesting.claimed, decimals)} unvested of ` +
          `${formatTokenAmount(vesting.total, decimals)} (starts at ledger ${vesting.startLedger}, ` +
          `${vesting.durationLedgers} ledgers)`;

    process.stdout.write(
      `${heading(`Contributor ${truncateAddress(result.contributor.address)}`)}\n${renderTable(
        ['metric', 'value'],
        [
          ['claimable in vault', formatTokenAmountWithSeparators(result.contributor.balance, decimals)],
          ['vesting', vestingText],
          [
            'pending claimable cycles',
            result.contributor.pendingCycles.length === 0
              ? 'none'
              : result.contributor.pendingCycles.join(', '),
          ],
          [
            'already claimed cycles',
            result.contributor.claimedCycles.length === 0
              ? 'none'
              : result.contributor.claimedCycles.join(', '),
          ],
        ],
      )}\n\n`,
    );
  }

  if (result.manifest) {
    process.stdout.write(
      `${heading(`Last known cycle ${result.manifest.cycleId}`)}\n${renderTable(
        ['metric', 'value'],
        [
          ['manifest', result.manifest.source],
          ['pool funded', formatTokenAmountWithSeparators(result.manifest.poolAmount, decimals)],
          ['contributors', String(result.manifest.contributorCount)],
          ['total points', String(result.manifest.totalPoints)],
          ['dust', formatTokenAmountWithSeparators(result.manifest.dust, decimals)],
        ],
      )}\n`,
    );
    process.stdout.write(
      note(
        `Run \`splitstream report --cycle ${result.manifest.cycleId} --manifest <path>\` for the per-contributor breakdown.\n\n`,
      ),
    );
  } else {
    process.stdout.write(
      warn(
        'no local manifest found, so only chain state is shown. Contributor-level breakdowns come from ' +
          'the manifest, not the contract (the contract does not expose a contributor list).',
      ) + '\n',
    );
  }
}

/** JSON-safe projection of a status result. */
export function serializeStatus(result: StatusResult): string {
  return JSON.stringify(
    {
      ...result,
      reserveBalance: result.reserveBalance.toString(),
      manifest: result.manifest
        ? {
            source: result.manifest.source,
            cycleId: result.manifest.cycleId,
            poolAmount: result.manifest.poolAmount.toString(),
            totalPoints: result.manifest.totalPoints,
            contributorCount: result.manifest.contributorCount,
            dust: result.manifest.dust.toString(),
          }
        : null,
      contributor: result.contributor
        ? {
            ...result.contributor,
            balance: result.contributor.balance.toString(),
            vesting: result.contributor.vesting
              ? {
                  total: result.contributor.vesting.total.toString(),
                  claimed: result.contributor.vesting.claimed.toString(),
                  startLedger: result.contributor.vesting.startLedger,
                  durationLedgers: result.contributor.vesting.durationLedgers,
                }
              : null,
          }
        : null,
    },
    null,
    2,
  );
}

/** Registers `splitstream status`. */
export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('show vault reserve, recent cycle distributions and a contributor position')
    .option('--contributor <G...>', 'contributor address to report on')
    .option('--cycle <id>', 'show a single cycle instead of a range')
    .option('--cycles <n>', 'how many recent cycles to show', '5')
    .option('--manifest <path>', 'manifest supplying the last cycle summary')
    .option('--repo <owner/name>', 'repository to fetch the manifest from')
    .option('--ref <ref>', 'git ref to read manifests from', 'main')
    .option('--json', 'print the result as JSON instead of tables')
    .option('--rpc-url <url>', 'override SPLITSTREAM_RPC_URL')
    .option('--network-passphrase <passphrase>', 'override SPLITSTREAM_NETWORK_PASSPHRASE')
    .option('--vault <id>', 'override SPLITSTREAM_VAULT_CONTRACT_ID')
    .option('--token <id>', 'override SPLITSTREAM_TOKEN_CONTRACT_ID')
    .action(async (options: StatusFlags & Record<string, string | undefined>) => {
      const config = loadConfig({
        verbose: options.verbose === true,
        ...(options['rpc-url'] ? { rpcUrl: options['rpc-url'] } : {}),
        ...(options['network-passphrase'] ? { networkPassphrase: options['network-passphrase'] } : {}),
        ...(options.vault ? { vaultContractId: options.vault } : {}),
        ...(options.token ? { tokenContractId: options.token } : {}),
      });
      const chain = requireChainConfig(config);
      const client = new SplitStreamClient(chain);

      const result = await collectStatus(client, options, {
        network: networkLabel(chain.networkPassphrase),
        rpcUrl: chain.rpcUrl,
        vaultContractId: chain.vaultContractId,
        tokenContractId: chain.tokenContractId,
      });

      if (options.json) {
        process.stdout.write(`${serializeStatus(result)}\n`);
        return;
      }
      printStatus(result);
    });
}
