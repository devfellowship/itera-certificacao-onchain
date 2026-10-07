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

## Known blocker: devnet airdrop rate limit

The public devnet faucet (`api.devnet.solana.com`) used by `setupClient()`'s airdrop is
aggressively rate-limited (`429`) — confirmed independently via `curl`, the Solana CLI, and this
SDK's own `client.airdrop(...)`, so it is not a client-specific bug. The full
Credential→Schema→Attestation flow has **not** been run end to end against real devnet funds yet.

What's already validated: the package installs clean, `tsc --noEmit` passes, and the pure
`manifestToAttestationData` mapping is unit tested. The on-chain calls in `client.ts` mirror the
official example's API exactly (same function names/argument shapes), so the remaining risk is
funding, not code correctness.

To unblock, pick one:
1. Fund a fixed devnet address manually via <https://faucet.solana.com> (web UI, needs a human +
   captcha — not automatable), then adapt `setupClient()` to load that persisted keypair instead
   of `generatedPayer()`'s ephemeral one.
2. Run `solana-test-validator` locally (no airdrop limit) — blocked on this machine by a Windows
   permission error unpacking the genesis archive; see
   `E:\_projetos\_conhecimento\blockchain-solana-attestation-service.md` for the full
   troubleshooting log.
3. Use a funded private RPC provider (Helius/QuickNode/Ankr) instead of the public devnet RPC.

## Gotcha carried over from the ChainOil hackathon project

Devnet's simulation node uses a stale cache and can reject a transaction's blockhash even when
it's genuinely recent — ChainOil's Solana flow needed `skipPreflight: true` on every
`sendRawTransaction` call to avoid spurious failures. `@solana/kit`'s `client.sendTransaction(...)`
here abstracts that call; if real devnet runs hit the same stale-preflight symptom, check whether
the Kit exposes a `skipPreflight` option before assuming the transaction itself is broken.

## Known gap: no persisted issuer keypair

`setupClient()` generates a fresh issuer/signer keypair every run (matches the official demo).
That's fine for a one-shot smoke test, but a real Credential needs a stable authority so the same
Credential PDA can be reused across runs — don't invent a `@solana/kit` keypair-persistence API
without checking the real one first; this is open follow-up work, not done here.
