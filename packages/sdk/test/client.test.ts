import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

import { SplitStreamClient, SplitStreamError } from '../src/index.js';

const CONTRIBUTOR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey();
const VAULT_ID = StrKey.encodeContract(new Uint8Array(32).fill(1));
const TOKEN_ID = StrKey.encodeContract(new Uint8Array(32).fill(2));

interface TestConfig {
  rpcUrl: string;
  networkPassphrase: string;
  vaultContractId: string;
  tokenContractId: string;
}

const CONFIG: TestConfig = {
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: Networks.TESTNET,
  vaultContractId: VAULT_ID,
  tokenContractId: TOKEN_ID,
};

/** Minimal fake of the parts of `rpc.Server` the client touches. */
type ServerStub = {
  simulateTransaction?: rpc.Server['simulateTransaction'];
  getAccount?: rpc.Server['getAccount'];
  sendTransaction?: rpc.Server['sendTransaction'];
  getTransaction?: rpc.Server['getTransaction'];
};

function fakeServer(stub: ServerStub): rpc.Server {
  return stub as unknown as rpc.Server;
}

function client(stub: ServerStub, extra: Partial<TestConfig> = {}): SplitStreamClient {
  return new SplitStreamClient({
    ...CONFIG,
    ...extra,
    server: fakeServer(stub),
    pollIntervalMs: 1,
    pollTimeoutMs: 500,
  });
}

function simulationSuccess(retval: xdr.ScVal): rpc.Api.SimulateTransactionResponse {
  return {
    _parsed: true,
    id: 'sim-1',
    latestLedger: 100,
    events: [],
    transactionData: new SorobanDataBuilder(),
    minResourceFee: '1000',
    result: { auth: [], retval },
  } as unknown as rpc.Api.SimulateTransactionResponse;
}

/**
 * A genuinely signed envelope. `submitSigned` decodes the XDR before talking to
 * the network, so the submit-path tests need a real transaction rather than an
 * arbitrary string.
 */
function signedEnvelopeXdr(): string {
  const signer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 5));
  const destination = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 6)).publicKey();
  const account = new Account(signer.publicKey(), '1');
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination, asset: Asset.native(), amount: '1' }))
    .setTimeout(30)
    .build();
  transaction.sign(signer);
  return transaction.toEnvelope().toXdr('base64');
}

function simulationError(error: string): rpc.Api.SimulateTransactionResponse {
  return {
    _parsed: true,
    id: 'sim-1',
    latestLedger: 100,
    events: [],
    error,
  } as unknown as rpc.Api.SimulateTransactionResponse;
}

describe('SplitStreamClient constructor', () => {
  it('requires every network field explicitly', () => {
    expect(() => client({}, { networkPassphrase: '' })).toThrow(SplitStreamError);
    expect(() => client({}, { vaultContractId: '' })).toThrow(SplitStreamError);
    expect(() => client({}, { tokenContractId: 'GABC' })).toThrow(/contract id/);
    expect(() => client({}, { rpcUrl: 'not-a-url' })).toThrow(/absolute http/);
  });
});

