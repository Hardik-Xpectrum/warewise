"""On-device vision, free and keyless.

CLIP (`openai/clip-vit-base-patch32`, zero-shot) names the garment and its pattern, and a
clothes-parsing SegFormer (`mattmdjaga/segformer_b2_clothes`) cuts it out. Both are open models
downloaded from Hugging Face on first use into MODEL_CACHE_DIR, then run here on the CPU with
PyTorch; photos never leave the service.
"""

from __future__ import annotations

import hashlib
import io
import os
import threading
from collections import OrderedDict
from collections.abc import Callable
from pathlib import Path
from typing import Any, TypeVar

import numpy as np
from PIL import Image
from scipy import ndimage

from app.image import crop_to_alpha, flatten_white, webp
from app.local_vision import (
    GARMENTS,
    NOT_CLOTHING,
    PATTERN_PROMPTS,
    cutout_labels,
    erode,
    mask_passes_gate,
    named_colors,
    pick_garment,
    pick_pattern,
)
from app.taxonomy import Category

CLIP_MODEL = "openai/clip-vit-base-patch32"
PARSER_MODEL = "mattmdjaga/segformer_b2_clothes"
PARSER_SIZE = 512
_IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

# Several phrasings, averaged: steadier than one, and covers photos of someone wearing the piece.
TEMPLATES = ["a photo of {}", "a product photo of {}", "a photo of a person wearing {}"]

T = TypeVar("T")


def cache_dir() -> str:
    return os.environ.get("MODEL_CACHE_DIR") or str(Path.cwd() / ".cache" / "models")


def _once(load: Callable[[], T]) -> Callable[[], T]:
    """Loads once (thread-safe); a failed load (e.g. a dropped download) is forgotten, so the next job tries again."""
    lock = threading.Lock()
    box: list[T] = []

    def get() -> T:
        with lock:
            if not box:
                box.append(load())
            return box[0]

    return get


def _torch() -> Any:
    import torch

    return torch


def _inference(fn: Callable[..., T]) -> Callable[..., T]:
    """Runs `fn` without autograd (the setting is per thread, so it is applied on every call)."""

    def wrapped(*args: Any, **kwargs: Any) -> T:
        with _torch().inference_mode():
            return fn(*args, **kwargs)

    return wrapped


@_once
def _clip() -> tuple[Any, Any]:
    from transformers import CLIPModel, CLIPProcessor

    model = CLIPModel.from_pretrained(CLIP_MODEL, cache_dir=cache_dir(), use_safetensors=True).eval()
    return model, CLIPProcessor.from_pretrained(CLIP_MODEL, cache_dir=cache_dir())


@_once
def _parser() -> Any:
    from transformers import AutoModelForSemanticSegmentation

    return AutoModelForSemanticSegmentation.from_pretrained(PARSER_MODEL, cache_dir=cache_dir(), use_safetensors=True).eval()


def _features(out: Any) -> Any:
    # transformers 5 returns an output object from get_*_features; 4.x returned the tensor.
    return getattr(out, "pooler_output", out)


_text_cache: dict[tuple[str, ...], Any] = {}
_text_lock = threading.Lock()


@_inference
def _text_embeddings(prompts: list[str]) -> Any:
    key = tuple(prompts)
    with _text_lock:
        if key not in _text_cache:
            model, processor = _clip()
            inputs = processor(text=prompts, return_tensors="pt", padding=True)
            emb = _features(model.get_text_features(**inputs))
            _text_cache[key] = emb / emb.norm(dim=-1, keepdim=True)
            if len(_text_cache) > 64:
                _text_cache.pop(next(iter(_text_cache)))
        return _text_cache[key]


@_inference
def _image_embedding(img: Image.Image) -> Any:
    model, processor = _clip()
    emb = _features(model.get_image_features(**processor(images=img, return_tensors="pt")))
    return emb / emb.norm(dim=-1, keepdim=True)


@_inference
def scores_for(img_emb: Any, labels: list[str], templates: list[str] = TEMPLATES) -> list[float]:
    """Zero-shot scores in the order of `labels`: softmax over the labels per phrasing, averaged."""
    torch = _torch()
    model, _ = _clip()
    total = torch.zeros(len(labels))
    for template in templates:
        text = _text_embeddings([template.replace("{}", label) for label in labels])
        logits = model.logit_scale.exp() * img_emb @ text.T
        total += logits.softmax(dim=-1)[0] / len(templates)
    return total.tolist()


# --- cut-out ---------------------------------------------------------------------------------

# The tagger cuts the garment out to read its colours; the job then asks again for the same photo
# for the stored cut-out, so the last few results are kept.
_cutouts: OrderedDict[str, bytes | None] = OrderedDict()
_cutout_lock = threading.Lock()


def parse_cutout(image: bytes, category: Category) -> bytes | None:
    """The garment cut out with the clothes parser: an RGBA WebP trimmed to the garment, or None
    when the parser finds too little (the caller then falls back to the plain-background keyer).
    Works on product photos and on photos of someone wearing the piece."""
    key = f"{category}:{hashlib.sha1(image).hexdigest()}"
    with _cutout_lock:
        if key in _cutouts:
            return _cutouts[key]
    result = _cut_out(image, category)
    with _cutout_lock:
        _cutouts[key] = result
        while len(_cutouts) > 8:
            _cutouts.popitem(last=False)
    return result


