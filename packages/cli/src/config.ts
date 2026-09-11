import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isValidContractId } from '@splitstream/sdk';
import { Networks } from '@stellar/stellar-sdk';
import { config as loadDotenv } from 'dotenv';

/** Raised for missing or malformed configuration. Message is user-facing. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Everything the CLI can read from flags, environment variables, or the
 * optional config file. Chain fields are optional here so commands that never
 * touch the network (`simulate`) work without any contract ids configured.
 */
export interface CliConfig {
  rpcUrl?: string;
  networkPassphrase?: string;
  vaultContractId?: string;
  tokenContractId?: string;
  /** Testnet-only signing key. Env var only - never accepted from a file or flag. */
  devSecretKey?: string;
  githubToken?: string;
  /** Path of the config file that was loaded, when one was. */
  configPath?: string;
  verbose: boolean;
}

/** Overrides from parsed CLI flags; highest precedence. */
export interface CliConfigOverrides {
  rpcUrl?: string;
  networkPassphrase?: string;
  vaultContractId?: string;
  tokenContractId?: string;
  configPath?: string;
  verbose?: boolean;
}

/** Chain fields that a network-touching command needs. */
export interface ChainConfig {
  rpcUrl: string;
  networkPassphrase: string;
  vaultContractId: string;
  tokenContractId: string;
}

/** Default directory searched for cycle manifests inside a repository. */
export const MANIFEST_DIRECTORY = 'manifests';

interface ConfigFile {
  rpcUrl?: unknown;
  networkPassphrase?: unknown;
  vaultContractId?: unknown;
  tokenContractId?: unknown;
  githubToken?: unknown;
  [key: string]: unknown;
}

/**
 * Keys we refuse to read from a config file. A key in a file is a key that can
 * be committed, copied into a Docker image, or shared in a support thread.
 */
const FORBIDDEN_CONFIG_FILE_KEYS = [
  'devSecretKey',
  'dev_secret_key',
  'secretKey',
  'secret_key',
  'secret',
  'seed',
  'stellarSecret',
];

function defaultConfigPath(): string {
  return join(homedir(), '.config', 'splitstream', 'config.json');
}

function localConfigPath(): string {
  return join(process.cwd(), 'splitstream.config.json');
}

