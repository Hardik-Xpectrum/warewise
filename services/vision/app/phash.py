"""Perceptual hash: the same dHash as the TypeScript service, so stored hashes stay comparable."""

from __future__ import annotations

import sys
from collections.abc import Sequence

NO_MATCH = sys.maxsize


def hamming_hex(a: str, b: str) -> int:
    """Number of differing bits between two equal-length hex hashes."""
    if len(a) != len(b):
        return NO_MATCH
    return sum(bin(int(x, 16) ^ int(y, 16)).count("1") for x, y in zip(a, b, strict=True))


def dhash_from_pixels(pixels: Sequence[int] | bytes, width: int = 9, height: int = 8) -> str:
    """Difference hash of a 9x8 greyscale thumbnail: one bit per horizontal neighbour pair, 64 bits
    as 16 hex chars (left brighter than right = 1). Near-identical photos land within a few bits."""
    bits = "".join(
        "1" if pixels[y * width + x] > pixels[y * width + x + 1] else "0"
        for y in range(height)
        for x in range(width - 1)
    )
    return "".join(format(int(bits[i : i + 4], 2), "x") for i in range(0, len(bits), 4))
