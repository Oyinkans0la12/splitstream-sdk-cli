import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Networks } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConfigError,
  explorerContractUrl,
  explorerTxUrl,
  isMainnet,
  loadConfig,
  networkLabel,
  requireChainConfig,
} from '../src/config.js';
import { SECRET_A, TOKEN_ID, VAULT_ID } from './fixtures.js';

function configFile(values: Record<string, unknown>): string {
  const directory = mkdtempSync(join(tmpdir(), 'splitstream-config-'));
  const path = join(directory, 'config.json');
  writeFileSync(path, JSON.stringify(values, null, 2), 'utf8');
  return path;
}

function clearChainEnv(): void {
  for (const name of [
    'SPLITSTREAM_RPC_URL',
    'SPLITSTREAM_NETWORK_PASSPHRASE',
    'SPLITSTREAM_VAULT_CONTRACT_ID',
    'SPLITSTREAM_TOKEN_CONTRACT_ID',
    'SPLITSTREAM_DEV_SECRET_KEY',
    'SPLITSTREAM_CONFIG',
    'GITHUB_TOKEN',
  ]) {
    vi.stubEnv(name, '');
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadConfig precedence', () => {
  it('reads the config file when no flag or environment variable is set', () => {
    clearChainEnv();
    const path = configFile({
      rpcUrl: 'https://from-file.example',
      networkPassphrase: Networks.TESTNET,
      vaultContractId: VAULT_ID,
      tokenContractId: TOKEN_ID,
    });

    const config = loadConfig({ configPath: path });
    expect(config.rpcUrl).toBe('https://from-file.example');
    expect(config.configPath).toBe(path);
  });

  it('lets the environment beat the file and a flag beat both', () => {
    clearChainEnv();
    vi.stubEnv('SPLITSTREAM_RPC_URL', 'https://from-env.example');
    const path = configFile({
      rpcUrl: 'https://from-file.example',
      networkPassphrase: Networks.TESTNET,
      vaultContractId: VAULT_ID,
      tokenContractId: TOKEN_ID,
    });

    expect(loadConfig({ configPath: path }).rpcUrl).toBe('https://from-env.example');
    expect(loadConfig({ configPath: path, rpcUrl: 'https://from-flag.example' }).rpcUrl).toBe(
      'https://from-flag.example',
    );
  });

  it('honours SPLITSTREAM_CONFIG as the file location', () => {
    clearChainEnv();
    const path = configFile({ rpcUrl: 'https://from-env-file.example' });
    vi.stubEnv('SPLITSTREAM_CONFIG', path);
    expect(loadConfig().rpcUrl).toBe('https://from-env-file.example');
  });
});

describe('signing keys are never read from a file', () => {
  it.each(['devSecretKey', 'secretKey', 'stellarSecret'])(
    'rejects a config file containing %s',
    (key) => {
      clearChainEnv();
      const path = configFile({ [key]: SECRET_A });
      expect(() => loadConfig({ configPath: path })).toThrow(ConfigError);
      expect(() => loadConfig({ configPath: path })).toThrow(/never reads a signing key/);
    },
  );

  it('reads the local testnet key from the environment only', () => {
    clearChainEnv();
    vi.stubEnv('SPLITSTREAM_DEV_SECRET_KEY', SECRET_A);
    expect(loadConfig().devSecretKey).toBe(SECRET_A);
  });
});

describe('requireChainConfig', () => {
  it('lists every missing variable at once', () => {
    clearChainEnv();
    expect(() => requireChainConfig(loadConfig())).toThrow(
      /SPLITSTREAM_RPC_URL, SPLITSTREAM_NETWORK_PASSPHRASE, SPLITSTREAM_VAULT_CONTRACT_ID, SPLITSTREAM_TOKEN_CONTRACT_ID/,
    );
  });

  it('rejects a vault or token id that is not a contract', () => {
    clearChainEnv();
    const config = loadConfig({
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: Networks.TESTNET,
      vaultContractId: 'GABC',
      tokenContractId: TOKEN_ID,
    });
    expect(() => requireChainConfig(config)).toThrow(/must be a Soroban contract id/);
  });

  it('returns the fully-resolved chain configuration', () => {
    clearChainEnv();
    const chain = requireChainConfig(
      loadConfig({
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: Networks.TESTNET,
        vaultContractId: VAULT_ID,
        tokenContractId: TOKEN_ID,
      }),
    );
    expect(chain).toEqual({
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: Networks.TESTNET,
      vaultContractId: VAULT_ID,
      tokenContractId: TOKEN_ID,
    });
  });
});

describe('network helpers', () => {
  it('names the networks the CLI knows', () => {
    expect(networkLabel(Networks.PUBLIC)).toBe('mainnet');
    expect(networkLabel(Networks.TESTNET)).toBe('testnet');
    expect(networkLabel(Networks.FUTURENET)).toBe('futurenet');
    expect(networkLabel('Something Else')).toBe('unknown network');
  });

  it('detects mainnet, which is what blocks the local signer', () => {
    expect(isMainnet(Networks.PUBLIC)).toBe(true);
    expect(isMainnet(` ${Networks.PUBLIC} `)).toBe(true);
    expect(isMainnet(Networks.TESTNET)).toBe(false);
  });

  it('builds explorer links and stays silent on unknown networks', () => {
    expect(explorerTxUrl(Networks.TESTNET, 'deadbeef')).toBe(
      'https://stellar.expert/explorer/testnet/tx/deadbeef',
    );
    expect(explorerTxUrl(Networks.PUBLIC, 'deadbeef')).toContain('/public/tx/');
    expect(explorerContractUrl(Networks.TESTNET, VAULT_ID)).toContain(`/testnet/contract/${VAULT_ID}`);
    expect(explorerTxUrl('Unknown Network', 'deadbeef')).toBeNull();
  });
});
