import { SplitStreamClient, buildClaimProof, formatTokenAmount, truncateAddress } from '@splitstream/sdk';
import type { Command } from 'commander';
import chalk from 'chalk';

import {
  explorerTxUrl,
  loadConfig,
  networkLabel,
  requireChainConfig,
  type ChainConfig,
} from '../config.js';
import { loadManifest } from '../manifest.js';
import { heading, note, renderTable, warn } from '../output.js';
import { promptConfirm, promptWalletKind } from '../prompt.js';
import { readLedgerPublicKey, resolveSigner, type Signer, type WalletKind } from '../wallet.js';

/**
 * `splitstream claim` - the two-step pull payment.
 *
 * Step 1 (`credit_claim`) proves the contributor's allocation against the
 * cycle's Merkle root and credits their balance inside the vault. Step 2
 * (`withdraw`) moves the credited balance out to the contributor. They are two
 * separately signed transactions by design, and the command says so rather than
 * hiding the second one.
 */

export interface ClaimFlags {
  cycle?: string;
  manifest?: string;
  repo?: string;
  ref?: string;
  contributor?: string;
  wallet?: string;
  yes?: boolean;
  force?: boolean;
  withdraw?: boolean;
  json?: boolean;
  verbose?: boolean;
  rpcUrl?: string;
  networkPassphrase?: string;
  vault?: string;
  token?: string;
}

/** Everything the claim flow decided, for printing and for tests. */
export interface ClaimPlan {
  readonly chain: ChainConfig;
  readonly contributor: string;
  readonly github: string;
  readonly cycleId: number;
  readonly amount: bigint;
  readonly tokenDecimals: number;
  readonly proof: readonly string[];
  readonly computedRoot: string;
  readonly manifestRoot: string;
  readonly rootMatches: boolean;
  readonly manifestSource: string;
  readonly walletKind: WalletKind;
}

