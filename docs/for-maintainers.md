# For maintainers

Maintainers use this repo to answer two questions before a cycle is settled and
after it lands: what would the pool pay out, and what did it actually pay. The
cycle itself — the manifest and the on-chain relay — is owned by
[splitstream-actions].

## Configuration

Chain-touching commands need four values. They come from flags, then
`SPLITSTREAM_*` environment variables, then a JSON config file, in that order.
Copy `.env.example` to `.env` and fill it in; `.env` is loaded on startup and is
never committed.

| Variable | Purpose |
| --- | --- |
| `SPLITSTREAM_RPC_URL` | Soroban RPC endpoint, e.g. `https://soroban-testnet.stellar.org` |
| `SPLITSTREAM_NETWORK_PASSPHRASE` | Must match the RPC endpoint's network |
| `SPLITSTREAM_VAULT_CONTRACT_ID` | Vault contract (`C...`) |
| `SPLITSTREAM_TOKEN_CONTRACT_ID` | Payout token contract (`C...`) |
| `GITHUB_TOKEN` | Optional; raises `simulate`'s GitHub rate limit |
| `SPLITSTREAM_CONFIG` | Optional path to a JSON config file |

Contract ids are validated as real Soroban ids, checksum included. When several
are missing, the command lists them all at once rather than failing one at a
time.

`simulate` never touches the chain and needs none of the chain variables.

A JSON config file is read from `SPLITSTREAM_CONFIG`, then
`./splitstream.config.json`, then `~/.config/splitstream/config.json`. A file
containing `devSecretKey`, `secretKey`, `secret`, `seed` or `stellarSecret` is
rejected outright: a signing key is never read from a file.

## Dry-run a cycle

```bash
splitstream simulate --cycle 3 --pool 100000 --map handles.json
splitstream simulate --repo owner/name --manifest manifests/cycle-3.json
```

`simulate` reads merged pull requests from GitHub, counts the distinct issues
each contributor closed with the same rule the deployed action uses, and
estimates the pro-rata payout. It contacts no RPC endpoint and signs nothing, so
it is safe to run against any repository.

- **The cycle window** is `--since <iso>` when you pass it. Otherwise it is the
  `generatedAt` of cycle *N-1*'s manifest — the same source of truth the action
  uses. If that manifest cannot be read, no window is applied and every merged
  PR is considered.
- **Repositories** come from `--repo <owner/name>`, repeatable, summed across
  every repo. With no `--repo`, the `origin` remote of the current directory is
  used.
- **The pool** comes from `--pool <amount>` (whole tokens) or from a manifest via
  `--cycle`/`--manifest`. With neither, the command stops and says so.
- **`--map <path>`** is a JSON object of `handle -> Stellar address`. Unmapped
  contributors are listed under the table as a warning, because they cannot be
  paid until the registry carries their address.
- **`--decimals <n>`** (default `7`) is used for display and for parsing
  `--pool`. Token decimals belong to the token contract, which `simulate` never
  reads; the manifest does not carry them either.
- **`--max-prs <n>`** (default `300`) caps how many merged PRs are read.

The output ends with an **estimated `post_cycle_root` cost** — instructions,
ledger-entry reads and writes, and fees in stroops, with the assumptions printed
underneath. That is an estimate to plan with. The authoritative number comes from
simulating the real transaction at relay time.

Add `--json` for machine-readable output; all amounts are strings of base units.

## Report on a settled cycle

```bash
splitstream report --cycle 3 --manifest manifests/cycle-3.json
splitstream report --cycle 3 --stdout > report.md
```

`report` writes plain markdown — no embedded HTML — so it renders correctly in
release notes, PR descriptions and issue comments. It reads claim status for
every contributor in the manifest, so it needs the chain configuration, and it
reads token decimals from the token contract.

The output path defaults to `SPLITSTREAM_REPORT.md`; `--out <path>` changes it
and `--stdout` prints instead of writing. `--concurrency <n>` (1–20, default `5`)
bounds the parallel contract reads.

The report contains the cycle summary (pool funded, contributors, issues closed,
allocated, claimed so far, dust remainder), a per-contributor table sorted by
issues closed, the dust note when the pool does not divide evenly, and a
`splitstream status` snippet that reproduces every number.

## Inspect the vault

Without `--contributor`, `status` is the maintainer view: the vault's unallocated
reserve, recent cycle roots, and — when a manifest is available locally — the
last cycle's distribution summary.

```bash
splitstream status --cycles 10
splitstream status --cycle 3 --json
```

The contract has no cycle counter on its public surface, so the range is anchored
on the highest cycle id with a manifest in `manifests/`, and falls back to
counting up. `--cycles` accepts 1–200; `--cycle` pins a single cycle.

## Where manifests come from

Manifests are committed by [splitstream-actions] as
`manifests/cycle-<id>.json`, and this tooling reads them in this order:

1. an explicit `--manifest <path>`;
2. the `manifests/` directory of a local checkout passed via `--repo <dir>`;
3. `manifests/cycle-<id>.json` at `--ref` (default `main`) on GitHub, for
   `--repo owner/name`;
4. `manifests/cycle-<id>.json`, `manifests/<id>.json`, or `cycle-<id>.json` in
   the working directory.

A manifest is validated on read: amounts must be integer strings of base units,
Stellar addresses are checksum-verified, and duplicate contributor addresses are
rejected. `merkleRoot` is the canonical root field; `root` is accepted only as a
read-compatibility alias.

Publishing a cycle, and the registry that decides who is eligible, are covered in
[splitstream-actions' maintainer page][actions-maintainers].

[splitstream-actions]: https://splitstream.gitbook.io/splitstream-actions/
[actions-maintainers]: https://splitstream.gitbook.io/splitstream-actions/for-maintainers
