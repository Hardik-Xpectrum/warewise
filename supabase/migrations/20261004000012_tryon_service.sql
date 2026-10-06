-- Try-on service (services/tryon). Only that service reads or writes this schema, with the
-- service key: RLS is on with no policies and only service_role has grants. See docs/microservices.md.
create schema if not exists tryon;

-- One row per render job (the web app picks job_id: resending it never duplicates work).
-- It is also the job queue: the worker claims the oldest due row, so a restart resumes work.
create table tryon.renders (
  job_id uuid primary key,
  user_id uuid not null,
  cache_key text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  render_path text,
  texture jsonb, -- {version, front, back} when a 3D avatar version was given
  note text,
  error text,
  quota boolean not null default false, -- failed because the free GPU time ran out
  -- A partly dressed outfit, or the composite fallback after the AI failed, is shown but never
  -- served from cache: the next request should try the real render again.
  cacheable boolean not null default false,
  cached_from uuid, -- the job whose render a cache hit reused
  attempts int not null default 0,
  run_after timestamptz not null default now(), -- queued: when it may run; running: lease expiry
  request jsonb not null,
  -- Outbox for the tryon.ready / tryon.failed event (retried 1, 4, 16, 60 min).
  event jsonb,
  event_attempts int not null default 0,
  event_after timestamptz,
  event_sent_at timestamptz,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index renders_cache on tryon.renders (user_id, cache_key) where status = 'done';
create index renders_due on tryon.renders (run_after) where status in ('queued', 'running');
create index renders_events on tryon.renders (event_after) where event is not null and event_sent_at is null;

-- Calls per model per day (and in the current minute), so the free GPU allowance is never overrun.
create table tryon.model_usage (
  model text not null,
  day date not null,
  day_calls int not null default 0,
  minute timestamptz not null default date_trunc('minute', now()),
  minute_calls int not null default 0,
  primary key (model, day)
);

alter table tryon.renders enable row level security;
alter table tryon.model_usage enable row level security;

-- Claims the next due render: queued and due, or running with an expired lease (a crashed worker).
create or replace function tryon.claim_render(p_lease_seconds int) returns setof tryon.renders
language sql security definer set search_path = '' as $$
  update tryon.renders r
     set status = 'running', attempts = r.attempts + 1, run_after = now() + make_interval(secs => p_lease_seconds)
   where r.job_id = (
     select job_id from tryon.renders
      where status in ('queued', 'running') and run_after <= now()
      order by run_after
      limit 1
      for update skip locked)
  returning r.*;
$$;

-- Takes one call from a model's allowance; false when the minute or day limit is reached.
-- Days follow Pacific time, when Hugging Face's free GPU quota resets.
create or replace function tryon.take_model_quota(p_model text, p_per_minute int, p_per_day int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_day date := (now() at time zone 'America/Los_Angeles')::date;
  v_minute timestamptz := date_trunc('minute', now());
  v_row tryon.model_usage;
begin
  insert into tryon.model_usage (model, day, minute) values (p_model, v_day, v_minute) on conflict do nothing;
  select * into v_row from tryon.model_usage where model = p_model and day = v_day for update;
  if v_row.minute <> v_minute then
    v_row.minute := v_minute;
    v_row.minute_calls := 0;
  end if;
  if (p_per_day is not null and v_row.day_calls >= p_per_day) or (p_per_minute is not null and v_row.minute_calls >= p_per_minute) then
    return false;
  end if;
  update tryon.model_usage set day_calls = v_row.day_calls + 1, minute = v_row.minute, minute_calls = v_row.minute_calls + 1
   where model = p_model and day = v_day;
  return true;
end;
$$;

revoke all on schema tryon from public, anon, authenticated;
revoke all on all tables in schema tryon from public, anon, authenticated;
revoke all on function tryon.claim_render(int) from public, anon, authenticated;
revoke all on function tryon.take_model_quota(text, int, int) from public, anon, authenticated;
grant usage on schema tryon to service_role;
grant select, insert, update, delete on all tables in schema tryon to service_role;
grant execute on function tryon.claim_render(int) to service_role;
grant execute on function tryon.take_model_quota(text, int, int) to service_role;

notify pgrst, 'reload schema';