function parseCycleId(value: string | undefined): number {
  if (value === undefined) {
    throw new Error('--cycle <id> is required; there is no way to guess which cycle to claim');
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--cycle must be a non-negative integer, received "${value}"`);
  }
  return parsed;
}

function parseWalletKind(value: string | undefined): WalletKind | undefined {
  if (value === undefined) return undefined;
  if (value === 'local' || value === 'hardware') return value;
  throw new Error(`--wallet must be "local" or "hardware", received "${value}"`);
}

/**
 * Works out which manifest row is being claimed.
 *
 * Precedence: an explicit `--contributor` (address or GitHub handle), then the
 * local testnet key, then the connected hardware device. The last two are
 * matched *against the manifest*, so a wrong key fails here rather than
 * on-chain.
 */
export async function resolveClaimant(options: {
  explicit?: string;
  devSecretKey?: string;
  walletKind?: WalletKind;
  networkPassphrase: string;
}): Promise<string> {
  if (options.explicit) return options.explicit;

  if (options.walletKind !== 'hardware' && options.devSecretKey) {
    const { createLocalSigner } = await import('../wallet.js');
    const signer = createLocalSigner(options.devSecretKey, options.networkPassphrase);
    return signer.getPublicKey();
  }

  return readLedgerPublicKey();
}

async function submitTransaction(
  client: SplitStreamClient,
  signer: Signer,
  transaction: Awaited<ReturnType<SplitStreamClient['buildClaimTx']>>,
): Promise<string> {
  const signedXdr = await signer.sign(transaction);
  process.stdout.write(note(`Signed by ${signer.label}; submitting...\n`));
  const result = await client.submitSigned(signedXdr);
  return result.hash;
}

function printHash(networkPassphrase: string, hash: string): void {
  const url = explorerTxUrl(networkPassphrase, hash);
  process.stdout.write(`${chalk.green('transaction')} ${hash}\n`);
  process.stdout.write(url === null ? note('no block explorer known for this network\n') : `${url}\n`);
}

/** Injectable pieces of the claim flow, so the command is testable end to end. */
export interface ClaimDependencies {
  /** Overrides the Inquirer confirmation prompt. */
  confirm?: typeof promptConfirm;
  /**
   * Test seam: an already-constructed client, so the flow can be exercised
   * without dialing Soroban RPC. Production callers leave this unset.
   */
  client?: SplitStreamClient;
}

export async function runClaim(flags: ClaimFlags, deps: ClaimDependencies = {}): Promise<void> {
  const confirm = deps.confirm ?? promptConfirm;

  const config = loadConfig({
    verbose: flags.verbose === true,
    ...(flags.rpcUrl ? { rpcUrl: flags.rpcUrl } : {}),
    ...(flags.networkPassphrase ? { networkPassphrase: flags.networkPassphrase } : {}),
    ...(flags.vault ? { vaultContractId: flags.vault } : {}),
    ...(flags.token ? { tokenContractId: flags.token } : {}),
  });
  const chain = requireChainConfig(config);
  const cycleId = parseCycleId(flags.cycle);
  const requestedWallet = parseWalletKind(flags.wallet);

  const loaded = await loadManifest({
    cycleId,
    ...(flags.manifest ? { manifestPath: flags.manifest } : {}),
    ...(flags.repo ? { repo: flags.repo } : {}),
    ...(flags.ref ? { gitRef: flags.ref } : {}),
  });

  const claimant = await resolveClaimant({
    ...(flags.contributor ? { explicit: flags.contributor } : {}),
    ...(config.devSecretKey ? { devSecretKey: config.devSecretKey } : {}),
    ...(requestedWallet ? { walletKind: requestedWallet } : {}),
    networkPassphrase: chain.networkPassphrase,
  });

  const proof = buildClaimProof(loaded.manifest, claimant);
  const client = deps.client ?? new SplitStreamClient(chain);
  const tokenDecimals = await client.getTokenDecimals();

  const plan: ClaimPlan = {
    chain,
    contributor: proof.contributor,
    github: proof.github,
    cycleId: proof.cycleId,
    amount: proof.amount,
    tokenDecimals,
    proof: proof.proof,
    computedRoot: proof.computedRoot,
    manifestRoot: proof.manifestRoot,
    rootMatches: proof.rootMatches,
    manifestSource: loaded.source,
    walletKind: requestedWallet ?? 'local',
  };

  process.stdout.write(`\n${heading(`Claim cycle ${plan.cycleId}`)}\n`);
  process.stdout.write(
    `${renderTable(
      ['field', 'value'],
      [
        ['network', networkLabel(chain.networkPassphrase)],
        ['contributor', `${truncateAddress(plan.contributor)} (+${plan.github})`],
        ['amount', `${formatTokenAmount(plan.amount, plan.tokenDecimals)} tokens`],
        ['manifest', plan.manifestSource],
        ['recomputed root', plan.computedRoot],
        ['manifest root', plan.manifestRoot],
        ['root check', plan.rootMatches ? 'matches' : 'MISMATCH'],
      ],
    )}\n`,
  );

  if (!plan.rootMatches) {
    if (flags.force !== true) {
      throw new Error(
        'the manifest root does not match the tree recomputed from its own rows. Submitting this proof would ' +
          'burn a fee and fail on-chain. Re-generate the manifest, or re-check that merkleProof.ts matches ' +
          "splitstream-actions' merkle.ts. Pass --force only if you are certain.",
      );
    }
    process.stdout.write(warn('root mismatch ignored because --force was passed.\n'));
  }

  // Cheap early exit: if the cycle is already claimed, stop before signing.
  const alreadyClaimed = await client.hasClaimed(plan.cycleId, plan.contributor);
  if (alreadyClaimed) {
    throw new Error(
      `${truncateAddress(plan.contributor)} has already claimed cycle ${plan.cycleId}. ` +
        'Use `splitstream status --contributor <address>` to see the current balance and vesting schedule.',
    );
  }

  const walletKind = requestedWallet ?? (await promptWalletKind('local'));

  const proceed =
    flags.yes === true ||
    (await confirm(
      `Sign and submit credit_claim for ${formatTokenAmount(plan.amount, plan.tokenDecimals)} tokens?`,
      true,
    ));
  if (!proceed) {
    process.stdout.write(note('aborted before signing; nothing was submitted.\n'));
    return;
  }

  const claimSigner = await resolveSigner({
    kind: walletKind,
    expectedAddress: plan.contributor,
    ...(config.devSecretKey ? { devSecretKey: config.devSecretKey } : {}),
    networkPassphrase: chain.networkPassphrase,
    select: () => promptWalletKind('local'),
  });

  const claimTx = await client.buildClaimTx(plan.contributor, plan.cycleId, plan.amount, plan.proof);
  const claimHash = await submitTransaction(client, claimSigner, claimTx);
  process.stdout.write(`${chalk.bold('credit_claim')} succeeded.\n`);
  printHash(chain.networkPassphrase, claimHash);

  // Step two is a separate transaction with its own signature. Contributors
  // usually want both, so offer it immediately - but never merge the steps.
  if (flags.withdraw === false) {
    process.stdout.write(note('\nSkipping withdraw (--no-withdraw). The claim stays credited inside the vault.\n'));
    return;
  }

  const wantsWithdraw = await confirm(
    'credit_claim only credits the vault balance. Also sign and submit withdraw now? (separate transaction)',
    true,
  );
  if (!wantsWithdraw) {
    process.stdout.write(
      note('\nFine - the balance is credited. Run `splitstream claim --cycle ' + plan.cycleId + '` again, ' +
        'or call withdraw later, to move it out.\n'),
    );
    return;
  }

  const withdrawSigner = await resolveSigner({
    kind: walletKind,
    expectedAddress: plan.contributor,
    ...(config.devSecretKey ? { devSecretKey: config.devSecretKey } : {}),
    networkPassphrase: chain.networkPassphrase,
    select: () => promptWalletKind('local'),
  });

  const withdrawTx = await client.buildWithdrawTx(plan.contributor);
  const withdrawHash = await submitTransaction(client, withdrawSigner, withdrawTx);
  process.stdout.write(`${chalk.bold('withdraw')} succeeded.\n`);
  printHash(chain.networkPassphrase, withdrawHash);
  process.stdout.write(note(`\nBoth steps are complete (2 transactions, 2 signatures).\n`));
}

/** Registers `splitstream claim`. */
export function registerClaimCommand(program: Command): void {
  program
    .command('claim')
    .description('claim a cycle allocation and optionally withdraw it (two signed transactions)')
    .requiredOption('--cycle <id>', 'cycle to claim')
    .option('--manifest <path>', 'manifest file for the cycle')
    .option('--repo <owner/name>', 'repository to fetch the manifest from')
    .option('--ref <ref>', 'git ref to read manifests from', 'main')
    .option('--contributor <address|handle>', 'who is claiming; defaults to the signing wallet')
    .option('--wallet <kind>', 'signing method: local or hardware')
    .option('-y, --yes', 'skip the confirmation prompt')
    .option('--force', 'proceed even if the manifest root does not match the recomputed tree')
    .option('--no-withdraw', 'stop after credit_claim; do not offer withdraw')
    .option('--rpc-url <url>', 'override SPLITSTREAM_RPC_URL')
    .option('--network-passphrase <passphrase>', 'override SPLITSTREAM_NETWORK_PASSPHRASE')
    .option('--vault <id>', 'override SPLITSTREAM_VAULT_CONTRACT_ID')
    .option('--token <id>', 'override SPLITSTREAM_TOKEN_CONTRACT_ID')
    .action(async (options: ClaimFlags) => {
      await runClaim(options);
    });
}
