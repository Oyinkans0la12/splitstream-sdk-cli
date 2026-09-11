import { SplitStreamError } from '@splitstream/sdk';
import chalk from 'chalk';
import Table from 'cli-table3';

/** Renders an ASCII table; `head` is the header row. */
export function renderTable(
  head: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const table = new Table({
    head: [...head],
    style: { head: ['cyan'] },
  });
  for (const row of rows) {
    table.push([...row]);
  }
  return table.toString();
}

/** Section heading. */
export function heading(text: string): string {
  return chalk.bold.underline(text);
}

/** Subdued label for a value that follows. */
export function label(text: string): string {
  return chalk.gray(text);
}

export function success(text: string): string {
  return `${chalk.green('OK')} ${text}`;
}

export function warn(text: string): string {
  return `${chalk.yellow('WARNING')} ${text}`;
}

export function failure(text: string): string {
  return `${chalk.red('ERROR')} ${text}`;
}

export function note(text: string): string {
  return chalk.gray(text);
}

/**
 * Prints an error the way a terminal user expects: one clear sentence, with the
 * raw stack reserved for `--verbose`.
 */
export function printError(error: unknown, verbose: boolean): void {
  if (verbose && error instanceof Error && error.stack) {
    console.error(chalk.red(error.stack));
    return;
  }

  if (error instanceof SplitStreamError) {
    const suffix = error.code === undefined ? '' : chalk.gray(` [${error.codeName ?? error.code}]`);
    console.error(failure(error.message + suffix));
    if (error.details) console.error(note(`  ${error.details}`));
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(failure(message));
}
