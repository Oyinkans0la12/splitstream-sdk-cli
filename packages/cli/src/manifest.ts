import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ManifestParseError, parseManifest, type Manifest } from '@splitstream/sdk';

import { MANIFEST_DIRECTORY } from './config.js';

/** Raised when a cycle manifest cannot be located. */
export class ManifestNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestNotFoundError';
  }
}

/** Minimal text-fetch shape, injectable for tests. */
export type FetchTextLike = (
  url: string,
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface LoadManifestOptions {
  cycleId: number;
  /** Explicit path to a manifest JSON file. */
  manifestPath?: string;
  /** `owner/name` for a remote repository, or a local directory of a checkout. */
  repo?: string;
  /** Git ref to read from on a remote repository. */
  gitRef?: string;
  fetchImpl?: FetchTextLike;
}

export interface LoadedManifest {
  readonly manifest: Manifest;
  /** Where the manifest came from, for display. */
  readonly source: string;
  /** Raw JSON text, so the file can be copied verbatim. */
  readonly json: string;
}

/**
 * Cycle ids that have a manifest in `manifests/` of the given directory,
 * ascending. Lets `status` anchor on the most recent posted cycle without
 * needing a contract call to discover it.
 */
export function discoverManifestCycleIds(cwd: string = process.cwd()): number[] {
  const directory = join(cwd, MANIFEST_DIRECTORY);
  if (!isDirectory(directory)) return [];
  try {
    return readdirSync(directory)
      .map((name) => /^cycle-(\d+)\.json$/.exec(name)?.[1] ?? /^(\d+)\.json$/.exec(name)?.[1])
      .filter((value): value is string => value !== undefined)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** Local filenames checked when no `--manifest` or `--repo` is given. */
export function candidateLocalPaths(cycleId: number, cwd: string = process.cwd()): string[] {
  return [
    join(cwd, MANIFEST_DIRECTORY, `cycle-${cycleId}.json`),
    join(cwd, MANIFEST_DIRECTORY, `${cycleId}.json`),
    join(cwd, `cycle-${cycleId}.json`),
  ];
}

function readAndParse(path: string): LoadedManifest {
  let json: string;
  try {
    json = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ManifestNotFoundError(
      `could not read the manifest at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { manifest: parseOrExplain(json, path), source: resolve(path), json };
}

function parseOrExplain(json: string, source: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new ManifestParseError(
      `the manifest at ${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return parseManifest(raw);
  } catch (error) {
    if (error instanceof ManifestParseError) {
      throw new ManifestParseError(`${source}: ${error.message}`);
    }
    throw error;
  }
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function looksLikeLocalRepo(repo: string): boolean {
  return isDirectory(repo) || existsSync(repo);
}

function localRepoManifest(repo: string, cycleId: number): LoadedManifest | null {
  for (const candidate of candidateLocalPaths(cycleId, repo)) {
    if (existsSync(candidate)) return readAndParse(candidate);
  }
  return null;
}

/**
 * Loads a cycle manifest, in this order of preference:
 *
 * 1. an explicit `--manifest <path>`
 * 2. the `manifests/` directory of a local checkout passed via `--repo`
 * 3. `manifests/cycle-<id>.json` at the ref passed via `--repo` on GitHub
 * 4. `manifests/cycle-<id>.json` in the current working directory
 */
export async function loadManifest(options: LoadManifestOptions): Promise<LoadedManifest> {
  const { cycleId } = options;

  if (options.manifestPath) {
    return readAndParse(options.manifestPath);
  }

  if (options.repo && looksLikeLocalRepo(options.repo)) {
    const found = localRepoManifest(options.repo, cycleId);
    if (found) return found;
    throw new ManifestNotFoundError(
      `no cycle-${cycleId}.json found under ${join(options.repo, MANIFEST_DIRECTORY)}`,
    );
  }

  if (options.repo) {
    const ref = options.gitRef ?? 'main';
    const url = `https://raw.githubusercontent.com/${options.repo}/${ref}/${MANIFEST_DIRECTORY}/cycle-${cycleId}.json`;
    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchTextLike);
    if (typeof fetchImpl !== 'function') {
      throw new ManifestNotFoundError('no fetch implementation available; pass --manifest <path> instead');
    }
    let response: Awaited<ReturnType<FetchTextLike>>;
    try {
      response = await fetchImpl(url);
    } catch (error) {
      throw new ManifestNotFoundError(
        `could not reach GitHub for ${url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      throw new ManifestNotFoundError(
        `GitHub returned HTTP ${response.status} for ${url}. Check --repo and --ref, or pass --manifest <path>.`,
      );
    }
    return { manifest: parseOrExplain(await response.text(), url), source: url, json: await response.text() };
  }

  for (const candidate of candidateLocalPaths(cycleId)) {
    if (existsSync(candidate)) return readAndParse(candidate);
  }

  throw new ManifestNotFoundError(
    `no manifest for cycle ${cycleId} found. Looked in ${candidateLocalPaths(cycleId).join(', ')}. ` +
      'Pass --manifest <path>, or --repo owner/name to fetch it from the repository.',
  );
}
