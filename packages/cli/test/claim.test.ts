import { Account, Asset, BASE_FEE, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runClaim, resolveClaimant, type ClaimFlags } from '../src/commands/claim.js';
import {
  ADDRESS_A,
  ADDRESS_STRANGER,
  SECRET_A,
  TOKEN_ID,
  VAULT_ID,
  fixtureRoot,
  writeManifestFile,
} from './fixtures.js';

const RPC_URL = 'https://soroban-testnet.stellar.org';
const HASH = 'ab'.repeat(32);

/** A real, unsigned transaction: the local signer signs it for real. */
function dummyTransaction(source: string) {
  return new TransactionBuilder(new Account(source, '1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination: source, asset: Asset.native(), amount: '1' }))
    .setTimeout(30)
    .build();
}

interface FakeClientOptions {
  alreadyClaimed?: boolean;
  /** Address the fake client pretends to serve. */
  contributor?: string;
}

function fakeClient(options: FakeClientOptions = {}) {
  const built: string[] = [];
  const submitted: string[] = [];
  const contributor = options.contributor ?? ADDRESS_A;

  const client = {
    getTokenDecimals: async () => 7,
    hasClaimed: async () => options.alreadyClaimed ?? false,
    buildClaimTx: async () => {
      built.push('credit_claim');
      return dummyTransaction(contributor);
    },
    buildWithdrawTx: async () => {
      built.push('withdraw');
      return dummyTransaction(contributor);
    },
    submitSigned: async (signedXdr: string) => {
      submitted.push(signedXdr);
      return { hash: HASH, status: 'SUCCESS' as const };
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as never, built, submitted };
}

function baseFlags(manifest: string, extra: Partial<ClaimFlags> = {}): ClaimFlags {
  return {
    cycle: '7',
    manifest,
    wallet: 'local',
    yes: true,
    rpcUrl: RPC_URL,
    networkPassphrase: Networks.TESTNET,
    vault: VAULT_ID,
    token: TOKEN_ID,
    ...extra,
  };
}

/** Captures everything the command writes, so output assertions are cheap. */
function captureStdout(): () => string {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  spies.push(spy);
  return () => chunks.join('');
}

const spies: ReturnType<typeof vi.spyOn>[] = [];

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  vi.unstubAllEnvs();
});

describe('resolveClaimant', () => {
  it('prefers an explicit contributor and does not touch a wallet', async () => {
    await expect(
      resolveClaimant({ explicit: ADDRESS_STRANGER, networkPassphrase: Networks.TESTNET }),
    ).resolves.toBe(ADDRESS_STRANGER);
  });

  it('falls back to the local testnet key', async () => {
    await expect(
      resolveClaimant({
        devSecretKey: SECRET_A,
        networkPassphrase: Networks.TESTNET,
      }),
    ).resolves.toBe(ADDRESS_A);
  });
});

describe('runClaim', () => {
  it('validates the manifest, signs credit_claim and reports the explorer link', async () => {
    vi.stubEnv('SPLITSTREAM_DEV_SECRET_KEY', SECRET_A);
    const manifest = writeManifestFile({ cycleId: 7 });
    const { client, built, submitted } = fakeClient();
    const output = captureStdout();

    await runClaim(baseFlags(manifest), { client, confirm: async () => false });

    expect(built).toEqual(['credit_claim']);
    expect(submitted).toHaveLength(1);
    const printed = output();
    expect(printed).toContain('Claim cycle 7');
    expect(printed).toContain('matches');
    expect(printed).toContain(fixtureRoot());
    expect(printed).toContain('credit_claim');
    expect(printed).toContain(HASH);
    expect(printed).toContain(`https://stellar.expert/explorer/testnet/tx/${HASH}`);
  });

  it('runs withdraw as a second, separately signed transaction when asked', async () => {
    vi.stubEnv('SPLITSTREAM_DEV_SECRET_KEY', SECRET_A);
    const manifest = writeManifestFile({ cycleId: 7 });
    const { client, built, submitted } = fakeClient();
    const output = captureStdout();

    await runClaim(baseFlags(manifest), { client, confirm: async () => true });

    expect(built).toEqual(['credit_claim', 'withdraw']);
    expect(submitted).toHaveLength(2);
    expect(output()).toContain('Both steps are complete (2 transactions, 2 signatures)');
    expect(output()).toContain('withdraw');
  });

  it('stops after credit_claim when --no-withdraw is passed', async () => {
    vi.stubEnv('SPLITSTREAM_DEV_SECRET_KEY', SECRET_A);
    const manifest = writeManifestFile({ cycleId: 7 });
    const { client, built } = fakeClient();
    const output = captureStdout();

    await runClaim(baseFlags(manifest, { withdraw: false }), { client, confirm: async () => true });

    expect(built).toEqual(['credit_claim']);
    expect(output()).toContain('Skipping withdraw');
  });

  it('refuses to submit a proof whose recomputed root disagrees with the manifest', async () => {
    vi.stubEnv('SPLITSTREAM_DEV_SECRET_KEY', SECRET_A);
    const manifest = writeManifestFile({ cycleId: 7, root: 'ff'.repeat(32) });
    const { client, submitted } = fakeClient();

    await expect(
      runClaim(baseFlags(manifest), { client, confirm: async () => true }),
    ).rejects.toThrow(/does not match the tree recomputed/);
    expect(submitted).toHaveLength(0);
  });

  it('submits anyway when --force is passed, but says so', async () => {
    vi.stubEnv('SPLITSTREAM_DEV_SECRET_KEY', SECRET_A);
    const manifest = writeManifestFile({ cycleId: 7, root: 'ff'.repeat(32) });
    const { client, submitted } = fakeClient();
    const output = captureStdout();

    await runClaim(baseFlags(manifest, { force: true }), { client, confirm: async () => false });

    expect(submitted).toHaveLength(1);
    expect(output()).toContain('MISMATCH');
    expect(output()).toContain('--force');
  });

  it('exits before signing when the cycle was already claimed', async () => {
    vi.stubEnv('SPLITSTREAM_DEV_SECRET_KEY', SECRET_A);
    const manifest = writeManifestFile({ cycleId: 7 });
    const { client, built } = fakeClient({ alreadyClaimed: true });

    await expect(
      runClaim(baseFlags(manifest), { client, confirm: async () => true }),
    ).rejects.toThrow(/already claimed cycle 7/);
    expect(built).toEqual([]);
  });

  it('rejects a contributor that is not in the manifest', async () => {
    vi.stubEnv('SPLITSTREAM_DEV_SECRET_KEY', SECRET_A);
    const manifest = writeManifestFile({ cycleId: 7 });
    const { client } = fakeClient();

    await expect(
      runClaim(baseFlags(manifest, { contributor: ADDRESS_STRANGER }), {
        client,
        confirm: async () => true,
      }),
    ).rejects.toThrow(/is not present in the cycle 7 manifest/);
  });

  it('requires --cycle, because there is no way to guess it', async () => {
    vi.stubEnv('SPLITSTREAM_DEV_SECRET_KEY', SECRET_A);
    const manifest = writeManifestFile({ cycleId: 7 });
    const { client } = fakeClient();

    await expect(
      runClaim(baseFlags(manifest, { cycle: undefined }), { client }),
    ).rejects.toThrow(/--cycle <id> is required/);
  });

  it('rejects an unknown wallet kind', async () => {
    vi.stubEnv('SPLITSTREAM_DEV_SECRET_KEY', SECRET_A);
    const manifest = writeManifestFile({ cycleId: 7 });
    const { client } = fakeClient();

    await expect(
      runClaim(baseFlags(manifest, { wallet: 'metamask' }), { client }),
    ).rejects.toThrow(/"local" or "hardware"/);
  });

  it('does not submit anything when the user declines the confirmation', async () => {
    vi.stubEnv('SPLITSTREAM_DEV_SECRET_KEY', SECRET_A);
    const manifest = writeManifestFile({ cycleId: 7 });
    const { client, submitted } = fakeClient();
    const output = captureStdout();

    await runClaim(baseFlags(manifest, { yes: false }), { client, confirm: async () => false });

    expect(submitted).toHaveLength(0);
    expect(output()).toContain('aborted before signing');
  });
});
