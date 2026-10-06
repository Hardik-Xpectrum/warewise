// Body measurements for the avatar. Lengths come from the photo's pose landmarks, scaled to real
// centimetres by the height in the profile; girths come from the sizes the user entered (a photo
// from the front cannot measure depth). Estimates, clearly labelled as such in the UI.
import type { Landmark } from "./placement";
import { TOP_SIZES, type UserSizes } from "./fit";

export type Measurements = {
  heightCm: number;
  shoulderCm: number; // shoulder width, edge to edge
  chestCm: number; // circumference
  waistCm: number; // circumference
  hipCm: number; // circumference
  armCm: number; // shoulder to wrist
  upperArmCm: number; // shoulder to elbow
  torsoCm: number; // shoulder line to hip line
  inseamCm: number; // hip joint to floor
  headCm: number; // chin to crown
  sources: { lengths: "photo" | "average"; chest: "size" | "estimate"; waist: "size" | "estimate" };
};

// Typical chest girth (cm) for each letter size.
const CHEST_BY_SIZE: Record<(typeof TOP_SIZES)[number], number> = { XS: 84, S: 90, M: 96, L: 102, XL: 108, XXL: 114, "3XL": 120 };

const d = (a: Landmark, b: Landmark, W: number, H: number) => Math.hypot((a.x - b.x) * W, (a.y - b.y) * H);
const mid = (a: Landmark, b: Landmark): Landmark => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const round = (v: number) => Math.round(v);

/**
 * Estimates measurements from one front-facing photo. `W`/`H` are the photo's pixel size, used to
 * undo the normalisation of landmark coordinates.
 */
export function estimateMeasurements(lm: Landmark[] | null, W: number, H: number, heightCm: number | null | undefined, sizes: UserSizes | null | undefined): Measurements {
  const height = heightCm && heightCm > 100 ? heightCm : 170;
  let lengths: Omit<Measurements, "chestCm" | "waistCm" | "hipCm" | "sources" | "heightCm">;
  let fromPhoto = false;

  const seen = (i: number) => (lm?.[i]?.visibility ?? 0) >= 0.5;
  if (lm && lm.length >= 33 && [0, 11, 12, 23, 24, 27, 28].every(seen)) {
    fromPhoto = true;
    const ankle = mid(lm[27], lm[28]);
    // The crown is above the nose by roughly the nose-to-shoulder distance; the floor just below the ankles.
    const shoulders = mid(lm[11], lm[12]);
    const noseToShoulder = (shoulders.y - lm[0].y) * H;
    const crownY = lm[0].y * H - noseToShoulder * 0.95;
    const floorY = ankle.y * H + noseToShoulder * 0.25;
    const cmPerPx = height / Math.max(1, floorY - crownY);
    const both = (a: number, b: number) => (d(lm[a], lm[b], W, H) + 0) * cmPerPx;
    const avg = (x: number, y: number) => (x + y) / 2;
    lengths = {
      shoulderCm: both(11, 12) * 1.18, // joints -> outer edge of the shoulders
      upperArmCm: seen(13) && seen(14) ? avg(both(11, 13), both(12, 14)) : height * 0.186,
      armCm: seen(15) && seen(16) ? avg(both(11, 13) + both(13, 15), both(12, 14) + both(14, 16)) : height * 0.33,
      torsoCm: d(shoulders, mid(lm[23], lm[24]), W, H) * cmPerPx,
      inseamCm: (floorY - mid(lm[23], lm[24]).y * H) * cmPerPx,
      headCm: (lm[0].y * H - crownY) * cmPerPx + noseToShoulder * cmPerPx * 0.45,
    };
  } else {
    // Average adult proportions (share of height).
    lengths = { shoulderCm: height * 0.245, upperArmCm: height * 0.186, armCm: height * 0.33, torsoCm: height * 0.3, inseamCm: height * 0.47, headCm: height * 0.13 };
  }

  const chestFromSize = sizes?.top_size ? CHEST_BY_SIZE[sizes.top_size] : null;
  const chestCm = chestFromSize ?? lengths.shoulderCm * 2.2;
  const waistCm = sizes?.waist_in ? sizes.waist_in * 2.54 : chestCm * 0.86;
  const hipCm = Math.max(waistCm * 1.08, chestCm * 0.96);

  return {
    heightCm: round(height),
    shoulderCm: round(lengths.shoulderCm),
    chestCm: round(chestCm),
    waistCm: round(waistCm),
    hipCm: round(hipCm),
    armCm: round(lengths.armCm),
    upperArmCm: round(lengths.upperArmCm),
    torsoCm: round(lengths.torsoCm),
    inseamCm: round(lengths.inseamCm),
    headCm: round(lengths.headCm),
    sources: { lengths: fromPhoto ? "photo" : "average", chest: chestFromSize ? "size" : "estimate", waist: sizes?.waist_in ? "size" : "estimate" },
  };
}
