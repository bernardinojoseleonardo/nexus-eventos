alter table public.profiles
  add column if not exists bi_number text,
  add column if not exists profile_photo_path text;

alter table public.events
  add column if not exists organizer_name text not null default '',
  add column if not exists organizer_phone text not null default '',
  add column if not exists organizer_photo_url text not null default '';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('organizer-profile-photos', 'organizer-profile-photos', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

drop policy if exists "organizer profile photos are public" on storage.objects;
create policy "organizer profile photos are public"
on storage.objects for select to anon, authenticated
using (bucket_id = 'organizer-profile-photos');

drop policy if exists "organizers upload own profile photo" on storage.objects;
create policy "organizers upload own profile photo"
on storage.objects for insert to authenticated
with check (bucket_id = 'organizer-profile-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "organizers update own profile photo" on storage.objects;
create policy "organizers update own profile photo"
on storage.objects for update to authenticated
using (bucket_id = 'organizer-profile-photos' and (storage.foldername(name))[1] = (select auth.uid())::text)
with check (bucket_id = 'organizer-profile-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "organizers delete own profile photo" on storage.objects;
create policy "organizers delete own profile photo"
on storage.objects for delete to authenticated
using (bucket_id = 'organizer-profile-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

