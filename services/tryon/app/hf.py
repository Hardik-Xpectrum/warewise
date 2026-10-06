"""The real model calls: free Hugging Face ZeroGPU Spaces through `gradio_client`.

IDM-VTON (upper body only) asks the free GPU for about 60 s per run; Leffa (upper, lower and
dresses) for 120 s or more. Both have a small daily GPU allowance (larger with a free HF_TOKEN)
and non-commercial licences."""

from __future__ import annotations

import os
import tempfile
import threading
from pathlib import Path
from typing import Any

from gradio_client import Client, handle_file

from app.config import ModelConfig
from app.engine import EngineGarment, model_input
from app.images import contain, jpeg, open_image
from app.plan import TryOnPass

_clients: dict[str, Client] = {}
_lock = threading.Lock()


def token_for(model: ModelConfig) -> str | None:
    return os.environ.get(model.api_key_env) or None if model.api_key_env else None


def has_token(model: ModelConfig) -> bool:
    return bool(token_for(model))


def _client(key: str, model: ModelConfig) -> Client:
    with _lock:
        if key not in _clients:
            _clients[key] = Client(model.space or "", token=token_for(model), verbose=False)
        return _clients[key]


def _result_path(result: Any) -> str:
    """The Spaces answer with a tuple (image, mask, ...); each image is a local file path (or a
    dict with `path`) that gradio_client already downloaded."""
    first = result[0] if isinstance(result, list | tuple) else result
    if isinstance(first, dict):
        first = first.get("path") or first.get("url")
    if not first:
        raise RuntimeError("Try-on model returned no image")
    return str(first)


def run_pass(key: str, model: ModelConfig, p: TryOnPass, garment: EngineGarment, current: bytes) -> bytes:
    """One garment onto the current image with one model. Returns a 768 x 1024 JPEG."""
    client = _client(key, model)
    with tempfile.TemporaryDirectory(prefix="tryon-") as tmp:
        person = Path(tmp, "person.jpg")
        person.write_bytes(current)
        # The garment alone on white, as these models were trained on: the cut-out when there is
        # one (no hanger, room or person wearing it, with an 8% margin), else the photo.
        garm = Path(tmp, "garment.jpg")
        garm.write_bytes(model_input(garment.cutout or garment.photo, 0.08 if garment.cutout else 0.0))
        if model.provider == "hf-idm-vton":
            result = client.predict(
                dict={"background": handle_file(str(person)), "layers": [], "composite": None},
                garm_img=handle_file(str(garm)),
                garment_des=garment.description,
                is_checked=True,
                is_checked_crop=False,
                denoise_steps=30,
                seed=42,
                api_name="/tryon",
            )
        else:
            result = client.predict(
                src_image_path=handle_file(str(person)),
                ref_image_path=handle_file(str(garm)),
                ref_acceleration=False,
                step=30,
                scale=2.5,
                seed=42,
                vt_model_type=p.model,
                vt_garment_type=p.region,
                vt_repaint=False,
                api_name="/leffa_predict_vt",
            )
    out = Path(_result_path(result))
    try:
        return jpeg(contain(open_image(out.read_bytes()).convert("RGB"), 768, 1024))
    finally:
        out.unlink(missing_ok=True)  # gradio_client's download cache would otherwise keep every render
