"""Image-to-3D engines for the avatar.

Each turns cut-out person images into a GLB on the engine's GPUs, so this service needs none.
Free Hugging Face ZeroGPU Spaces come first (Hunyuan3D-2mv for a 360° scan, TRELLIS for one photo
or as the multi-view fallback, Stable Fast 3D), then paid APIs (fal.ai, Tripo, Meshy) when their
keys are set. The order lives in config/ai.config.json.

A job is resumable: `submit_3d` returns a `Ref3d` that is saved on the job, and `poll_3d` reads
it on this or a later tick. Free Spaces run the whole generation in one call (20–90 s on
ZeroGPU), so their submit waits for the result and their poll just hands back the file URL.
"""

from __future__ import annotations

import base64
import json
import os
import re
import tempfile
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

import httpx

from .config import EngineConfig
from .glb import MAX_GLB_BYTES, BadModel, assert_glb, mock_glb
from .images import flat_jpeg
from .log import error_text, log


@dataclass
class Views:
    """Cut-out person images (RGBA PNG). Photo scans have the front only."""

    front: bytes
    back: bytes | None = None
    left: bytes | None = None
    right: bytes | None = None


@dataclass
class Poll3d:
    state: Literal["running", "done", "failed"]
    glb_url: str | None = None
    glb: bytes | None = None
    error: str | None = None
    progress: float | None = None
    textured_attempt_failed: bool = False


Ref3d = dict[str, Any]  # {engineKey, task, statusUrl?, resultUrl?, note?}: JSON, saved on the job row


# ---------------------------------------------------------------------------------------------
# Response parsers: pure, so they are unit-tested without calling (and paying for) the APIs.
# ---------------------------------------------------------------------------------------------


def parse_fal_status(body: Any) -> Literal["running", "completed"]:
    """fal.ai queue status: IN_QUEUE | IN_PROGRESS | COMPLETED (errors come back as COMPLETED + error)."""
    return "completed" if isinstance(body, dict) and body.get("status") == "COMPLETED" else "running"


def parse_fal_result(body: Any) -> Poll3d:
    """fal.ai result: Trellis returns model_mesh; other 3D models use model_glb / model."""
    j = body if isinstance(body, dict) else {}
    for key in ("model_mesh", "model_glb", "model"):
        url = (j.get(key) or {}).get("url") if isinstance(j.get(key), dict) else None
        if url:
            return Poll3d("done", glb_url=url)
    extra = j.get("detail") or j.get("error")
    return Poll3d("failed", error="fal.ai returned no model" + (f": {json.dumps(extra)[:200]}" if extra else ""))


def parse_tripo_task(body: Any) -> Poll3d:
    """Tripo v3: {code, data: {status: queued|running|success|failed|cancelled|banned, progress, output}}."""
    j = body if isinstance(body, dict) else {}
    if j.get("code") != 0:
        return Poll3d("failed", error=f"Tripo error {j.get('code')}: {j.get('message') or 'unknown'}")
    d = j.get("data") or {}
    status = d.get("status")
    if status == "success":
        out = d.get("output") or {}
        url = out.get("pbr_model_url") or out.get("model_url")
        return Poll3d("done", glb_url=url) if url else Poll3d("failed", error="Tripo finished without a model URL")
    if status in ("failed", "cancelled", "banned"):
        return Poll3d("failed", error=f"Tripo task {status}")
    return Poll3d("running", progress=d.get("progress"))


def parse_meshy_task(body: Any) -> Poll3d:
    """Meshy: {status: PENDING|IN_PROGRESS|SUCCEEDED|FAILED|CANCELED, progress, model_urls: {glb}, task_error}."""
    j = body if isinstance(body, dict) else {}
    status = j.get("status")
    if status == "SUCCEEDED":
        url = (j.get("model_urls") or {}).get("glb")
        return Poll3d("done", glb_url=url) if url else Poll3d("failed", error="Meshy finished without a GLB")
    if status in ("FAILED", "CANCELED"):
        msg = (j.get("task_error") or {}).get("message")
        return Poll3d("failed", error=f"Meshy task {status.lower()}" + (f": {msg}" if msg else ""))
    return Poll3d("running", progress=j.get("progress"))


_GLB = re.compile(r"\.glb($|\?)", re.I)


