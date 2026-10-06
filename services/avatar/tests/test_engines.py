from app.engines import (
    Views,
    error_message,
    gradio_glb_url,
    is_texturing_broken,
    multi_view_list,
    parse_fal_result,
    parse_fal_status,
    parse_meshy_task,
    parse_tripo_task,
    pick_hunyuan_glb,
    with_urls,
)


def test_fal():
    assert parse_fal_status({"status": "IN_QUEUE"}) == "running"
    assert parse_fal_status({"status": "IN_PROGRESS"}) == "running"
    assert parse_fal_status({"status": "COMPLETED"}) == "completed"
    assert parse_fal_result({"model_mesh": {"url": "https://x/m.glb"}}).glb_url == "https://x/m.glb"
    assert parse_fal_result({"model_glb": {"url": "https://x/h.glb"}}).glb_url == "https://x/h.glb"
    assert parse_fal_result({"detail": "bad image"}).state == "failed"


def test_tripo():
    r = parse_tripo_task({"code": 0, "data": {"status": "running", "progress": 40}})
    assert (r.state, r.progress) == ("running", 40)
    assert parse_tripo_task({"code": 0, "data": {"status": "success", "output": {"model_url": "https://t/m.glb"}}}).glb_url == "https://t/m.glb"
    assert parse_tripo_task({"code": 0, "data": {"status": "success", "output": {"pbr_model_url": "https://t/p.glb", "model_url": "https://t/m.glb"}}}).glb_url == "https://t/p.glb"
    assert parse_tripo_task({"code": 0, "data": {"status": "banned"}}).state == "failed"
    assert parse_tripo_task({"code": 2010, "message": "Insufficient credits"}).error == "Tripo error 2010: Insufficient credits"


def test_meshy():
    r = parse_meshy_task({"status": "IN_PROGRESS", "progress": 55})
    assert (r.state, r.progress) == ("running", 55)
    assert parse_meshy_task({"status": "SUCCEEDED", "model_urls": {"glb": "https://m/a.glb"}}).glb_url == "https://m/a.glb"
    assert parse_meshy_task({"status": "FAILED", "task_error": {"message": "no subject"}}).error == "Meshy task failed: no subject"


def test_gradio_glb_url():
    data = [
        {"video": {"path": "/tmp/a/sample.mp4", "url": "https://s/file=/tmp/a/sample.mp4"}, "subtitles": None},
        {"path": "/tmp/b/sample.glb", "url": "https://s/file=/tmp/b/sample.glb"},
    ]
    assert gradio_glb_url(data) == "https://s/file=/tmp/b/sample.glb"
    assert gradio_glb_url([{"path": "/x/preview.png", "url": "https://s/x.png"}]) is None
    # Older servers send FileData without a URL: the file route is filled in.
    assert gradio_glb_url(with_urls([{"path": "/t/white_mesh.glb", "url": None}], "https://h.hf.space/")) == "https://h.hf.space/gradio_api/file=/t/white_mesh.glb"


white = {"path": "/c/1/white_mesh.glb", "url": "https://h/file=/c/1/white_mesh.glb"}
textured = {"path": "/c/1/textured_mesh.glb", "url": "https://h/file=/c/1/textured_mesh.glb"}


def test_hunyuan_prefers_textured_then_white():
    assert pick_hunyuan_glb((white, textured, "<html>", {"stats": 1}, 1234)) == textured["url"]
    assert pick_hunyuan_glb([white, "<html>", {}, 1234]) == white["url"]
    assert pick_hunyuan_glb(None) is None


def test_views_order():
    f, b, r = b"f", b"b", b"r"
    assert multi_view_list(Views(front=f, right=r, back=b)) == [f, b, r]


def test_texturing_broken():
    assert is_texturing_broken(Exception("'PyMeshLabException'"))
    assert is_texturing_broken({"type": "status", "message": "PyMeshLabException"})
    assert not is_texturing_broken("You have exceeded your GPU quota")
    assert error_message({"code": 1}) == '{"code":1}'
