-- Streamlines cover photos: a public Storage bucket Zach can upload property
-- photos to directly from the dashboard, auto-filling cover_image_url with a
-- stable public URL (no more Imgur/Drive copy-paste).

insert into storage.buckets (id, name, public)
values ('property-photos', 'property-photos', true)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'authenticated_manage_property_photos'
  ) then
    execute 'create policy "authenticated_manage_property_photos" on storage.objects
               for all using (bucket_id = ''property-photos'' and auth.role() = ''authenticated'')
               with check (bucket_id = ''property-photos'' and auth.role() = ''authenticated'')';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'public_read_property_photos'
  ) then
    execute 'create policy "public_read_property_photos" on storage.objects
               for select using (bucket_id = ''property-photos'')';
  end if;
end $$;
