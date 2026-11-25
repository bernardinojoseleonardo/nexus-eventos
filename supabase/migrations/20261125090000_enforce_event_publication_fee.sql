drop policy if exists "organizers create own publication payments" on public.event_publication_payments;
create policy "organizers create own publication payments"
on public.event_publication_payments for insert to authenticated
with check (
  organizer_id = (select auth.uid())
  and status = 'pending'
  and paid_at is null
  and receipt_code is null
  and payment_method in ('multicaixa_express', 'referencia', 'transferencia', 'dinheiro')
  and nullif(btrim(payment_reference), '') is not null
  and exists (
    select 1
    from public.events e
    where e.id = event_id
      and e.organizer_id = (select auth.uid())
      and e.status = 'draft'
  )
);

create unique index if not exists event_publication_payments_receipt_code_idx
  on public.event_publication_payments(receipt_code)
  where receipt_code is not null;

create or replace function public.guard_event_publication_fee()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'published' then
    if tg_op = 'UPDATE' and old.status = 'published' then
      return new;
    end if;

    if exists (
      select 1
      from public.profiles p
      where p.id = new.organizer_id
        and p.role = 'organizer'
    ) and not exists (
      select 1
      from public.event_publication_payments payment
      where payment.event_id = new.id
        and payment.organizer_id = new.organizer_id
        and payment.status = 'paid'
    ) then
      raise exception 'Pague 2 000 Kz antes de publicar o anúncio';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists events_guard_publication_fee on public.events;
create trigger events_guard_publication_fee
before insert or update of status on public.events
for each row execute function public.guard_event_publication_fee();

create or replace function public.confirm_event_publication_payment(p_payment_id uuid)
returns public.event_publication_payments
language plpgsql
security definer
set search_path = ''
as $$
declare
  payment public.event_publication_payments%rowtype;
  target_event public.events%rowtype;
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

  select *
  into target_event
  from public.events
  where id = payment.event_id
  for update;

  if not found or target_event.status <> 'draft'
    or target_event.organizer_id <> payment.organizer_id
  then
    raise exception 'The event is no longer awaiting publication';
  end if;

  if exists (
    select 1
    from public.event_publication_payments other_payment
    where other_payment.event_id = payment.event_id
      and other_payment.status = 'paid'
  ) then
    raise exception 'A publication fee has already been paid for this event';
  end if;

  update public.event_publication_payments
  set status = 'paid',
      paid_at = now(),
      receipt_code = 'PUB-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
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
