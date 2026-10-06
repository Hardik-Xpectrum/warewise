-- Avatar service: keep the face scan's texture image path on each version (it is also embedded in
-- the face GLB when the mesh has UVs). complete_job gains a trailing, defaulted argument, so callers
-- passing the previous eight still work.

alter table avatar.versions add column if not exists face_texture_path text;

drop function if exists avatar.complete_job(uuid, text, text, text, jsonb, text, jsonb, boolean);

create function avatar.complete_job(
  p_job_id uuid,
  p_kind text,
  p_mesh_path text,
  p_face_mesh_path text,
  p_measurements jsonb,
  p_engine text,
  p_measurement_sources jsonb default '{}'::jsonb,
  p_textured boolean default false,
  p_face_texture_path text default null
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

  insert into avatar.versions (user_id, version, kind, mesh_path, face_mesh_path, face_texture_path, measurements,
                               measurement_sources, textured, engine, job_id)
  values (v_user, v_version, p_kind, p_mesh_path, p_face_mesh_path, p_face_texture_path, coalesce(p_measurements, '{}'::jsonb),
          coalesce(p_measurement_sources, '{}'::jsonb), coalesce(p_textured, false), p_engine, p_job_id);

  update avatar.jobs
     set status = 'done', version = v_version, provider_ref = null, last_error = null,
         event = jsonb_build_object('type', 'avatar.ready', 'jobId', p_job_id, 'userId', v_user, 'version', v_version),
         event_attempts = 0, event_after = now(), updated_at = now()
   where job_id = p_job_id;
  return v_version;
end;
$$;

revoke all on function avatar.complete_job(uuid, text, text, text, jsonb, text, jsonb, boolean, text) from public, anon, authenticated;
grant execute on function avatar.complete_job(uuid, text, text, text, jsonb, text, jsonb, boolean, text) to service_role;

notify pgrst, 'reload schema';
