-- 0019_evaluations_payment_kind.sql — the free evaluation path (web2 client, BYOK).
-- Plan 20261015-testmyagent-web2-client, ADR-4 and ADR-6, task T7.
--
-- One `evaluations` table and one `runs` queue serve both clients:
--   solana_pay  web3 (SIWS principal): a SOL fee, a confirmed payment, a proof per graded run.
--   free_byok   web2 (DFL principal): no fee, the user's own model key, no proof. Terminal = graded.
--
-- A free evaluation has no fee and no payment. So the fee columns become nullable, and a CHECK
-- keeps them NOT NULL for every `solana_pay` row (the web3 invariant stays in the database).
-- `payment_id` is already nullable and its foreign key to payments stays as is: a `free_byok`
-- row must not point at a payment.
--
-- Idempotent: safe to run twice. Additive for existing rows (all of them are `solana_pay` with
-- every fee column set). No DB functions, no triggers: the logic stays in apps/api.
-- Depends on 0008_evaluations_payments.sql.

begin;

alter table public.evaluations add column if not exists payment_kind text not null default 'solana_pay';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'evaluations_payment_kind_check') then
    alter table public.evaluations add constraint evaluations_payment_kind_check
      check (payment_kind in ('solana_pay', 'free_byok'));
  end if;
end $$;

alter table public.evaluations alter column price_usd_per_run drop not null;
alter table public.evaluations alter column fee_usd           drop not null;
alter table public.evaluations alter column fee_lamports      drop not null;
alter table public.evaluations alter column sol_usd_rate      drop not null;
alter table public.evaluations alter column price_source      drop not null;

do $$
begin
  -- The web3 invariant: a paid evaluation always carries its fee.
  if not exists (select 1 from pg_constraint where conname = 'evaluations_solana_pay_fee_check') then
    alter table public.evaluations add constraint evaluations_solana_pay_fee_check
      check (
        payment_kind <> 'solana_pay'
        or (price_usd_per_run is not null and fee_usd is not null and fee_lamports is not null
            and sol_usd_rate is not null and price_source is not null)
      );
  end if;
  -- A free evaluation has no payment.
  if not exists (select 1 from pg_constraint where conname = 'evaluations_free_byok_payment_check') then
    alter table public.evaluations add constraint evaluations_free_byok_payment_check
      check (payment_kind <> 'free_byok' or payment_id is null);
  end if;
end $$;

-- `graded`: the terminal state of a free evaluation (every run graded, no proof to issue).
alter table public.evaluations drop constraint if exists evaluations_status_check;
alter table public.evaluations add constraint evaluations_status_check
  check (status in ('pending', 'in_progress', 'review', 'issuing', 'issued', 'graded', 'cancelled', 'failed'));

-- The abuse floor of the free path counts the queued and running runs of one principal.
create index if not exists runs_owner_wallet_active_idx on public.runs (owner_wallet)
  where status in ('queued', 'running');

commit;
