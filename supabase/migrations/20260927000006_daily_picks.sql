-- "Today": one outfit per user per day, chosen once and kept until they shuffle.
create table public.daily_picks (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  day date not null,
  occasion text not null,
  outfit_id uuid not null references public.outfits on delete cascade,
  shuffles int not null default 0,
  why text,
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.daily_picks enable row level security;
create policy "own daily picks" on public.daily_picks for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Picks older than a week have done their job.
select cron.schedule('warewise-daily-picks', '51 3 * * *', $$
  delete from public.daily_picks where day < current_date - 7;
$$);
