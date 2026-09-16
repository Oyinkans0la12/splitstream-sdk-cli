# For contributors

If you closed issues that were counted in a cycle, your allocation is already
on-chain before you do anything: [splitstream-actions] wrote the manifest and
relayed the cycle's Merkle root to the vault. This repo is how you check what
you are owed and pull it out.

## Check your position

```bash
splitstream status --contributor GABC...XYZ
```

With `--contributor`, status reads the vault and reports:

- **claimable in vault** — your credit balance, from `get_balance`.
- **vesting** — the schedule from `get_vesting`, or `none`.
- **pending claimable cycles** — cycles whose root is posted and which you have
  not claimed yet.
- **already claimed cycles** — cycles where `has_claimed` is already true.

Add `--json` for machine-readable output, or `--cycles <n>` to widen the range.
There is no contributor list on-chain — the contract does not expose one, and
this tooling does not pretend otherwise. Per-contributor amounts come from the
manifest, so a local `manifests/` directory makes the output richer.

## Claim a cycle

```bash
splitstream claim --cycle 3
```

`--cycle` is required: there is no way to guess which cycle you mean. The
manifest for that cycle is read from `--manifest <path>`, a local checkout
passed with `--repo <dir>`, `--repo owner/name` at `--ref` on GitHub, or
`manifests/cycle-<id>.json` in your working directory.

Claiming is **two separately signed transactions**, always:

1. `credit_claim` proves your allocation against the cycle's Merkle root and
   credits your balance inside the vault.
2. `withdraw` moves that credited balance out to your account.

The command submits the first, then offers the second explicitly. They are never
merged into one transaction. Pass `--no-withdraw` to stop after `credit_claim`.

### What the command checks before it signs

1. It builds your proof from the manifest row for your address, or for your
   GitHub handle if you pass one as `--contributor`.
2. It **recomputes the Merkle root from the manifest's own rows** and compares it
   to the published `merkleRoot`. If they disagree it refuses to submit, because
   the proof would burn a fee and fail on-chain. `--force` overrides that, prints
   a warning, and should only be used when you are certain.
3. It checks `has_claimed` for your cycle and address, and stops before signing
   if you have already claimed.
4. It asks you to confirm, unless you pass `-y, --yes`.

## Signing

There are two ways to sign, and neither is "paste a secret key into the
terminal".

### Local testnet keypair

Set `SPLITSTREAM_DEV_SECRET_KEY` in `.env`. This is a testnet-only path: it is
labelled `INSECURE, testnet-only` wherever it is printed, and it is
**hard-blocked on mainnet**. The key is read only from that environment
variable — never from a flag and never from a config file. If the key does not
control your claimant address, the command fails before signing.

### Hardware wallet

```bash
splitstream claim --cycle 3 --wallet hardware
```

Signing is delegated to a Ledger device through the optional
`@ledgerhq/hw-app-str` and `@ledgerhq/hw-transport-node-hid` packages, which
keep the key off the machine. They are not installed by default; the CLI tells
you the `npm install --save-optional` line if they are missing. The default
derivation path is `44'/148'/0'`.

The device's address is read first and matched against the address the claim is
sourced from, so a wrong device fails before you approve anything.

A mainnet claim therefore requires a hardware wallet, by construction.

## Where your amount comes from

Your row in the manifest has `stellar` (your `G...` account), `issuesClosed`
(the count that produced the payout) and `amount` (base units, as a decimal
string). Amounts are computed as:

```
contributor_amount = floor(poolAmount * contributor_issues_closed / totalIssuesClosed)
```

The remainder that does not divide evenly is `dustRemainder` and stays in the
vault. An issue counts when it was closed by a merged pull request containing a
recognized closing keyword — `Closes #N`, `Fixes #N` or `Resolves #N`. No label
is read, and every qualifying issue counts equally. Credit goes to the PR
author.

**If you are not in the manifest, you are not paid by this cycle.** Who is
eligible is decided by the contributor registry, which is owned by
[splitstream-actions] — see its
[maintainer page on `.github/splitstream.yml`][actions-registry]. Missing or
wrong addresses in that registry are the usual reason a contributor is absent or
unmapped, so check there before opening an issue here.

## Vesting

If a cycle granted you a vesting schedule, part of your allocation unlocks over
time rather than all at once. `splitstream status --contributor <address>`
reports the unvested remainder, the start ledger and the duration. The vault's
`claim_vested` entrypoint and the SDK's `buildClaimVestedTx` handle it, but there
is no CLI command for it yet — the SDK path is in the
[SDK reference](./sdk-reference.md).

## When something refuses to run

- **"has already claimed cycle N"** — you already credited this cycle. Run
  `splitstream status --contributor <address>` to see the balance instead.
- **"the manifest root does not match the tree recomputed from its own rows"** —
  the manifest and this repo's proof code disagree. Re-generate the manifest, or
  report it. Do not reach for `--force` first.
- **"is not present in the cycle N manifest"** — your address or handle is not in
  the eligible set. See the registry note above.

Every message is a single line by default; `-v, --verbose` adds stack traces and
raw RPC detail.

[splitstream-actions]: https://splitstream.gitbook.io/splitstream-actions/
[actions-registry]: https://splitstream.gitbook.io/splitstream-actions/for-maintainers
