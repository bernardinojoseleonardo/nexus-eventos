alter table public.ticket_orders
  add column if not exists expires_at timestamptz,
  add column if not exists expired_at timestamptz;

update public.ticket_orders
set expires_at = greatest(
  created_at + interval '15 minutes',
  statement_timestamp() + interval '15 minutes'
)
where status = 'reserved'
  and expires_at is null;

create index if not exists ticket_orders_active_reservations_idx
  on public.ticket_orders (event_id, expires_at)
  where status = 'reserved';

create or replace function public.guard_order_financial_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('nexus.ticket_order_rpc', true) = 'on' then
    return new;
  end if;

  if not public.is_admin() then
    if new.status is distinct from old.status
       or new.unit_price is distinct from old.unit_price
       or new.quantity is distinct from old.quantity
       or new.event_id is distinct from old.event_id
       or new.buyer_id is distinct from old.buyer_id
       or new.paid_at is distinct from old.paid_at
       or new.payment_reference is distinct from old.payment_reference then
      raise exception 'Only an administrator or trusted payment webhook can update order financial fields';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.expire_ticket_reservations(p_event_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  expired_count integer;
begin
  perform set_config('nexus.ticket_order_rpc', 'on', true);

  update public.ticket_orders
  set status = 'cancelled',
      expired_at = statement_timestamp()
  where status = 'reserved'
    and expires_at <= statement_timestamp()
    and expired_at is null
    and (p_event_id is null or event_id = p_event_id);

  get diagnostics expired_count = row_count;
  return expired_count;
end;
$$;

revoke all on function public.expire_ticket_reservations(uuid) from public, anon, authenticated;

create or replace function public.check_ticket_capacity()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  event_capacity integer;
  already_reserved bigint;
  current_price numeric(12,2);
begin
  select e.ticket_capacity, e.ticket_price into event_capacity, current_price
  from public.events e
  where e.id = new.event_id and e.status = 'published'
  for update;

  if not found then
    raise exception 'Event is not available';
  end if;
  if new.unit_price <> current_price then
    raise exception 'Ticket price has changed';
  end if;

  select coalesce(sum(o.quantity), 0) into already_reserved
  from public.ticket_orders o
  where o.event_id = new.event_id
    and (
      o.status = 'paid'
      or (o.status = 'reserved' and o.expires_at > clock_timestamp())
    );

  if already_reserved + new.quantity > event_capacity then
    raise exception 'Not enough tickets remain';
  end if;
  return new;
end;
$$;

drop policy if exists "buyers create own reservations" on public.ticket_orders;

create or replace function public.create_ticket_order(
  p_event_id uuid,
  p_quantity integer,
  p_payment_method text,
  p_payment_reference text default null
)
returns public.ticket_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_event public.events%rowtype;
  buyer_name text;
  already_reserved bigint;
  buyer_event_tickets bigint;
  created_order public.ticket_orders%rowtype;
  reservation_time timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Entre na sua conta antes de reservar';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 4 then
    raise exception 'Pode reservar no máximo 4 ingressos por pedido';
  end if;
  if p_payment_method is null
     or p_payment_method not in ('multicaixa_express', 'referencia', 'transferencia', 'cartao', 'dinheiro') then
    raise exception 'Método de pagamento inválido';
  end if;

  select p.full_name into buyer_name
  from public.profiles p
  where p.id = auth.uid();
  if not found then
    raise exception 'Perfil do participante não encontrado';
  end if;

  select * into target_event
  from public.events e
  where e.id = p_event_id and e.status = 'published'
  for update;
  if not found then
    raise exception 'Event is not available';
  end if;

  reservation_time := clock_timestamp();
  perform public.expire_ticket_reservations(p_event_id);

  select coalesce(sum(o.quantity), 0) into already_reserved
  from public.ticket_orders o
  where o.event_id = p_event_id
    and (
      o.status = 'paid'
      or (o.status = 'reserved' and o.expires_at > reservation_time)
    );

  select coalesce(sum(o.quantity), 0) into buyer_event_tickets
  from public.ticket_orders o
  where o.event_id = p_event_id
    and o.buyer_id = auth.uid()
    and (
      o.status = 'paid'
      or (o.status = 'reserved' and o.expires_at > reservation_time)
    );

  if buyer_event_tickets + p_quantity > 4 then
    raise exception 'Pode comprar no máximo 4 ingressos por conta para este evento';
  end if;

  if already_reserved + p_quantity > target_event.ticket_capacity then
    raise exception 'Not enough tickets remain';
  end if;

  insert into public.ticket_orders (
    event_id,
    buyer_id,
    buyer_name,
    buyer_email,
    quantity,
    unit_price,
    payment_method,
    payment_reference,
    expires_at
  )
  values (
    p_event_id,
    auth.uid(),
    buyer_name,
    null,
    p_quantity,
    target_event.ticket_price,
    p_payment_method,
    nullif(btrim(p_payment_reference), ''),
    reservation_time + interval '15 minutes'
  )
  returning * into created_order;

  return created_order;
end;
$$;

revoke all on function public.create_ticket_order(uuid, integer, text, text) from public, anon;
grant execute on function public.create_ticket_order(uuid, integer, text, text) to authenticated;

create or replace function public.get_public_event_availability()
returns table (
  event_id uuid,
  remaining_quantity integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.expire_ticket_reservations(null);

  return query
  select
    e.id,
    greatest(
      e.ticket_capacity - coalesce(sum(o.quantity) filter (
        where o.status = 'paid'
           or (o.status = 'reserved' and o.expires_at > statement_timestamp())
      ), 0)::integer,
      0
    )
  from public.events e
  left join public.ticket_orders o on o.event_id = e.id
  where e.status = 'published'
  group by e.id, e.ticket_capacity;
end;
$$;

revoke all on function public.get_public_event_availability() from public, anon;
grant execute on function public.get_public_event_availability() to anon, authenticated;

create or replace function public.guard_event_ticket_capacity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  allocated_tickets bigint;
begin
  if new.ticket_capacity < old.ticket_capacity then
    select coalesce(sum(o.quantity), 0) into allocated_tickets
    from public.ticket_orders o
    where o.event_id = old.id
      and (
        o.status = 'paid'
        or (o.status = 'reserved' and o.expires_at > clock_timestamp())
      );

    if allocated_tickets > new.ticket_capacity then
      raise exception 'Ticket capacity cannot be lower than tickets already reserved or sold';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists events_ticket_capacity_guard on public.events;
create trigger events_ticket_capacity_guard
before update of ticket_capacity on public.events
for each row execute function public.guard_event_ticket_capacity();

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

  perform public.expire_ticket_reservations(null);

  select * into cancelled
  from public.ticket_orders
  where id = p_order_id
    and buyer_id = auth.uid()
    and status = 'reserved'
    and expires_at > clock_timestamp()
  for update;

  if not found then
    raise exception 'Reserva não encontrada, expirada, já paga ou já cancelada';
  end if;

  perform set_config('nexus.ticket_order_rpc', 'on', true);
  update public.ticket_orders
  set status = 'cancelled'
  where id = cancelled.id
  returning * into cancelled;

  return cancelled;
end;
$$;

revoke all on function public.cancel_my_reservation(uuid) from public, anon;
grant execute on function public.cancel_my_reservation(uuid) to authenticated;

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

  perform public.expire_ticket_reservations(null);

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
    and expires_at > clock_timestamp()
  returning * into issued;

  if not found then
    raise exception 'Reservation not found, expired or already paid';
  end if;

  return issued;
end;
$$;

revoke all on function public.issue_paid_ticket(uuid) from public, anon;
grant execute on function public.issue_paid_ticket(uuid) to authenticated;

create or replace function public.get_my_organizer_event_report()
returns table (
  event_id uuid,
  title text,
  starts_at timestamptz,
  tickets_sold bigint,
  tickets_reserved bigint,
  confirmed_gross numeric,
  reserved_gross numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    e.id,
    e.title,
    e.starts_at,
    coalesce(sum(o.quantity) filter (where o.status = 'paid'), 0)::bigint,
    coalesce(sum(o.quantity) filter (
      where o.status = 'reserved' and o.expires_at > statement_timestamp()
    ), 0)::bigint,
    coalesce(sum(o.total) filter (where o.status = 'paid'), 0)::numeric,
    coalesce(sum(o.total) filter (
      where o.status = 'reserved' and o.expires_at > statement_timestamp()
    ), 0)::numeric
  from public.events e
  left join public.ticket_orders o on o.event_id = e.id
  where auth.uid() is not null
    and e.organizer_id = auth.uid()
  group by e.id, e.title, e.starts_at
  order by e.starts_at desc nulls last;
$$;

revoke all on function public.get_my_organizer_event_report() from public, anon;
grant execute on function public.get_my_organizer_event_report() to authenticated;

create or replace view public.admin_event_report with (security_invoker = true) as
select e.id as event_id, e.title, e.starts_at, e.organizer_id,
  count(distinct o.id) filter (where o.status = 'paid') as paid_orders,
  coalesce(sum(o.quantity) filter (where o.status = 'paid'), 0)::bigint as tickets_sold,
  coalesce(sum(o.total) filter (where o.status = 'paid'), 0)::numeric(14,2) as confirmed_gross,
  coalesce(sum(o.total) filter (
    where o.status = 'reserved' and o.expires_at > statement_timestamp()
  ), 0)::numeric(14,2) as reserved_gross,
  coalesce(sum(o.quantity) filter (
    where o.status = 'reserved' and o.expires_at > statement_timestamp()
  ), 0)::bigint as tickets_reserved
from public.events e
left join public.ticket_orders o on o.event_id = e.id
where public.is_admin()
group by e.id, e.title, e.starts_at, e.organizer_id;