describe('read methods', () => {
  it('decodes a bigint balance', async () => {
    const simulate = vi.fn(async () => simulationSuccess(nativeToScVal(400_000_000n, { type: 'i128' })));
    const subject = client({ simulateTransaction: simulate });
    await expect(subject.getBalance(CONTRIBUTOR)).resolves.toBe(400_000_000n);
    expect(simulate).toHaveBeenCalledOnce();
  });

  it('rejects a malformed contributor address before hitting the network', async () => {
    const simulate = vi.fn();
    const subject = client({ simulateTransaction: simulate });
    await expect(subject.getBalance('not-an-address')).rejects.toThrow(SplitStreamError);
    expect(simulate).not.toHaveBeenCalled();
  });

  it('returns null for an unposted cycle root', async () => {
    const subject = client({
      simulateTransaction: async () => simulationSuccess(xdr.ScVal.scvVoid()),
    });
    await expect(subject.getCycleRoot(3)).resolves.toBeNull();
  });

  it('hex-encodes a posted cycle root', async () => {
    const subject = client({
      simulateTransaction: async () =>
        simulationSuccess(xdr.ScVal.scvBytes(new Uint8Array(32).fill(7))),
    });
    await expect(subject.getCycleRoot(3)).resolves.toBe('07'.repeat(32));
  });

  it('decodes claim status', async () => {
    const subject = client({
      simulateTransaction: async () => simulationSuccess(nativeToScVal(true, { type: 'bool' })),
    });
    await expect(subject.hasClaimed(3, CONTRIBUTOR)).resolves.toBe(true);
  });

  it('returns null when no vesting schedule exists', async () => {
    const subject = client({
      simulateTransaction: async () => simulationSuccess(xdr.ScVal.scvVoid()),
    });
    await expect(subject.getVesting(CONTRIBUTOR)).resolves.toBeNull();
  });

  it('decodes a vesting schedule', async () => {
    // Soroban structs arrive as a map with symbol keys, which is exactly what
    // `get_vesting` returns for a `VestingSchedule`.
    const retval = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('total'),
        val: nativeToScVal(1_000_000n, { type: 'i128' }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('claimed'),
        val: nativeToScVal(250_000n, { type: 'i128' }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('start_ledger'),
        val: nativeToScVal(10, { type: 'u32' }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('duration_ledgers'),
        val: nativeToScVal(100, { type: 'u32' }),
      }),
    ]);
    const subject = client({ simulateTransaction: async () => simulationSuccess(retval) });
    await expect(subject.getVesting(CONTRIBUTOR)).resolves.toEqual({
      total: 1_000_000n,
      claimed: 250_000n,
      startLedger: 10,
      durationLedgers: 100,
    });
  });

  it('reads token decimals and the vault reserve from the token contract', async () => {
    const simulate = vi.fn(async () => simulationSuccess(nativeToScVal(6, { type: 'u32' })));
    const subject = client({ simulateTransaction: simulate });
    await expect(subject.getTokenDecimals()).resolves.toBe(6);

    const reserve = 5_000_000_000n;
    const subject2 = client({
      simulateTransaction: async () => simulationSuccess(nativeToScVal(reserve, { type: 'i128' })),
    });
    await expect(subject2.getReserveBalance()).resolves.toBe(reserve);
  });

  it('surfaces a contract error code from a failed simulation', async () => {
    const subject = client({
      simulateTransaction: async () =>
        simulationError('HostError: Error(Contract, #8)\ncontract called trap'),
    });
    await expect(subject.getBalance(CONTRIBUTOR)).rejects.toMatchObject({
      name: 'SplitStreamError',
      code: 8,
      codeName: 'InvalidProof',
    });
  });
});

describe('buildClaimTx', () => {
  it('returns an unsigned credit_claim invocation', async () => {
    const subject = client({
      getAccount: async () => new Account(CONTRIBUTOR, '42'),
      simulateTransaction: async () => simulationSuccess(nativeToScVal(1n, { type: 'i128' })),
    });

    const tx = await subject.buildClaimTx(CONTRIBUTOR, 3, 1_000n, ['00'.repeat(32)]);

    expect(tx.operations).toHaveLength(1);
    const operation = tx.operations[0];
    expect(operation?.type).toBe('invokeHostFunction');
    if (operation?.type !== 'invokeHostFunction') throw new Error('unexpected operation type');
    expect(operation.func.type).toBe('hostFunctionTypeInvokeContract');
    if (operation.func.type !== 'hostFunctionTypeInvokeContract') {
      throw new Error('unexpected host function type');
    }
    expect(operation.func.invokeContract.functionName.toString()).toBe('credit_claim');
    expect(operation.func.invokeContract.contractAddress.toXdr).toBeTypeOf('function');

    // The SDK never signs: no decorated signatures on the assembled tx.
    expect(tx.signatures).toHaveLength(0);

    // The assembled envelope round-trips, so it is a valid unsigned tx.
    const decoded = rpc.assembleTransaction(
      tx,
      simulationSuccess(nativeToScVal(1n, { type: 'i128' })),
    );
    expect(decoded).toBeDefined();
  });

  it('builds distinct withdraw and claim_vested transactions', async () => {
    const subject = client({
      getAccount: async () => new Account(CONTRIBUTOR, '7'),
      simulateTransaction: async () => simulationSuccess(xdr.ScVal.scvVoid()),
    });

    const methodOf = async (tx: Awaited<ReturnType<typeof subject.buildWithdrawTx>>): Promise<string> => {
      const operation = tx.operations[0];
      if (operation?.type !== 'invokeHostFunction') throw new Error('unexpected operation type');
      if (operation.func.type !== 'hostFunctionTypeInvokeContract') {
        throw new Error('unexpected host function type');
      }
      return operation.func.invokeContract.functionName.toString();
    };

    expect(await methodOf(await subject.buildWithdrawTx(CONTRIBUTOR))).toBe('withdraw');
    expect(await methodOf(await subject.buildClaimVestedTx(CONTRIBUTOR))).toBe('claim_vested');
  });

  it('rejects an empty proof and a negative amount', async () => {
    const subject = client({});
    await expect(subject.buildClaimTx(CONTRIBUTOR, 3, 1n, [])).rejects.toThrow(/non-empty Merkle proof/);
    await expect(subject.buildClaimTx(CONTRIBUTOR, 3, -1n, ['00'.repeat(32)])).rejects.toThrow(
      /must not be negative/,
    );
  });

  it('reports an unfunded source account clearly', async () => {
    const subject = client({
      getAccount: async () => {
        throw new Error('Account not found: ' + CONTRIBUTOR);
      },
    });
    await expect(subject.buildClaimTx(CONTRIBUTOR, 3, 1n, ['00'.repeat(32)])).rejects.toThrow(
      /must exist and be funded/,
    );
  });
});

