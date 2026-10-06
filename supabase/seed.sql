-- Local development only: let pg_cron (inside Docker) reach `next dev` on your Mac.
-- Must match JOB_SECRET in .env.local. In production, set these with the SQL in README.md.
insert into private.settings (key, value) values
  ('jobs_url', 'http://host.docker.internal:3000/api/internal/jobs/run'),
  ('jobs_secret', 'local-dev-job-secret')
on conflict (key) do update set value = excluded.value;
