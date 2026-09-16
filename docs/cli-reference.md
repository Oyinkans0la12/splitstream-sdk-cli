# CLI reference

The CLI installs as `splitstream` and is built on Commander. Every command ends
up in one place that turns an exception into a single readable line; raw stack
traces appear only with `--verbose`.

```bash
splitstream <command> [options]
splitstream <command> --help
```

## Global options

| Flag | Meaning |
| --- | --- |
| `-v, --verbose` | Print stack traces and raw RPC detail on failure |
| `-V, --version` | Output the version number |
| `-h, --help` | Display help for a command |

`splitstream` with no command lists the commands and examples.

## Commands

| Command | Needs chain config | Purpose |
| --- | --- | --- |
| `simulate` | no | Dry-run payout calculations against merged PRs |
| `status` | yes | Vault reserve, recent cycle distributions, contributor position |
| `claim` | yes | Claim a cycle allocation, and optionally withdraw it |
| `report` | yes | Generate the per-cycle markdown transparency report |

Configuration precedence is flags, then `SPLITSTREAM_*` environment variables,
then a JSON config file. `status`, `claim` and `report` accept
`--rpc-url <url>`, `--network-passphrase <passphrase>`, `--vault <id>` and
`--token <id>` to override the environment for one invocation. `simulate` does
not, because it never touches the chain.

A command that fails prints one line and exits non-zero.

## `splitstream simulate`

Dry run over merged pull requests. Counts the distinct issues each contributor
closed, estimates the pro-rata payout, and estimates the cost of the eventual
`post_cycle_root` call. Never contacts RPC and never signs.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--cycle <id>` | — | Cycle id to simulate |
| `--manifest <path>` | — | Read cycle id and pool from a manifest file |
| `--repo <owner/name...>` | `origin` remote | Repository to read merged PRs from; repeatable |
| `--ref <ref>` | `main` | Git ref to read manifests from when `--repo` is remote |
| `--since <iso>` | previous cycle manifest | Cycle window lower bound, ISO 8601 |
| `--pool <amount>` | manifest | Pool size in whole tokens; overrides the manifest |
| `--decimals <n>` | `7` | Token decimals for display and `--pool` parsing, 0–38 |
| `--map <path>` | — | JSON map of GitHub handle → Stellar address |
| `--max-prs <n>` | `300` | Maximum merged pull requests to consider |
| `--json` | off | Print the result as JSON instead of a table |

`--repo` may be repeated or take several values (`--repo a/b c/d`). With no
`--repo` at all, the `origin` remote of the working directory is used, and the
command fails with a clear message if it cannot determine one.

`--cycle` must be a non-negative integer, `--max-prs` a positive integer, and
`--since` a valid ISO 8601 timestamp; anything else is rejected before any
network call.

## `splitstream status`

Vault reserve, recent cycle distributions, and — with `--contributor` — a single
contributor's balance, vesting and claimed/pending cycles.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--contributor <G...>` | — | Contributor address to report on |
| `--cycle <id>` | — | Show a single cycle instead of a range |
| `--cycles <n>` | `5` | How many recent cycles to show, 1–200 |
| `--manifest <path>` | — | Manifest supplying the last cycle summary |
| `--repo <owner/name>` | — | Repository to fetch the manifest from |
| `--ref <ref>` | `main` | Git ref to read manifests from |
| `--json` | off | Print the result as JSON instead of tables |
| `--rpc-url <url>` | env | Override `SPLITSTREAM_RPC_URL` |
| `--network-passphrase <passphrase>` | env | Override `SPLITSTREAM_NETWORK_PASSPHRASE` |
| `--vault <id>` | env | Override `SPLITSTREAM_VAULT_CONTRACT_ID` |
| `--token <id>` | env | Override `SPLITSTREAM_TOKEN_CONTRACT_ID` |

Cycle ranges are anchored on the highest cycle id that has a manifest in
`manifests/`, so discovering recent cycles needs no extra contract call. A
manifest is optional context here: without one, status still prints chain state
and says so, because contributor-level breakdowns are not available on-chain.

## `splitstream claim`

Claims a cycle allocation and optionally withdraws it, as two separately signed
transactions.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--cycle <id>` | **required** | Cycle to claim |
| `--manifest <path>` | — | Manifest file for the cycle |
| `--repo <owner/name>` | — | Repository to fetch the manifest from |
| `--ref <ref>` | `main` | Git ref to read manifests from |
| `--contributor <address\|handle>` | signing wallet | Who is claiming |
| `--wallet <kind>` | prompt | Signing method: `local` or `hardware` |
| `-y, --yes` | off | Skip the confirmation prompt |
| `--force` | off | Proceed even if the manifest root does not match the recomputed tree |
| `--no-withdraw` | withdraw offered | Stop after `credit_claim` |
| `--rpc-url <url>` | env | Override `SPLITSTREAM_RPC_URL` |
| `--network-passphrase <passphrase>` | env | Override `SPLITSTREAM_NETWORK_PASSPHRASE` |
| `--vault <id>` | env | Override `SPLITSTREAM_VAULT_CONTRACT_ID` |
| `--token <id>` | env | Override `SPLITSTREAM_TOKEN_CONTRACT_ID` |

`--wallet` accepts only `local` or `hardware`. Without it you are prompted.
`--contributor` takes an address or a GitHub handle; without it the claimant is
the local testnet key if one is configured, otherwise the connected Ledger
device, matched against the manifest before anything is signed.

`claim` has no `--json` flag: it is an interactive signing flow, and its output
is the transaction hashes it submitted.

## `splitstream report`

Generates the per-cycle markdown transparency report.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--cycle <id>` | **required** | Cycle to report on |
| `--manifest <path>` | — | Manifest file for the cycle |
| `--repo <owner/name>` | — | Repository to fetch the manifest from |
| `--ref <ref>` | `main` | Git ref to read manifests from |
| `--out <path>` | `SPLITSTREAM_REPORT.md` | Output path |
| `--concurrency <n>` | `5` | Parallel contract reads, 1–20 |
| `--stdout` | off | Print the report instead of writing it to disk |
| `--rpc-url <url>` | env | Override `SPLITSTREAM_RPC_URL` |
| `--network-passphrase <passphrase>` | env | Override `SPLITSTREAM_NETWORK_PASSPHRASE` |
| `--vault <id>` | env | Override `SPLITSTREAM_VAULT_CONTRACT_ID` |
| `--token <id>` | env | Override `SPLITSTREAM_TOKEN_CONTRACT_ID` |

`--concurrency` bounds the in-flight contract reads used to check each
contributor's claim status; a value outside 1–20 is rejected before the run.

## Examples

```bash
splitstream simulate --cycle 3 --pool 100000 --map handles.json
splitstream simulate --repo owner/name --manifest manifests/cycle-3.json --json
splitstream status --contributor GABC...XYZ
splitstream status --cycles 10 --json
splitstream claim --cycle 3 --manifest manifests/cycle-3.json
splitstream claim --cycle 3 --repo owner/name --wallet hardware
splitstream report --cycle 3 --manifest manifests/cycle-3.json
splitstream report --cycle 3 --stdout > report.md
```
