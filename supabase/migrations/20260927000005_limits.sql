-- Abuse limits: a daily cap on signed upload URLs, and a per-minute limit on write requests.

alter table public.usage_counters add column upload_urls int not null default 0;

create or replace function public.take_usage(p_kind text, p_cap int) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_day date := (now() at time zone 'Asia/Kolkata')::date;
  v_count int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_kind not in ('stylist_calls', 'tag_calls', 'tryon_calls', 'upload_urls') then raise exception 'bad kind'; end if;

  insert into public.usage_counters (user_id, day) values (v_uid, v_day)
  on conflict (user_id, day) do nothing;

  execute format(
    'update public.usage_counters set %1$I = %1$I + 1 where user_id = $1 and day = $2 and %1$I < $3 returning %1$I',
    p_kind)
  into v_count using v_uid, v_day, p_cap;

  return coalesce(v_count, -1);
end;
$$;

-- Fixed one-minute windows per user. Unlogged: losing counts on a crash is fine, and it's faster.
create unlogged table public.rate_windows (
  user_id uuid not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (user_id, window_start)
);
alter table public.rate_windows enable row level security; -- no policies: only the function below touches it

-- Counts one request; returns false once the user passes p_limit requests this minute.
create or replace function public.take_rate(p_limit int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_hits int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  insert into public.rate_windows as w (user_id, window_start, hits)
  values (v_uid, date_trunc('minute', now()), 1)
  on conflict (user_id, window_start) do update set hits = w.hits + 1
  returning hits into v_hits;
  return v_hits <= p_limit;
end;
$$;
revoke all on function public.take_rate(int) from public, anon;
grant execute on function public.take_rate(int) to authenticated;

select cron.schedule('warewise-rate-windows', '*/10 * * * *', $$
  delete from public.rate_windows where window_start < now() - interval '5 minutes';
$$);
