# Developer guide

## Requirements

Node.js 20 or newer — `package.json` declares `engines.node: ">=20"` in both
workspaces, and CI uses the version pinned in `.nvmrc`. No other toolchain is
required.

## Build, typecheck, test

```bash
npm install
npm run build       # builds the SDK, then the CLI
npm run typecheck   # type-checks both workspaces without emitting
npm test            # runs both workspaces' vitest suites
```

This is an npm workspace with two packages, so the root scripts fan out to each
workspace in order: the CLI depends on the SDK's build output.

Run the CLI straight from the build output:

```bash
node packages/cli/dist/index.js --help
```

`dist/` is build output and is not committed.

## Layout

```
packages/
  sdk/   @splitstream/sdk - typed vault client, Merkle proofs, amount math
  cli/   splitstream-cli  - commander-based terminal app (bin: splitstream)
```

| Path | Responsibility |
| --- | --- |
| `packages/sdk/src/types.ts` | Manifest parsing and domain types |
| `packages/sdk/src/merkleProof.ts` | Frozen leaf hashing and the sorted-pair tree |
| `packages/sdk/src/client.ts` | Typed Soroban client; never signs |
| `packages/sdk/src/errors.ts` | Contract error table and error decoding |
| `packages/sdk/src/amounts.ts` | bigint amount formatting and parsing |
| `packages/sdk/src/bytes.ts`, `xdr.ts` | Byte and ScVal conversion helpers |
| `packages/cli/src/contributions.ts` | Count-based ingest and the payout formula |
| `packages/cli/src/manifest.ts` | Locating and loading a cycle manifest |
| `packages/cli/src/commands/` | `simulate`, `status`, `claim`, `report` |
| `packages/cli/src/wallet.ts` | Signing: local testnet keypair or Ledger |
| `packages/cli/src/report.ts` | Markdown transparency report |

## Tests

- `packages/sdk/test/` covers manifest parsing, amount math, XDR plumbing, the
  Merkle scheme, and the RPC client against a stubbed server.
- `packages/cli/test/` covers the commands, configuration precedence, manifest
  loading, the wallet paths and the count-based rule.

### The cross-repo golden test

`packages/sdk/test/merkleGolden.test.ts` is not an internal consistency check. It
loads `test/fixtures/merkle.golden.json` — copied verbatim from
[splitstream-actions] — plus a real-shaped manifest fixture, and proves this
repo's proof reconstruction verifies against the *other repo's* committed root.

If it fails, the implementation has diverged from the cross-repo Merkle contract
and real claims would fail `InvalidProof` on-chain. **Never fix it by editing the
fixture.** Fix the implementation, or coordinate the format change across all
three repos.

## Working on the payout path

Two rules matter more than style here:

- **Amounts are `bigint` or strings, never JS `number`.** A rounded payout is a
  wrong payout, and the failure is silent.
- **Token decimals come from the token contract at runtime** via
  `getTokenDecimals`. They are never read from a manifest, and a manifest that
  carries them is out of date.

When you change how a transaction is assembled, exercise it against a stubbed
`rpc.Server` rather than a live network — the client accepts an injected server
precisely so tests stay offline.

## Cross-repo changes

Some changes here cannot land alone:

- **The manifest format** is written by [splitstream-actions] and parsed here.
  Do not add fields to the parser that the writer does not produce.
- **The Merkle scheme** is shared byte-for-byte with [splitstream-actions] and
  [splitstream-core]. A change to leaf pre-image, leaf order or the odd-node rule
  is a breaking change for both.
- **The contract error table** mirrors the vault's enum. Update it in the same
  change that renumbers the contract.

The [Contributing](./contributing.md) page says more about what to coordinate;
the sibling sites carry the other side of each contract:
[splitstream-actions docs][actions-docs], [splitstream-core docs][core-docs].

[splitstream-actions]: https://splitstream.gitbook.io/splitstream-actions/
[splitstream-core]: https://splitstream.gitbook.io/splitstream-core/
[actions-docs]: https://splitstream.gitbook.io/splitstream-actions/
[core-docs]: https://splitstream.gitbook.io/splitstream-core/
