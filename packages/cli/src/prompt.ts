import inquirer from 'inquirer';

import type { WalletKind } from './wallet.js';

/**
 * Thin wrappers over Inquirer's legacy `prompt` API. Keeping them in one module
 * means command files read as a sequence of decisions rather than prompt
 * plumbing, and keeps the interactive surface easy to stub in tests.
 */

/** Asks which signing method to use. */
export async function promptWalletKind(defaultKind: WalletKind = 'local'): Promise<WalletKind> {
  const answer = await inquirer.prompt<{ wallet: WalletKind }>([
    {
      type: 'select',
      name: 'wallet',
      message: 'How should this transaction be signed?',
      default: defaultKind,
      choices: [
        {
          name: 'Local testnet keypair  (INSECURE - testnet only)',
          value: 'local' as WalletKind,
        },
        {
          name: 'Hardware wallet        (Ledger via @ledgerhq/hw-app-str)',
          value: 'hardware' as WalletKind,
        },
      ],
    },
  ]);
  return answer.wallet;
}

/** Yes/no confirmation, defaulting to `true` so the common path is one keypress. */
export async function promptConfirm(message: string, defaultValue = true): Promise<boolean> {
  const answer = await inquirer.prompt<{ confirmed: boolean }>([
    { type: 'confirm', name: 'confirmed', message, default: defaultValue },
  ]);
  return answer.confirmed;
}
