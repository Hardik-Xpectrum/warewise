from app.cache import decide_render

U = "11111111-1111-4111-8111-111111111111"


def row(**over: object) -> dict:
    r = {"job_id": "a", "user_id": U, "cache_key": "k", "status": "done", "render_path": f"{U}/tryon/a.webp", "texture": None,
         "note": "AI dressed the top.", "error": None, "quota": False, "cacheable": True, "cached_from": None, "created_at": "2026-10-04T10:00:00Z"}
    r.update(over)
    return r


def decide(same: dict | None, hits: list[dict], version: int | None = None):
    return decide_render(U, "k", version, same, hits)


def test_reuses_the_newest_complete_render_with_the_same_key():
    d = decide(None, [row(), row(job_id="b", created_at="2026-10-04T11:00:00Z")])
    assert d.kind == "cached" and d.row and d.row["job_id"] == "b"


def test_never_reuses_partial_failed_other_users_or_other_keys():
    assert decide(None, [row(cacheable=False)]).kind == "new"
    assert decide(None, [row(status="failed", render_path=None)]).kind == "new"
    assert decide(None, [row(user_id="someone")]).kind == "new"
    assert decide(None, [row(cache_key="other")]).kind == "new"
    assert decide(None, []).kind == "new"


def test_needs_the_texture_for_the_asked_avatar_version():
    assert decide(None, [row()], 2).kind == "new"
    assert decide(None, [row(texture={"version": 2, "front": "f", "back": "b"})], 2).kind == "cached"


def test_answers_a_resent_job_id_with_its_state_and_refuses_a_reused_one():
    d = decide(row(status="running"), [row()])
    assert d.kind == "existing" and d.row and d.row["status"] == "running"
    assert decide(row(cache_key="other"), []).kind == "conflict"
