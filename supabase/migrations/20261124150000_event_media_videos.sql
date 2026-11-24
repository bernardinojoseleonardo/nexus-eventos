create table if not exists public.event_media (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  object_path text not null unique,
  media_type text not null check (media_type in ('image','video')),
  label text not null default '',
  position smallint not null check (position between 0 and 9),
  created_at timestamptz not null default now(),
  unique (event_id, media_type, position)
);

alter table public.event_media enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'event-media',
  'event-media',
  false,
  104857600,
  array[
    'image/jpeg','image/png','image/webp',
    'video/mp4','video/webm','video/quicktime'
  ]
)
on conflict (id) do update
set file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "published event media readable" on storage.objects;
create policy "published event media readable"
on storage.objects for select to anon, authenticated
using (
  bucket_id = 'event-media'
  and exists (
    select 1
    from public.event_media m
    join public.events e on e.id = m.event_id
    where m.object_path = name
      and (e.status = 'published' or e.organizer_id = (select auth.uid()) or public.is_admin())
  )
);

drop policy if exists "organizers upload own event media" on storage.objects;
create policy "organizers upload own event media"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'event-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1
    from public.events e
    where e.id::text = (storage.foldername(name))[2]
      and (e.organizer_id = (select auth.uid()) or public.is_admin())
  )
);

drop policy if exists "owners or admins manage event media" on storage.objects;
create policy "owners or admins manage event media"
on storage.objects for all to authenticated
using (
  bucket_id = 'event-media'
  and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or public.is_admin()
  )
)
with check (
  bucket_id = 'event-media'
  and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or public.is_admin()
  )
);

drop policy if exists "event media follows event visibility" on public.event_media;
create policy "event media follows event visibility"
on public.event_media for select to anon, authenticated
using (
  exists (
    select 1
    from public.events e
    where e.id = event_id
      and (e.status = 'published' or e.organizer_id = (select auth.uid()) or public.is_admin())
  )
);

drop policy if exists "organizers manage own event media" on public.event_media;
create policy "organizers manage own event media"
on public.event_media for all to authenticated
using (
  exists (
    select 1
    from public.events e
    where e.id = event_id
      and (e.organizer_id = (select auth.uid()) or public.is_admin())
  )
)
with check (
  exists (
    select 1
    from public.events e
    where e.id = event_id
      and (e.organizer_id = (select auth.uid()) or public.is_admin())
  )
);
