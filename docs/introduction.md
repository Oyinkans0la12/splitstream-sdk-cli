# Introduction

SplitStream is a Soroban settlement protocol that lets an open-source team turn
pooled treasury funds into a verifiable, disputable, on-chain distribution to
contributors, instead of working out who gets what by hand. The pieces are
[splitstream-core] — the vault contract that holds the pool, enforces the cycle
rules, and pays claims — [splitstream-actions] — the GitHub→chain bridge that
computes each cycle's payout manifest and relays its Merkle root on-chain — and
this repo, splitstream-sdk-cli.

This repo is the client half of that system. It reads the manifests the action
publishes, reads chain state from the vault, and builds the transactions a
contributor claims with. It never holds funds and never holds a private key on
anyone's behalf.

| Repo | Docs | Role |
| --- | --- | --- |
| splitstream-core | <https://splitstream.gitbook.io/splitstream-core/> | The Soroban vault contract that holds and settles the funds |
| splitstream-actions | <https://splitstream.gitbook.io/splitstream-actions/> | The GitHub→chain bridge that computes each cycle's payout manifest and relays its Merkle root on-chain |
| **splitstream-sdk-cli** | **this site** | The client SDK and CLI contributors claim with and maintainers simulate and report with |

## The two packages

- **`@splitstream/sdk`** — a thin, typed client over the deployed vault. It
  never signs: the `build*` methods return unsigned transactions for you to sign
  with a wallet, a hardware device, or a locally stored testnet key. It is
  browser-safe: no `node:crypto`, no CLI-only dependencies.
- **`splitstream`** (CLI) — the operational cockpit built on the SDK:
  `simulate`, `status`, `claim` and `report`.

## What this repo owns, and what it only consumes

The payout formula, the manifest shape, the Merkle leaf format and the contract
error codes are a frozen cross-repo contract. They are not this repo's
invention, and this repo does not get to change them alone.

- The **manifest format** is written by [splitstream-actions] and only read
  here — see its [Manifest reference][actions-manifest].
- The **Merkle scheme** is built by [splitstream-actions] and verified by
  [splitstream-core]; `merkleProof.ts` reconstructs proofs that must match both
  byte for byte.
- **Contract error codes** are raised by the vault. `errors.ts` carries a local
  copy of the enum because Soroban only surfaces `Error(Contract, #N)` on the
  wire.

What this repo does own is the client side of that contract: manifest parsing,
proof reconstruction, amount arithmetic, the typed vault client, and the
terminal workflow around them.

## Read on

- [For contributors](./for-contributors.md) — check a position, claim a cycle,
  get the money out.
- [For maintainers](./for-maintainers.md) — dry-run a cycle and publish the
  report.
- [CLI reference](./cli-reference.md) — every command and flag.
- [SDK reference](./sdk-reference.md) — the exported API.
- [Developer guide](./developer-guide.md) — build, test, and the cross-repo
  golden fixture.
- [Contributing](./contributing.md) — what a change here can break elsewhere.

[splitstream-core]: https://splitstream.gitbook.io/splitstream-core/
[splitstream-actions]: https://splitstream.gitbook.io/splitstream-actions/
[actions-manifest]: https://splitstream.gitbook.io/splitstream-actions/manifest-reference
