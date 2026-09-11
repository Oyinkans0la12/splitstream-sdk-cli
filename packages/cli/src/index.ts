#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { registerClaimCommand } from './commands/claim.js';
import { registerReportCommand } from './commands/report.js';
import { registerSimulateCommand } from './commands/simulate.js';
import { registerStatusCommand } from './commands/status.js';
import { printError } from './output.js';

/**
 * `splitstream` - the operational cockpit for SplitStream payouts.
 *
 * Every command ends up here, so this is the single place that turns an
 * exception into a human-readable line. Raw stacks only appear with
 * `--verbose`.
 */

function readVersion(): string {
  try {
    const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('splitstream')
    .description(
      'Simulate, inspect and claim SplitStream contributor payouts.\n' +
        'Signing always happens on this machine or on a hardware wallet - the SDK never signs for you.',
    )
    .version(readVersion())
    .option('-v, --verbose', 'print stack traces and raw RPC detail on failure')
    .showHelpAfterError('(run `splitstream <command> --help` for usage)')
    .configureHelp({ sortSubcommands: true });

  registerSimulateCommand(program);
  registerStatusCommand(program);
  registerClaimCommand(program);
  registerReportCommand(program);

  program.addHelpText(
    'after',
    [
      '',
      'Examples:',
      '  splitstream simulate --cycle 3 --pool 100000 --map handles.json',
      '  splitstream status --contributor GABC...XYZ',
      '  splitstream claim --cycle 3 --manifest manifests/cycle-3.json',
      '  splitstream report --cycle 3 --manifest manifests/cycle-3.json',
      '',
      'Configuration comes from flags, then SPLITSTREAM_* environment variables,',
      'then a JSON config file. See .env.example and SECURITY.md.',
    ].join('\n'),
  );

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    printError(error, program.opts().verbose === true);
    process.exitCode = 1;
  }
}

// Only run when invoked as a program, so tests can import `buildProgram`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
