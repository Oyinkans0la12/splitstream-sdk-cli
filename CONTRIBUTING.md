# Contributing to splitstream-sdk-cli

## Git workflow — non-negotiable

Same as splitstream-core and splitstream-actions:

- **Never `git add .`** — stage exactly what belongs to the change.
- **One commit per logical unit** — a feature, a fix, a doc, not a grab-bag.
- **Push immediately** after each commit; keep the branch short-lived.
- **Conventional commit format**: `feat(...)`, `fix(...)`, `test(...)`,
  `docs(...)`, `chore(...)`, `refactor(...)`.

## Non-negotiables checklist

- [ ] `parseManifest` reads the field names `splitstream-actions` actually
      writes (`entries`, `stellar`, `issuesClosed`, `totalIssuesClosed`,
      `dustRemainder`, `merkleRoot`) — never an invented shape.
- [ ] The Merkle scheme matches the frozen cross-repo contract: leaves are
      `sha256(ScVal(Address).toXDR() || ScVal(i128).toXDR())`, leaves are
      ordered by ascending Stellar public-key bytes, internal nodes are the
      sorted pair `sha256(min||max)`, and an unpaired node is promoted
      unchanged. The cross-repo golden test must stay green.
- [ ] Token decimals are read from the token contract at runtime
      (`getTokenDecimals`) — never from the manifest.
- [ ] All monetary amounts are `bigint`/strings, never JS `number`.
- [ ] `simulate` counts distinct issues closed by merged PRs with a closing
      keyword; no labels, size buckets or churn fallbacks exist anywhere.
- [ ] The CLI never signs on mainnet with a locally stored key, and never reads
      a signing key from a flag or a config file.

## Layout

```
packages/sdk/src/types.ts        manifest parsing + domain types
packages/sdk/src/merkleProof.ts  frozen leaf hashing + sorted-pair tree
packages/sdk/src/client.ts       typed Soroban client (never signs)
packages/cli/src/contributions.ts  count-based ingest + payout formula
packages/cli/src/commands/       simulate, status, claim, report
packages/cli/src/report.ts       markdown transparency report
```

## Development

Requires **Node.js >= 20** (CI uses the version in `.nvmrc`).

```bash
npm install
npm run build       # builds the SDK, then the CLI
npm run typecheck   # type-checks both workspaces without emitting
npm test            # runs both workspaces' vitest suites
```

Run the CLI straight from the build output:

```bash
node packages/cli/dist/index.js --help
```

## Testing

- `packages/sdk/test/` covers manifest parsing, amount math, XDR plumbing, the
  RPC client (with a stubbed server) and the Merkle scheme.
- `packages/sdk/test/merkleGolden.test.ts` is a **cross-repo** test: it loads
  `test/fixtures/merkle.golden.json` (copied verbatim from
  `splitstream-actions`) and a real-shaped manifest fixture, and proves this
  repo's proof reconstruction verifies against the other repo's committed root.
  It must never be "fixed" by editing the fixture — if it fails, the
  implementation has diverged and on-chain claims would fail `InvalidProof`.
- `packages/cli/test/` covers the commands and the count-based rule.

## Manifest format — frozen

The manifest written by `splitstream-actions` is the source of truth. See the
README's "Cycles and manifests" section for the exact shape. Do not add fields
(no `version`, no `tokenDecimals`) without changing the writer first.
