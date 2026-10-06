import io

from PIL import Image

from app.image import phash_of
from app.phash import NO_MATCH, dhash_from_pixels, hamming_hex


def test_gradient_hash():
    pixels = [255 - (i % 9) * 20 for i in range(72)]
    h = dhash_from_pixels(pixels)
    assert len(h) == 16 and h == "ffffffffffffffff"


def test_hamming():
    assert hamming_hex("ff00", "ff00") == 0
    assert hamming_hex("ff00", "fe00") == 1
    assert hamming_hex("0000", "ffff") == 16
    assert hamming_hex("00", "0000") == NO_MATCH


def test_resized_copy_hashes_close():
    img = Image.linear_gradient("L").rotate(90).convert("RGB").resize((400, 300))
    small = Image.open(io.BytesIO(_jpeg(img.resize((200, 150))))).convert("RGB")
    assert hamming_hex(phash_of(img), phash_of(small)) <= 4


def _jpeg(img):
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=70)
    return buf.getvalue()
