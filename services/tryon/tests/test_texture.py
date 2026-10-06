import io

import numpy as np
from PIL import Image

from app.texture import avatar_textures, average_grid, key_out_background


def synthetic() -> np.ndarray:
    """40 x 40 white image with a red 20 x 20 square, and a white 6 x 6 patch inside the square."""
    img = np.full((40, 40, 4), 255, dtype=np.uint8)
    img[10:30, 10:30, :3] = (200, 30, 30)
    img[17:23, 17:23, :3] = 255
    return img


def test_makes_the_outer_white_transparent_but_keeps_white_inside_the_figure():
    out = key_out_background(synthetic())
    assert out[0, 0, 3] == 0
    assert out[20, 39, 3] == 0
    assert out[12, 12, 3] == 255  # red
    assert out[20, 20, 3] == 255  # the white shirt patch survives


def test_soft_edge_on_light_pixels_touching_the_background():
    img = synthetic()
    img[10, 10:30, :3] = 230  # a light halo row on the square's top edge
    out = key_out_background(img)
    assert 0 < out[10, 15, 3] < 255
    assert out[11, 15, 3] == 255


def test_average_grid_averages_opaque_colour_and_fills_empty_cells_with_the_mean():
    g = average_grid(key_out_background(synthetic()), 2, 2)
    # Every cell holds a quarter of the red square: mostly red, a little white.
    assert g[0, 0, 0] > 200 and g[0, 0, 1] < 100
    assert g.shape == (2, 2, 4)


def test_avatar_textures_keyed_front_and_plain_mirrored_back_with_the_same_silhouette():
    # Shift the square left (extend white to the right) so the mirror shows.
    img = np.full((40, 60, 4), 255, dtype=np.uint8)
    img[:, :40] = synthetic()
    buf = io.BytesIO()
    Image.fromarray(img[..., :3], "RGB").save(buf, "PNG")
    front_png, back_png = avatar_textures(buf.getvalue())
    f = np.array(Image.open(io.BytesIO(front_png)))
    b = np.array(Image.open(io.BytesIO(back_png)))
    assert f.shape == (40, 60, 4) and b.shape == (40, 60, 4)
    assert f[12, 12, 3] == 255
    assert b[12, 60 - 1 - 12, 3] == 255  # mirrored
    assert b[12, 12, 3] == 0
    # No detail on the back: the white patch is averaged into the red.
    r, g = int(b[20, 60 - 1 - 20, 0]), int(b[20, 60 - 1 - 20, 1])
    assert r > g + 60