function readConfigFile(explicitPath: string | undefined): { values: ConfigFile; path?: string } {
  const candidates = explicitPath ? [explicitPath] : [process.env.SPLITSTREAM_CONFIG, localConfigPath(), defaultConfigPath()];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(candidate, 'utf8'));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ConfigError(`could not parse the config file at ${candidate}: ${detail}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ConfigError(`the config file at ${candidate} must contain a JSON object`);
    }

    const values = parsed as ConfigFile;
    for (const forbidden of FORBIDDEN_CONFIG_FILE_KEYS) {
      if (values[forbidden] !== undefined) {
        throw new ConfigError(
          `the config file at ${candidate} contains "${forbidden}". SplitStream never reads a signing key ` +
            'from a config file: on-chain signing keys belong on a hardware wallet, and the local testnet ' +
            'key must be supplied as the SPLITSTREAM_DEV_SECRET_KEY environment variable.',
        );
      }
    }
    return { values, path: candidate };
  }
  return { values: {} };
}

function firstDefined(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function fileValue(values: ConfigFile, key: keyof ConfigFile): string | undefined {
  const value = values[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ConfigError(`config file field "${String(key)}" must be a string`);
  }
  return value.trim() === '' ? undefined : value.trim();
}

/**
 * Loads configuration in precedence order: CLI flags, then environment
 * variables, then the config file. `.env` is loaded first for local dev.
 */
export function loadConfig(overrides: CliConfigOverrides = {}): CliConfig {
  loadDotenv({ quiet: true });

  const { values, path } = readConfigFile(overrides.configPath);

  const config: CliConfig = { verbose: overrides.verbose === true };

  const rpcUrl = firstDefined(overrides.rpcUrl, process.env.SPLITSTREAM_RPC_URL, fileValue(values, 'rpcUrl'));
  if (rpcUrl) config.rpcUrl = rpcUrl;

  const networkPassphrase = firstDefined(
    overrides.networkPassphrase,
    process.env.SPLITSTREAM_NETWORK_PASSPHRASE,
    fileValue(values, 'networkPassphrase'),
  );
  if (networkPassphrase) config.networkPassphrase = networkPassphrase;

  const vaultContractId = firstDefined(
    overrides.vaultContractId,
    process.env.SPLITSTREAM_VAULT_CONTRACT_ID,
    fileValue(values, 'vaultContractId'),
  );
  if (vaultContractId) config.vaultContractId = vaultContractId;

  const tokenContractId = firstDefined(
    overrides.tokenContractId,
    process.env.SPLITSTREAM_TOKEN_CONTRACT_ID,
    fileValue(values, 'tokenContractId'),
  );
  if (tokenContractId) config.tokenContractId = tokenContractId;

  // The dev key is deliberately env-only: see SECURITY.md.
  const devSecretKey = firstDefined(process.env.SPLITSTREAM_DEV_SECRET_KEY);
  if (devSecretKey) config.devSecretKey = devSecretKey;

  const githubToken = firstDefined(process.env.GITHUB_TOKEN, fileValue(values, 'githubToken'));
  if (githubToken) config.githubToken = githubToken;

  if (path) config.configPath = path;

  return config;
}

/**
 * Asserts that everything needed to talk to the network is present, and
 * reports every missing variable at once instead of failing one at a time.
 */
export function requireChainConfig(config: CliConfig): ChainConfig {
  const missing: string[] = [];
  if (!config.rpcUrl) missing.push('SPLITSTREAM_RPC_URL');
  if (!config.networkPassphrase) missing.push('SPLITSTREAM_NETWORK_PASSPHRASE');
  if (!config.vaultContractId) missing.push('SPLITSTREAM_VAULT_CONTRACT_ID');
  if (!config.tokenContractId) missing.push('SPLITSTREAM_TOKEN_CONTRACT_ID');

  if (missing.length > 0) {
    throw new ConfigError(
      `this command needs the network configuration and it is not set: ${missing.join(', ')}.\n` +
        'Copy .env.example to .env and fill it in, or pass the values as flags.',
    );
  }

  for (const [name, value] of [
    ['SPLITSTREAM_VAULT_CONTRACT_ID', config.vaultContractId],
    ['SPLITSTREAM_TOKEN_CONTRACT_ID', config.tokenContractId],
  ] as const) {
    if (!isValidContractId(value as string)) {
      throw new ConfigError(`${name} must be a Soroban contract id (C...), received "${value}"`);
    }
  }

  return {
    rpcUrl: config.rpcUrl as string,
    networkPassphrase: config.networkPassphrase as string,
    vaultContractId: config.vaultContractId as string,
    tokenContractId: config.tokenContractId as string,
  };
}

/** True when the passphrase identifies the public network. */
export function isMainnet(networkPassphrase: string): boolean {
  return networkPassphrase.trim() === Networks.PUBLIC;
}

/** Human-readable network name for output headers. */
export function networkLabel(networkPassphrase: string): string {
  switch (networkPassphrase.trim()) {
    case Networks.PUBLIC:
      return 'mainnet';
    case Networks.TESTNET:
      return 'testnet';
    case Networks.FUTURENET:
      return 'futurenet';
    case Networks.SANDBOX:
      return 'sandbox';
    case Networks.STANDALONE:
      return 'standalone';
    default:
      return 'unknown network';
  }
}

function explorerSegment(networkPassphrase: string): string | null {
  switch (networkPassphrase.trim()) {
    case Networks.PUBLIC:
      return 'public';
    case Networks.TESTNET:
      return 'testnet';
    case Networks.FUTURENET:
      return 'futurenet';
    default:
      return null;
  }
}

/** stellar.expert link for a transaction hash, or null on an unknown network. */
export function explorerTxUrl(networkPassphrase: string, hash: string): string | null {
  const segment = explorerSegment(networkPassphrase);
  return segment === null ? null : `https://stellar.expert/explorer/${segment}/tx/${hash}`;
}

/** stellar.expert link for a contract, or null on an unknown network. */
export function explorerContractUrl(networkPassphrase: string, contractId: string): string | null {
  const segment = explorerSegment(networkPassphrase);
  return segment === null
    ? null
    : `https://stellar.expert/explorer/${segment}/contract/${contractId}`;
}
