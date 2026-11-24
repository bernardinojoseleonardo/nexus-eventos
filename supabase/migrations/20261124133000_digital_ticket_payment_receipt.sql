alter table public.ticket_orders
  add column if not exists payment_method text,
  add column if not exists payment_reference text,
  add column if not exists digital_ticket_code text,
  add column if not exists ticket_issued_at timestamptz;

create or replace function public.issue_paid_ticket(p_order_id uuid)
returns public.ticket_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  issued public.ticket_orders%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can issue a paid ticket';
  end if;

  update public.ticket_orders
  set
    status = 'paid',
    paid_at = coalesce(paid_at, now()),
    digital_ticket_code = coalesce(
      digital_ticket_code,
      'NX-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
    ),
    ticket_issued_at = coalesce(ticket_issued_at, now())
  where id = p_order_id
    and status = 'reserved'
  returning * into issued;

  if not found then
    raise exception 'Reservation not found or already paid';
  end if;

  return issued;
end;
$$;

revoke all on function public.issue_paid_ticket(uuid) from public, anon;
grant execute on function public.issue_paid_ticket(uuid) to authenticated;
