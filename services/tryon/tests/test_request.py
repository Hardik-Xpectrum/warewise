from app.request import validate_render
from tests.conftest import render_body


def test_accepts_a_valid_request():
    ok, v = validate_render(render_body())
    assert ok and isinstance(v, dict)
    assert len(v["garments"]) == 2 and v["pose"] is None


def test_rejects_bad_shapes_with_a_readable_detail():
    ok, detail = validate_render(render_body(jobId="nope"))
    assert not ok and "jobId" in str(detail)
    assert validate_render(None)[0] is False
    assert validate_render(render_body(garments=[]))[0] is False


def test_refuses_files_from_another_users_folder():
    other = "99999999-9999-4999-8999-999999999999"
    assert validate_render(render_body(personImagePath=f"{other}/avatar/front.webp")) == (False, "All image paths must be under the user's own folder")
    g = {**render_body()["garments"][0], "cutoutPath": f"{other}/cutout/a.webp"}
    assert validate_render(render_body(garments=[g]))[0] is False
    # Not a user prefix at all.
    assert validate_render(render_body(personImagePath="../etc/passwd"))[0] is False


def test_needs_something_the_ai_can_dress():
    shoes = [{**render_body()["garments"][0], "slot": "shoes"}]
    ok, detail = validate_render(render_body(garments=shoes))
    assert not ok and "not shoes" in str(detail)


def test_refuses_duplicate_items_and_malformed_poses():
    g = render_body()["garments"][0]
    assert validate_render(render_body(garments=[g, g]))[0] is False
    assert validate_render(render_body(pose={"landmarks": []}))[0] is False
    assert validate_render(render_body(pose=[{"x": 0.5, "y": 0.5}] * 32))[0] is False


def test_keeps_a_valid_pose_as_landmarks():
    ok, v = validate_render(render_body(pose=[{"x": 0.5, "y": 0.5, "visibility": 0.9}] * 33))
    assert ok and isinstance(v, dict) and len(v["pose"]["landmarks"]) == 33


def test_dresses_a_shirt_filed_under_layers_as_a_top():
    g = {**render_body()["garments"][0], "slot": "outer", "description": "linen shirt"}
    ok, v = validate_render(render_body(garments=[g]))
    assert ok and isinstance(v, dict) and v["garments"][0]["slot"] == "top"
