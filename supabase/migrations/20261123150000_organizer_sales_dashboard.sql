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
    coalesce(sum(o.quantity) filter (where o.status = 'reserved'), 0)::bigint,
    coalesce(sum(o.total) filter (where o.status = 'paid'), 0)::numeric,
    coalesce(sum(o.total) filter (where o.status = 'reserved'), 0)::numeric
  from public.events e
  left join public.ticket_orders o on o.event_id = e.id
  where auth.uid() is not null
    and e.organizer_id = auth.uid()
  group by e.id, e.title, e.starts_at
  order by e.starts_at desc nulls last;
$$;

revoke all on function public.get_my_organizer_event_report() from public, anon;
grant execute on function public.get_my_organizer_event_report() to authenticated;

