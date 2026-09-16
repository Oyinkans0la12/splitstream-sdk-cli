# SDK reference

`@splitstream/sdk` is a thin, typed client over the deployed `splitstream-core`
vault, plus the manifest, Merkle, amount and XDR helpers the CLI is built from.
It is browser-safe: no `node:crypto`, no `commander`, no `inquirer`.

Design rules the package holds to:

- **The SDK never signs.** The `build*` methods return unsigned transactions;
  you sign them and hand them back to `submitSigned`.
- **Token amounts are `bigint` end to end.** Decimal strings appear only at
  display and parse boundaries.
- **Nothing is defaulted about the network.** Every network identity is a
  required option.

## `SplitStreamClient`

```ts
import { SplitStreamClient } from '@splitstream/sdk';

const client = new SplitStreamClient({
  rpcUrl: process.env.SPLITSTREAM_RPC_URL!,
  networkPassphrase: process.env.SPLITSTREAM_NETWORK_PASSPHRASE!,
  vaultContractId: process.env.SPLITSTREAM_VAULT_CONTRACT_ID!,
  tokenContractId: process.env.SPLITSTREAM_TOKEN_CONTRACT_ID!,
});
```

| Option | Required | Meaning |
| --- | --- | --- |
| `rpcUrl` | yes | Soroban RPC endpoint; must be an absolute http(s) URL |
| `networkPassphrase` | yes | Must match `rpcUrl`'s network |
| `vaultContractId` | yes | Deployed vault contract id (`C...`) |
| `tokenContractId` | yes | Payout token contract id (`C...`) |
| `server` | no | Inject an already-constructed `rpc.Server` (a test seam) |
| `pollIntervalMs` | no | Poll interval while waiting for a submitted transaction; default `2000` |
| `pollTimeoutMs` | no | Give up after this long; default `60000` |

The constructor validates all four required values up front and throws
`SplitStreamError` when one is missing or malformed, so a misconfigured client
fails immediately rather than at the first call.

### Read methods

Reads run a read-only simulation and decode the return value. They never need a
funded account.

| Method | Returns |
| --- | --- |
| `getBalance(contributor)` | Claimable balance in the vault, base units (`bigint`) |
| `getCycleRoot(cycleId)` | Published Merkle root, lowercase hex, or `null` if unposted |
| `hasClaimed(cycleId, contributor)` | Whether that contributor has pulled that cycle |
| `getVesting(contributor)` | `VestingInfo`, or `null` when there is no schedule |
| `getTokenDecimals()` | Decimals read from the token contract |
| `getReserveBalance()` | The vault's own token balance — the reserve for future cycles |

Addresses are validated as `G...` accounts before a call is made. No read
method enumerates contributors: the contract does not expose a contributor list.

### Unsigned transactions

| Method | Builds |
| --- | --- |
| `buildClaimTx(contributor, cycleId, amount, proof)` | `credit_claim` |
| `buildWithdrawTx(contributor)` | `withdraw` |
| `buildClaimVestedTx(contributor)` | `claim_vested` |

Each returns an assembled `Transaction` built from the contributor's account,
simulated and assembled (footprint and resource fees included) — and **unsigned**.
`buildClaimTx` rejects a negative amount and an empty proof before it touches the
network.

### Submitting

```ts
const tx = await client.buildClaimTx(address, 3, amount, proof); // unsigned
const signedXdr = await myWallet.sign(tx);                       // you sign it
const { hash, status } = await client.submitSigned(signedXdr);
```

`submitSigned` decodes the envelope against the client's network passphrase,
sends it, and polls until the transaction is final. It retries while the node
answers `TRY_AGAIN_LATER` (three attempts, spaced by `pollIntervalMs`) and then
fails with a clear message rather than hanging. A transaction that fails on-chain
raises `SplitStreamError` with the contract's numeric code decoded into its name
when the diagnostics carry one.

`VAULT_METHODS` and `TOKEN_METHODS` are exported as the entrypoint names the
client calls, so the wire surface is auditable from one place.

## Errors

`SplitStreamError` carries `code` (the numeric contract error, when the failure
came from the contract), `codeName` (its decoded name) and `details` (the raw
RPC or XDR blob). `contractError`, `parseContractErrorCode`,
`splitstreamErrorName` and `toSplitStreamError` are exported for callers that
need to classify a failure themselves.

Soroban reports contract failures as `Error(Contract, #N)` in diagnostics, so
the SDK carries a local copy of the vault's error enum —
`SPLITSTREAM_CONTRACT_ERRORS`. Anything not in the table is reported as
`UnknownSplitStreamError(<n>)` rather than guessed at. The table must be updated
in the same change that renumbers the contract: a stale table prints a
*misspelled* name, which is worse than an unknown code.

| Code | Name | Code | Name |
| ---: | --- | ---: | --- |
| 1 | `NotInitialized` | 11 | `InvalidAmount` |
| 2 | `AlreadyInitialized` | 12 | `Overflow` |
| 3 | `Unauthorized` | 13 | `VestingNotFound` |
| 4 | `Paused` | 14 | `VestingNotStarted` |
| 5 | `CycleNotFound` | 15 | `VestingNotComplete` |
| 6 | `CycleAlreadyPosted` | 16 | `InvalidContributor` |
| 7 | `InvalidMerkleRoot` | 17 | `InvalidCycleId` |
| 8 | `InvalidProof` | 18 | `ReentrancyDetected` |
| 9 | `AlreadyClaimed` | 19 | `RootNotSet` |
| 10 | `NothingToClaim` | 20 | `InsufficientReserve` |

