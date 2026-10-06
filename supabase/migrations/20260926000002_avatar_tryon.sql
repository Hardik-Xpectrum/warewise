-- Avatar and virtual try-on, plus sample wardrobe data for testing.
-- Avatar photos are body images: kept in their own folder, max 5 per user, deleted with the account,
-- and only sent to an outside AI after a separate 'avatar_ai' consent.

-- Garment cut-outs (transparent background) for the try-on preview, and sample-data flags.
alter table public.wardrobe_items add column cutout_path text;
alter table public.wardrobe_items add column is_sample boolean not null default false;
alter table public.outfits add column is_sample boolean not null default false;

-- New consent kind: sending avatar photos to a third-party try-on model.
alter table public.consents drop constraint consents_kind_check;
alter table public.consents add constraint consents_kind_check check (kind in ('ai_training', 'analytics', 'avatar_ai'));

alter table public.usage_counters add column tryon_calls int not null default 0;

create or replace function public.take_usage(p_kind text, p_cap int) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_day date := (now() at time zone 'Asia/Kolkata')::date;
  v_count int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_kind not in ('stylist_calls', 'tag_calls', 'tryon_calls') then raise exception 'bad kind'; end if;

  insert into public.usage_counters (user_id, day) values (v_uid, v_day)
  on conflict (user_id, day) do nothing;

  execute format(
    'update public.usage_counters set %1$I = %1$I + 1 where user_id = $1 and day = $2 and %1$I < $3 returning %1$I',
    p_kind)
  into v_count using v_uid, v_day, p_cap;

  return coalesce(v_count, -1);
end;
$$;

-- ---------------------------------------------------------------------------
-- Avatar photos
-- ---------------------------------------------------------------------------
create table public.avatar_photos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  path text not null,               -- person cut-out, transparent WebP
  width int not null,
  height int not null,
  pose jsonb not null,              -- normalised body landmarks detected on the device
  quality real not null,            -- 0..1: how usable the photo is for try-on
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);
create index avatar_photos_user on public.avatar_photos (user_id, created_at);
create unique index avatar_photos_one_primary on public.avatar_photos (user_id) where is_primary;

create or replace function public.limit_avatar_photos() returns trigger
language plpgsql as $$
begin
  if (select count(*) from public.avatar_photos where user_id = new.user_id) >= 5 then
    raise exception 'avatar photo limit reached' using errcode = 'P0001', hint = 'max 5 photos';
  end if;
  return new;
end;
$$;
create trigger avatar_photos_limit before insert on public.avatar_photos
  for each row execute function public.limit_avatar_photos();

-- ---------------------------------------------------------------------------
-- Try-on results (AI mode; the instant preview is drawn in the browser and not stored)
-- ---------------------------------------------------------------------------
create table public.tryon_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  avatar_photo_id uuid references public.avatar_photos on delete set null,
  outfit_id uuid references public.outfits on delete set null,
  item_ids uuid[] not null,
  engine text not null,
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  result_path text,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index tryon_results_user on public.tryon_results (user_id, created_at desc);

alter table public.avatar_photos enable row level security;
alter table public.tryon_results enable row level security;
create policy "own rows" on public.avatar_photos for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- Users read their results; only the job handler writes status and images.
create policy "read own" on public.tryon_results for select to authenticated using (user_id = (select auth.uid()));
create policy "create own" on public.tryon_results for insert to authenticated with check (user_id = (select auth.uid()) and status = 'pending');
create policy "delete own" on public.tryon_results for delete to authenticated using (user_id = (select auth.uid()));

-- Try-on jobs share the media job runner, on their own queue.
select pgmq.create('tryon_jobs');

create or replace function public.enqueue_tryon_job() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pgmq.send('tryon_jobs', jsonb_build_object('tryon_id', new.id, 'user_id', new.user_id));
  return new;
end;
$$;
create trigger tryon_results_enqueue after insert on public.tryon_results
  for each row execute function public.enqueue_tryon_job();

create or replace function public.read_tryon_jobs(p_qty int, p_vt int)
returns table (msg_id bigint, read_ct int, message jsonb)
language sql security definer set search_path = '' as $$
  select m.msg_id, m.read_ct, m.message from pgmq.read('tryon_jobs', p_vt, p_qty) m;
$$;
create or replace function public.finish_tryon_job(p_msg_id bigint) returns void
language sql security definer set search_path = '' as $$
  select pgmq.delete('tryon_jobs', p_msg_id);
$$;
create or replace function public.give_up_tryon_job(p_msg_id bigint) returns void
language sql security definer set search_path = '' as $$
  select pgmq.archive('tryon_jobs', p_msg_id);
$$;

do $$
declare f text;
begin
  foreach f in array array['read_tryon_jobs(int, int)', 'finish_tryon_job(bigint)', 'give_up_tryon_job(bigint)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- The scheduler also wakes the runner for waiting try-on jobs.
create or replace function private.trigger_job_runner() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_url text := (select value from private.settings where key = 'jobs_url');
  v_secret text := (select value from private.settings where key = 'jobs_secret');
begin
  if v_url is null or v_secret is null then return; end if;
  if not exists (select 1 from pgmq.q_media_jobs where vt <= now())
     and not exists (select 1 from pgmq.q_tryon_jobs where vt <= now()) then
    return;
  end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('content-type', 'application/json', 'x-job-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
end;
$$;

alter publication supabase_realtime add table public.tryon_results;
