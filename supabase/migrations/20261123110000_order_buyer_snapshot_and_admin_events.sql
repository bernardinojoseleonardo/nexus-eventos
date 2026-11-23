alter table public.ticket_orders
  add column buyer_email text,
  add column buyer_name text;

drop policy if exists "organizers create own events" on public.events;
create policy "organizers and admins create own events" on public.events for insert to authenticated
with check (
  organizer_id = (select auth.uid())
  and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role in ('organizer', 'admin'))
);

