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
