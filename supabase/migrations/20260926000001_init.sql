-- Warewise MVP schema. See the architecture doc, section 6.
-- Every user-owned table carries user_id and is protected by row-level security.

create extension if not exists vector with schema extensions;
create extension if not exists pgmq;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.item_status as enum ('processing', 'ready', 'failed');
create type public.item_lifecycle as enum ('active', 'laundry', 'lent', 'archived');
create type public.outfit_slot as enum ('top', 'bottom', 'one_piece', 'outer', 'shoes', 'accessory');
create type public.feedback_kind as enum ('like', 'dislike', 'regenerate', 'saved');

create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- identity
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  home_city text,
  lat double precision,
  lon double precision,
  style_prefs jsonb not null default '{}'::jsonb,
  body_profile jsonb not null default '{}'::jsonb,
  daily_stylist_cap int not null default 10,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  kind text not null check (kind in ('ai_training', 'analytics')),
  granted boolean not null,
  policy_version text not null,
  decided_at timestamptz not null default now()
);
create index consents_user_kind on public.consents (user_id, kind, decided_at desc);

-- New auth user -> profile row.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- wardrobe
-- ---------------------------------------------------------------------------
create table public.wardrobe_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  status public.item_status not null default 'processing',
  status_reason text,
  lifecycle public.item_lifecycle not null default 'active',
  category public.outfit_slot,
  subcategory text,
  colors text[] not null default '{}',
  pattern text,
  seasons text[] not null default '{}',
  fabric text,
  formality smallint check (formality between 1 and 5),
  fit text,
  brand text,
  price_inr numeric(10, 2) check (price_inr >= 0),
  notes text,
  image_path text not null,
  clean_path text,
  thumb_path text,
  phash text,
  embedding extensions.vector(512),
  duplicate_of uuid references public.wardrobe_items on delete set null,
  ai_tags jsonb,
  ai_confidence real,
  user_verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index wardrobe_items_user_lifecycle on public.wardrobe_items (user_id, lifecycle, category) where deleted_at is null;
create index wardrobe_items_colors on public.wardrobe_items using gin (colors);
create index wardrobe_items_seasons on public.wardrobe_items using gin (seasons);
create index wardrobe_items_embedding on public.wardrobe_items using hnsw (embedding extensions.vector_cosine_ops);
create trigger wardrobe_items_updated_at before update on public.wardrobe_items
  for each row execute function public.set_updated_at();

create table public.item_corrections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  item_id uuid not null references public.wardrobe_items on delete cascade,
  field text not null,
  ai_value text,
  user_value text,
  created_at timestamptz not null default now()
);
create index item_corrections_item on public.item_corrections (item_id);

-- ---------------------------------------------------------------------------
-- outfits, stylist, insights
-- ---------------------------------------------------------------------------
create table public.outfits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text,
  occasion text,
  source text not null check (source in ('ai', 'rules', 'manual')),
  saved boolean not null default false,
  is_favorite boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index outfits_user_saved on public.outfits (user_id, saved, created_at desc);
create trigger outfits_updated_at before update on public.outfits
  for each row execute function public.set_updated_at();

create table public.outfit_items (
  outfit_id uuid not null references public.outfits on delete cascade,
  item_id uuid not null references public.wardrobe_items on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  slot public.outfit_slot not null,
  primary key (outfit_id, item_id)
);
create index outfit_items_item on public.outfit_items (item_id);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text,
  created_at timestamptz not null default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index messages_conversation on public.messages (conversation_id, created_at);

create table public.ai_interactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade,
  job text not null,
  model_key text,
  provider_model text,
  prompt_version text,
  request jsonb,
  response jsonb,
  tokens_in int,
  tokens_out int,
  latency_ms int,
  status text not null check (status in ('ok', 'error', 'invalid', 'skipped')),
  error text,
  request_id text,
  created_at timestamptz not null default now()
);
create index ai_interactions_created on public.ai_interactions (created_at);
create index ai_interactions_user on public.ai_interactions (user_id, created_at desc);

create table public.recommendations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  conversation_id uuid references public.conversations on delete cascade,
  outfit_id uuid not null references public.outfits on delete cascade,
  occasion text,
  event_date date,
  weather jsonb,
  rank smallint not null default 1,
  why text,
  source text not null check (source in ('ai', 'rules')),
  ai_interaction_id uuid references public.ai_interactions on delete set null,
  created_at timestamptz not null default now()
);
create index recommendations_conversation on public.recommendations (conversation_id);

create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  recommendation_id uuid not null references public.recommendations on delete cascade,
  kind public.feedback_kind not null,
  reason text,
  created_at timestamptz not null default now()
);

create table public.wear_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  outfit_id uuid references public.outfits on delete set null,
  worn_on date not null default current_date,
  created_at timestamptz not null default now()
);
create index wear_log_user_date on public.wear_log (user_id, worn_on desc);

