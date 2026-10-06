"""Image preparation. The phone sends transparent cut-outs; engines want them at a sane size, the
paid APIs want a flat JPEG, and the measurements read the alpha channel as a silhouette."""

from __future__ import annotations

import io

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

MAX_SIDE = 1024
Image.MAX_IMAGE_PIXELS = 40_000_000


class BadImage(ValueError):
    """The file isn't a readable image: the user's input, so retrying won't help."""


def _open(data: bytes) -> Image.Image:
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as err:
        raise BadImage("A scan view isn't a readable image") from err
    return img


def prepare_cutout(data: bytes) -> bytes:
    """A cut-out as engines want it: RGBA PNG, at most 1024 px on its longer side, EXIF dropped."""
    img = ImageOps.exif_transpose(_open(data)).convert("RGBA")
    img.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, "PNG", optimize=False)
    return out.getvalue()


def flat_jpeg(png: bytes) -> bytes:
    """The same image on white as a JPEG, for APIs that don't take transparency."""
    img = _open(png).convert("RGBA")
    bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
    out = io.BytesIO()
    Image.alpha_composite(bg, img).convert("RGB").save(out, "JPEG", quality=92)
    return out.getvalue()


def alpha_mask(png: bytes) -> np.ndarray:
    """The alpha channel as a silhouette mask (uint8, height x width, 0 = background)."""
    return np.asarray(_open(png).convert("RGBA").getchannel("A"), dtype=np.uint8)


def texture_image(data: bytes) -> tuple[Image.Image, str]:
    """A face texture: (RGB/RGBA image, 'png' | 'jpeg' to store it as)."""
    img = _open(data)
    fmt = "jpeg" if (img.format or "").upper() in ("JPEG", "JPG") else "png"
    return ImageOps.exif_transpose(img).convert("RGBA" if fmt == "png" else "RGB"), fmt
