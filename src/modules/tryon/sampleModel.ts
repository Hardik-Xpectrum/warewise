// The sample model shown on Try-on until someone adds their own photo: an illustrated figure
// (public/samples/model.svg) with its 33 pose landmarks set by hand, so garments are placed on
// it exactly as on a real photo.
import type { Landmark } from "./placement";

const W = 600;
const H = 1500;
// Pixel positions in the SVG, keyed by MediaPipe landmark index. 11/13/15/23/25/27 are the
// person's left side, which appears on the image right for a front-facing figure.
const PX: Record<number, [number, number]> = {
  0: [300, 165], 1: [288, 142], 2: [282, 142], 3: [276, 142], 4: [312, 142], 5: [318, 142], 6: [324, 142],
  7: [248, 150], 8: [352, 150], 9: [288, 188], 10: [312, 188],
  11: [398, 305], 12: [202, 305], 13: [422, 530], 14: [178, 530], 15: [438, 738], 16: [162, 738],
  17: [442, 790], 18: [158, 790], 19: [440, 800], 20: [160, 800], 21: [432, 770], 22: [168, 770],
  23: [355, 790], 24: [245, 790], 25: [356, 1070], 26: [244, 1070], 27: [354, 1372], 28: [246, 1372],
  29: [350, 1405], 30: [250, 1405], 31: [376, 1418], 32: [224, 1418],
};

export const SAMPLE_MODEL = {
  id: "sample-model",
  imageUrl: "/samples/model.svg",
  width: W,
  height: H,
  pose: {
    landmarks: Array.from({ length: 33 }, (_, i): Landmark => ({ x: PX[i][0] / W, y: PX[i][1] / H, visibility: 0.99 })),
  },
};
