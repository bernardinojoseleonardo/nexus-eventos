create or replace function public.get_public_event_availability()
returns table (
  event_id uuid,
  remaining_quantity integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    e.id,
    greatest(
      e.ticket_capacity - coalesce(sum(o.quantity) filter (
        where o.status in ('reserved', 'paid')
      ), 0)::integer,
      0
    )
  from public.events e
  left join public.ticket_orders o on o.event_id = e.id
  where e.status = 'published'
  group by e.id, e.ticket_capacity;
$$;

revoke all on function public.get_public_event_availability() from public, anon;
grant execute on function public.get_public_event_availability() to anon, authenticated;

create or replace function public.cancel_my_reservation(p_order_id uuid)
returns public.ticket_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  cancelled public.ticket_orders%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Entre na sua conta para cancelar uma reserva';
  end if;

  select *
  into cancelled
  from public.ticket_orders
  where id = p_order_id
    and buyer_id = auth.uid()
    and status = 'reserved'
  for update;

  if not found then
    raise exception 'Reserva não encontrada, já paga ou já cancelada';
  end if;

  update public.ticket_orders
  set status = 'cancelled'
  where id = cancelled.id
  returning * into cancelled;

  return cancelled;
end;
$$;

revoke all on function public.cancel_my_reservation(uuid) from public, anon;
grant execute on function public.cancel_my_reservation(uuid) to authenticated;
