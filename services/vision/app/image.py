"""Photo checks and the stored variants: clean (1024 px WebP), thumb (320 px WebP), dHash, cut-out."""

from __future__ import annotations

import io
import warnings
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageOps

from app.cutout import key_out_background
from app.log import error_fields, log
from app.phash import dhash_from_pixels
from app.taxonomy import Category

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
ACCEPTED_FORMATS = {"JPEG", "PNG", "WEBP"}
MAX_SIDE = 8000
# 40 megapixels: any real phone photo, but a tiny file that decodes to gigabytes is refused.
MAX_PIXELS = 40_000_000
# Pillow's own bomb guard as a backstop (it raises at twice this).
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


class BadImageError(Exception):
    """The upload itself is unusable; the message is shown to the user as-is."""


@dataclass
class ProcessedImage:
    clean: bytes  # 1024 px max, WebP, no metadata (EXIF and GPS removed)
    thumb: bytes  # 320 px max, WebP
    phash: str


def _fit_inside(img: Image.Image, size: int, enlarge: bool = False) -> Image.Image:
    w, h = img.size
    scale = size / max(w, h)
    if scale >= 1 and not enlarge:
        return img.copy()
    return img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.Resampling.LANCZOS)


def webp(img: Image.Image, quality: int, alpha_quality: int | None = None) -> bytes:
    buf = io.BytesIO()
    opts: dict = {"quality": quality, "method": 4}
    if alpha_quality is not None:
        opts["alpha_quality"] = alpha_quality
    img.save(buf, "WEBP", **opts)  # no exif/icc/xmp passed, so none is written
    return buf.getvalue()


def flatten_white(img: Image.Image) -> Image.Image:
    """RGB on a white background (transparent pixels become white)."""
    if img.mode == "RGB":
        return img
    rgba = img.convert("RGBA")
    base = Image.new("RGB", rgba.size, (255, 255, 255))
    base.paste(rgba, mask=rgba.getchannel("A"))
    return base


def _srgb_grey(rgb: np.ndarray) -> np.ndarray:
    """Luminance like libvips' sRGB → B_W (linear-light Rec.709 weights, re-encoded to sRGB)."""
    v = rgb.astype(np.float64) / 255
    lin = np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)
    y = lin[..., 0] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 2] * 0.0722
    s = np.where(y <= 0.0031308, y * 12.92, 1.055 * np.power(y, 1 / 2.4) - 0.055)
    return np.clip(np.floor(s * 255 + 0.5), 0, 255).astype(np.uint8)


def phash_of(img: Image.Image) -> str:
    """dHash of the photo on white, at 9x8 greyscale (same steps as the TypeScript service)."""
    small = flatten_white(img).resize((9, 8), Image.Resampling.LANCZOS)
    return dhash_from_pixels(_srgb_grey(np.asarray(small)).reshape(-1).tolist())


def load_image(data: bytes) -> Image.Image:
    """Validates by file contents (not name or declared type) and decodes, upright, without metadata."""
    if len(data) > MAX_UPLOAD_BYTES:
        raise BadImageError("Photo is larger than 10 MB")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            probe = Image.open(io.BytesIO(data))
            fmt, (w, h) = probe.format, probe.size
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise BadImageError("Photo dimensions are too large") from None
    except Exception:
        raise BadImageError("This file is not a readable image") from None
    if fmt not in ACCEPTED_FORMATS:
        raise BadImageError("Use a JPEG, PNG or WebP photo")
    if w > MAX_SIDE or h > MAX_SIDE or w * h > MAX_PIXELS:
        raise BadImageError("Photo dimensions are too large")
    try:
        probe.load()
        img = ImageOps.exif_transpose(probe)  # applies the EXIF orientation
    except Exception:
        raise BadImageError("This file is not a readable image") from None
    has_alpha = img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info)
    img = img.convert("RGBA" if has_alpha else "RGB")
    img.info = {}  # drop EXIF (GPS included), ICC, XMP
    return img


def process_image(data: bytes) -> ProcessedImage:
    img = load_image(data)
    return ProcessedImage(
        clean=webp(_fit_inside(img, 1024), 80),
        thumb=webp(_fit_inside(img, 320), 70),
        phash=phash_of(img),
    )


def crop_to_alpha(img: Image.Image) -> Image.Image | None:
    """Trims fully transparent edges; None when nothing is left."""
    box = img.getchannel("A").point(lambda a: 255 if a > 0 else 0).getbbox()
    return img.crop(box) if box else None


def make_cutout(clean: bytes, category: Category | None) -> bytes | None:
    """Transparent, tightly cropped garment cut-out for the try-on preview.

    The clothes parser handles real photos, including someone wearing the piece; plain-background
    keying is the fallback. None when neither finds the garment cleanly.
    """
    if category and category != "accessory":
        try:
            from app.local_models import parse_cutout

            cut = parse_cutout(clean, category)
            if cut:
                return cut
        except Exception as err:  # model download or runtime failed: key instead of failing the job
            log("warn", "clothes parser unavailable; keying instead", **error_fields(err))
    if category == "accessory":
        # Small product shots (sunglasses, watches, bags): the parser has few labels for them, and
        # rembg's salient-object matting beats the keyer. Not used for garments: on clothes on a
        # hanger it tends to keep the hanger and drop the shirt.
        try:
            from app.local_models import rembg_cutout

            cut = rembg_cutout(clean)
            if cut:
                return cut
        except Exception as err:
            log("warn", "rembg unavailable; keying instead", **error_fields(err))
    img = _fit_inside(Image.open(io.BytesIO(clean)).convert("RGBA"), 640, enlarge=True)
    keyed = key_out_background(np.asarray(img).copy())
    if keyed is None:
        return None
    cropped = crop_to_alpha(Image.fromarray(keyed, "RGBA"))
    return webp(cropped, 85, 90) if cropped else None
