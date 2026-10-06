-- CI gate: every table in the public schema must have row-level security enabled, and every
-- table users can reach must have at least one policy (RLS with no policy = locked, which is
-- only intended for service-role tables listed below).
do $$
declare
  missing text;
  unguarded text;
begin
  select string_agg(c.relname, ', ') into missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if missing is not null then
    raise exception 'Tables without row-level security: %', missing;
  end if;

  select string_agg(c.relname, ', ') into unguarded
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)
    and c.relname not in ('ai_interactions', 'ai_model_usage', 'weather_cache', 'rate_windows', 'service_events');
  if unguarded is not null then
    raise exception 'Tables with RLS but no policy (add one, or list them as service-only here): %', unguarded;
  end if;
  raise notice 'RLS check passed';
end $$;
