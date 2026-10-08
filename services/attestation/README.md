# @itera/attestation

Anchors a `services/evaluator` evidence manifest on Solana via the [Solana Attestation
Service](https://github.com/solana-foundation/solana-attestation-service) (SAS) — the
"Verify on-chain" step of the Itera Agent Proof flow.

## What's here

- `src/config.ts` — the on-chain schema definition (field layout/names), pure data.
- `src/manifest.ts` — `manifestToAttestationData`, a pure function mapping an evidence manifest
  onto the schema's field shape. Unit tested (`src/manifest.test.ts`), no network involved.
- `src/client.ts` — thin wrappers around the real SAS TypeScript client
  (`@solana/attestation` + `@solana/kit`) for `createCredential`, `createSchema`, and
  `createAttestationFromManifest`. Adapted directly from the SAS repo's own
  `examples/typescript/attestation-flow-guides/src/kit/sas-standard-kit-demo.ts` — not written
  from scratch, per the project's own SAS research notes.
- `src/cli.ts` — `npm run cli -- <path-to-manifest.json>` runs the full flow end to end: fund
  payer (devnet airdrop) → create Credential → create Schema → create Attestation.

## Status: validated end to end on devnet (2026-10-08)

The full Credential→Schema→Attestation flow ran for real against the `webhook-ledger` golden
(100/100) evidence manifest. Confirmed on-chain via `getAccountInfo` (not just "the CLI printed
success" — the account data was read back and matches the manifest):

- Credential: `Dh9NF2L2Ua2u4TUzKRX5u8S5DDCBLNA7aVkunteXt7A3`
- Schema: `ABA68smXFGBtByCUKAzDaRi3SckBmmaWzKuoBbGCy79d`
- Attestation: `3N2qF69NScEQHiyaqvQpc15RBe9oR2Bv2ussysfJSynf`
- Payer/issuer: `t93y3suJv2ZjX7WT9wKtcx3Q1tC4ZsxJgrmdBryWbFU` (persisted, funded with 10 devnet SOL
  via the authenticated faucet.solana.com UI — the public `api.devnet.solana.com` airdrop RPC
  stayed rate-limited throughout; a human visiting the web faucet with a connected GitHub account
  was the only working unblock)

### The original blocker (now resolved) and what fixed it

The public devnet faucet (`api.devnet.solana.com`) used by an ephemeral `generatedPayer()` is
aggressively rate-limited (`429`) regardless of client (`curl`, Solana CLI, this SDK) — not a
client bug, a shared quota. The fix was switching the payer from an ephemeral
`generatedPayer()` to a **persisted** keypair (`setupClient()` now uses
`@solana/kit-plugin-signer`'s `payerFromFile()`, defaulting to the Solana CLI's own
`~/.config/solana/id.json`), funded ONCE manually via the web faucet UI, then reused indefinitely
— no more airdrops needed per run.

## Gotcha carried over from the ChainOil hackathon project

Devnet's simulation node uses a stale cache and can reject a transaction's blockhash even when
it's genuinely recent — ChainOil's Solana flow needed `skipPreflight: true` on every
`sendRawTransaction` call to avoid spurious failures. `@solana/kit`'s `client.sendTransaction(...)`
here abstracts that call; if real devnet runs hit the same stale-preflight symptom, check whether
the Kit exposes a `skipPreflight` option before assuming the transaction itself is broken.

## Keypair persistence (resolved)

`setupClient()` loads a persisted keypair via `payerFromFile()` and uses it as payer, Credential
issuer, and the Credential's sole authorized signer — correct for a single-issuer MVP. The real
`@solana/kit` API for this (found by reading `@solana/signers`' and `@solana/kit-plugin-signer`'s
`.d.ts` files, not guessed): `createKeyPairSignerFromBytes()` / `payerFromFile()` /
`writeKeyPairSigner()`, all documented in those packages.

`cli.ts` derives the Attestation's `nonce` deterministically from the manifest's `patch_hash`
(via `createKeyPairSignerFromPrivateKeyBytes`), so re-running the CLI on the same manifest always
resolves to the same Attestation PDA instead of a random one each time.
