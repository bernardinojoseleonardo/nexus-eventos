alter table public.profiles
  add column if not exists has_identity_data boolean not null default false;

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
  update public.profiles set has_identity_data = true where id = actor_id;
end;
$$;

revoke all on function public.save_organizer_bi(text) from public, anon;
grant execute on function public.save_organizer_bi(text) to authenticated;

