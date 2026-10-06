-- Avatar service (services/avatar): each user's 3D avatar, versioned, and the jobs that build it.
-- Only the avatar service reads or writes this schema, with the service key: RLS is on with no
-- policies, and only service_role has grants. See docs/microservices.md.

create schema if not exists avatar;

-- One row per successful build. version goes up by one per user; renders are cached per version.
create table avatar.versions (
  user_id uuid not null,
  version int not null check (version > 0),
  kind text not null check (kind in ('photo', 'body360', 'face')),
  mesh_path text,
  face_mesh_path text,
  measurements jsonb not null default '{}'::jsonb,
  measurement_sources jsonb not null default '{}'::jsonb, -- per measurement: measured | size | average
  textured boolean not null default false, -- false: shape only (the 3D service's texturing was down)
  engine text not null,
  job_id uuid unique, -- the build that made it: a resumed job never makes a second version
  created_at timestamptz not null default now(),
  primary key (user_id, version)
);

-- The service's queue. A job is claimed by the worker, may wait on an engine across several
-- ticks (provider_ref holds the engine's task), and ends done (with a version) or failed. The
-- event for the web app is queued on the same row and retried until delivered.
create table avatar.jobs (
  job_id uuid primary key, -- chosen by the web app: the idempotency key
  user_id uuid not null,
  kind text not null check (kind in ('photo', 'body360', 'face')),
  request jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  provider_ref jsonb,
  attempts int not null default 0,
  last_error text,
  run_after timestamptz not null default now(),
  version int,
  event jsonb,
  event_attempts int not null default 0,
  event_after timestamptz,
  event_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index jobs_due_idx on avatar.jobs (run_after) where status in ('queued', 'running');
create index jobs_user_idx on avatar.jobs (user_id, created_at desc);
create index jobs_event_idx on avatar.jobs (event_after) where event is not null and event_sent_at is null;

-- Daily use per engine, so a free Space's small GPU allowance isn't burnt by one busy day.
create table avatar.engine_usage (
  engine text not null,
  day date not null default current_date,
  count int not null default 0,
  primary key (engine, day)
);

alter table avatar.versions enable row level security;
alter table avatar.jobs enable row level security;
alter table avatar.engine_usage enable row level security;

-- Claims the next due job (queued, or running with an expired lease after a restart or a slow
-- engine). SKIP LOCKED lets two workers run without taking the same job.
create function avatar.claim_job(p_lease_seconds int default 300)
returns setof avatar.jobs
language sql
set search_path = ''
as $$
  update avatar.jobs j
     set status = 'running', run_after = now() + make_interval(secs => p_lease_seconds), updated_at = now()
   where j.job_id = (
     select job_id from avatar.jobs
      where status in ('queued', 'running') and run_after <= now()
      order by run_after
      limit 1
      for update skip locked)
  returning j.*;
$$;

-- Records a finished build as the user's next version, marks the job done and queues the
-- avatar.ready event, all in one transaction. A per-user advisory lock serialises concurrent
-- builds for the same user, so versions are 1, 2, 3... without gaps or duplicates (the primary
-- key would reject a duplicate anyway). Idempotent by job: calling it again returns the same
-- version. Returns null when the job no longer exists (the user's avatar was deleted meanwhile).
create function avatar.complete_job(
  p_job_id uuid,
  p_kind text,
  p_mesh_path text,
  p_face_mesh_path text,
  p_measurements jsonb,
  p_engine text
) returns int
language plpgsql
set search_path = ''
as $$
declare
  v_user uuid;
  v_version int;
begin
  select user_id into v_user from avatar.jobs where job_id = p_job_id for update;
  if not found then
    return null;
  end if;

  select version into v_version from avatar.versions where job_id = p_job_id;
  if found then
    return v_version;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('avatar.versions:' || v_user::text, 0));
  select coalesce(max(version), 0) + 1 into v_version from avatar.versions where user_id = v_user;

  insert into avatar.versions (user_id, version, kind, mesh_path, face_mesh_path, measurements, engine, job_id)
  values (v_user, v_version, p_kind, p_mesh_path, p_face_mesh_path, coalesce(p_measurements, '{}'::jsonb), p_engine, p_job_id);

  update avatar.jobs
     set status = 'done', version = v_version, provider_ref = null, last_error = null,
         event = jsonb_build_object('type', 'avatar.ready', 'jobId', p_job_id, 'userId', v_user, 'version', v_version),
         event_attempts = 0, event_after = now(), updated_at = now()
   where job_id = p_job_id;
  return v_version;
end;
$$;

-- Takes one use of an engine for today; false when its daily cap is reached.
create function avatar.take_engine_quota(p_engine text, p_per_day int)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_count int;
begin
  insert into avatar.engine_usage (engine, day, count) values (p_engine, current_date, 1)
  on conflict (engine, day) do update set count = avatar.engine_usage.count + 1
  returning count into v_count;
  if p_per_day is not null and v_count > p_per_day then
    update avatar.engine_usage set count = count - 1 where engine = p_engine and day = current_date;
    return false;
  end if;
  return true;
end;
$$;

revoke all on schema avatar from public, anon, authenticated;
revoke all on all tables in schema avatar from public, anon, authenticated;
revoke all on all functions in schema avatar from public, anon, authenticated;
grant usage on schema avatar to service_role;
grant select, insert, update, delete on all tables in schema avatar to service_role;
grant execute on all functions in schema avatar to service_role;
