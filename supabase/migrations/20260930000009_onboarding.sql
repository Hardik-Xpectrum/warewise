-- First-run onboarding: set once the user finishes (or skips) the welcome flow. Everyone who
-- signed up before the flow existed counts as onboarded, so nobody is sent back through it.
alter table public.profiles add column if not exists onboarded_at timestamptz;
update public.profiles set onboarded_at = coalesce(onboarded_at, created_at, now());
