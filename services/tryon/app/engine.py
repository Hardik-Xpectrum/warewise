"""The pass-based try-on engine. The model calls and quota checks come in as deps, so the pass
logic (order, fallbacks, partial results) is unit-tested with fakes and only hf.py talks to
Hugging Face."""

from __future__ import annotations

import concurrent.futures
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from PIL import Image

from app.config import AiConfig, ModelConfig
from app.images import contain, flatten, jpeg, open_image, webp
from app.log import error_message
from app.placement import GarmentInput, place_garments
from app.plan import TryOnPass, failure_message, is_quota_error, plan_passes

AI = ("hf-idm-vton", "hf-leffa")


@dataclass
class EngineGarment:
    id: str
    slot: str
    description: str
    photo: bytes  # garment photo as uploaded (with background)
    cutout: bytes | None  # transparent cut-out


@dataclass
class EngineInput:
    person: bytes
    pose: dict | None  # {"landmarks": [...33]}
    garments: list[EngineGarment]


@dataclass
class EngineResult:
    image: bytes  # WebP: 768 x 1024 (AI) or the photo's size (composite)
    engine: str  # "idm-vton-space+leffa-space", "composite"
    note: str
    complete: bool  # every planned pass ran (safe to serve from cache)


@dataclass
class Attempt:
    model_key: str
    pass_label: str
    status: Literal["ok", "error", "skipped"]
    error: str | None = None
    ms: int | None = None

    def fields(self) -> dict:
        out = {"modelKey": self.model_key, "pass": self.pass_label, "status": self.status}
        if self.error is not None:
            out["error"] = self.error
        if self.ms is not None:
            out["ms"] = self.ms
        return out


RunPass = Callable[[str, ModelConfig, TryOnPass, EngineGarment, bytes], bytes]


@dataclass
class EngineDeps:
    config: AiConfig
    has_token: Callable[[ModelConfig], bool]
    take_quota: Callable[[str, ModelConfig], bool]
    run_pass: RunPass
    on_attempt: Callable[[Attempt], None] | None = None


