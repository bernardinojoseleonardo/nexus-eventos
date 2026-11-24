create table if not exists public.event_publication_payments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  organizer_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric(12,2) not null default 2000 check (amount = 2000),
  payment_method text,
  payment_reference text,
  status text not null default 'pending' check (status in ('pending','paid','cancelled')),
  receipt_code text,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists event_publication_payments_organizer_idx
  on public.event_publication_payments(organizer_id, created_at desc);
create index if not exists event_publication_payments_status_idx
  on public.event_publication_payments(status, created_at desc);

alter table public.event_publication_payments enable row level security;

drop policy if exists "organizers read own publication payments" on public.event_publication_payments;
create policy "organizers read own publication payments"
on public.event_publication_payments for select to authenticated
using (organizer_id = (select auth.uid()) or public.is_admin());

drop policy if exists "organizers create own publication payments" on public.event_publication_payments;
create policy "organizers create own publication payments"
on public.event_publication_payments for insert to authenticated
with check (organizer_id = (select auth.uid()) and status = 'pending');

drop policy if exists "admins manage publication payments" on public.event_publication_payments;
create policy "admins manage publication payments"
on public.event_publication_payments for all to authenticated
using (public.is_admin())
with check (public.is_admin());

create or replace function public.confirm_event_publication_payment(p_payment_id uuid)
returns public.event_publication_payments
language plpgsql
security definer
set search_path = ''
as $$
declare
  payment public.event_publication_payments%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only administrators can confirm publication payments';
  end if;

  select *
  into payment
  from public.event_publication_payments
  where id = p_payment_id
    and status = 'pending'
  for update;

  if not found then
    raise exception 'Publication payment not found or already processed';
  end if;

  update public.event_publication_payments
  set status = 'paid',
      paid_at = coalesce(paid_at, now()),
      receipt_code = coalesce(receipt_code, 'PUB-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)))
  where id = payment.id
  returning * into payment;

  update public.events
  set status = 'published', updated_at = now()
  where id = payment.event_id;

  return payment;
end;
$$;

revoke all on function public.confirm_event_publication_payment(uuid) from public, anon;
grant execute on function public.confirm_event_publication_payment(uuid) to authenticated;
