do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'organizer_status'
      and n.nspname = 'public'
  ) then
    create type public.organizer_status as enum ('pending', 'approved', 'suspended');
  end if;
end;
$$;

alter table public.profiles
  add column if not exists organizer_status public.organizer_status;

update public.profiles
set organizer_status = case
  when role = 'organizer' then 'approved'::public.organizer_status
  else null
end
where role = 'organizer';

alter table public.profiles
  alter column organizer_status set default null;

create or replace function public.create_profile_for_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  requested_role public.account_role;
begin
  requested_role := case
    when new.raw_user_meta_data ->> 'role' = 'organizer' then 'organizer'::public.account_role
    else 'participant'::public.account_role
  end;
  insert into public.profiles (id, full_name, phone, role, organizer_status)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    new.raw_user_meta_data ->> 'phone',
    requested_role,
    case when requested_role = 'organizer'
      then 'pending'::public.organizer_status
      else null
    end
  );
  return new;
end;
$$;

create or replace function public.approve_organizer(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only administrators can approve organizers';
  end if;
  update public.profiles
  set organizer_status = 'approved'::public.organizer_status
  where id = p_user_id and role = 'organizer';
  if not found then
    raise exception 'Organizer account not found';
  end if;
end;
$$;

create or replace function public.suspend_organizer(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only administrators can suspend organizers';
  end if;
  update public.profiles
  set organizer_status = 'suspended'::public.organizer_status
  where id = p_user_id and role = 'organizer';
  if not found then
    raise exception 'Organizer account not found';
  end if;
end;
$$;

create or replace function public.review_event(p_event_id uuid, p_status public.event_status)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only administrators can review events';
  end if;
  if p_status not in ('published', 'cancelled') then
    raise exception 'Event review must publish or cancel the event';
  end if;
  update public.events set status = p_status, updated_at = now()
  where id = p_event_id;
  if not found then
    raise exception 'Event not found';
  end if;
end;
$$;

revoke all on function public.approve_organizer(uuid) from public, anon;
revoke all on function public.suspend_organizer(uuid) from public, anon;
revoke all on function public.review_event(uuid, public.event_status) from public, anon;
grant execute on function public.approve_organizer(uuid) to authenticated;
grant execute on function public.suspend_organizer(uuid) to authenticated;
grant execute on function public.review_event(uuid, public.event_status) to authenticated;

drop policy if exists "organizers and admins create own events" on public.events;
create policy "approved organizers and admins create own events" on public.events
for insert to authenticated
with check (
  organizer_id = (select auth.uid())
  and (
    public.is_admin()
    or exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid())
        and p.role = 'organizer'
        and p.organizer_status = 'approved'
    )
  )
);

create or replace function public.guard_event_moderation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin()
    and new.status is distinct from old.status
    and new.status = 'published'
  then
    raise exception 'Event publication requires administrator approval';
  end if;

  if not public.is_admin()
    and exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role = 'organizer'
        and p.organizer_status is distinct from 'approved'
    )
  then
    raise exception 'Only approved organizers can manage events';
  end if;

  return new;
end;
$$;

drop trigger if exists events_guard_moderation on public.events;
create trigger events_guard_moderation
before update on public.events
for each row execute function public.guard_event_moderation();
