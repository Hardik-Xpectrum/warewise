-- Stylist and "Complete the look" save each suggestion as an unsaved outfit so Try on and
-- "I wore this" work. Clear the ones nobody saved, wore or rated after 14 days; recommendations
-- (the training dataset) keep theirs.
create index if not exists outfits_unsaved_created on public.outfits (created_at) where saved = false;

select cron.schedule('warewise-stale-outfits', '41 3 * * *', $$
  delete from public.outfits o
  where o.saved = false
    and o.created_at < now() - interval '14 days'
    and not exists (select 1 from public.recommendations r where r.outfit_id = o.id)
    and not exists (select 1 from public.wear_log w where w.outfit_id = o.id)
    and not exists (select 1 from public.daily_picks d where d.outfit_id = o.id);
$$);

-- Foreign keys the cleanup above (and the dataset views) look up by; Postgres doesn't index them automatically.
create index if not exists recommendations_outfit on public.recommendations (outfit_id);
create index if not exists wear_log_outfit on public.wear_log (outfit_id) where outfit_id is not null;
create index if not exists feedback_recommendation on public.feedback (recommendation_id);
