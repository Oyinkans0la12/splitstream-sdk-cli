import { formatTokenAmount, truncateAddress, type Manifest } from '@splitstream/sdk';
import { writeFileSync } from 'node:fs';

/**
 * Transparency report generation.
 *
 * The output is plain markdown with no embedded HTML, so it renders correctly
 * in GitHub release notes, PR descriptions, and issue comments.
 */

/** Filename written when the caller does not pass `--out`. */
export const DEFAULT_REPORT_PATH = 'SPLITSTREAM_REPORT.md';

/** One contributor's row in the report. */
export interface ReportEntry {
  readonly github: string;
  readonly address: string;
  readonly points: number;
  /** Amount in base units. */
  readonly amount: bigint;
  readonly claimed: boolean;
}

/** Everything the report needs. */
export interface ReportInput {
  readonly manifest: Manifest;
  readonly entries: readonly ReportEntry[];
  /** Address the payouts come from, for verification. */
  readonly vaultContractId: string;
  /** Human-readable network name, e.g. `testnet`. */
  readonly network: string;
  /** Payout token symbol, when known. */
  readonly tokenSymbol?: string;
  /** Timestamp to stamp on the report; defaults to now. */
  readonly generatedAt?: Date;
  /** stellar.expert account link for the vault, when the network is known. */
  readonly accountExplorerUrl?: string | null;
}

const TRUNCATION_LEADING = 6;
const TRUNCATION_TRAILING = 6;

/** Escapes the characters that would break a markdown table cell. */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Renders the report as a markdown string. */
export function generateReport(input: ReportInput): string {
  const { manifest } = input;
  const decimals = manifest.tokenDecimals;
  const unit = input.tokenSymbol ?? 'tokens';
  const generatedAt = (input.generatedAt ?? new Date()).toISOString();

  const sorted = [...input.entries].sort(
    (a, b) => b.points - a.points || a.github.localeCompare(b.github),
  );

  const totalPaid = sorted.filter((entry) => entry.claimed).reduce((sum, entry) => sum + entry.amount, 0n);
  const totalAllocated = sorted.reduce((sum, entry) => sum + entry.amount, 0n);
  const claimedCount = sorted.filter((entry) => entry.claimed).length;

  const lines: string[] = [];

  lines.push(`# SplitStream payout report - cycle ${manifest.cycleId}`);
  lines.push('');
  lines.push(
    `Generated ${generatedAt} from manifest root \`${manifest.root}\`.`,
  );
  lines.push('');
  lines.push('## Cycle summary');
  lines.push('');
  lines.push(`- **Network:** ${input.network}`);
  lines.push(`- **Vault contract:** \`${input.vaultContractId}\``);
  lines.push(`- **Pool funded:** ${formatTokenAmount(manifest.poolAmount, decimals)} ${unit}`);
  lines.push(`- **Contributors:** ${sorted.length}`);
  lines.push(`- **Total points:** ${manifest.totalPoints}`);
  lines.push(`- **Allocated:** ${formatTokenAmount(totalAllocated, decimals)} ${unit}`);
  lines.push(`- **Claimed so far:** ${formatTokenAmount(totalPaid, decimals)} ${unit} (${claimedCount}/${sorted.length} contributors)`);
  lines.push(`- **Dust remainder:** ${formatTokenAmount(manifest.dust, decimals)} ${unit}`);
  lines.push('');

  lines.push('## Allocations');
  lines.push('');
  lines.push('| GitHub | Stellar address | Points | Amount | Claimed |');
  lines.push('| --- | --- | ---: | ---: | :---: |');
  for (const entry of sorted) {
    lines.push(
      `| @${cell(entry.github)} | \`${truncateAddress(entry.address, TRUNCATION_LEADING, TRUNCATION_TRAILING)}\` | ` +
        `${entry.points} | ${formatTokenAmount(entry.amount, decimals)} | ${entry.claimed ? 'yes' : 'no'} |`,
    );
  }
  lines.push('');

  if (manifest.dust > 0n) {
    lines.push(
      `> ${formatTokenAmount(manifest.dust, decimals)} ${unit} of dust remains in the vault because the pool ` +
        'does not divide evenly across the allocated points. It stays available for the next cycle.',
    );
    lines.push('');
  }

  lines.push('## Verify this report');
  lines.push('');
  lines.push(
    'Every row is derived from the cycle manifest and the vault contract, so anyone can reproduce it:',
  );
  lines.push('');
  lines.push('```bash');
  lines.push(`splitstream status --cycle ${manifest.cycleId} --manifest <path-to-manifest.json>`);
  lines.push('```');
  lines.push('');
  if (input.accountExplorerUrl) {
    lines.push(`Vault: ${input.accountExplorerUrl}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

/** Writes the report to disk. */
export function writeReport(path: string, content: string): void {
  writeFileSync(path, content, 'utf8');
}
