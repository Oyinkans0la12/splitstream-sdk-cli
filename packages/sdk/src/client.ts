import {
  Account,
  BASE_FEE,
  Contract,
  StrKey,
  Transaction,
  TransactionBuilder,
  rpc,
  type FeeBumpTransaction,
} from '@stellar/stellar-sdk';

import { contractError, SplitStreamError, toSplitStreamError } from './errors.js';
import { parseVesting, type VestingInfo } from './types.js';
import {
  addressToScVal,
  findContractErrorCode,
  i128ToScVal,
  isVoidScVal,
  proofToScVal,
  scValToBigInt,
  scValToBool,
  scValToHexOrNull,
  scValToNativeValue,
  u32ToScVal,
  xdr,
} from './xdr.js';

/** Vault contract entrypoint names. Kept together so they are easy to audit. */
export const VAULT_METHODS = {
  getBalance: 'get_balance',
  getCycleRoot: 'get_cycle_root',
  hasClaimed: 'has_claimed',
  getVesting: 'get_vesting',
  creditClaim: 'credit_claim',
  withdraw: 'withdraw',
  claimVested: 'claim_vested',
} as const;

/** SEP-41 token entrypoint names used by the status command. */
export const TOKEN_METHODS = {
  balance: 'balance',
  decimals: 'decimals',
} as const;

/** Options for {@link SplitStreamClient}. Network identity is never defaulted. */
export interface SplitStreamClientOptions {
  /** Soroban RPC endpoint, e.g. `https://soroban-testnet.stellar.org`. */
  rpcUrl: string;
  /** Network passphrase. Must match {@link rpcUrl}'s network. */
  networkPassphrase: string;
  /** Deployed splitstream-core vault contract id (`C...`). */
  vaultContractId: string;
  /** Payout token contract id (`C...`). */
  tokenContractId: string;
  /**
   * Test seam: inject an already-constructed `rpc.Server`. Production callers
   * should leave this unset so the client builds its own from `rpcUrl`.
   */
  server?: rpc.Server;
  /** Poll interval while waiting for a submitted transaction. Default 2000ms. */
  pollIntervalMs?: number;
  /** Give up waiting for a submitted transaction after this long. Default 60s. */
  pollTimeoutMs?: number;
}

/** Result of {@link SplitStreamClient.submitSigned}. */
export interface SubmittedTransaction {
  readonly hash: string;
  readonly status: 'SUCCESS' | 'FAILED';
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 60_000;
const SUBMIT_RETRY_ATTEMPTS = 3;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function requireNonEmpty(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SplitStreamError(
      `SplitStreamClient requires ${name}; there is no default so the caller must be explicit about the network`,
    );
  }
  return value.trim();
}

function requireContractId(value: string | undefined, name: string): string {
  const trimmed = requireNonEmpty(value, name);
  if (!StrKey.isValidContract(trimmed)) {
    throw new SplitStreamError(`${name} must be a valid Soroban contract id (C...), received "${trimmed}"`);
  }
  return trimmed;
}

