alter table public.profiles drop column if exists bi_number;

create table if not exists public.organizer_private_data (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  bi_number text not null check (length(trim(bi_number)) between 5 and 32),
  updated_at timestamptz not null default now()
);

alter table public.organizer_private_data enable row level security;
grant select on public.organizer_private_data to authenticated;
revoke insert, update, delete on public.organizer_private_data from anon, authenticated;
drop policy if exists "admins can read organizer identity data" on public.organizer_private_data;
create policy "admins can read organizer identity data"
on public.organizer_private_data for select to authenticated
using (public.is_admin());

create or replace function public.save_organizer_bi(p_bi_number text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  normalized_bi text := nullif(upper(regexp_replace(trim(p_bi_number), '\s+', '', 'g')), '');
begin
  if actor_id is null or not exists (
    select 1 from public.profiles p where p.id = actor_id and p.role = 'organizer'
  ) then
    raise exception 'Only organizers can submit identity data';
  end if;
  if normalized_bi is null or length(normalized_bi) < 5 or length(normalized_bi) > 32 then
    raise exception 'Enter a valid BI number';
  end if;
  insert into public.organizer_private_data (user_id, bi_number)
  values (actor_id, normalized_bi)
  on conflict (user_id) do update
    set bi_number = excluded.bi_number, updated_at = now();
end;
$$;

revoke all on function public.save_organizer_bi(text) from public, anon;
grant execute on function public.save_organizer_bi(text) to authenticated;

