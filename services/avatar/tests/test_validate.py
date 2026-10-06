from app.validate import validate_build

user_id = "11111111-1111-4111-8111-111111111111"
job_id = "22222222-2222-4222-8222-222222222222"
base = {"jobId": job_id, "userId": user_id, "heightCm": 175}


def p(name):
    return f"{user_id}/scans/{name}.png"


def test_accepts_each_kind():
    assert validate_build({**base, "kind": "photo", "views": {"front": p("f")}}).ok
    assert validate_build({**base, "kind": "body360", "views": {"front": p("f"), "back": p("b"), "left": p("l"), "right": p("r")}}).ok
    assert validate_build({**base, "kind": "face", "faceMesh": f"{user_id}/scans/face.glb", "faceTexture": f"{user_id}/scans/face.png"}).ok


def test_missing_files_per_kind():
    r = validate_build({**base, "kind": "photo"})
    assert not r.ok and "views.front" in r.detail
    r = validate_build({**base, "kind": "body360", "views": {"front": p("f"), "left": p("l")}})
    assert not r.ok and "360" in r.detail
    r = validate_build({**base, "kind": "face"})
    assert not r.ok and "faceMesh" in r.detail


def test_other_users_files_and_path_tricks():
    other = "33333333-3333-4333-8333-333333333333"
    assert not validate_build({**base, "kind": "photo", "views": {"front": f"{other}/scans/f.png"}}).ok
    assert not validate_build({**base, "kind": "photo", "views": {"front": f"{user_id}/../{other}/f.png"}}).ok
    # The face texture is checked too (the TypeScript service didn't read it).
    assert not validate_build({**base, "kind": "face", "faceMesh": f"{user_id}/f.glb", "faceTexture": f"{other}/t.png"}).ok


def test_contract_violations():
    r = validate_build({**base, "kind": "photo", "heightCm": 40, "views": {"front": p("f")}})
    assert not r.ok and "heightCm" in r.detail
    assert not validate_build({**base, "jobId": "nope", "kind": "photo", "views": {"front": p("f")}}).ok
    assert not validate_build(None).ok
    assert not validate_build([1, 2]).ok
