from app.versions import Built, engine_label, version_contents

u = "11111111-1111-4111-8111-111111111111"
previous = {
    "mesh_path": f"{u}/avatar3d/a/body.glb",
    "face_mesh_path": f"{u}/avatar3d/b/face.glb",
    "measurements": {"heightCm": 180, "chestCm": 100},
    "measurement_sources": {"heightCm": "size", "chestCm": "measured"},
    "textured": True,
}


def test_new_body_keeps_last_face_and_uses_new_measurements():
    v = version_contents("body360", previous, Built(measurements={"heightCm": 181}, sources={"heightCm": "size"}, mesh_path=f"{u}/avatar3d/c/body.glb", engine_key="hf-hunyuan3d-2mv", textured=False))
    assert (v.mesh_path, v.face_mesh_path, v.measurements, v.engine, v.textured) == (f"{u}/avatar3d/c/body.glb", previous["face_mesh_path"], {"heightCm": 181}, "hunyuan3d-2mv", False)
    assert v.measurement_sources == {"heightCm": "size"}


def test_face_scan_keeps_body_texture_flag_and_measurements():
    v = version_contents("face", previous, Built(measurements={"heightCm": 170}, face_mesh_path=f"{u}/avatar3d/d/face.glb"))
    assert v.mesh_path == previous["mesh_path"]
    assert v.face_mesh_path == f"{u}/avatar3d/d/face.glb"
    assert v.measurements == previous["measurements"]
    assert v.measurement_sources == previous["measurement_sources"]
    assert v.textured is True
    assert v.engine == "mediapipe-face"


def test_first_scan_has_nothing_to_carry_over():
    f = version_contents("face", None, Built(measurements={"heightCm": 170}, sources={"heightCm": "average"}, face_mesh_path="f"))
    assert f.mesh_path is None and f.measurements == {"heightCm": 170} and f.measurement_sources == {"heightCm": "average"} and f.textured is False
    p = version_contents("photo", None, Built(measurements={}, mesh_path="m", engine_key="hf-trellis"))
    assert p.face_mesh_path is None and p.engine == "trellis"


def test_engine_labels():
    assert [engine_label(k) for k in ("hf-hunyuan3d-2mv", "hf-trellis-multi", "mock-3d")] == ["hunyuan3d-2mv", "trellis-multi", "mock-3d"]


def test_version_allocation_migration_is_race_free():
    """Version numbers come from SQL: the newest complete_job takes a per-user advisory lock before
    reading max(version), is idempotent by job, and records textured + measurement sources."""
    from pathlib import Path

    sql = (Path(__file__).resolve().parents[3] / "supabase/migrations/20261004000014_avatar_service_py.sql").read_text()
    lock = sql.index("pg_advisory_xact_lock")
    assert lock < sql.index("coalesce(max(version), 0) + 1")
    assert sql.index("where job_id = p_job_id;\n  if found") < lock  # idempotent before allocating
    assert "p_measurement_sources jsonb default" in sql and "p_textured boolean default false" in sql
    assert "grant execute on function avatar.complete_job" in sql
