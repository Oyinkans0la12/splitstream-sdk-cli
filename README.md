<p align="center">
  <img src="assets/splitstream-banner.svg" alt="SplitStream banner" width="700" />
</p>

# SplitStream SDK & CLI

![CI](https://github.com/Oyinkans0la12/splitstream-sdk-cli/actions/workflows/ci.yml/badge.svg)
![Node](https://img.shields.io/badge/node-24-green)
![License](https://img.shields.io/github/license/Oyinkans0la12/splitstream-sdk-cli)

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

Client tooling for **SplitStream**, the pro-rata contributor payout vault on
Stellar: a typed SDK over the deployed [splitstream-core] contract, and a
terminal CLI for simulating, inspecting, claiming and reporting on a cycle's
payouts.

- **`@splitstream/sdk`** — a thin, typed client. It never signs: `build*` methods
  return unsigned transactions for you to sign with a wallet, a hardware device,
  or a locally stored testnet key. Browser-safe (no `node:crypto`, no CLI deps).
- **`splitstream`** (CLI) — the operational cockpit:
  [`simulate`](#splitstream-simulate), [`status`](#splitstream-status),
  [`claim`](#splitstream-claim), [`report`](#splitstream-report).

> The manifest this tooling reads is written by [splitstream-actions], and the
> vault it talks to is [splitstream-core]. The payout formula, Merkle leaf
> format, and manifest shape are a frozen cross-repo contract, not this repo's
> invention.

Requires **Node.js >= 20**.

## Deployed — Testnet

| | |
|---|---|
| Vault contract | `CCC2LP2LOYZOLA2JW4C4K7JMR3TRJZIKHDSQYSFJ3R3MCDJLVBT3PZOC` |
| Explorer | https://stellar.expert/explorer/testnet/contract/CCC2LP2LOYZOLA2JW4C4K7JMR3TRJZIKHDSQYSFJ3R3MCDJLVBT3PZOC |
| Network | Test SDF Network ; September 2015 (Testnet) |

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

Copy `.env.example` to `.env` and fill it in — `.env` is loaded on startup and is
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

Dry run over merged pull requests: reads GitHub, counts the distinct issues each
contributor closed (the same rule the deployed action uses), and estimates the
pro-rata payout plus the cost of the eventual `post_cycle_root` call. It never
contacts RPC and never signs.

```bash
splitstream simulate --cycle 3 --pool 100000 --map handles.json
splitstream simulate --repo owner/name --repo owner/other --manifest manifests/cycle-3.json --json
```

| Flag | Meaning |
| --- | --- |
| `--repo <owner/name>` | Repository to read merged PRs from (repeatable; defaults to the `origin` remote) |
| `--cycle <id>`, `--manifest <path>` | Cycle to simulate; a manifest supplies the pool and cycle id |
| `--ref <ref>` | Git ref to read manifests from (default `main`) |
| `--since <iso>` | Cycle window lower bound; defaults to the previous cycle manifest's `generatedAt` |
| `--pool <amount>` | Pool size in whole tokens (overrides the manifest) |
| `--decimals <n>` | Token decimals for display and `--pool` parsing (default `7`) |
| `--map <path>` | JSON object of `handle -> Stellar address` |
| `--max-prs <n>` | Maximum merged pull requests to consider (default `300`) |
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
If it disagrees with the published `merkleRoot` it refuses to submit (the proof
would fail on-chain) unless `--force` is passed, which is reported loudly.

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

1. **`local`** — a keypair from `SPLITSTREAM_DEV_SECRET_KEY`. It is labelled
   `INSECURE, testnet-only` wherever it is printed, and it is **hard-blocked on
   mainnet**. It is never accepted from a flag or a config file.
2. **`hardware`** — signing delegated to a Ledger device via the optional
   `@ledgerhq/hw-app-str` and `@ledgerhq/hw-transport-node-hid` packages, which
   keeps the key off the machine. Ledger support is installed on demand; the
   CLI tells you to run
   `npm install --save-optional @ledgerhq/hw-transport-node-hid @ledgerhq/hw-app-str`
   if the packages are missing.

A mainnet claim therefore requires a hardware wallet, by construction.

## Cycles and manifests

A manifest is the contract between the action that publishes a cycle
([splitstream-actions]) and this tooling. It lives at `manifests/cycle-<id>.json`
and is fetched from a local checkout, from GitHub at `--ref`, or read from
`--manifest`. This is the **real, current shape** the action writes:

```json
{
  "cycleId": 4,
  "generatedAt": "2026-09-10T00:00:00Z",
  "poolAmount": "5000000000",
  "totalIssuesClosed": 4,
  "entries": [
    { "github": "octocat", "stellar": "GABCDEF...", "issuesClosed": 3, "amount": "3750000000" }
  ],
  "dustRemainder": "3",
  "merkleRoot": "hex-encoded-32-byte-root"
}
```

- `entries` — one row per contributor; `stellar` is their `G...` account and
  `issuesClosed` is the count that produced the payout. There is no `address`
  or `points` field.
- `totalIssuesClosed` — the payout denominator (the sum of `entries[].issuesClosed`).
- `amount` and `poolAmount` — **decimal strings in base units**; they become
  `bigint` at parse time. JSON numbers are never used for token amounts.
- `dustRemainder` — the integer-division remainder left in the vault.
- `merkleRoot` — lowercase hex. `root` is accepted only as a read-compatibility
  alias; `merkleRoot` is the canonical field.

There is deliberately **no `version` field and no `tokenDecimals`**: token
decimals are a property of the SEP-41 token contract, so they are read from the
chain at runtime with `SplitStreamClient.getTokenDecimals()` rather than being
asserted by a data file that cannot verify them.

## Payout rule

The rule is deliberately minimal, and it is the exact rule the deployed action
uses. A qualifying issue is **any issue closed via a merged pull request that
contains a recognized closing keyword** — `Closes #N` / `Fixes #N` /
`Resolves #N`, case-insensitive — in one of the tracked repositories, inside the
cycle window.

- **No label of any kind is read.** Complexity, type, size and `points:*` labels
  are informational only and play no role in payout math.
- Every qualifying issue counts equally: **one issue, one share**.
- Each distinct issue closed by a contributor's PRs increments their count
  exactly once — the same issue referenced by two of their PRs is not
  double-counted — and counts are summed across every repository before shares
  are computed.
- Credit goes to the **PR author** (the PR closes the issue; the PR author did
  the work), not the issue author.

Payouts use the frozen formula, in integer arithmetic only:

```
contributor_amount = floor(poolAmount * contributor_issues_closed / totalIssuesClosed)
```

The remainder that does not divide evenly is recorded as `dustRemainder` and
stays in the vault, matching the on-chain behaviour the manifest records.

## Merkle proof format

The leaf format is **frozen** and shared byte-for-byte with [splitstream-core]
(which verifies it) and [splitstream-actions] (which builds it):

```
leaf = sha256( xdr_encode(ScVal(Address(stellar))) || xdr_encode(ScVal(i128(amount))) )

Address XDR (44 bytes):  u32(SCV_ADDRESS=18) | u32(SC_ADDRESS_TYPE_ACCOUNT=0) | u32(publickey ED25519=0) | ed25519(32)
i128 XDR     (20 bytes):  u32(SCV_I128=10) | int64 hi | uint64 lo
```

Tree construction is a **sorted-pair Merkle tree**: at each level, children are
paired left-to-right and concatenated in ascending byte order before hashing,
and an unpaired node is **promoted unchanged**. Leaves are ordered by
**ascending Stellar public-key bytes** (not by leaf hash, and not by manifest
row order), so the root is reproducible from the manifest alone.

`packages/sdk/test/merkleGolden.test.ts` pins all of this against
`splitstream-actions`' own committed golden fixture and a real-shaped manifest,
not merely against this repo's internal consistency.

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
const decimals = await client.getTokenDecimals();      // from the token contract

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

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the
build/test workflow and PR expectations, and [SECURITY.md](SECURITY.md) for the
security model and responsible-disclosure process. Found a bug or have a feature
idea? [Open an issue](https://github.com/Oyinkans0la12/splitstream-sdk-cli/issues).

## Contributors

[![Contributors](https://contrib.rocks/image?repo=Oyinkans0la12/splitstream-sdk-cli)](https://github.com/Oyinkans0la12/splitstream-sdk-cli/graphs/contributors)

## License

This project is licensed under the MIT License — see [LICENSE](./LICENSE) for details.

## Community

- 💬 **GitHub Issues** — bug reports, feature requests, and design discussion
- 🔒 **Security** — report vulnerabilities privately per [SECURITY.md](SECURITY.md)
- 📋 **Wave** — this repo participates in the
  [Drips Stellar Wave](https://www.drips.network/wave/stellar)

## Maintainers

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/Oyinkans0la12">
        <img src="https://github.com/Oyinkans0la12.png" width="100" alt="Oyinkans0la12" />
      </a>
      <br />
      <strong>Oyinkans0la12</strong>
      <br />
      Smart Contract Engineer
      <br />
      <a href="https://github.com/Oyinkans0la12">GitHub</a>
    </td>
    <td align="left">
      <strong>Contact</strong>
      <br />
      <a href="https://github.com/Oyinkans0la12/splitstream-sdk-cli/issues">GitHub Issues</a> — primary channel for bugs, feature requests, and design discussion
      <br />
      🔒 For vulnerabilities, use a <a href="https://github.com/Oyinkans0la12/splitstream-sdk-cli/security/advisories/new">private security advisory</a> per SECURITY.md
    </td>
  </tr>
</table>

[splitstream-core]: https://github.com/Oyinkans0la12/splitstream-core
[splitstream-actions]: https://github.com/Oyinkans0la12/splitstream-actions