def gradio_glb_url(data: Any) -> str | None:
    """Output file URL from a Gradio result: the first FileData with a .glb path."""
    if isinstance(data, dict):
        url, path = data.get("url"), data.get("path")
        if isinstance(url, str) and _GLB.search(path if isinstance(path, str) else url):
            return url
        children = list(data.values())
    elif isinstance(data, (list, tuple)):
        children = list(data)
    else:
        return None
    for child in children:
        hit = gradio_glb_url(child)
        if hit:
            return hit
    return None


def pick_hunyuan_glb(data: Any) -> str | None:
    """Hunyuan3D-2mv's /generation_all answers [white mesh, textured mesh, viewer html, stats, seed];
    /shape_generation answers [white mesh, ...]. Prefer the textured one, fall back to any GLB."""
    out = list(data) if isinstance(data, (list, tuple)) else []
    for x in out:
        url = gradio_glb_url([x])
        if url and re.search("textured", url, re.I):
            return url
    return gradio_glb_url(out)


def error_message(err: Any) -> str:
    """gradio_client raises AppError / exceptions, the JS client status objects; accept both."""
    if isinstance(err, BaseException):
        return str(err)
    if isinstance(err, dict) and isinstance(err.get("message"), str):
        return err["message"]
    return err if isinstance(err, str) else json.dumps(err, separators=(",", ":"))


def is_texturing_broken(err: Any) -> bool:
    """Errors from Hunyuan3D-2mv's texturing step that the untextured shape endpoint avoids."""
    return bool(re.search(r"PyMeshLab|texture|custom_rasterizer|mesh_painter", error_message(err), re.I))


def with_urls(data: Any, root: str) -> Any:
    """FileData without a URL (older Gradio servers) gets the server's file route."""
    if isinstance(data, dict):
        out = {k: with_urls(v, root) for k, v in data.items()}
        if isinstance(out.get("path"), str) and not out.get("url"):
            out["url"] = f"{root.rstrip('/')}/gradio_api/file={out['path']}"
        return out
    if isinstance(data, (list, tuple)):
        return [with_urls(x, root) for x in data]
    return data


def multi_view_list(views: Views) -> list[bytes]:
    """The views a multi-view engine gets, front first, in the order Hunyuan3D-2mv names them."""
    return [b for b in (views.front, views.back, views.left, views.right) if b]


# ---------------------------------------------------------------------------------------------
# Engines
# ---------------------------------------------------------------------------------------------


def _key(engine: EngineConfig) -> str:
    k = os.environ.get(engine.api_key_env or "")
    if not k:
        raise RuntimeError(f"{engine.api_key_env or 'API key'} is not set")
    return k


def _json(res: httpx.Response, what: str) -> Any:
    try:
        body: Any = res.json()
    except ValueError:
        body = res.text
    if res.status_code >= 400:
        text = body if isinstance(body, str) else json.dumps(body)
        raise RuntimeError(f"{what} failed ({res.status_code}): {text[:200]}")
    return body


