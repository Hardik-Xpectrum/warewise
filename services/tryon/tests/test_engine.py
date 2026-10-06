import io
import time

import pytest
from PIL import Image

from app.config import AiConfig
from app.engine import EngineDeps, EngineGarment, EngineInput, TryOnError, dress_outfit, model_input


def png(w: int, h: int, color: str) -> bytes:
    buf = io.BytesIO()
    Image.new("RGBA", (w, h), color).save(buf, "PNG")
    return buf.getvalue()


def config(chain: list[str], timeout_ms: int = 1000) -> AiConfig:
    return AiConfig.model_validate({
        "jobs": {"tryon": {"chain": chain, "timeoutMs": timeout_ms}},
        "models": {
            "idm": {"provider": "hf-idm-vton", "space": "yisol/IDM-VTON", "apiKeyEnv": "HF_TOKEN", "tokenOptional": True, "model": "IDM-VTON", "limits": {"perDay": 15}},
            "leffa": {"provider": "hf-leffa", "space": "franciszzj/Leffa", "apiKeyEnv": "HF_TOKEN", "tokenOptional": True, "model": "Leffa", "limits": {"perDay": 15}},
            "composite": {"provider": "composite", "model": "pillow"},
        },
    })


def setup() -> EngineInput:
    return EngineInput(person=png(300, 600, "#c8a080"), pose=None, garments=[
        EngineGarment("jeans", "bottom", "blue jeans", png(100, 140, "#2040a0"), png(100, 140, "#2040a0")),
        EngineGarment("tee", "top", "red tee", png(120, 120, "#c02020"), png(120, 120, "#c02020")),
    ])


class Recorder:
    def __init__(self, fail=None) -> None:
        self.calls: list[tuple[str, str]] = []
        self.fail = fail

    def __call__(self, key, model, p, garment, current):  # noqa: ANN204
        self.calls.append((key, p.region))
        if self.fail:
            self.fail(key, p)
        return current


def deps(chain: list[str], run, quota: bool = True, timeout_ms: int = 1000) -> EngineDeps:
    return EngineDeps(config=config(chain, timeout_ms), has_token=lambda m: True, take_quota=lambda k, m: quota, run_pass=run)


def test_dresses_the_top_on_idm_vton_then_the_bottom_on_leffa():
    run = Recorder()
    r = dress_outfit(setup(), deps(["idm", "leffa"], run))
    assert run.calls == [("idm", "upper_body"), ("leffa", "lower_body")]
    assert (r.engine, r.complete, r.note) == ("idm+leffa", True, "AI dressed the top: red tee and bottom: blue jeans.")
    assert Image.open(io.BytesIO(r.image)).size == (768, 1024)


def test_falls_back_to_leffa_for_the_top_when_idm_vton_fails():
    def fail(key, p):  # noqa: ANN202
        if key == "idm":
            raise RuntimeError("boom")
    run = Recorder(fail)
    r = dress_outfit(setup(), deps(["idm", "leffa"], run))
    assert [c[0] for c in run.calls] == ["idm", "leffa", "leffa"]
    assert r.engine == "leffa"


def test_keeps_the_dressed_top_with_a_note_when_the_bottom_cant_run():
    def fail(key, p):  # noqa: ANN202
        if p.region == "lower_body":
            raise RuntimeError("You have exceeded your GPU quota. Try again in 3:00:00")
    r = dress_outfit(setup(), deps(["idm", "leffa"], Recorder(fail)))
    assert r.complete is False
    assert r.note == "AI dressed the top: red tee. The bottom was skipped: the free GPU time ran out."


def test_fails_with_the_quota_message_when_nothing_could_run():
    def fail(key, p):  # noqa: ANN202
        raise RuntimeError("ZeroGPU quota exceeded. Try again in 0:30:00")
    with pytest.raises(TryOnError) as e:
        dress_outfit(setup(), deps(["idm", "leffa"], Recorder(fail)))
    assert e.value.quota is True
    assert e.value.message == "The free GPU time is used up; it resets in about 30 minutes. The instant preview still works."


def test_skips_models_whose_own_daily_limit_is_used_without_calling_them():
    run = Recorder()
    with pytest.raises(TryOnError) as e:
        dress_outfit(setup(), deps(["idm", "leffa"], run, quota=False))
    assert run.calls == []
    assert e.value.quota is True


def test_a_pass_that_hangs_times_out_and_falls_back():
    def slow(key, model, p, garment, current):  # noqa: ANN202
        if key == "idm":
            time.sleep(1)
        return current
    r = dress_outfit(setup(), deps(["idm", "leffa"], slow, timeout_ms=200))
    assert r.engine == "leffa"


def test_uses_the_composite_offline_engine_and_caches_only_a_chosen_one():
    offline = dress_outfit(setup(), deps(["composite"], Recorder()))
    assert (offline.engine, offline.complete) == ("composite", True)
    assert Image.open(io.BytesIO(offline.image)).size == (300, 600)

    def down(key, p):  # noqa: ANN202
        raise RuntimeError("down")
    fallback = dress_outfit(setup(), deps(["idm", "leffa", "composite"], Recorder(down)))
    assert (fallback.engine, fallback.complete) == ("composite", False)
    assert fallback.note.startswith("Composite preview (offline engine). The AI try-on service is unavailable")


def test_composite_draws_the_garments_where_the_pose_puts_them():
    r = dress_outfit(setup(), deps(["composite"], Recorder()))
    img = Image.open(io.BytesIO(r.image)).convert("RGB")
    red, green, blue = img.getpixel((150, 170))  # chest of the default pose: the red tee
    assert red > 150 and green < 90
    red, green, blue = img.getpixel((150, 480))  # legs: the blue jeans
    assert blue > 120 and red < 90


def test_model_input_is_768x1024_on_white_with_the_margin():
    img = Image.open(io.BytesIO(model_input(png(100, 100, "#ff000000"), 0.08)))  # fully transparent
    assert img.size == (768, 1024) and img.format == "JPEG"
    assert min(img.convert("RGB").getpixel((384, 512))) > 245  # transparency flattened on white
    garment = Image.open(io.BytesIO(model_input(png(100, 100, "#2040a0"), 0.08))).convert("RGB")
    assert min(garment.getpixel((30, 512))) > 245  # inside the 8% margin
    assert garment.getpixel((384, 512))[2] > 120
