-- NEXUS EVENTOS: base de dados inicial. Executar num projeto Supabase novo.
create extension if not exists pgcrypto;

create type public.account_role as enum ('participant', 'organizer', 'admin');
create type public.event_status as enum ('draft', 'published', 'cancelled');
create type public.order_status as enum ('reserved', 'paid', 'cancelled', 'refunded');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  phone text,
  role public.account_role not null default 'participant',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references public.profiles(id) on delete restrict,
  title text not null check (char_length(title) between 3 and 120),
  category text not null,
  starts_at timestamptz not null,
  venue text not null,
  description text not null default '',
  ticket_price numeric(12,2) not null default 0 check (ticket_price >= 0),
  ticket_capacity integer not null check (ticket_capacity > 0),
  status public.event_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.event_images (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  object_path text not null unique,
  label text not null default 'Flyer do evento',
  position smallint not null check (position between 0 and 4),
  created_at timestamptz not null default now(),
  unique (event_id, position)
);

create table public.ticket_orders (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default ('NX-' || upper(substr(encode(gen_random_bytes(8), 'hex'), 1, 10))),
  event_id uuid not null references public.events(id) on delete restrict,
  buyer_id uuid not null references public.profiles(id) on delete restrict,
  quantity integer not null check (quantity between 1 and 20),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  total numeric(12,2) generated always as (quantity * unit_price) stored,
  status public.order_status not null default 'reserved',
  payment_reference text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create table public.platform_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
insert into public.platform_settings (key, value) values ('commission_percent', '10') on conflict (key) do nothing;

create index events_public_listing_idx on public.events (starts_at) where status = 'published';
create index events_organizer_idx on public.events (organizer_id, created_at desc);
create index orders_event_status_idx on public.ticket_orders (event_id, status);
create index orders_buyer_idx on public.ticket_orders (buyer_id, created_at desc);

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'admin');
$$;

create or replace function public.create_profile_for_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name, phone, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    new.raw_user_meta_data ->> 'phone',
    case when new.raw_user_meta_data ->> 'role' = 'organizer' then 'organizer'::public.account_role else 'participant'::public.account_role end
  );
  return new;
end;
$$;
create trigger on_auth_user_created_profile after insert on auth.users
for each row execute function public.create_profile_for_new_user();

create or replace function public.guard_profile_role()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.role is distinct from old.role and not public.is_admin() then
    raise exception 'Only an administrator can change account roles';
  end if;
  new.updated_at = now();
  return new;
end;
$$;
create trigger profiles_guard_role before update on public.profiles
for each row execute function public.guard_profile_role();

create or replace function public.guard_order_financial_fields()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not public.is_admin() then
    if new.status is distinct from old.status or new.unit_price is distinct from old.unit_price
       or new.quantity is distinct from old.quantity or new.event_id is distinct from old.event_id
       or new.buyer_id is distinct from old.buyer_id or new.paid_at is distinct from old.paid_at
       or new.payment_reference is distinct from old.payment_reference then
      raise exception 'Only an administrator or trusted payment webhook can update order financial fields';
    end if;
  end if;
  return new;
end;
$$;
create trigger orders_financial_fields before update on public.ticket_orders
for each row execute function public.guard_order_financial_fields();

create or replace function public.check_ticket_capacity()
returns trigger language plpgsql set search_path = '' as $$
declare
  event_capacity integer;
  already_reserved bigint;
  current_price numeric(12,2);
begin
  select e.ticket_capacity, e.ticket_price into event_capacity, current_price
  from public.events e where e.id = new.event_id and e.status = 'published' for update;
  if not found then raise exception 'Event is not available'; end if;
  if new.unit_price <> current_price then raise exception 'Ticket price has changed'; end if;
  select coalesce(sum(o.quantity), 0) into already_reserved
  from public.ticket_orders o where o.event_id = new.event_id and o.status in ('reserved', 'paid');
  if already_reserved + new.quantity > event_capacity then raise exception 'Not enough tickets remain'; end if;
  return new;
end;
$$;
create trigger orders_capacity_check before insert on public.ticket_orders
for each row execute function public.check_ticket_capacity();