describe('submitSigned', () => {
  const HASH = 'de'.repeat(32);
  const ENVELOPE = signedEnvelopeXdr();

  it('polls until the transaction is final', async () => {
    const getTransaction = vi
      .fn<rpc.Server['getTransaction']>()
      .mockResolvedValueOnce({ status: rpc.Api.GetTransactionStatus.NOT_FOUND } as never)
      .mockResolvedValueOnce({ status: rpc.Api.GetTransactionStatus.SUCCESS } as never);

    const subject = client({
      sendTransaction: async () =>
        ({ status: 'PENDING', hash: HASH, latestLedger: 1 }) as rpc.Api.SendTransactionResponse,
      getTransaction,
    });

    await expect(subject.submitSigned(ENVELOPE)).resolves.toEqual({ hash: HASH, status: 'SUCCESS' });
    expect(getTransaction).toHaveBeenCalledTimes(2);
  });

  it('decodes the contract error when the transaction fails on-chain', async () => {
    const diagnostic = new xdr.DiagnosticEvent({
      inSuccessfulContractCall: false,
      event: new xdr.ContractEvent({
        ext: xdr.ExtensionPoint.v0(),
        contractId: null,
        type: xdr.ContractEventType.system,
        body: xdr.ContractEventBody.v0(
          new xdr.ContractEventV0({
            topics: [],
            data: xdr.ScVal.scvError(xdr.ScError.sceContract(9)),
          }),
        ),
      }),
    });

    const subject = client({
      sendTransaction: async () =>
        ({ status: 'PENDING', hash: HASH, latestLedger: 1 }) as rpc.Api.SendTransactionResponse,
      getTransaction: async () =>
        ({
          status: rpc.Api.GetTransactionStatus.FAILED,
          hash: HASH,
          diagnosticEventsXdr: [diagnostic],
        }) as never,
    });

    await expect(subject.submitSigned(ENVELOPE)).rejects.toMatchObject({
      code: 9,
      codeName: 'AlreadyClaimed',
    });
  });

  it('surfaces an immediate ERROR response from sendTransaction', async () => {
    const subject = client({
      sendTransaction: async () =>
        ({ status: 'ERROR', hash: HASH, latestLedger: 1 }) as rpc.Api.SendTransactionResponse,
    });
    await expect(subject.submitSigned(ENVELOPE)).rejects.toThrow(/rejected the transaction/);
  });

  it('gives up instead of hanging when a transaction never lands', async () => {
    const subject = client({
      sendTransaction: async () =>
        ({ status: 'PENDING', hash: HASH, latestLedger: 1 }) as rpc.Api.SendTransactionResponse,
      getTransaction: async () =>
        ({ status: rpc.Api.GetTransactionStatus.NOT_FOUND, hash: HASH }) as never,
    });
    await expect(subject.submitSigned(ENVELOPE)).rejects.toThrow(/timed out/);
  });

  it('rejects an envelope that is not a valid transaction', async () => {
    const subject = client({});
    await expect(subject.submitSigned('not-xdr')).rejects.toThrow(/could not decode/);
  });
});
