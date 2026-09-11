# splitstream-sdk-cli

Client tooling for SplitStream, the pro-rata contributor payout vault on Stellar:
a typed SDK over the deployed `splitstream-core` contract, and a terminal CLI for
simulating, inspecting, claiming and reporting on a cycle's payouts.

- **`@splitstream/sdk`** - a thin, typed client. It never signs: `build*` methods
  return unsigned transactions for you to sign with a wallet, a hardware device,
  or a locally stored testnet key. Browser-safe (no `node:crypto`, no CLI deps).
- **`splitstream`** (CLI) - the operational cockpit:
  [`simulate`](#splitstream-simulate), [`status`](#splitstream-status),
  [`claim`](#splitstream-claim), [`report`](#splitstream-report).

Requires **Node.js >= 20**.

## Repository layout

```
packages/
  sdk/   @splitstream/sdk - typed vault client, Merkle proofs, amount math
  cli/   splitstream-cli  - commander-based terminal app (bin: splitstream)
```

## Getting started

```bash
npm install
npm run build     # builds the SDK, then the CLI
npm test          # runs both workspaces' vitest suites
```

Run the CLI straight from the build output:

```bash
node packages/cli/dist/index.js --help
```

`npm run typecheck` type-checks both workspaces without emitting anything.

## Configuration

Copy `.env.example` to `.env` and fill it in - `.env` is loaded on startup and is
never committed.

| Variable | Purpose |
| --- | --- |
| `SPLITSTREAM_RPC_URL` | Soroban RPC endpoint, e.g. `https://soroban-testnet.stellar.org` |
| `SPLITSTREAM_NETWORK_PASSPHRASE` | Must match the RPC endpoint's network |
| `SPLITSTREAM_VAULT_CONTRACT_ID` | Vault contract (`C...`) |
| `SPLITSTREAM_TOKEN_CONTRACT_ID` | Payout token contract (`C...`) |
| `SPLITSTREAM_DEV_SECRET_KEY` | **Testnet-only, insecure** local signing seed |
| `GITHUB_TOKEN` | Optional; raises `simulate`'s GitHub rate limit |
| `SPLITSTREAM_CONFIG` | Optional path to a JSON config file |

Precedence is **flags → environment → config file**. Contract ids are validated
as real Soroban ids (`C...`, including the StrKey checksum). `simulate` never
touches the chain, so it needs none of the chain variables.

### Config file

A JSON object, read from `SPLITSTREAM_CONFIG`, then `./splitstream.config.json`,
then `~/.config/splitstream/config.json`:

```json
{
  "rpcUrl": "https://soroban-testnet.stellar.org",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "vaultContractId": "C...",
  "tokenContractId": "C...",
  "githubToken": "..."
}
```

A config file containing `devSecretKey`, `secretKey`, `stellarSecret` or a similar
field is rejected outright: signing keys are never read from a file.

## Commands

Every command supports `-v, --verbose`, which prints stack traces and raw RPC
detail on failure. Commands that talk to the chain also accept `--rpc-url`,
`--network-passphrase`, `--vault` and `--token` to override the environment.

### `splitstream simulate`

Dry run over a repository's pull requests: reads GitHub, applies the points
rules below, and estimates the pro-rata payout plus the cost of the eventual
`post_cycle_root` call. It never contacts RPC and never signs.

```bash
splitstream simulate --cycle 3 --pool 100000 --map handles.json
splitstream simulate --repo owner/name --manifest manifests/cycle-3.json --json
```

| Flag | Meaning |
| --- | --- |
| `--repo <owner/name>` | Repository to read PRs from (defaults to the `origin` remote) |
| `--cycle <id>`, `--manifest <path>` | Cycle to simulate; a manifest supplies pool, decimals and cycle id |
| `--ref <ref>` | Git ref to read manifests from (default `main`) |
| `--pool <amount>` | Pool size in whole tokens (overrides the manifest) |
| `--decimals <n>` | Token decimals when no manifest is available (default `7`) |
| `--map <path>` | JSON object of `handle -> Stellar address` |
| `--max-prs <n>` | Maximum pull requests to score (default `300`) |
| `--json` | Machine-readable output |

### `splitstream status`

Vault reserve, recent cycle distributions and (with `--contributor`) a single
contributor's balance, vesting and claimed/pending cycles.

```bash
splitstream status --contributor GABC...XYZ
splitstream status --cycles 10 --json
```

| Flag | Meaning |
| --- | --- |
| `--contributor <G...>` | Contributor address to report on |
| `--cycle <id>` | Show a single cycle instead of a range |
| `--cycles <n>` | How many recent cycles to show (default `5`) |
| `--manifest`, `--repo`, `--ref` | Where to read the last cycle's manifest from |
| `--json` | Machine-readable output |

Cycle ranges are anchored on the highest cycle id with a manifest in
`manifests/`, so the contract does not need a call to discover them.

### `splitstream claim`

The two-step pull payment. `credit_claim` proves the contributor's allocation
against the cycle's Merkle root and credits their vault balance; `withdraw` then
moves it out. They are always two separately signed transactions, and the command
offers the second one explicitly rather than merging them.

```bash
splitstream claim --cycle 3 --manifest manifests/cycle-3.json
splitstream claim --cycle 3 --repo owner/name --wallet hardware
```

| Flag | Meaning |
| --- | --- |
| `--cycle <id>` | **Required.** There is no way to guess which cycle to claim |
| `--manifest`, `--repo`, `--ref` | Where to read the manifest from |
| `--contributor <address\|handle>` | Who is claiming; defaults to the signing wallet |
| `--wallet local\|hardware` | Signing method (defaults to a prompt) |
| `-y, --yes` | Skip the confirmation prompt |
| `--force` | Proceed even when the recomputed root disagrees with the manifest |
| `--no-withdraw` | Stop after `credit_claim` |

Before signing, the CLI recomputes the Merkle root from the manifest's own rows.
If it disagrees with the published root it refuses to submit (the proof would
fail on-chain) unless `--force` is passed, which is reported loudly.

### `splitstream report`

Generates the per-cycle transparency report as plain markdown (no embedded
HTML), suitable for GitHub release notes or a PR description.

```bash
splitstream report --cycle 3 --manifest manifests/cycle-3.json
splitstream report --cycle 3 --stdout > report.md
```

| Flag | Meaning |
| --- | --- |
| `--cycle <id>` | **Required.** Cycle to report on |
| `--manifest`, `--repo`, `--ref` | Where to read the manifest from |
| `--out <path>` | Output path (default `SPLITSTREAM_REPORT.md`) |
| `--concurrency <n>` | Parallel contract reads, 1-20 (default `5`) |
| `--stdout` | Print the report instead of writing it to disk |

The report includes the cycle summary, a per-contributor allocation table, the
dust remainder when the pool does not divide evenly, and a `splitstream status`
snippet that reproduces every number.

## Signing and key handling

There are exactly two ways to sign, and neither of them is "paste a secret key
into the terminal":

1. **`local`** - a keypair from `SPLITSTREAM_DEV_SECRET_KEY`. It is labelled
   `INSECURE, testnet-only` wherever it is printed, and it is **hard-blocked on
   mainnet**. It is never accepted from a flag or a config file.
2. **`hardware`** - signing delegated to a Ledger device via the optional
   `@ledgerhq/hw-app-str` and `@ledgerhq/hw-transport-node-hid` packages, which
   keeps the key off the machine. Ledger support is installed on demand; the
   CLI tells you to run
   `npm install --save-optional @ledgerhq/hw-transport-node-hid @ledgerhq/hw-app-str`
   if the packages are missing.

A mainnet claim therefore requires a hardware wallet, by construction.

## Cycles and manifests

A manifest is the contract between the action that publishes a cycle
(`splitstream-actions`) and this tooling. It lives at
`manifests/cycle-<id>.json` and is fetched from a local checkout, from GitHub at
`--ref`, or read from `--manifest`:

```json
{
  "version": 1,
  "cycleId": 3,
  "poolAmount": "100000000",
  "totalPoints": 100,
  "tokenDecimals": 7,
  "root": "…64 hex characters…",
  "generatedAt": "2026-09-01T00:00:00.000Z",
  "dust": "0",
  "contributors": [
    { "github": "ada", "address": "G...", "points": 50, "amount": "50000000" }
  ]
}
```

Field aliases are accepted for `cycle`/`cycleId` and `root`/`merkleRoot`. Token
amounts cross the JSON boundary as **decimal strings in base units** and become
`bigint` at parse time - JSON numbers are never used for token amounts anywhere
in this codebase.

### Points rules

`simulate` scores pull requests with an explicit, auditable rule set. Label
matches win over size buckets:

- A `points:N` label (also `pts:N`, `point:N`, letter case ignored) awards `N`
  points. The explicit set is 10, 25, 50, 100, 150 and 200.
- Otherwise a `size/XS|S|M|L|XL` label is used.
- Otherwise points fall back to PR size by total churn
  (`additions + deletions`):

  | Churn | ≤ 10 | ≤ 50 | ≤ 200 | ≤ 500 | > 500 |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Points | 10 | 25 | 50 | 100 | 200 |

Unmerged pull requests score the same as merged ones by default. Allocations are
split with integer arithmetic only; the remainder stays in the vault as dust,
matching the on-chain behaviour the manifest records.

## Using the SDK

```ts
import { SplitStreamClient } from '@splitstream/sdk';

const client = new SplitStreamClient({
  rpcUrl: process.env.SPLITSTREAM_RPC_URL!,
  networkPassphrase: process.env.SPLITSTREAM_NETWORK_PASSPHRASE!,
  vaultContractId: process.env.SPLITSTREAM_VAULT_CONTRACT_ID!,
  tokenContractId: process.env.SPLITSTREAM_TOKEN_CONTRACT_ID!,
});

const balance = await client.getBalance(address);      // bigint, base units
const root = await client.getCycleRoot(3);             // lowercase hex, or null
const claimed = await client.hasClaimed(3, address);

const tx = await client.buildClaimTx(address, 3, amount, proof); // unsigned
const signedXdr = await myWallet.sign(tx);                        // you sign it
const { hash } = await client.submitSigned(signedXdr);
```

Reads: `getBalance`, `getCycleRoot`, `hasClaimed`, `getVesting`,
`getTokenDecimals`, `getReserveBalance`.
Builds: `buildClaimTx`, `buildWithdrawTx`, `buildClaimVestedTx`.
The package also exports the Merkle proof helpers (`buildClaimProof`,
`verifyMerkleProof`, `computeMerkleRoot`), amount formatting
(`formatTokenAmount`, `parseTokenAmount`), manifest parsing (`parseManifest`)
and contract-error decoding (`SplitStreamError`).

## License

Apache-2.0.