alter table public.profiles enable row level security;
alter table public.events enable row level security;
alter table public.event_images enable row level security;
alter table public.ticket_orders enable row level security;
alter table public.platform_settings enable row level security;

create policy "profiles readable by self or admin" on public.profiles for select to authenticated
using (id = (select auth.uid()) or public.is_admin());
create policy "profiles update self or admin" on public.profiles for update to authenticated
using (id = (select auth.uid()) or public.is_admin()) with check (id = (select auth.uid()) or public.is_admin());

create policy "published events are public" on public.events for select to anon, authenticated
using (status = 'published' or organizer_id = (select auth.uid()) or public.is_admin());
create policy "organizers create own events" on public.events for insert to authenticated
with check (organizer_id = (select auth.uid()) and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'organizer'));
create policy "organizers or admins update events" on public.events for update to authenticated
using (organizer_id = (select auth.uid()) or public.is_admin())
with check ((organizer_id = (select auth.uid()) and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'organizer')) or public.is_admin());
create policy "organizers or admins delete events" on public.events for delete to authenticated
using (organizer_id = (select auth.uid()) or public.is_admin());

create policy "images public for published events" on public.event_images for select to anon, authenticated
using (exists (select 1 from public.events e where e.id = event_id and (e.status = 'published' or e.organizer_id = (select auth.uid()) or public.is_admin())));
create policy "organizers manage own event images" on public.event_images for all to authenticated
using (exists (select 1 from public.events e where e.id = event_id and (e.organizer_id = (select auth.uid()) or public.is_admin())))
with check (exists (select 1 from public.events e where e.id = event_id and (e.organizer_id = (select auth.uid()) or public.is_admin())));

create policy "buyers and admins read orders" on public.ticket_orders for select to authenticated
using (buyer_id = (select auth.uid()) or public.is_admin());
create policy "buyers create own reservations" on public.ticket_orders for insert to authenticated
with check (buyer_id = (select auth.uid()) and status = 'reserved' and paid_at is null and exists (select 1 from public.events e where e.id = event_id and e.status = 'published' and e.ticket_price = unit_price));
create policy "admins update orders" on public.ticket_orders for update to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "settings visible to admins" on public.platform_settings for select to authenticated using (public.is_admin());
create policy "settings editable by admins" on public.platform_settings for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- Relatórios financeiros só são acessíveis através de leitura administrativa protegida.
create or replace view public.admin_event_report with (security_invoker = true) as
select e.id as event_id, e.title, e.starts_at, e.organizer_id,
  count(distinct o.id) filter (where o.status = 'paid') as paid_orders,
  coalesce(sum(o.quantity) filter (where o.status = 'paid'), 0)::bigint as tickets_sold,
  coalesce(sum(o.total) filter (where o.status = 'paid'), 0)::numeric(14,2) as confirmed_gross,
  coalesce(sum(o.total) filter (where o.status = 'reserved'), 0)::numeric(14,2) as reserved_gross,
  coalesce(sum(o.quantity) filter (where o.status = 'reserved'), 0)::bigint as tickets_reserved
from public.events e left join public.ticket_orders o on o.event_id = e.id
where public.is_admin()
group by e.id, e.title, e.starts_at, e.organizer_id;

-- Storage: bucket privado. Cada objeto deve seguir o caminho {user_id}/{event_id}/{filename}.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('event-images', 'event-images', false, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
create policy "published event images readable" on storage.objects for select to anon, authenticated
using (bucket_id = 'event-images' and exists (
  select 1 from public.event_images i join public.events e on e.id = i.event_id
  where i.object_path = name and e.status = 'published'
));
create policy "organizers upload own event images" on storage.objects for insert to authenticated
with check (bucket_id = 'event-images' and (storage.foldername(name))[1] = (select auth.uid())::text and exists (
  select 1 from public.events e where e.id::text = (storage.foldername(name))[2] and e.organizer_id = (select auth.uid())
));
create policy "owners or admins update event images" on storage.objects for update to authenticated
using (bucket_id = 'event-images' and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_admin()))
with check (bucket_id = 'event-images' and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_admin()));
create policy "owners or admins delete event images" on storage.objects for delete to authenticated
using (bucket_id = 'event-images' and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_admin()));

