-- The web app hands work to the vision, avatar and try-on services (when their URLs are set) and
-- hears back through events.

-- The vision job currently processing each item: a resent request with the same id never
-- duplicates work, and a retry gets a new id. Events for an old id are ignored.
alter table public.wardrobe_items add column if not exists vision_job_id uuid;

-- Events received from the services, so each (type, jobId) is applied once even when a service
-- delivers it again. Service role only.
create table if not exists public.service_events (
  type text not null,
  job_id uuid not null,
  user_id uuid not null,
  received_at timestamptz not null default now(),
  primary key (type, job_id)
);
alter table public.service_events enable row level security;
revoke all on public.service_events from anon, authenticated;

-- Housekeeping: a month of event history is plenty.
select cron.schedule('warewise-old-service-events', '53 3 * * *', $$
  delete from public.service_events where received_at < now() - interval '30 days'
$$);
