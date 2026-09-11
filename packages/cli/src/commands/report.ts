import { SplitStreamClient } from '@splitstream/sdk';
import type { Command } from 'commander';

import { explorerContractUrl, loadConfig, networkLabel, requireChainConfig } from '../config.js';
import { loadManifest } from '../manifest.js';
import { heading, note } from '../output.js';
import { DEFAULT_REPORT_PATH, generateReport, writeReport, type ReportEntry } from '../report.js';

/** `splitstream report` - generates the per-cycle transparency report. */

export interface ReportFlags {
  cycle?: string;
  manifest?: string;
  repo?: string;
  ref?: string;
  out?: string;
  concurrency?: string;
  stdout?: boolean;
  verbose?: boolean;
  rpcUrl?: string;
  networkPassphrase?: string;
  vault?: string;
  token?: string;
}

/** Runs `fn` over `items` with a bounded number of in-flight promises. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });

  await Promise.all(workers);
  return results;
}

function parseCycleId(value: string | undefined): number {
  if (value === undefined) {
    throw new Error('--cycle <id> is required to generate a report');
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--cycle must be a non-negative integer, received "${value}"`);
  }
  return parsed;
}

export async function runReport(flags: ReportFlags): Promise<{ path: string | null; content: string }> {
  const config = loadConfig({
    verbose: flags.verbose === true,
    ...(flags.rpcUrl ? { rpcUrl: flags.rpcUrl } : {}),
    ...(flags.networkPassphrase ? { networkPassphrase: flags.networkPassphrase } : {}),
    ...(flags.vault ? { vaultContractId: flags.vault } : {}),
    ...(flags.token ? { tokenContractId: flags.token } : {}),
  });
  const chain = requireChainConfig(config);
  const cycleId = parseCycleId(flags.cycle);

  const loaded = await loadManifest({
    cycleId,
    ...(flags.manifest ? { manifestPath: flags.manifest } : {}),
    ...(flags.repo ? { repo: flags.repo } : {}),
    ...(flags.ref ? { gitRef: flags.ref } : {}),
  });

  const client = new SplitStreamClient(chain);
  const concurrency = flags.concurrency === undefined ? 5 : Number.parseInt(flags.concurrency, 10);
  if (!Number.isInteger(concurrency) || concurrency <= 0 || concurrency > 20) {
    throw new Error(`--concurrency must be an integer between 1 and 20, received "${flags.concurrency}"`);
  }

  process.stdout.write(
    note(
      `Reading claim status for ${loaded.manifest.contributors.length} contributors ` +
        `(${concurrency} at a time)...\n`,
    ),
  );

  const entries: ReportEntry[] = await mapWithConcurrency(
    loaded.manifest.contributors,
    concurrency,
    async (contributor) => ({
      github: contributor.github,
      address: contributor.address,
      points: contributor.points,
      amount: contributor.amount,
      claimed: await client.hasClaimed(loaded.manifest.cycleId, contributor.address),
    }),
  );

  const content = generateReport({
    manifest: loaded.manifest,
    entries,
    vaultContractId: chain.vaultContractId,
    network: networkLabel(chain.networkPassphrase),
    generatedAt: new Date(),
    accountExplorerUrl: explorerContractUrl(chain.networkPassphrase, chain.vaultContractId),
  });

  if (flags.stdout === true) {
    return { path: null, content };
  }

  const path = flags.out ?? DEFAULT_REPORT_PATH;
  writeReport(path, content);
  return { path, content };
}

/** Registers `splitstream report`. */
export function registerReportCommand(program: Command): void {
  program
    .command('report')
    .description('generate SPLITSTREAM_REPORT.md for a cycle (markdown transparency report)')
    .requiredOption('--cycle <id>', 'cycle to report on')
    .option('--manifest <path>', 'manifest file for the cycle')
    .option('--repo <owner/name>', 'repository to fetch the manifest from')
    .option('--ref <ref>', 'git ref to read manifests from', 'main')
    .option('--out <path>', 'output path', DEFAULT_REPORT_PATH)
    .option('--concurrency <n>', 'parallel contract reads', '5')
    .option('--stdout', 'print the report instead of writing it to disk')
    .option('--rpc-url <url>', 'override SPLITSTREAM_RPC_URL')
    .option('--network-passphrase <passphrase>', 'override SPLITSTREAM_NETWORK_PASSPHRASE')
    .option('--vault <id>', 'override SPLITSTREAM_VAULT_CONTRACT_ID')
    .option('--token <id>', 'override SPLITSTREAM_TOKEN_CONTRACT_ID')
    .action(async (options: ReportFlags) => {
      const result = await runReport(options);
      if (result.path === null) {
        process.stdout.write(result.content);
        return;
      }
      const claimed = result.content.split('\n').filter((line) => line.endsWith('| yes |')).length;
      process.stdout.write(`\n${heading('Report written')}\n`);
      process.stdout.write(`  path: ${result.path}\n`);
      process.stdout.write(`  contributors marked claimed: ${claimed}\n`);
    });
}
