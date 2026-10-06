"""Small Pillow helpers shared by the engine, the model calls and the worker."""

from __future__ import annotations

import io

from PIL import Image, ImageOps

WHITE = (255, 255, 255)


def open_image(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img)  # phone photos carry their rotation in EXIF
    img.load()
    return img


def flatten(img: Image.Image, background: tuple[int, int, int] = WHITE) -> Image.Image:
    """RGB with any transparency laid on `background`."""
    if img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        base = Image.new("RGBA", rgba.size, (*background, 255))
        return Image.alpha_composite(base, rgba).convert("RGB")
    return img.convert("RGB")


def contain(img: Image.Image, width: int, height: int, background: tuple[int, int, int] = WHITE) -> Image.Image:
    """Scale to fit inside width x height keeping the aspect ratio, centred on `background`."""
    scale = min(width / img.width, height / img.height)
    w, h = max(1, round(img.width * scale)), max(1, round(img.height * scale))
    resized = img.resize((w, h), Image.Resampling.LANCZOS) if (w, h) != img.size else img
    canvas = Image.new("RGB", (width, height), background)
    canvas.paste(resized, ((width - w) // 2, (height - h) // 2))
    return canvas


def encode(img: Image.Image, fmt: str, **opts: object) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format=fmt, **opts)
    return buf.getvalue()


def webp(img: Image.Image) -> bytes:
    return encode(img if img.mode in ("RGB", "RGBA") else img.convert("RGB"), "WEBP", quality=85)


def jpeg(img: Image.Image) -> bytes:
    return encode(img.convert("RGB"), "JPEG", quality=92)
