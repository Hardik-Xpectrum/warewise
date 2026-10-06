-- Vision service: its own schema, used only by services/vision with the service key.
-- One row per processing job (the web app picks job_id, which makes POST /v1/items/process
-- idempotent). The row is also the job queue (status, attempts, run_after) and the outbox for the
-- item.processed event (event_*), so a restart resumes both unfinished work and undelivered events.
create schema if not exists vision;

create table vision.jobs (
  job_id uuid primary key,
  user_id uuid not null,
  item_id uuid not null,
  image_path text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts int not null default 0,
  last_error text,
  run_after timestamptz not null default now(),
  result jsonb, -- the ItemProcessed event, once the job is done or has failed for good
  event_attempts int not null default 0,
  event_after timestamptz, -- next delivery try; null when there is nothing (more) to send
  event_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index jobs_queue_idx on vision.jobs (run_after) where status = 'queued';
create index jobs_events_idx on vision.jobs (event_after) where event_sent_at is null and event_after is not null;
create index jobs_user_idx on vision.jobs (user_id);

create function vision.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger jobs_touch before update on vision.jobs
  for each row execute function vision.touch_updated_at();

-- Takes the next due job and marks it running in one statement, so two workers (should there
-- ever be two) never take the same job. attempts counts every start, including ones a crash cut short.
create function vision.claim_next_job() returns setof vision.jobs
language sql set search_path = '' as $$
  update vision.jobs
     set status = 'running', attempts = attempts + 1
   where job_id = (
     select job_id from vision.jobs
      where status = 'queued' and run_after <= now()
      order by run_after, created_at
      limit 1
      for update skip locked)
  returning *;
$$;

-- Only the service key reaches this schema: RLS on with no policies, and no grants to the
-- browser roles.
alter table vision.jobs enable row level security;

revoke all on schema vision from public, anon, authenticated;
revoke all on all tables in schema vision from public, anon, authenticated;
revoke all on function vision.claim_next_job() from public, anon, authenticated;
revoke all on function vision.touch_updated_at() from public, anon, authenticated;

grant usage on schema vision to service_role;
grant select, insert, update, delete on vision.jobs to service_role;
grant execute on function vision.claim_next_job() to service_role;