function requireRpcUrl(value: string | undefined): string {
  const trimmed = requireNonEmpty(value, 'rpcUrl');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SplitStreamError(`rpcUrl must be an absolute http(s) URL, received "${trimmed}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SplitStreamError(`rpcUrl must use http or https, received "${trimmed}"`);
  }
  return trimmed;
}

/**
 * Typed client for the deployed splitstream-core vault.
 *
 * The client never signs. Read methods return decoded values; `build*` methods
 * return an assembled but *unsigned* `Transaction` for the caller to sign (with
 * a wallet, a hardware device, or a locally stored testnet key) and hand back
 * to {@link SplitStreamClient.submitSigned}.
 */
export class SplitStreamClient {
  readonly rpcUrl: string;
  readonly networkPassphrase: string;
  readonly vaultContractId: string;
  readonly tokenContractId: string;

  readonly server: rpc.Server;

  private readonly vault: Contract;
  private readonly token: Contract;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  /** All-zero account used as the source for read-only simulations. */
  private readonly simulationSource: string;

  constructor(options: SplitStreamClientOptions) {
    this.rpcUrl = requireRpcUrl(options.rpcUrl);
    this.networkPassphrase = requireNonEmpty(options.networkPassphrase, 'networkPassphrase');
    this.vaultContractId = requireContractId(options.vaultContractId, 'vaultContractId');
    this.tokenContractId = requireContractId(options.tokenContractId, 'tokenContractId');

    this.server = options.server ?? new rpc.Server(this.rpcUrl);
    this.vault = new Contract(this.vaultContractId);
    this.token = new Contract(this.tokenContractId);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    this.simulationSource = StrKey.encodeEd25519PublicKey(new Uint8Array(32));
  }

  // ---------------------------------------------------------------- reads

  /**
   * Runs a read-only simulation of `method` against `contract` and returns the
   * raw return value.
   */
  private async simulateRead(
    contract: Contract,
    method: string,
    params: readonly xdr.ScVal[],
    what: string,
  ): Promise<xdr.ScVal> {
    const source = new Account(this.simulationSource, '0');
    const raw = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(method, ...params))
      .setTimeout(30)
      .build();

    let simulation: rpc.Api.SimulateTransactionResponse;
    try {
      simulation = await this.server.simulateTransaction(raw);
    } catch (error) {
      throw toSplitStreamError(error, `reading ${what}`);
    }

    if (rpc.Api.isSimulationError(simulation)) {
      throw toSplitStreamError(simulation.error, `reading ${what}`);
    }

    const retval = (simulation as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!retval) {
      throw new SplitStreamError(`contract method ${method} returned no value while reading ${what}`);
    }
    return retval;
  }

  /** Claimable balance for `contributor`, in the token's base units. */
  async getBalance(contributor: string): Promise<bigint> {
    this.assertAddress(contributor, 'contributor');
    const retval = await this.simulateRead(
      this.vault,
      VAULT_METHODS.getBalance,
      [addressToScVal(contributor)],
      `balance of ${contributor}`,
    );
    return scValToBigInt(retval, 'get_balance');
  }

  /** Published Merkle root for `cycleId`, lowercase hex, or `null` if unposted. */
  async getCycleRoot(cycleId: number): Promise<string | null> {
    const retval = await this.simulateRead(
      this.vault,
      VAULT_METHODS.getCycleRoot,
      [u32ToScVal(cycleId)],
      `cycle ${cycleId} root`,
    );
    if (isVoidScVal(retval)) return null;
    return scValToHexOrNull(retval, 'get_cycle_root');
  }

  /** Whether `contributor` has already pulled their `cycleId` allocation. */
  async hasClaimed(cycleId: number, contributor: string): Promise<boolean> {
    this.assertAddress(contributor, 'contributor');
    const retval = await this.simulateRead(
      this.vault,
      VAULT_METHODS.hasClaimed,
      [u32ToScVal(cycleId), addressToScVal(contributor)],
      `claim status of ${contributor} for cycle ${cycleId}`,
    );
    return scValToBool(retval, 'has_claimed');
  }

  /** Vesting schedule for `contributor`, or `null` when none exists. */
  async getVesting(contributor: string): Promise<VestingInfo | null> {
    this.assertAddress(contributor, 'contributor');
    const retval = await this.simulateRead(
      this.vault,
      VAULT_METHODS.getVesting,
      [addressToScVal(contributor)],
      `vesting schedule of ${contributor}`,
    );
    if (isVoidScVal(retval)) return null;
    return parseVesting(scValToNativeValue(retval));
  }

  /** Decimals of the payout token, read from the token contract. */
  async getTokenDecimals(): Promise<number> {
    const retval = await this.simulateRead(
      this.token,
      TOKEN_METHODS.decimals,
      [],
      'token decimals',
    );
    const decimals = scValToBigInt(retval, 'token.decimals');
    if (decimals < 0n || decimals > 38n) {
      throw new SplitStreamError(`token contract reported an out-of-range decimals value: ${decimals}`);
    }
    return Number(decimals);
  }

  /**
   * The vault's own token balance - i.e. the reserve still available for
   * future cycles. Read straight from the token contract.
   */
  async getReserveBalance(): Promise<bigint> {
    const retval = await this.simulateRead(
      this.token,
      TOKEN_METHODS.balance,
      [addressToScVal(this.vaultContractId)],
      'vault reserve balance',
    );
    return scValToBigInt(retval, 'token.balance(vault)');
  }

  // ------------------------------------------------- unsigned transactions

  private async prepareInvocation(
    source: string,
    method: string,
    params: readonly xdr.ScVal[],
    what: string,
  ): Promise<Transaction> {
    let account: Account;
    try {
      account = await this.server.getAccount(source);
    } catch (error) {
      throw toSplitStreamError(
        error,
        `loading account ${source} (it must exist and be funded to pay the fee)`,
      );
    }

    const raw = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.vault.call(method, ...params))
      .setTimeout(30)
      .build();

    let simulation: rpc.Api.SimulateTransactionResponse;
    try {
      simulation = await this.server.simulateTransaction(raw);
    } catch (error) {
      throw toSplitStreamError(error, `simulating ${what}`);
    }
    if (rpc.Api.isSimulationError(simulation)) {
      throw toSplitStreamError(simulation.error, `simulating ${what}`);
    }

    return rpc.assembleTransaction(raw, simulation).build();
  }

  /**
   * Builds the unsigned `credit_claim` transaction.
   *
   * @param contributor - address claiming; also the transaction source
   * @param cycleId - cycle whose root the proof is for
   * @param amount - amount committed to in the leaf, base units
   * @param proof - sibling hashes, lowercase hex, from `merkleProof.ts`
   */
  async buildClaimTx(
    contributor: string,
    cycleId: number,
    amount: bigint,
    proof: readonly string[],
  ): Promise<Transaction> {
    this.assertAddress(contributor, 'contributor');
    if (amount < 0n) {
      throw new SplitStreamError(`claim amount must not be negative, received ${amount.toString()}`);
    }
    if (proof.length === 0) {
      throw new SplitStreamError('credit_claim requires a non-empty Merkle proof');
    }
    return this.prepareInvocation(
      contributor,
      VAULT_METHODS.creditClaim,
      [addressToScVal(contributor), u32ToScVal(cycleId), i128ToScVal(amount), proofToScVal(proof)],
      `credit_claim for cycle ${cycleId}`,
    );
  }

  /** Builds the unsigned `withdraw` transaction (step two of the pull payment). */
  async buildWithdrawTx(contributor: string): Promise<Transaction> {
    this.assertAddress(contributor, 'contributor');
    return this.prepareInvocation(
      contributor,
      VAULT_METHODS.withdraw,
      [addressToScVal(contributor)],
      'withdraw',
    );
  }

  /** Builds the unsigned `claim_vested` transaction. */
  async buildClaimVestedTx(contributor: string): Promise<Transaction> {
    this.assertAddress(contributor, 'contributor');
    return this.prepareInvocation(
      contributor,
      VAULT_METHODS.claimVested,
      [addressToScVal(contributor)],
      'claim_vested',
    );
  }

  // --------------------------------------------------------------- submit

  /**
   * Submits a signed envelope and polls Soroban RPC until it is final.
   *
   * @throws {SplitStreamError} on rejection or failure, with the contract's
   * numeric error code decoded into its SplitStream name when available.
   */
  async submitSigned(signedXdr: string): Promise<SubmittedTransaction> {
    let transaction: Transaction | FeeBumpTransaction;
    try {
      transaction = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SplitStreamError(`could not decode the signed transaction envelope: ${detail}`, {
        details: detail,
      });
    }

    const sent = await this.sendWithRetry(transaction);
    const hash = sent.hash;
    const deadline = Date.now() + this.pollTimeoutMs;

    for (;;) {
      let response: rpc.Api.GetTransactionResponse;
      try {
        response = await this.server.getTransaction(hash);
      } catch (error) {
        throw toSplitStreamError(error, `polling transaction ${hash}`);
      }

      if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return { hash, status: 'SUCCESS' };
      }

      if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
        const code = findContractErrorCode(response.diagnosticEventsXdr);
        if (code !== null) {
          throw contractError(code, `transaction ${hash}`, safeToXdr(response.resultXdr));
        }
        throw new SplitStreamError(`transaction ${hash} failed on-chain`, {
          details: safeToXdr(response.resultXdr),
        });
      }

      if (Date.now() >= deadline) {
        throw new SplitStreamError(
          `timed out after ${Math.round(this.pollTimeoutMs / 1000)}s waiting for transaction ${hash}; ` +
            'it may still land - check the explorer before retrying',
        );
      }

      await delay(this.pollIntervalMs);
    }
  }

  private async sendWithRetry(
    transaction: Transaction | FeeBumpTransaction,
  ): Promise<rpc.Api.SendTransactionResponse> {
    let last: rpc.Api.SendTransactionResponse | undefined;

    for (let attempt = 1; attempt <= SUBMIT_RETRY_ATTEMPTS; attempt += 1) {
      let sent: rpc.Api.SendTransactionResponse;
      try {
        sent = await this.server.sendTransaction(transaction);
      } catch (error) {
        throw toSplitStreamError(error, 'submitting the signed transaction');
      }

      if (sent.status !== 'TRY_AGAIN_LATER') {
        if (sent.status === 'ERROR') {
          const code = findContractErrorCode(sent.diagnosticEvents);
          if (code !== null) {
            throw contractError(code, 'submission', safeToXdr(sent.errorResult));
          }
          throw new SplitStreamError(
            'the network rejected the transaction before inclusion',
            { details: sent.errorResult ? safeToXdr(sent.errorResult) : `status=${sent.status}` },
          );
        }
        return sent;
      }

      last = sent;
      if (attempt < SUBMIT_RETRY_ATTEMPTS) {
        await delay(this.pollIntervalMs);
      }
    }

    throw new SplitStreamError(
      `the RPC node kept answering TRY_AGAIN_LATER after ${SUBMIT_RETRY_ATTEMPTS} attempts; ` +
        'the network may be congested (or this transaction is not the next sequence number)',
      { details: last ? `hash=${last.hash}` : undefined },
    );
  }

  private assertAddress(address: string, name: string): void {
    if (!StrKey.isValidEd25519PublicKey(address)) {
      throw new SplitStreamError(`${name} must be a valid Stellar account (G...), received "${address}"`);
    }
  }
}

/** Best-effort XDR stringification for `--verbose` detail; never throws. */
function safeToXdr(value: { toXdr(format: 'base64'): string } | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return value.toXdr('base64');
  } catch {
    return undefined;
  }
}