class TryOnError(Exception):
    def __init__(self, message: str, quota: bool, attempts: list[Attempt] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.quota = quota
        self.attempts = attempts or []


def model_input(image: bytes, margin: float = 0.0) -> bytes:
    """Person or garment photo as the try-on models expect it: 768 x 1024 JPEG on white, the
    content scaled to fit inside a `margin` (fraction of each side) white border.

    (The TypeScript version resized the inner image again with `fit: contain`, which scaled it
    back up to 768 x 1024 and lost the margin; here the inner image is padded, not rescaled.)"""
    inner = contain(flatten(open_image(image)), round(768 * (1 - 2 * margin)), round(1024 * (1 - 2 * margin)))
    if inner.size == (768, 1024):
        return jpeg(inner)
    canvas = Image.new("RGB", (768, 1024), (255, 255, 255))
    canvas.paste(inner, ((768 - inner.width) // 2, (1024 - inner.height) // 2))
    return jpeg(canvas)


def models_for(p: TryOnPass, available: list[tuple[str, ModelConfig]]) -> list[tuple[str, ModelConfig]]:
    """Which models can do a pass, cheapest GPU request first: IDM-VTON (~60 s) only does upper body."""
    idm = [m for m in available if m[1].provider == "hf-idm-vton"]
    leffa = [m for m in available if m[1].provider == "hf-leffa"]
    return idm + leffa if p.region == "upper_body" else leffa


def default_pose() -> dict:
    """A standing, centred figure: used by the composite when the request carries no landmarks."""
    lm = [{"x": 0.5, "y": 0.5, "visibility": 0.9} for _ in range(33)]
    for i, x, y in [(0, 0.5, 0.08), (11, 0.64, 0.2), (12, 0.36, 0.2), (23, 0.6, 0.5), (24, 0.4, 0.5),
                    (25, 0.6, 0.7), (26, 0.4, 0.7), (27, 0.6, 0.92), (28, 0.4, 0.92)]:
        lm[i] = {"x": x, "y": y, "visibility": 0.95}
    return {"landmarks": lm}


def composite(inp: EngineInput) -> bytes:
    """Lays garment cut-outs over the person photo: the same placement as the browser preview."""
    person = open_image(inp.person).convert("RGBA")
    width, height = person.size
    usable = [(g, open_image(g.cutout).convert("RGBA")) for g in inp.garments if g.cutout]
    boxes = place_garments(
        inp.pose or default_pose(),
        width,
        height,
        [GarmentInput(id=g.id, slot=g.slot, subcategory=g.description, aspect=c.width / max(1, c.height)) for g, c in usable],
    )
    cutouts = {g.id: c for g, c in usable}
    canvas = person
    for b in boxes:
        piece = cutouts[b.id].resize((max(1, round(b.w)), max(1, round(b.h))), Image.Resampling.LANCZOS)
        # Garments may hang past the photo edge: paste clips them to the canvas.
        layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        layer.paste(piece, (round(b.x), round(b.y)), piece)
        canvas = Image.alpha_composite(canvas, layer)
    return webp(flatten(canvas))


def _with_timeout(fn: Callable[[], bytes], ms: int) -> bytes:
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="tryon-pass")
    try:
        return pool.submit(fn).result(timeout=ms / 1000)
    except concurrent.futures.TimeoutError:
        raise TimeoutError(f"timed out after {ms} ms") from None
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def dress_outfit(inp: EngineInput, deps: EngineDeps) -> EngineResult:
    """Dresses the person photo in the outfit, one garment per pass (a dress; or the top, then the
    bottom on that result), each pass on the cheapest model that can do it, falling back to the
    next. If a later pass can't run, the partly dressed result is kept with a note. A `composite`
    entry in the chain is the offline last resort. Raises TryOnError when nothing could be done."""
    job = deps.config.jobs.tryon
    models = deps.config.models
    attempts: list[Attempt] = []

    def note(a: Attempt) -> None:
        attempts.append(a)
        if deps.on_attempt:
            deps.on_attempt(a)

    errors: list[str] = []
    available: list[tuple[str, ModelConfig]] = []
    for key in job.chain:
        model = models[key]
        if model.provider not in AI:
            continue
        if model.api_key_env and not deps.has_token(model) and not model.token_optional:
            note(Attempt(key, "-", "skipped", "no api key"))
            continue
        available.append((key, model))
    ai_in_chain = any(models[k].provider in AI for k in job.chain)

    passes = plan_passes([{"id": g.id, "slot": g.slot} for g in inp.garments])
    current = model_input(inp.person)
    done: list[str] = []
    used: list[str] = []
    stopped = ""

    if available:
        for p in passes:
            garment = next(g for g in inp.garments if g.id == p.garment_id)
            dressed = False
            pass_errors: list[str] = []
            for key, model in models_for(p, available):
                if (model.limits.per_minute or model.limits.per_day) and not deps.take_quota(key, model):
                    note(Attempt(key, p.label, "skipped", "free quota used"))
                    pass_errors.append("free quota used")
                    continue
                started = time.monotonic()
                try:
                    image = current
                    current = _with_timeout(lambda m=model, k=key, img=image, ps=p, g=garment: deps.run_pass(k, m, ps, g, img), job.timeout_ms)
                    note(Attempt(key, p.label, "ok", ms=round((time.monotonic() - started) * 1000)))
                    done.append(f"{p.label}: {garment.description}")
                    if key not in used:
                        used.append(key)
                    dressed = True
                    break
                except Exception as err:  # noqa: BLE001 - any model failure falls through to the next model
                    message = error_message(err)[:300]
                    note(Attempt(key, p.label, "error", message, round((time.monotonic() - started) * 1000)))
                    pass_errors.append(message)
            if not dressed:
                errors.extend(pass_errors)
                # Later garments go on top of this one, so stop here (keeping anything already dressed).
                quota = bool(pass_errors) and all(is_quota_error(e) for e in pass_errors)
                reason = "the free GPU time ran out" if quota else "the AI couldn't dress it"
                stopped = f"The {p.label} was skipped: {reason}."
                break

    if done:
        return EngineResult(
            image=webp(open_image(current).convert("RGB")),
            engine="+".join(used),
            note=f"AI dressed the {' and '.join(done)}.{' ' + stopped if stopped else ''}",
            complete=not stopped,
        )

    message, quota = failure_message(errors)
    if any(models[k].provider == "composite" for k in job.chain) and any(g.cutout for g in inp.garments):
        return EngineResult(
            image=composite(inp),
            engine="composite",
            note=f"Composite preview (offline engine). {message}" if ai_in_chain else "Composite preview (offline engine).",
            # Offline by choice: cache it. A fallback after the AI failed: try the AI again next time.
            complete=not ai_in_chain,
        )
    raise TryOnError(message if passes else "Nothing in this outfit can be dressed by the AI.", quota, attempts)
