-- 0004_proofs.sql — on-chain proofs of runs (lane D, plan 20261012-itera-agent-proof-route-change-fixes).
--
-- One row per run. proofHash = manifest_sha256 = sha256 of the exact evidence bytes pinned to IPFS
-- (apps/api/src/chain/issue-proof.ts). The NFT is a tokenized SAS attestation (schema run-result-v2)
-- minted to owner_wallet. Logic stays in the API: no functions, no triggers.
--
-- Depends on 0001_runs_async.sql (runs.owner_wallet, runs.run_start_sig). Idempotent.

create table if not exists public.proofs (
  run_id uuid primary key references public.runs(id) on delete restrict,
  owner_wallet text,
  manifest_sha256 text unique,
  evidence_cid text,
  attestation_address text,
  nft_mint text,
  tx_sig text,
  status text not null default 'pending',
  error text,
  created_at timestamptz not null default now(),
  constraint proofs_status_check check (status in ('pending', 'confirmed', 'failed'))
);

-- GET /leaderboard reads confirmed proofs only.
create index if not exists proofs_confirmed_idx on public.proofs (run_id) where status = 'confirmed';
create index if not exists proofs_nft_mint_idx on public.proofs (nft_mint) where nft_mint is not null;

-- Same posture as the baseline: RLS on, no policies. Only the API (table owner role) reads/writes.
alter table public.proofs enable row level security;
