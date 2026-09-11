import { SplitStreamError, hexToBytes, truncateAddress } from '@splitstream/sdk';
import { Keypair, StrKey, Transaction, xdr } from '@stellar/stellar-sdk';

import { isMainnet } from './config.js';

/**
 * Signing.
 *
 * ## Security decision: no plaintext mainnet secret keys in the terminal
 *
 * Freighter is a browser extension and cannot be driven from a Node process, so
 * the CLI deliberately does **not** offer "paste your secret key" as a general
 * path. There are exactly two ways to sign:
 *
 * 1. `local` - a keypair read from the `SPLITSTREAM_DEV_SECRET_KEY` environment
 *    variable. It is labelled INSECURE everywhere it is printed and is hard
 *    blocked unless the network passphrase is a test network. It is never
 *    accepted from a command-line flag or a config file (see SECURITY.md).
 * 2. `hardware` - signing delegated to a Ledger device through the optional
 *    `@ledgerhq/hw-app-str` package, which keeps the key off the machine.
 *
 * A mainnet claim therefore requires a hardware wallet, by construction.
 */

/** Which signing method the user picked. */
export type WalletKind = 'local' | 'hardware';

/** A signer for one session. The key is never logged by this module. */
export interface Signer {
  readonly kind: WalletKind;
  /** Human-readable description for confirmation prompts. */
  readonly label: string;
  /** Address this signer controls. */
  getPublicKey(): Promise<string>;
  /**
   * Signs an assembled transaction and returns the signed envelope as base64.
   * Mutates the transaction by attaching a decorated signature.
   */
  sign(transaction: Transaction): Promise<string>;
}

/** Default Ledger derivation path for Stellar (SLIP-0044 coin type 148). */
export const DEFAULT_LEDGER_PATH = "44'/148'/0'";

/** Ledger packages are optional; nothing is required to run on testnet. */
const LEDGER_TRANSPORT_PACKAGE = '@ledgerhq/hw-transport-node-hid';
const LEDGER_APP_PACKAGE = '@ledgerhq/hw-app-str';

/**
 * Creates a signer backed by a locally stored keypair.
 *
 * @throws {SplitStreamError} on a mainnet passphrase - this path is testnet-only
 */
export function createLocalSigner(secretKey: string, networkPassphrase: string): Signer {
  const seed = secretKey.trim();
  if (!StrKey.isValidEd25519SecretSeed(seed)) {
    throw new SplitStreamError(
      'SPLITSTREAM_DEV_SECRET_KEY is not a valid Stellar secret seed (should start with "S")',
    );
  }

  if (isMainnet(networkPassphrase)) {
    throw new SplitStreamError(
      'refusing to sign a mainnet transaction with the local testnet keypair. ' +
        'The local key store is testnet-only by design; sign mainnet transactions with a hardware wallet ' +
        'instead: splitstream claim --cycle <id> --wallet hardware',
    );
  }

  const keypair = Keypair.fromSecret(seed);
  return {
    kind: 'local',
    label: `local testnet keypair ${truncateAddress(keypair.publicKey())} (INSECURE, testnet-only)`,
    getPublicKey: async () => keypair.publicKey(),
    sign: async (transaction: Transaction) => {
      transaction.sign(keypair);
      return transaction.toEnvelope().toXdr('base64');
    },
  };
}

interface LedgerTransport {
  close(): Promise<void>;
}

interface LedgerApp {
  getPublicKey(path: string): Promise<{ publicKey: string } | string>;
  signTransaction(
    path: string,
    payload: Uint8Array | string,
  ): Promise<{ signature: string } | string>;
}

/**
 * Dynamically loads a module that may not be installed.
 *
 * A static import would be a hard dependency, and `@ledgerhq/hw-transport-node-hid`
 * needs a native USB build that most contributors never want. A missing module
 * is reported as an actionable error instead of a stack trace.
 */
