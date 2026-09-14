import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ManifestNotFoundError,
  candidateLocalPaths,
  discoverManifestCycleIds,
  loadManifest,
  type FetchTextLike,
} from '../src/manifest.js';
import { ManifestParseError } from '@splitstream/sdk';
import { manifestDirectory, writeManifestFile } from './fixtures.js';

const REPO = 'owner/name';
const URL_FOR_CYCLE_3 = `https://raw.githubusercontent.com/${REPO}/main/manifests/cycle-3.json`;

/**
 * A `fetch` stub that behaves like the real thing: the body can be read once.
 *
 * The strictness is the point. A stub whose `text()` can be called repeatedly
 * hides a double-read defect, which is exactly how the remote branch of
 * `loadManifest` shipped broken.
 */
function remoteFetch(
  body: string,
  options: { ok?: boolean; status?: number } = {},
): { fetchImpl: FetchTextLike; calls: string[]; readCount: () => number } {
  const calls: string[] = [];
  let reads = 0;
  const fetchImpl: FetchTextLike = async (url) => {
    calls.push(url);
    return {
      ok: options.ok ?? true,
      status: options.status ?? 200,
      text: async () => {
        reads += 1;
        if (reads > 1) {
          throw new TypeError('Body is unusable: Body has already been read');
        }
        return body;
      },
    };
  };
  return { fetchImpl, calls, readCount: () => reads };
}

function fixtureManifestText(cycleId = 3): string {
  return readFileSync(writeManifestFile({ cycleId }), 'utf8');
}

/** Runs `fn` with the process working directory temporarily changed. */
async function withCwd<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

/**
 * Captures the error a promise rejects with.
 *
 * The stub's single-read guard is per-stub, so each rejecting case is loaded
 * once and asserted against the captured error instead of loading twice.
 */
async function rejection(promise: Promise<unknown>): Promise<{ error: unknown; message: string }> {
  try {
    await promise;
  } catch (error) {
    return {
      error,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  throw new Error('expected the promise to reject, but it resolved');
}

describe('discoverManifestCycleIds', () => {
  it('lists the cycles that have a manifest, ascending', () => {
    expect(discoverManifestCycleIds(manifestDirectory([5, 3, 4]))).toEqual([3, 4, 5]);
  });

  it('returns nothing when there is no manifests directory', () => {
    expect(discoverManifestCycleIds(mkdtempSync(join(tmpdir(), 'splitstream-empty-')))).toEqual([]);
  });
});

describe('candidateLocalPaths', () => {
  it('prefers manifests/cycle-<id>.json, then manifests/<id>.json, then the root', () => {
    expect(candidateLocalPaths(3, '/repo')).toEqual([
      join('/repo', 'manifests', 'cycle-3.json'),
      join('/repo', 'manifests', '3.json'),
      join('/repo', 'cycle-3.json'),
    ]);
  });
});

describe('loadManifest source preference', () => {
  it('uses an explicit --manifest path and never calls GitHub', async () => {
    const path = writeManifestFile({ cycleId: 3 });
    const remote = remoteFetch(fixtureManifestText(3));

    const loaded = await loadManifest({ cycleId: 3, manifestPath: path, repo: REPO, fetchImpl: remote.fetchImpl });

    expect(loaded.manifest.cycleId).toBe(3);
    expect(loaded.source).toBe(path);
    expect(remote.calls).toEqual([]);
  });

  it('prefers a local checkout passed via --repo over fetching from GitHub', async () => {
    const checkout = manifestDirectory([3]);
    const remote = remoteFetch('{}');

    const loaded = await loadManifest({ cycleId: 3, repo: checkout, fetchImpl: remote.fetchImpl });

    expect(loaded.manifest.cycleId).toBe(3);
    expect(loaded.source).toBe(join(checkout, 'manifests', 'cycle-3.json'));
    expect(remote.calls).toEqual([]);
  });

  it('falls back to the working directory', async () => {
    const cwd = manifestDirectory([3]);
    const loaded = await withCwd(cwd, () => loadManifest({ cycleId: 3 }));
    expect(loaded.manifest.cycleId).toBe(3);
  });
});

describe('loadManifest remote branch', () => {
  it('reads the manifest from raw.githubusercontent.com at the given ref', async () => {
    const body = fixtureManifestText(3);
    const remote = remoteFetch(body);

    const loaded = await loadManifest({ cycleId: 3, repo: REPO, gitRef: 'release', fetchImpl: remote.fetchImpl });

    expect(remote.calls).toEqual([
      `https://raw.githubusercontent.com/${REPO}/release/manifests/cycle-3.json`,
    ]);
    expect(loaded.manifest.cycleId).toBe(3);
    expect(loaded.manifest.totalIssuesClosed).toBeGreaterThan(0);
    expect(loaded.source).toBe(remote.calls[0]);
  });

  it('reads the response body exactly once and returns it verbatim', async () => {
    const body = fixtureManifestText(3);
    const remote = remoteFetch(body);

    const loaded = await loadManifest({ cycleId: 3, repo: REPO, fetchImpl: remote.fetchImpl });

    // The default `--ref` is `main`.
    expect(remote.calls).toEqual([URL_FOR_CYCLE_3]);
    expect(remote.readCount()).toBe(1);
    expect(loaded.json).toBe(body);
  });

  it('reports a 404 as a manifest-not-found error naming the ways out', async () => {
    const remote = remoteFetch('Not Found', { ok: false, status: 404 });

    const { error, message } = await rejection(
      loadManifest({ cycleId: 3, repo: REPO, fetchImpl: remote.fetchImpl }),
    );

    expect(error).toBeInstanceOf(ManifestNotFoundError);
    expect(message).toMatch(/HTTP 404/);
    expect(message).toMatch(/--repo and --ref/);
    expect(message).toMatch(/--manifest/);
    expect(remote.readCount()).toBe(0);
  });

  it('names the URL when the fetched body is not valid JSON', async () => {
    const remote = remoteFetch('<html>not json</html>');

    const { error, message } = await rejection(
      loadManifest({ cycleId: 3, repo: REPO, fetchImpl: remote.fetchImpl }),
    );

    expect(error).toBeInstanceOf(ManifestParseError);
    expect(message).toContain(URL_FOR_CYCLE_3);
    expect(message).toMatch(/not valid JSON/);
  });

  it('names the URL when the fetched body is JSON but not a manifest', async () => {
    const remote = remoteFetch('{"hello":"world"}');

    await expect(
      loadManifest({ cycleId: 3, repo: REPO, fetchImpl: remote.fetchImpl }),
    ).rejects.toThrow(URL_FOR_CYCLE_3);
  });

  it('surfaces a transport failure instead of pretending there is no manifest', async () => {
    const fetchImpl: FetchTextLike = async () => {
      throw new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com');
    };

    await expect(loadManifest({ cycleId: 3, repo: REPO, fetchImpl })).rejects.toThrow(
      /could not reach GitHub.*ENOTFOUND/s,
    );
  });
});

describe('loadManifest when nothing is found', () => {
  it('lists every candidate path it looked at', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'splitstream-none-'));
    try {
      const { error, message } = await rejection(withCwd(cwd, () => loadManifest({ cycleId: 12 })));

      expect(error).toBeInstanceOf(ManifestNotFoundError);
      expect(message).toMatch(/no manifest for cycle 12 found/);
      expect(message).toMatch(/manifests\/cycle-12\.json/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
