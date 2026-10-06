import numpy as np

from app.cutout import key_out_background


def image(w, h, bg, fg, box):
    px = np.zeros((h, w, 4), np.uint8)
    px[..., :3] = bg
    px[..., 3] = 255
    px[box[1]:box[3], box[0]:box[2], :3] = fg
    return px


def test_plain_background_becomes_transparent():
    out = key_out_background(image(40, 40, (245, 245, 240), (30, 60, 120), (10, 10, 30, 30)))
    assert out[0, 0, 3] == 0 and out[20, 20, 3] == 255


def test_enclosed_background_colour_is_kept():
    px = image(40, 40, (250, 250, 250), (20, 20, 20), (5, 5, 35, 35))
    px[20, 20, :3] = 250  # a white button inside a black shirt
    assert key_out_background(px)[20, 20, 3] == 255


def test_edge_softening():
    out = key_out_background(image(40, 40, (245, 245, 240), (30, 60, 120), (10, 10, 30, 30)))
    assert out[10, 15, 3] == 150


def test_rejects_background_surviving_on_edges():
    px = image(40, 40, (240, 240, 240), (250, 250, 250), (15, 15, 25, 25))
    px[:, :12, :3] = 60
    assert key_out_background(px) is None


def test_gives_up_on_busy_background():
    flat = np.array([255 if i % 4 == 3 else (i * 37) % 256 for i in range(30 * 30 * 4)], np.uint8)
    assert key_out_background(flat.reshape(30, 30, 4)) is None