async function optionalImport(specifier: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(specifier)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function openLedgerApp(): Promise<{ app: LedgerApp; transport: LedgerTransport }> {
  const transportModule = await optionalImport(LEDGER_TRANSPORT_PACKAGE);
  const appModule = await optionalImport(LEDGER_APP_PACKAGE);

  if (!transportModule || !appModule) {
    throw new SplitStreamError(
      'hardware wallet signing needs the optional Ledger packages, which are not installed.\n' +
        `  npm install --save-optional ${LEDGER_TRANSPORT_PACKAGE} ${LEDGER_APP_PACKAGE}\n` +
        'Freighter is a browser extension and cannot be driven from a terminal, so a Ledger device is the ' +
        'supported way to sign mainnet claims from the CLI.',
    );
  }

  const Transport = (transportModule.default ?? transportModule) as {
    create(): Promise<LedgerTransport>;
  };
  const StrApp = (appModule.default ?? appModule) as new (transport: LedgerTransport) => LedgerApp;

  const transport = await Transport.create();
  return { app: new StrApp(transport), transport };
}

function publicKeyFromLedgerResult(result: { publicKey: string } | string): string {
  const raw = typeof result === 'string' ? result : result.publicKey;
  if (typeof raw !== 'string' || raw === '') {
    throw new SplitStreamError('the Ledger device did not return a public key');
  }
  // The device returns raw hex; StrKey wraps it as a G... address.
  return StrKey.encodeEd25519PublicKey(hexToBytes(raw, 'device public key'));
}

function signatureFromLedgerResult(result: { signature: string } | string): Uint8Array {
  const raw = typeof result === 'string' ? result : result.signature;
  if (typeof raw !== 'string' || raw === '') {
    throw new SplitStreamError('the Ledger device returned an empty signature');
  }
  const signature = hexToBytes(raw, 'device signature');
  if (signature.length !== 64) {
    throw new SplitStreamError(`the Ledger device returned a ${signature.length}-byte signature, expected 64`);
  }
  return signature;
}

/**
 * Reads the address held by a connected Ledger device, without signing
 * anything. Used to match the device against a manifest row before the user is
 * asked to approve anything.
 */
export async function readLedgerPublicKey(
  derivationPath: string = DEFAULT_LEDGER_PATH,
): Promise<string> {
  const { app, transport } = await openLedgerApp();
  try {
    return publicKeyFromLedgerResult(await app.getPublicKey(derivationPath));
  } catch (error) {
    throw error instanceof SplitStreamError
      ? error
      : new SplitStreamError(
          `could not read the public key from the Ledger device: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
  } finally {
    await transport.close().catch(() => undefined);
  }
}

/**
 * Creates a signer backed by a Ledger device.
 *
 * The device's address is checked against `expectedAddress` before anything is
 * signed, so a wrong device (or wrong derivation path) fails before the user
 * approves a transaction that could not succeed.
 *
 * @param expectedAddress - address the transaction is sourced from
 * @param derivationPath - Ledger path, defaults to `44'/148'/0'`
 */
export async function createHardwareSigner(
  expectedAddress: string,
  derivationPath: string = DEFAULT_LEDGER_PATH,
): Promise<Signer> {
  const { app, transport } = await openLedgerApp();

  let publicKey: string;
  try {
    publicKey = publicKeyFromLedgerResult(await app.getPublicKey(derivationPath));
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error instanceof SplitStreamError
      ? error
      : new SplitStreamError(
          `could not read the public key from the Ledger device: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
  }

  if (publicKey !== expectedAddress) {
    await transport.close().catch(() => undefined);
    throw new SplitStreamError(
      `the connected device holds ${publicKey}, but this claim is sourced from ${expectedAddress}. ` +
        `Use the matching device, or change the derivation path (current: ${derivationPath}).`,
    );
  }

  return {
    kind: 'hardware',
    label: `Ledger device ${truncateAddress(publicKey)} at ${derivationPath}`,
    getPublicKey: async () => publicKey,
    sign: async (transaction: Transaction) => {
      try {
        const signature = signatureFromLedgerResult(
          await app.signTransaction(derivationPath, transaction.signatureBase()),
        );
        transaction.addDecoratedSignature(
          new xdr.DecoratedSignature({
            hint: StrKey.decodeEd25519PublicKey(publicKey).slice(-4),
            signature,
          }),
        );
        return transaction.toEnvelope().toXdr('base64');
      } finally {
        await transport.close().catch(() => undefined);
      }
    },
  };
}

/**
 * Resolves a signer for the requested wallet kind, prompting when the user did
 * not pass `--wallet`.
 *
 * @param kind - explicit choice from a flag, if any
 * @param expectedAddress - address the transaction is sourced from
 * @param devSecretKey - value of SPLITSTREAM_DEV_SECRET_KEY, if set
 * @param networkPassphrase - used to block the local signer on mainnet
 */
export async function resolveSigner(options: {
  kind?: WalletKind;
  expectedAddress: string;
  devSecretKey?: string;
  networkPassphrase: string;
  select: () => Promise<WalletKind>;
}): Promise<Signer> {
  const kind = options.kind ?? (await options.select());

  if (kind === 'hardware') {
    return createHardwareSigner(options.expectedAddress);
  }

  if (!options.devSecretKey) {
    throw new SplitStreamError(
      'the local testnet keypair was selected but SPLITSTREAM_DEV_SECRET_KEY is not set.\n' +
        'Set it in .env (testnet only, never commit it), or sign with a hardware wallet instead:\n' +
        '  splitstream claim --cycle <id> --wallet hardware',
    );
  }

  const signer = createLocalSigner(options.devSecretKey, options.networkPassphrase);
  const address = await signer.getPublicKey();
  if (address !== options.expectedAddress) {
    throw new SplitStreamError(
      `SPLITSTREAM_DEV_SECRET_KEY holds ${address}, but this claim is for ${options.expectedAddress}. ` +
        'The local key can only sign for its own account.',
    );
  }
  return signer;
}
