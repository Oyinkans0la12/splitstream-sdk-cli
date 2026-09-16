# Contributing

The build/test workflow, commit conventions and the non-negotiables checklist
for this repo live in [CONTRIBUTING.md](../CONTRIBUTING.md) — that file is the
source of truth for how to land a change here, and this page does not duplicate
it. In short: one commit per logical unit, conventional commit subjects, stage
exactly what belongs to the change, and never "fix" the cross-repo Merkle golden
test by editing its fixture.

Changes reach `main` through a pull request: the branch rules require one, and
they require the CI status check to pass before merge. CI runs the typecheck and
both workspaces' test suites.

## What this repo affects

Three repos split the protocol, and a change here can break the other two:

- **splitstream-sdk-cli** (this repo) is how people check status and claim. It
  reads the manifest and the on-chain state, reconstructs Merkle proofs, and
  builds the transactions contributors sign.
- **[splitstream-actions]** produces what gets settled. It reads GitHub activity,
  decides the amounts, writes the manifest and relays the root. It is the
  authoritative source for the manifest format.
- **[splitstream-core]** enforces and pays it. The vault holds the pool, verifies
  the proof against the relayed root and pays claims. Its `merkle::leaf_hash` and
  `hash_pair` must stay byte-identical to `merkleProof.ts`.

So a change to **manifest parsing** or to the **Merkle scheme** is a
cross-repo change, not an internal refactor. Land it in coordination with the
other repos and say so in the PR description, linking what depends on this
repo's output:

- [splitstream-actions docs][actions-docs]
- [splitstream-core docs][core-docs]

Three areas deserve specific care:

| Area | Why it is cross-repo |
| --- | --- |
| `parseManifest` | Must read the field names the writer actually emits (`entries`, `stellar`, `issuesClosed`, `totalIssuesClosed`, `dustRemainder`, `merkleRoot`), never an invented shape |
| `merkleProof.ts` | Leaves are `sha256(ScVal(Address).toXDR() || ScVal(i128).toXDR())`, ordered by ascending Stellar public-key bytes, internal nodes are `sha256(min||max)`, and an unpaired node is promoted unchanged |
| `errors.ts` | The error table mirrors the vault's enum; a stale table prints a wrong name, which is worse than an unknown code |

Two more rules that are not cross-repo but are not negotiable either: token
decimals are always read from the token contract, never from a manifest; and
monetary amounts are always `bigint` or strings, never JS `number`.

## Where to start

- A claim that fails locally or on-chain: [For contributors](./for-contributors.md).
- A cycle report that looks wrong: [For maintainers](./for-maintainers.md).
- Setup, tests and the golden fixture: [Developer guide](./developer-guide.md).
- The exported API: [SDK reference](./sdk-reference.md).

[splitstream-actions]: https://splitstream.gitbook.io/splitstream-actions/
[splitstream-core]: https://splitstream.gitbook.io/splitstream-core/
[actions-docs]: https://splitstream.gitbook.io/splitstream-actions/
[core-docs]: https://splitstream.gitbook.io/splitstream-core/