def _data_uri(jpeg: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()


def _hf_space_3d(engine: EngineConfig, views: Views) -> tuple[str, str | None]:
    """Runs a free Space once. Returns (GLB URL, note), the note saying when the textured attempt
    fell back to the bare shape."""
    from gradio_client import Client, handle_file

    token = os.environ.get(engine.api_key_env or "") or None
    timeout = engine.timeout_ms / 1000
    note: str | None = None
    with tempfile.TemporaryDirectory(prefix="avatar-views-") as tmp:

        def file(png: bytes | None, name: str) -> Any:
            if not png:
                return None
            p = Path(tmp) / f"{name}.png"
            p.write_bytes(png)
            return handle_file(str(p))

        # download_files=False: results come back as FileData with the Space's URL, which is what
        # gets saved on the job, so a resumed job downloads instead of generating again.
        client = Client(engine.space or "", token=token, verbose=False, download_files=False, analytics_enabled=False)

        def call(api_name: str, **kwargs: Any) -> Any:
            return with_urls(client.submit(api_name=api_name, **kwargs).result(timeout=timeout), client.src)

        try:
            if engine.provider == "hf-hunyuan3d-mv":
                # Cut-outs are already RGBA, so the Space's background removal is skipped; turbo
                # (5 steps) and a fixed seed keep GPU time and results stable. /generation_all also
                # paints a texture from the front view (~90 s of ZeroGPU time instead of ~40 s).
                inputs = dict(
                    caption=None,
                    image=None,
                    mv_image_front=file(views.front, "front"),
                    mv_image_back=file(views.back, "back"),
                    mv_image_left=file(views.left, "left"),
                    mv_image_right=file(views.right, "right"),
                    steps=5,
                    guidance_scale=5,
                    seed=1234,
                    octree_resolution=256,
                    check_box_rembg=False,
                    num_chunks=8000,
                    randomize_seed=False,
                )
                result = None
                if engine.textured:
                    try:
                        result = call("/generation_all", **inputs)
                    except Exception as err:  # noqa: BLE001
                        # Seen 2026-10: the Space's mesh simplifier (PyMeshLab, run only before
                        # texturing) fails after ~9 s. The bare shape doesn't use it.
                        if not is_texturing_broken(err):
                            raise
                        note = f"texturing failed, shape only: {error_text(err)[:160]}"
                        log("warn", "textured generation failed; trying the shape endpoint", engine=engine.space, error=error_text(err))
                if result is None:
                    result = call("/shape_generation", **inputs)
                url = pick_hunyuan_glb(result)
            elif engine.provider in ("hf-trellis", "hf-trellis-multi"):
                # The Space keeps each visitor's files in a session folder its page creates on load;
                # without /start_session first, generation fails with FileNotFoundError.
                call("/start_session")
                if engine.provider == "hf-trellis":
                    pre = call("/preprocess_image", image=file(views.front, "front"))
                    prepared = pre[0] if isinstance(pre, (list, tuple)) else pre
                    result = call(
                        "/generate_and_extract_glb",
                        image=prepared or file(views.front, "front"),
                        multiimages=[],
                        seed=0,
                        ss_guidance_strength=7.5,
                        ss_sampling_steps=12,
                        slat_guidance_strength=3,
                        slat_sampling_steps=12,
                        multiimage_algo="stochastic",
                        mesh_simplify=0.95,
                        texture_size=1024,
                    )
                else:
                    # Multi-image mode is a session State the page flips when its "Multiple Images"
                    # tab is selected (/lambda_1); State inputs are read from the session.
                    call("/lambda_1")
                    names = ("front", "back", "left", "right")
                    imgs = [{"image": file(b, n), "caption": None} for b, n in zip(multi_view_list(views), names, strict=False)]
                    pre = call("/preprocess_images", images=imgs)
                    gallery = (pre[0] if isinstance(pre, (list, tuple)) and pre and isinstance(pre[0], list) else pre) or []
                    if not gallery:
                        raise RuntimeError("TRELLIS could not prepare the views")
                    first = gallery[0]["image"] if isinstance(gallery[0], dict) else gallery[0]
                    result = call(
                        "/generate_and_extract_glb",
                        image=first,
                        multiimages=gallery,
                        seed=0,
                        ss_guidance_strength=7.5,
                        ss_sampling_steps=12,
                        slat_guidance_strength=3,
                        slat_sampling_steps=12,
                        multiimage_algo="multidiffusion",
                        mesh_simplify=0.95,
                        texture_size=1024,
                    )
                url = gradio_glb_url(result)
            else:
                # Stable Fast 3D: its background-removal step produces the image the generator reads.
                bg = client.predict(file(views.front, "front"), 0.85, api_name="/requires_bg_remove")
                processed = bg[1] if isinstance(bg, (list, tuple)) and len(bg) > 1 else None
                result = client.submit(file(views.front, "front"), 0.85, processed, "None", -1, 1024, api_name="/run_button").result(timeout=timeout)
                url = gradio_glb_url(with_urls(result, client.src))
        except FutureTimeout:
            raise RuntimeError("The free 3D service took too long") from None
        finally:
            try:
                client.close()
            except Exception:  # noqa: BLE001
                pass
    if not url:
        raise RuntimeError("The free 3D service returned no model")
    return url, note


def submit_3d(engine_key: str, engine: EngineConfig, views: Views) -> Ref3d:
    p = engine.provider
    if p in ("hf-hunyuan3d-mv", "hf-trellis-multi", "hf-trellis", "hf-sf3d"):
        url, note = _hf_space_3d(engine, views)
        return {"engineKey": engine_key, "task": "done", "resultUrl": url, **({"note": note} if note else {})}
    if p == "mock-3d":
        return {"engineKey": engine_key, "task": "mock"}
    with httpx.Client(timeout=60) as http:
        if p == "fal-3d":
            body = _json(
                http.post(
                    f"https://queue.fal.run/{engine.model}",
                    headers={"authorization": f"Key {_key(engine)}"},
                    json={"image_url": _data_uri(flat_jpeg(views.front))},
                ),
                "fal.ai submit",
            )
            return {"engineKey": engine_key, "task": body["request_id"], "statusUrl": body.get("status_url"), "resultUrl": body.get("response_url")}
        if p == "tripo-3d":
            auth = {"authorization": f"Bearer {_key(engine)}"}
            jpeg = {"file": ("avatar.jpg", flat_jpeg(views.front), "image/jpeg")}
            up = _json(http.post("https://openapi.tripo3d.ai/v3/files", headers=auth, files=jpeg), "Tripo upload")
            token = (up.get("data") or {}).get("file_token")
            if up.get("code") != 0 or not token:
                raise RuntimeError(f"Tripo upload error {up.get('code')}: {up.get('message') or ''}")
            # align_image keeps the model facing the camera like the photo; 50k faces suits the web.
            task = _json(
                http.post(
                    "https://openapi.tripo3d.ai/v3/generation/image-to-model",
                    headers=auth,
                    json={"input": token, "model": engine.model, "texture": True, "pbr": True, "face_limit": 50000, "orientation": "align_image"},
                ),
                "Tripo image-to-model",
            )
            task_id = (task.get("data") or {}).get("task_id")
            if task.get("code") != 0 or not task_id:
                raise RuntimeError(f"Tripo error {task.get('code')}: {task.get('message') or ''}")
            return {"engineKey": engine_key, "task": task_id}
        if p == "meshy-3d":
            body = _json(
                http.post(
                    "https://api.meshy.ai/openapi/v1/image-to-3d",
                    headers={"authorization": f"Bearer {_key(engine)}"},
                    json={
                        "image_url": _data_uri(flat_jpeg(views.front)),
                        "ai_model": engine.model,
                        "should_texture": True,
                        "enable_pbr": True,
                        "topology": "triangle",
                        "target_polycount": 50000,
                    },
                ),
                "Meshy submit",
            )
            return {"engineKey": engine_key, "task": body["result"]}
    raise RuntimeError(f"Unknown provider {p}")


def poll_3d(engine: EngineConfig, ref: Ref3d) -> Poll3d:
    p = engine.provider
    if p in ("hf-hunyuan3d-mv", "hf-trellis-multi", "hf-trellis", "hf-sf3d"):
        return Poll3d("done", glb_url=ref["resultUrl"]) if ref.get("resultUrl") else Poll3d("failed", error="Missing model URL")
    if p == "mock-3d":
        return Poll3d("done", glb=mock_glb())
    with httpx.Client(timeout=30) as http:
        if p == "fal-3d":
            base = f"https://queue.fal.run/{engine.model}/requests/{ref['task']}"
            auth = {"authorization": f"Key {_key(engine)}"}
            if parse_fal_status(_json(http.get(ref.get("statusUrl") or f"{base}/status", headers=auth), "fal.ai status")) == "running":
                return Poll3d("running")
            return parse_fal_result(_json(http.get(ref.get("resultUrl") or base, headers=auth), "fal.ai result"))
        bearer = {"authorization": f"Bearer {_key(engine)}"}
        if p == "tripo-3d":
            return parse_tripo_task(_json(http.get(f"https://openapi.tripo3d.ai/v3/tasks/{ref['task']}", headers=bearer), "Tripo status"))
        if p == "meshy-3d":
            return parse_meshy_task(_json(http.get(f"https://api.meshy.ai/openapi/v1/image-to-3d/{ref['task']}", headers=bearer), "Meshy status"))
    return Poll3d("failed", error=f"Unknown provider {p}")


def download_glb(url: str) -> bytes:
    """Downloads the finished model (engine URLs are short-lived) and checks it really is a GLB.
    The Hugging Face token goes only to Hugging Face hosts."""
    host = urlparse(url).hostname or ""
    headers = {}
    token = os.environ.get("HF_TOKEN")
    if token and (host.endswith(".hf.space") or host.endswith("huggingface.co")):
        headers["authorization"] = f"Bearer {token}"
    with httpx.Client(timeout=120, follow_redirects=True) as http, http.stream("GET", url, headers=headers) as res:
        if res.status_code >= 400:
            raise RuntimeError(f"Model download failed ({res.status_code})")
        if int(res.headers.get("content-length") or 0) > MAX_GLB_BYTES:
            raise BadModel(f"Model is too large ({round(int(res.headers['content-length']) / 1e6)} MB)")
        chunks: list[bytes] = []
        size = 0
        for chunk in res.iter_bytes():
            size += len(chunk)
            if size > MAX_GLB_BYTES:
                raise BadModel("Model is too large (over 50 MB)")
            chunks.append(chunk)
    return assert_glb(b"".join(chunks), "The 3D service")
