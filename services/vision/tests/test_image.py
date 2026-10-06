import io

import pytest
from PIL import Image

from app.image import MAX_UPLOAD_BYTES, BadImageError, make_cutout, process_image


def photo(fmt="JPEG", size=(1600, 1200), exif=True, colour=(30, 60, 120)):
    img = Image.new("RGB", size, (245, 245, 240))
    img.paste(Image.new("RGB", (size[0] // 2, size[1] // 2), colour), (size[0] // 4, size[1] // 4))
    buf = io.BytesIO()
    kwargs = {}
    if exif:
        e = Image.Exif()
        e[0x010F] = "PhoneMaker"
        e[0x8825] = {2: (12.0, 34.0, 56.0)}  # GPS
        kwargs["exif"] = e.tobytes()
    img.save(buf, fmt, **kwargs)
    return buf.getvalue()


def test_clean_and_thumb_are_resized_webp_without_metadata():
    p = process_image(photo())
    clean, thumb = Image.open(io.BytesIO(p.clean)), Image.open(io.BytesIO(p.thumb))
    assert clean.format == thumb.format == "WEBP"
    assert max(clean.size) == 1024 and max(thumb.size) == 320
    assert not clean.info.get("exif") and not thumb.info.get("exif")
    assert b"PhoneMaker" not in p.clean
    assert len(p.phash) == 16


def test_small_photo_is_not_enlarged():
    assert Image.open(io.BytesIO(process_image(photo(size=(300, 200))).clean)).size == (300, 200)


def test_rejects_by_content():
    with pytest.raises(BadImageError, match="not a readable image"):
        process_image(b"%PDF-1.4 hello")
    buf = io.BytesIO()
    Image.new("RGB", (10, 10)).save(buf, "GIF")
    with pytest.raises(BadImageError, match="JPEG, PNG or WebP"):
        process_image(buf.getvalue())
    with pytest.raises(BadImageError, match="10 MB"):
        process_image(b"\xff" * (MAX_UPLOAD_BYTES + 1))


def test_rejects_too_many_pixels():
    buf = io.BytesIO()
    Image.new("1", (7000, 7000)).save(buf, "PNG")  # 49 MP, a tiny file
    with pytest.raises(BadImageError, match="too large"):
        process_image(buf.getvalue())


def test_keyer_cutout_for_accessory(monkeypatch):
    import app.local_models

    monkeypatch.setattr(app.local_models, "rembg_cutout", lambda clean: None)  # no model download in tests
    cut = make_cutout(process_image(photo(exif=False)).clean, "accessory")
    img = Image.open(io.BytesIO(cut))
    assert img.mode == "RGBA" and img.getpixel((img.width // 2, img.height // 2))[3] == 255


def test_no_cutout_for_busy_background(monkeypatch):
    import numpy as np

    import app.local_models

    monkeypatch.setattr(app.local_models, "rembg_cutout", lambda clean: None)
    noise = Image.fromarray(np.random.default_rng(1).integers(0, 255, (200, 200, 3), dtype=np.uint8))
    buf = io.BytesIO()
    noise.save(buf, "PNG")
    assert make_cutout(process_image(buf.getvalue()).clean, "accessory") is None