@_inference
def parse_labels(rgb: Image.Image) -> tuple[np.ndarray, dict[int, str]]:
    """Per-pixel clothes-parsing label ids at the photo's own size, and the id → name map."""
    torch = _torch()
    model = _parser()
    x = np.asarray(rgb.resize((PARSER_SIZE, PARSER_SIZE), Image.Resampling.BILINEAR), dtype=np.float32) / 255
    x = (x - _IMAGENET_MEAN) / _IMAGENET_STD
    pixel_values = torch.from_numpy(x.transpose(2, 0, 1)[None].copy())
    logits = model(pixel_values=pixel_values).logits
    up = torch.nn.functional.interpolate(logits, size=(rgb.height, rgb.width), mode="bilinear", align_corners=False)
    return up.argmax(dim=1)[0].numpy(), {int(k): v for k, v in model.config.id2label.items()}


def _cut_out(image: bytes, category: Category) -> bytes | None:
    rgb = flatten_white(Image.open(io.BytesIO(image)))
    labels, names = parse_labels(rgb)
    h, w = labels.shape
    area = {names[i]: float((labels == i).sum()) / (w * h) for i in np.unique(labels).tolist()}
    keep_ids = [i for i, n in names.items() if n in set(cutout_labels(area, category))]
    alpha = np.where(np.isin(labels, keep_ids), 255, 0).astype(np.uint8)
    if not mask_passes_gate(alpha):
        return None
    # Pull the edge in a pixel or two (it carries some of the photo's backdrop, which shows as a
    # grey halo on the avatar), then soften it so the garment doesn't look stencilled.
    alpha = erode(alpha, max(1, round(max(w, h) * 0.003)))
    soft = np.clip(ndimage.gaussian_filter(alpha.astype(np.float32), 0.8) + 0.5, 0, 255).astype(np.uint8)
    rgba = np.dstack([np.asarray(rgb), soft])
    cropped = crop_to_alpha(Image.fromarray(rgba, "RGBA"))
    return webp(cropped, 85, 90) if cropped else None


@_once
def _rembg_session() -> Any:
    # Optional dependency (rembg + onnxruntime); its u2net model (~176 MB) downloads on first use.
    os.environ.setdefault("U2NET_HOME", str(Path(cache_dir()) / "u2net"))
    from rembg import new_session

    return new_session("u2net")


def rembg_cutout(image: bytes) -> bytes | None:
    """Salient-object cut-out with rembg (u2net), held to the same quality gate as the parser's."""
    from rembg import remove

    out = remove(Image.open(io.BytesIO(image)).convert("RGB"), session=_rembg_session())
    rgba = np.asarray(out.convert("RGBA")).copy()
    if not mask_passes_gate(np.where(rgba[..., 3] > 127, 255, 0).astype(np.uint8)):
        return None
    cropped = crop_to_alpha(Image.fromarray(rgba, "RGBA"))
    return webp(cropped, 85, 90) if cropped else None


# --- tagging ---------------------------------------------------------------------------------


def local_tag(image: bytes) -> dict[str, Any]:
    """Tags one garment photo without any API: CLIP picks the garment and pattern, the colours are
    named from the cut-out's own pixels. Returns the same JSON shape as the AI tagger."""
    img = flatten_white(Image.open(io.BytesIO(image)))
    emb = _image_embedding(img)
    garment, confidence = pick_garment(scores_for(emb, [g.label for g in GARMENTS] + NOT_CLOTHING))
    if garment is None:
        return {
            "is_clothing": False, "item_count": 1, "category": "top", "subcategory": None, "colors": [], "pattern": "other",
            "seasons": ["all"], "fabric": None, "formality": 2, "fit": "regular", "brand": None, "confidence": confidence,
        }
    # Shoes and accessories: the pattern rarely matters and CLIP guesses wildly, so they're plain.
    if garment.category in ("shoes", "accessory"):
        pattern = "solid"
    else:
        prompts = [p.replace("{}", garment.subcategory) for p in PATTERN_PROMPTS.values()]
        pattern = pick_pattern(scores_for(emb, prompts, ["a photo of {}"]))

    # Colours from the garment itself, not the background: use the cut-out when there is one.
    try:
        cut = parse_cutout(image, garment.category)
    except Exception:
        cut = None
    src = Image.open(io.BytesIO(cut or image)).convert("RGBA")
    scale = 160 / max(src.size)
    small = src.resize((max(1, round(src.width * scale)), max(1, round(src.height * scale))), Image.Resampling.LANCZOS)
    colors = named_colors(np.asarray(small))
    if not cut:  # a white backdrop shouldn't lead
        colors = ([c for c in colors if c != "white"] + (["white"] if "white" in colors else []))[:3]

    return {
        "is_clothing": True,
        "item_count": 1,
        "category": garment.category,
        "subcategory": garment.subcategory,
        "colors": colors,
        "pattern": pattern,
        "seasons": garment.seasons or ["all"],
        "fabric": garment.fabric,
        "formality": garment.formality,
        "fit": "regular",
        "brand": None,
        "confidence": confidence,
    }
