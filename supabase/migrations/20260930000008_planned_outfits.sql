-- Plan the week: one outfit per day. Today uses the planned outfit when there is one.
create table public.planned_outfits (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  day date not null,
  outfit_id uuid not null references public.outfits on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.planned_outfits enable row level security;
create policy "own plans" on public.planned_outfits for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create index planned_outfits_outfit on public.planned_outfits (outfit_id);

-- Keep planned outfits out of the stale-outfit cleanup.
select cron.schedule('warewise-stale-outfits', '41 3 * * *', $$
  delete from public.outfits o
  where o.saved = false
    and o.created_at < now() - interval '14 days'
    and not exists (select 1 from public.recommendations r where r.outfit_id = o.id)
    and not exists (select 1 from public.wear_log w where w.outfit_id = o.id)
    and not exists (select 1 from public.daily_picks d where d.outfit_id = o.id)
    and not exists (select 1 from public.planned_outfits p where p.outfit_id = o.id);
$$);
-- Past plans have done their job after two weeks.
select cron.schedule('warewise-old-plans', '47 3 * * *', $$
  delete from public.planned_outfits where day < current_date - 14;
$$);