create table public.wear_log_items (
  wear_log_id uuid not null references public.wear_log on delete cascade,
  item_id uuid not null references public.wardrobe_items on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  primary key (wear_log_id, item_id)
);
create index wear_log_items_item on public.wear_log_items (item_id);

-- ---------------------------------------------------------------------------
-- platform
-- ---------------------------------------------------------------------------
create table public.usage_counters (
  user_id uuid not null references auth.users on delete cascade,
  day date not null,
  stylist_calls int not null default 0,
  tag_calls int not null default 0,
  primary key (user_id, day)
);

create table public.ai_model_usage (
  model_key text not null,
  window_kind text not null check (window_kind in ('minute', 'day')),
  window_start timestamptz not null,
  calls int not null default 0,
  primary key (model_key, window_kind, window_start)
);

create table public.weather_cache (
  location_key text not null,
  date date not null,
  forecast jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (location_key, date)
);

create table public.idempotency_keys (
  user_id uuid not null references auth.users on delete cascade,
  key text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
create policy "own profile" on public.profiles for all to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

do $$
declare t text;
begin
  foreach t in array array[
    'consents', 'wardrobe_items', 'item_corrections', 'outfits', 'outfit_items',
    'conversations', 'messages', 'recommendations', 'feedback', 'wear_log',
    'wear_log_items', 'idempotency_keys'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy "own rows" on public.%I for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
      t);
  end loop;
end $$;

alter table public.usage_counters enable row level security;
create policy "read own usage" on public.usage_counters for select to authenticated
  using (user_id = (select auth.uid()));

-- Service-role only (no policies): AI logs, model quota, weather cache.
alter table public.ai_interactions enable row level security;
alter table public.ai_model_usage enable row level security;
alter table public.weather_cache enable row level security;

-- ---------------------------------------------------------------------------
-- Daily per-user caps. Returns the new count, or -1 when the cap is reached.
-- ---------------------------------------------------------------------------
create or replace function public.take_usage(p_kind text, p_cap int) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_day date := (now() at time zone 'Asia/Kolkata')::date;
  v_count int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_kind not in ('stylist_calls', 'tag_calls') then raise exception 'bad kind'; end if;

  insert into public.usage_counters (user_id, day) values (v_uid, v_day)
  on conflict (user_id, day) do nothing;

  execute format(
    'update public.usage_counters set %1$I = %1$I + 1 where user_id = $1 and day = $2 and %1$I < $3 returning %1$I',
    p_kind)
  into v_count using v_uid, v_day, p_cap;

  return coalesce(v_count, -1);
end;
$$;
revoke all on function public.take_usage(text, int) from public, anon;
grant execute on function public.take_usage(text, int) to authenticated;

-- AI router free-quota check: atomically counts a call against a model's minute and day windows.
create or replace function public.take_model_quota(p_model text, p_per_minute int, p_per_day int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_minute timestamptz := date_trunc('minute', now());
  v_day timestamptz := date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles';
  v_ok boolean;
begin
  insert into public.ai_model_usage (model_key, window_kind, window_start) values
    (p_model, 'minute', v_minute), (p_model, 'day', v_day)
  on conflict do nothing;

  -- Lock both rows, check both limits, then increment both.
  perform 1 from public.ai_model_usage
    where model_key = p_model and ((window_kind = 'minute' and window_start = v_minute) or (window_kind = 'day' and window_start = v_day))
    for update;

  select bool_and(case when window_kind = 'minute' then p_per_minute is null or calls < p_per_minute
                       else p_per_day is null or calls < p_per_day end)
    into v_ok
    from public.ai_model_usage
    where model_key = p_model and ((window_kind = 'minute' and window_start = v_minute) or (window_kind = 'day' and window_start = v_day));

  if v_ok then
    update public.ai_model_usage set calls = calls + 1
      where model_key = p_model and ((window_kind = 'minute' and window_start = v_minute) or (window_kind = 'day' and window_start = v_day));
  end if;
  return coalesce(v_ok, false);
end;
$$;
revoke all on function public.take_model_quota(text, int, int) from public, anon, authenticated;
grant execute on function public.take_model_quota(text, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- Media job queue (pgmq). An item entering 'processing' is queued in the same transaction.
-- ---------------------------------------------------------------------------
select pgmq.create('media_jobs');

create or replace function public.enqueue_media_job() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'processing' and (tg_op = 'INSERT' or old.status is distinct from 'processing') then
    perform pgmq.send('media_jobs', jsonb_build_object('item_id', new.id, 'user_id', new.user_id));
  end if;
  return new;
end;
$$;
create trigger wardrobe_items_enqueue after insert or update of status on public.wardrobe_items
  for each row execute function public.enqueue_media_job();

create or replace function public.read_media_jobs(p_qty int, p_vt int)
returns table (msg_id bigint, read_ct int, message jsonb)
language sql security definer set search_path = '' as $$
  select m.msg_id, m.read_ct, m.message from pgmq.read('media_jobs', p_vt, p_qty) m;
$$;

create or replace function public.finish_media_job(p_msg_id bigint) returns void
language sql security definer set search_path = '' as $$
  select pgmq.delete('media_jobs', p_msg_id);
$$;

create or replace function public.give_up_media_job(p_msg_id bigint) returns void
language sql security definer set search_path = '' as $$
  select pgmq.archive('media_jobs', p_msg_id);
$$;

-- Put a job back without spending an attempt (used when every AI model is out of free quota).
create or replace function public.requeue_media_job(p_msg_id bigint, p_delay_seconds int) returns void
language plpgsql security definer set search_path = '' as $$
declare v_message jsonb;
begin
  select message into v_message from pgmq.q_media_jobs where msg_id = p_msg_id;
  if v_message is null then return; end if;
  perform pgmq.delete('media_jobs', p_msg_id);
  perform pgmq.send('media_jobs', v_message, p_delay_seconds);
end;
$$;

create or replace function public.media_queue_depth() returns bigint
language sql security definer set search_path = '' as $$
  select count(*) from pgmq.q_media_jobs;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'read_media_jobs(int, int)', 'finish_media_job(bigint)', 'give_up_media_job(bigint)',
    'requeue_media_job(bigint, int)', 'media_queue_depth()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Scheduler: pg_cron calls the app's job endpoint every minute through pg_net.
-- The URL and secret live in a private table (not exposed by the API).
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.settings (
  key text primary key,
  value text not null
);

create or replace function private.trigger_job_runner() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_url text := (select value from private.settings where key = 'jobs_url');
  v_secret text := (select value from private.settings where key = 'jobs_secret');
begin
  if v_url is null or v_secret is null then return; end if;
  if not exists (select 1 from pgmq.q_media_jobs where vt <= now()) then return; end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('content-type', 'application/json', 'x-job-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
end;
$$;

select cron.schedule('warewise-run-jobs', '* * * * *', $$ select private.trigger_job_runner() $$);

-- Housekeeping: raw AI logs kept 30 days, idempotency keys 1 day, quota windows 2 days.
select cron.schedule('warewise-housekeeping', '17 3 * * *', $$
  delete from public.ai_interactions where created_at < now() - interval '30 days';
  delete from public.idempotency_keys where created_at < now() - interval '1 day';
  delete from public.ai_model_usage where window_start < now() - interval '2 days';
$$);

-- ---------------------------------------------------------------------------
-- Realtime: the browser hears when an item finishes processing.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.wardrobe_items;

-- ---------------------------------------------------------------------------
-- Storage: one private bucket, one folder per user.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wardrobe', 'wardrobe', false, 10485760, array['image/jpeg', 'image/png', 'image/webp']);

create policy "own folder read" on storage.objects for select to authenticated
  using (bucket_id = 'wardrobe' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own folder write" on storage.objects for insert to authenticated
  with check (bucket_id = 'wardrobe' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own folder delete" on storage.objects for delete to authenticated
  using (bucket_id = 'wardrobe' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ---------------------------------------------------------------------------
-- Dataset views (section 16): consented users only; service role only.
-- ---------------------------------------------------------------------------
create view public.dataset_item_tags with (security_invoker = true) as
select i.id as item_id, i.clean_path, i.ai_tags,
       jsonb_build_object('category', i.category, 'subcategory', i.subcategory, 'colors', i.colors,
                          'pattern', i.pattern, 'seasons', i.seasons, 'fabric', i.fabric,
                          'formality', i.formality, 'fit', i.fit) as final_tags,
       i.user_verified,
       (select count(*) from public.item_corrections c where c.item_id = i.id) as corrections
from public.wardrobe_items i
where i.status = 'ready' and i.deleted_at is null
  and (select c.granted from public.consents c
       where c.user_id = i.user_id and c.kind = 'ai_training'
       order by c.decided_at desc limit 1) is true;

create view public.dataset_outfit_outcomes with (security_invoker = true) as
select r.id as recommendation_id, r.occasion, r.event_date, r.weather, r.source,
       (select jsonb_agg(jsonb_build_object('item_id', oi.item_id, 'slot', oi.slot)) from public.outfit_items oi where oi.outfit_id = r.outfit_id) as items,
       (select jsonb_agg(f.kind) from public.feedback f where f.recommendation_id = r.id) as feedback,
       exists (select 1 from public.wear_log w where w.outfit_id = r.outfit_id) as worn
from public.recommendations r
where (select c.granted from public.consents c
       where c.user_id = r.user_id and c.kind = 'ai_training'
       order by c.decided_at desc limit 1) is true;

revoke all on public.dataset_item_tags, public.dataset_outfit_outcomes from anon, authenticated;
