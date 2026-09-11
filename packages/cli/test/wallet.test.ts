import {
  Account,
  Asset,
  BASE_FEE,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  createHardwareSigner,
  createLocalSigner,
  readLedgerPublicKey,
  resolveSigner,
} from '../src/wallet.js';
import { ADDRESS_A, ADDRESS_B, ADDRESS_STRANGER, SECRET_A } from './fixtures.js';

function unsignedTransaction(source: string = ADDRESS_A) {
  return new TransactionBuilder(new Account(source, '1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({ destination: ADDRESS_B, asset: Asset.native(), amount: '1' }),
    )
    .setTimeout(30)
    .build();
}

describe('createLocalSigner', () => {
  it('exposes the address and labels itself insecure', async () => {
    const signer = createLocalSigner(SECRET_A, Networks.TESTNET);
    expect(signer.kind).toBe('local');
    expect(signer.label).toContain('INSECURE');
    expect(signer.label).toContain('testnet-only');
    await expect(signer.getPublicKey()).resolves.toBe(ADDRESS_A);
  });

  it('refuses to sign on mainnet, whatever the caller asks', () => {
    expect(() => createLocalSigner(SECRET_A, Networks.PUBLIC)).toThrow(/refusing to sign a mainnet/);
  });

  it('refuses a value that is not a secret seed', () => {
    expect(() => createLocalSigner('not-a-seed', Networks.TESTNET)).toThrow(/valid Stellar secret seed/);
    // A public key is the easy mistake to make here.
    expect(() => createLocalSigner(ADDRESS_A, Networks.TESTNET)).toThrow(/valid Stellar secret seed/);
  });

  it('signs a transaction that verifies against the keypair', async () => {
    const signer = createLocalSigner(SECRET_A, Networks.TESTNET);
    const transaction = unsignedTransaction();
    const signedXdr = await signer.sign(transaction);

    const decoded = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
    expect(decoded.signatures).toHaveLength(1);
    // `hash()` is typed as a bare `Uint8Array`, whose `toString` takes no
    // arguments, so re-wrap before asking for hex.
    expect(Buffer.from(decoded.hash()).toString('hex')).toBe(
      Buffer.from(transaction.hash()).toString('hex'),
    );
  });
});

describe('resolveSigner', () => {
  const select = vi.fn(async () => 'local' as const);

  it('rejects an explicit local signer when no dev key is configured', async () => {
    await expect(
      resolveSigner({
        kind: 'local',
        expectedAddress: ADDRESS_A,
        networkPassphrase: Networks.TESTNET,
        select,
      }),
    ).rejects.toThrow(/SPLITSTREAM_DEV_SECRET_KEY is not set/);
  });

  it('refuses a dev key that does not own the address being claimed', async () => {
    await expect(
      resolveSigner({
        kind: 'local',
        expectedAddress: ADDRESS_STRANGER,
        devSecretKey: SECRET_A,
        networkPassphrase: Networks.TESTNET,
        select,
      }),
    ).rejects.toThrow(/can only sign for its own account/);
  });

  it('builds a local signer for the matching address', async () => {
    const signer = await resolveSigner({
      kind: 'local',
      expectedAddress: ADDRESS_A,
      devSecretKey: SECRET_A,
      networkPassphrase: Networks.TESTNET,
      select,
    });
    expect(signer.kind).toBe('local');
    await expect(signer.getPublicKey()).resolves.toBe(ADDRESS_A);
  });

  it('prompts when no wallet kind was passed', async () => {
    const prompted = vi.fn(async () => 'local' as const);
    const signer = await resolveSigner({
      expectedAddress: ADDRESS_A,
      devSecretKey: SECRET_A,
      networkPassphrase: Networks.TESTNET,
      select: prompted,
    });
    expect(prompted).toHaveBeenCalledOnce();
    expect(signer.kind).toBe('local');
  });
});

describe('hardware wallet path', () => {
  // The Ledger packages are optional and deliberately not installed in CI, so
  // these tests pin the *failure* behaviour: an actionable install line rather
  // than a module-resolution stack trace.
  it('explains how to install the optional Ledger packages', async () => {
    await expect(readLedgerPublicKey()).rejects.toThrow(/optional Ledger packages/);
    await expect(createHardwareSigner(ADDRESS_A)).rejects.toThrow(/hw-app-str/);
  });

  it('tells the user a Ledger is the supported mainnet path', async () => {
    await expect(createHardwareSigner(ADDRESS_A)).rejects.toThrow(/supported way to sign mainnet/);
  });
});
