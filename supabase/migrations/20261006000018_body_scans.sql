-- 360° body scans: the phone records a slow turn, picks front / back / left / right frames, cuts
-- the person out of each and uploads them; a 3D model is then built from all four views.

alter table public.avatar_models drop constraint if exists avatar_models_source_kind_check;
alter table public.avatar_models add constraint avatar_models_source_kind_check check (source_kind in ('avatar', 'tryon', 'scan'));

-- The four cut-out views of a scan ({front, back, left, right}: Storage paths under <user>/scan/).
-- "left" is the person's left side facing the camera. Null for photo and try-on sources.
alter table public.avatar_models add column if not exists scan_views jsonb;

-- Users may only queue a scan whose views sit in their own folder (the API checks this too).
drop policy if exists "create own" on public.avatar_models;
create policy "create own" on public.avatar_models for insert to authenticated
  with check (
    user_id = (select auth.uid()) and status = 'pending' and model_path is null and provider_ref is null
    and (scan_views is null or (
      scan_views ->> 'front' like (select auth.uid())::text || '/scan/%'
      and coalesce(scan_views ->> 'back', '') like (select auth.uid())::text || '/scan/%'
      and coalesce(scan_views ->> 'left', '') like (select auth.uid())::text || '/scan/%'
      and coalesce(scan_views ->> 'right', '') like (select auth.uid())::text || '/scan/%'
    ))
  );