That table is a copy of the vault's enum, so it is owned by
[splitstream-core] — not by this repo.

## Manifests

```ts
import { parseManifest, findManifestEntry } from '@splitstream/sdk';

const manifest = parseManifest(JSON.parse(jsonText));
const entry = findManifestEntry(manifest, 'GABC...XYZ'); // address, or a handle
```

`parseManifest` validates and normalizes a raw manifest into a `Manifest`:
`cycleId`, `generatedAt`, `poolAmount`, `totalIssuesClosed`, `entries`,
`dustRemainder` and `merkleRoot`. It throws `ManifestParseError` naming the
offending field when something is wrong, and it refuses duplicate contributor
addresses. Amounts must be integer strings of base units: a JSON number beyond
the safe integer range is rejected rather than silently rounded.

Entry fields are `github`, `stellar`, `issuesClosed` and `amount`. `stellar` is
the `G...` account and `issuesClosed` is the count that produced the payout —
there is no `address` and no `points`. `merkleRoot` is canonical; `root` is
accepted only as a read-compatibility alias.

The manifest's shape, the payout rule and the Merkle leaf/tree format are all
owned by [splitstream-actions] — see its
[Manifest reference][actions-manifest]. This package parses that format and
reconstructs those proofs; it does not define them. `isValidStellarAddress`,
`isValidContractId`, `parseVesting` and `findManifestEntry` are exported
alongside the types (`Manifest`, `ManifestEntry`, `RawManifest`, `VestingInfo`,
`CycleInfo`).

## Merkle proofs

`buildClaimProof(manifest, identifier)` is the one call contributors need: it
finds the entry, hashes its leaf, builds the tree and returns a `ClaimProof` with
`proof` (sibling hashes, lowercase hex), `leaf`, `leafIndex`, `computedRoot`,
`manifestRoot` and `rootMatches`.

The rest of the surface exists so the scheme can be checked locally:
`merkleLeaf`, `hashPair`, `buildMerkleTree`, `merkleProofForLeaf`,
`manifestToLeafInputs`, `computeMerkleRoot`, `computeManifestRoot` and
`verifyMerkleProof`.

The scheme is a port, and the port must stay byte-exact — a different leaf
pre-image, leaf order or odd-node rule fails every claim with `InvalidProof` even
though the manifest is correct. It is the frozen cross-repo contract shared with
[splitstream-actions] (which builds the root) and [splitstream-core] (which
verifies it):

```
leaf(stellar, amount) = SHA-256( ScVal(Address(stellar)).toXDR() || ScVal(i128(amount)).toXDR() )

Address XDR (44 bytes): u32(SCV_ADDRESS=18) | u32(SC_ADDRESS_TYPE_ACCOUNT=0) | u32(publickey ED25519=0) | ed25519(32)
i128 XDR    (20 bytes): u32(SCV_I128=10) | int64 hi | uint64 lo

node(a, b)             = SHA-256( min(a, b) || max(a, b) )
```

Leaves are ordered by ascending Stellar public-key bytes — not by leaf hash and
not by manifest row order — so the root is reproducible from the manifest alone.
An unpaired node is promoted unchanged (it is not hashed with itself), which is
why a proof may be shorter than the tree is tall.

SHA-256 comes from `@stellar/stellar-sdk`'s `hash`, which is pure JS, so this
path works in a browser too.

## Amounts

Amounts are `bigint` base units everywhere; these helpers exist for the display
and parse boundaries.

| Helper | Behaviour |
| --- | --- |
| `formatTokenAmount(value, decimals)` | Base units → decimal string, trailing zeros trimmed |
| `formatTokenAmountWithSeparators(value, decimals)` | The same, with thousands separators |
| `parseTokenAmount(input, decimals)` | Decimal string → base units; rejects excess precision instead of rounding |
| `percentOf(part, total, digits)` | Truncated percentage, pure integer arithmetic |
| `truncateAddress(address, leading, trailing)` | Shortens an address for table output |

Decimals must be an integer between 0 and 38. There is no `Number` conversion
anywhere in the amount path, so values above `Number.MAX_SAFE_INTEGER` survive
intact.

## Bytes and XDR

The byte helpers work on `Uint8Array` (never Node's `Buffer`):
`bytesToHex`, `hexToBytes`, `bytesEqual`, `compareBytes`, `concatBytes`,
`i128ToBytes`, `bytesToI128`, `bytesToBase64`, plus the
`ED25519_PUBLIC_KEY_BYTES` and `MERKLE_HASH_BYTES` constants.

The XDR helpers keep the rest of the package out of the XDR classes:
`addressToScVal`, `u32ToScVal`, `i128ToScVal`, `bytesToScVal`, `proofToScVal`,
`scValToNativeValue`, `scValToBigInt`, `scValToBool`, `scValToHexOrNull`,
`isVoidScVal` and `findContractErrorCode`. `proofToScVal` rejects a sibling hash
that is not a full 32 bytes locally, rather than letting the contract reject it.

[splitstream-core]: https://splitstream.gitbook.io/splitstream-core/
[splitstream-actions]: https://splitstream.gitbook.io/splitstream-actions/
[actions-manifest]: https://splitstream.gitbook.io/splitstream-actions/manifest-reference
