import { SplitStreamClient } from '@splitstream/sdk';
import { describe, expect, it } from 'vitest';

import {
  collectStatus,
  resolveCycleIds,
  serializeStatus,
  type StatusFlags,
} from '../src/commands/status.js';
import {
  ADDRESS_A,
  ADDRESS_STRANGER,
  TOKEN_ID,
  VAULT_ID,
  manifestDirectory,
  writeManifestFile,
} from './fixtures.js';

const ROOT_3 = 'ab'.repeat(32);

/**
 * Only the methods `status` calls are implemented, and the cast is deliberate:
 * the point of these tests is the command's decisions, not the RPC plumbing
 * (which `packages/sdk` already covers).
 */
function fakeClient(overrides: Record<string, unknown> = {}): SplitStreamClient {
  return {
    getTokenDecimals: async () => 7,
    getReserveBalance: async () => 5_000_000_000n,
    getCycleRoot: async (cycleId: number) => (cycleId === 3 ? ROOT_3 : null),
    hasClaimed: async (cycleId: number, address: string) => cycleId === 3 && address === ADDRESS_A,
    getBalance: async () => 12_345_678n,
    getVesting: async () => ({
      total: 10_000_000n,
      claimed: 1_000_000n,
      startLedger: 100,
      durationLedgers: 50,
    }),
    ...overrides,
  } as unknown as SplitStreamClient;
}

const META = {
  network: 'testnet',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  vaultContractId: VAULT_ID,
  tokenContractId: TOKEN_ID,
};

describe('resolveCycleIds', () => {
  it('pins a single cycle with --cycle', () => {
    expect(resolveCycleIds({ cycle: '12' })).toEqual([12]);
  });

  it('counts back from the highest known manifest', () => {
    const cwd = manifestDirectory([3, 5]);
    expect(resolveCycleIds({ cycles: '3' }, cwd)).toEqual([3, 4, 5]);
  });

  it('never asks for a negative cycle id', () => {
    const cwd = manifestDirectory([1]);
    expect(resolveCycleIds({ cycles: '5' }, cwd)).toEqual([0, 1]);
  });

  it('rejects malformed ranges', () => {
    expect(() => resolveCycleIds({ cycle: '-1' })).toThrow(/non-negative/);
    expect(() => resolveCycleIds({ cycles: '0' })).toThrow(/between 1 and 200/);
    expect(() => resolveCycleIds({ cycles: '1000' })).toThrow(/between 1 and 200/);
  });
});

describe('collectStatus', () => {
  it('shows the maintainer aggregate, including the last manifest summary', async () => {
    const flags: StatusFlags = { cycles: '2', cycle: '3', manifest: writeManifestFile({ cycleId: 3 }) };
    const result = await collectStatus(fakeClient(), flags, META);

    expect(result.network).toBe('testnet');
    expect(result.tokenDecimals).toBe(7);
    expect(result.reserveBalance).toBe(5_000_000_000n);
    expect(result.cycles).toEqual([{ cycleId: 3, root: ROOT_3, hasClaimed: null }]);
    expect(result.contributor).toBeNull();
    expect(result.manifest?.contributorCount).toBe(3);
  });

  it('adds the contributor position and splits claimed from pending cycles', async () => {
    const flags: StatusFlags = { cycle: '3', contributor: ADDRESS_A };
    const result = await collectStatus(fakeClient(), flags, META);

    expect(result.cycles[0]?.hasClaimed).toBe(true);
    expect(result.contributor?.balance).toBe(12_345_678n);
    expect(result.contributor?.claimedCycles).toEqual([3]);
    expect(result.contributor?.pendingCycles).toEqual([]);
    expect(result.contributor?.vesting?.startLedger).toBe(100);
  });

  it('lists a posted, unclaimed cycle as pending', async () => {
    const client = fakeClient({ hasClaimed: async () => false });
    const result = await collectStatus(client, { cycle: '3', contributor: ADDRESS_STRANGER }, META);
    expect(result.contributor?.pendingCycles).toEqual([3]);
    expect(result.contributor?.claimedCycles).toEqual([]);
  });

  it('does not query claim status for a contributor when no root is posted', async () => {
    let called = false;
    const client = fakeClient({
      hasClaimed: async () => {
        called = true;
        return false;
      },
    });
    const result = await collectStatus(client, { cycle: '9', contributor: ADDRESS_A }, META);
    expect(called).toBe(false);
    expect(result.cycles[0]?.hasClaimed).toBeNull();
  });

  it('treats a missing manifest as "no extra context" rather than an error', async () => {
    const result = await collectStatus(
      fakeClient(),
      { cycle: '3', repo: manifestDirectory([]) },
      META,
    );
    expect(result.manifest).toBeNull();
  });
});

describe('serializeStatus', () => {
  it('emits amounts as decimal strings', async () => {
    const result = await collectStatus(
      fakeClient(),
      { cycle: '3', contributor: ADDRESS_A },
      META,
    );
    const parsed = JSON.parse(serializeStatus(result)) as Record<string, unknown>;
    expect(parsed.reserveBalance).toBe('5000000000');

    const contributor = parsed.contributor as Record<string, unknown>;
    expect(contributor.balance).toBe('12345678');
    const vesting = contributor.vesting as Record<string, unknown>;
    expect(vesting.total).toBe('10000000');
    expect(vesting.claimed).toBe('1000000');
  });
});
