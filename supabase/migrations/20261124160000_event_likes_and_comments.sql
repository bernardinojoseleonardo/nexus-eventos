create table if not exists public.event_likes (
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create table if not exists public.event_comments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  author_name text not null default '',
  content text not null check (char_length(trim(content)) between 1 and 500),
  status text not null default 'visible' check (status in ('visible', 'hidden')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists event_likes_event_idx on public.event_likes(event_id);
create index if not exists event_comments_event_status_idx on public.event_comments(event_id, status, created_at desc);

alter table public.event_likes enable row level security;
alter table public.event_comments enable row level security;

drop policy if exists "event likes are public" on public.event_likes;
create policy "event likes are public"
on public.event_likes for select to anon, authenticated
using (true);

drop policy if exists "users insert own event likes" on public.event_likes;
create policy "users insert own event likes"
on public.event_likes for insert to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists "users delete own event likes" on public.event_likes;
create policy "users delete own event likes"
on public.event_likes for delete to authenticated
using (user_id = (select auth.uid()) or public.is_admin());

drop policy if exists "visible event comments are public" on public.event_comments;
create policy "visible event comments are public"
on public.event_comments for select to anon, authenticated
using (status = 'visible');

drop policy if exists "users add event comments" on public.event_comments;
create policy "users add event comments"
on public.event_comments for insert to authenticated
with check (user_id = (select auth.uid()) and status = 'visible');

drop policy if exists "users update own event comments" on public.event_comments;
create policy "users update own event comments"
on public.event_comments for update to authenticated
using (user_id = (select auth.uid()) or public.is_admin())
with check (user_id = (select auth.uid()) or public.is_admin());

drop policy if exists "users delete own event comments" on public.event_comments;
create policy "users delete own event comments"
on public.event_comments for delete to authenticated
using (user_id = (select auth.uid()) or public.is_admin());

create or replace function public.toggle_event_like(p_event_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  exists_like boolean;
begin
  if actor_id is null then
    raise exception 'Entre na sua conta para deixar um gosto';
  end;
  if not exists (select 1 from public.events where id = p_event_id and status = 'published') then
    raise exception 'Evento não encontrado';
  end;

  select exists(select 1 from public.event_likes where event_id = p_event_id and user_id = actor_id) into exists_like;
  if exists_like then
    delete from public.event_likes where event_id = p_event_id and user_id = actor_id;
    return false;
  end if;
  insert into public.event_likes(event_id,user_id) values(p_event_id,actor_id)
  on conflict(event_id,user_id) do nothing;
  return true;
end;
$$;

create or replace function public.add_event_comment(p_event_id uuid,p_content text)
returns public.event_comments
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  profile_name text;
  created public.event_comments%rowtype;
begin
  if actor_id is null then
    raise exception 'Entre na sua conta para comentar';
  end;
  if char_length(trim(coalesce(p_content,''))) between 1 and 500 then
    null;
  else
    raise exception 'Escreva um comentário entre 1 e 500 caracteres';
  end;
  if not exists (select 1 from public.events where id = p_event_id and status = 'published') then
    raise exception 'Evento não encontrado';
  end;
  select coalesce(full_name,'Participante') into profile_name from public.profiles where id=actor_id;
  insert into public.event_comments(event_id,user_id,author_name,status,content)
  values(p_event_id,actor_id,coalesce(profile_name,'Participante'),'visible',trim(p_content))
  returning * into created;
  return created;
end;
$$;

revoke all on function public.toggle_event_like(uuid) from public,anon;
revoke all on function public.add_event_comment(uuid,text) from public,anon;
grant execute on function public.toggle_event_like(uuid) to authenticated;
grant execute on function public.add_event_comment(uuid,text) to authenticated;
