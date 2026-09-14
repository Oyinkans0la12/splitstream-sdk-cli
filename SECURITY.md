# Security Policy

## Threat model

`splitstream-sdk-cli` is a client toolkit: a typed SDK over the deployed
`splitstream-core` vault, and a terminal CLI for inspecting, claiming and
reporting on a cycle's payouts. It is much narrower than the other two repos in
this project, and the risk surface is correspondingly different:

- **It never holds funds.** Unlike splitstream-core, there is no pooled balance
  here to drain.
- **It never relays anything.** Unlike splitstream-actions, it does not submit
  `post_cycle_root`; it only reads chain state and builds (never signs by
  default) claim transactions.
- **It does handle signing flows.** The CLI can drive a locally stored testnet
  key or a hardware wallet to sign `credit_claim` / `withdraw`.
- **It reads manifests.** A cycle manifest drives which address is paid and how
  much, so a malicious or malformed manifest is the primary external input.

The blast radius of a compromised client is therefore limited to the wallet that
runs it and the claims it is asked to sign.

## Secret handling — hard rules

1. **Mainnet never uses a local key.** `local` signing is hard-blocked on the
   mainnet passphrase (`isMainnet` in `packages/cli/src/config.ts`). Signing a
   mainnet claim requires a Ledger device, by construction.
2. **Signing keys never come from a file or a flag.** The local testnet key is
   read only from `SPLITSTREAM_DEV_SECRET_KEY`. A config file containing
   `devSecretKey`, `secretKey`, `stellarSecret`, `seed` or a similar field is
   rejected outright before any use.
3. **Keys are never logged.** Errors and `--verbose` output redact nothing that
   would echo key material; do not add a step that prints env vars.
4. The local testnet key is labelled **INSECURE, testnet-only** wherever it is
   shown. Treat it as a throwaway.

## Malicious or malformed manifests

The manifest is the main untrusted input. Two independent defences apply:

1. **Recompute-and-refuse.** Before signing, the CLI recomputes the Merkle root
   from the manifest's own `entries` and compares it to the manifest's
   `merkleRoot`. If they disagree, `claim` refuses to submit (unless `--force`),
   because the proof would burn a fee and fail on-chain. A manifest whose rows
   were edited after the fact cannot be used to build a proof that the
   *on-chain* root accepts.
2. **The chain is the final gate.** The vault verifies the proof against the
   root it stored. A manifest that is internally consistent but does not match
   the on-chain root produces proofs that fail `InvalidProof` — no funds move.
   A manifest that points a contributor row at a different address simply
   produces a proof for that leaf, which only succeeds if that exact
   `(address, amount)` pair is in the on-chain tree.

Parsing itself is defensive: amounts must be integer strings in base units
(never JSON numbers, which could lose precision), Stellar addresses are
checksum-verified, and duplicate contributor addresses are rejected.

## Reporting a vulnerability

Do **not** open a public issue. Report privately to the maintainers via GitHub
Security Advisories ("Report a vulnerability" on this repository), or by
contacting the org's security contact directly.

Please include the affected file/version, the vulnerability class (e.g. "mainnet
local signing not blocked", "a malformed manifest is accepted", "secret could
appear in output"), a minimal reproduction if possible, and whether it could
lead to a real mis-signed or unintended claim. Maintainers aim to acknowledge
within 5 business days.
