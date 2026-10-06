// Where each garment goes on an avatar photo, from body landmarks. Pure and shared by the browser
// preview (canvas) and the server compositor (sharp), so both draw the same outfit the same way.

export type Landmark = { x: number; y: number; visibility?: number };
export type Pose = { landmarks: Landmark[] }; // 33 MediaPipe pose landmarks, normalised 0..1

export type GarmentInput = {
  id: string;
  slot: string; // top | bottom | one_piece | outer | shoes | accessory
  subcategory?: string | null;
  aspect: number; // width / height of the garment cut-out
};

export type Box = { id: string; slot: string; x: number; y: number; w: number; h: number };

// MediaPipe pose landmark indices.
const L = { nose: 0, lShoulder: 11, rShoulder: 12, lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28 };

// Drawing order, back to front: a top goes over trousers, a jacket over the top.
const ORDER = ["shoes", "bottom", "one_piece", "top", "outer"];

const visible = (p: Landmark | undefined, min = 0.3) => Boolean(p && (p.visibility ?? 1) >= min);

/** 0..1 score of how usable a photo is: full body visible, standing, facing the camera. */
export function poseQuality(pose: Pose): number {
  const lm = pose.landmarks;
  if (lm.length < 33) return 0;
  const key = [L.nose, L.lShoulder, L.rShoulder, L.lHip, L.rHip, L.lKnee, L.rKnee, L.lAnkle, L.rAnkle];
  const vis = key.reduce((acc, i) => acc + Math.min(1, Math.max(0, lm[i].visibility ?? 1)), 0) / key.length;
  const shoulderW = Math.abs(lm[L.lShoulder].x - lm[L.rShoulder].x);
  const facing = Math.min(1, shoulderW / 0.12); // side-on photos have narrow shoulders
  const tall = Math.min(1, (Math.max(lm[L.lAnkle].y, lm[L.rAnkle].y) - lm[L.nose].y) / 0.7);
  return Math.round(Math.max(0, Math.min(1, vis * 0.5 + facing * 0.25 + tall * 0.25)) * 100) / 100;
}

/** Hard requirement: shoulders and hips must be found, or garments cannot be placed at all. */
export function poseUsable(pose: Pose): boolean {
  const lm = pose.landmarks;
  return lm.length >= 33 && [L.lShoulder, L.rShoulder, L.lHip, L.rHip].every((i) => visible(lm[i], 0.5));
}

function fit(aspect: number, targetW: number, maxH: number) {
  let w = targetW;
  let h = w / aspect;
  if (h > maxH) {
    h = maxH;
    w = h * aspect;
  }
  return { w, h };
}

/** Pixel boxes for each garment on a W x H avatar image, in drawing order. Accessories are skipped. */
export function placeGarments(pose: Pose, W: number, H: number, garments: GarmentInput[]): Box[] {
  const lm = pose.landmarks;
  const px = (i: number) => ({ x: lm[i].x * W, y: lm[i].y * H });
  const ls = px(L.lShoulder), rs = px(L.rShoulder), lh = px(L.lHip), rh = px(L.rHip);
  const shoulderY = (ls.y + rs.y) / 2;
  const shoulderX = (ls.x + rs.x) / 2;
  const shoulderW = Math.max(Math.abs(ls.x - rs.x), W * 0.12);
  const hipY = (lh.y + rh.y) / 2;
  const hipX = (lh.x + rh.x) / 2;
  const hipW = Math.max(Math.abs(lh.x - rh.x), shoulderW * 0.6);
  const torso = Math.max(hipY - shoulderY, H * 0.15);

  const anklesSeen = visible(lm[L.lAnkle]) && visible(lm[L.rAnkle]);
  const ankleY = anklesSeen ? (px(L.lAnkle).y + px(L.rAnkle).y) / 2 : Math.min(H, hipY + torso * 2.1);
  const kneeY = visible(lm[L.lKnee]) && visible(lm[L.rKnee]) ? (px(L.lKnee).y + px(L.rKnee).y) / 2 : (hipY + ankleY) / 2;
  const ankleX = anklesSeen ? (px(L.lAnkle).x + px(L.rAnkle).x) / 2 : hipX;
  const ankleSpread = anklesSeen ? Math.abs(px(L.lAnkle).x - px(L.rAnkle).x) : hipW;

  const boxes: Box[] = [];
  for (const g of garments) {
    const aspect = g.aspect > 0 ? g.aspect : 0.8;
    const sub = (g.subcategory ?? "").toLowerCase();
    let box: { w: number; h: number; top: number; cx: number } | null = null;

    if (g.slot === "top") {
      const long = /kurta|tunic|kurti/.test(sub);
      const { w, h } = fit(aspect, shoulderW * 1.95, long ? kneeY - shoulderY + torso * 0.2 : torso * 1.45);
      box = { w, h, top: shoulderY - torso * 0.12, cx: shoulderX };
    } else if (g.slot === "outer") {
      const { w, h } = fit(aspect, shoulderW * 2.1, torso * 1.6);
      box = { w, h, top: shoulderY - torso * 0.14, cx: shoulderX };
    } else if (g.slot === "one_piece") {
      const { w, h } = fit(aspect, shoulderW * 1.9, ankleY - shoulderY + torso * 0.15);
      box = { w, h, top: shoulderY - torso * 0.1, cx: shoulderX };
    } else if (g.slot === "bottom") {
      const short = /shorts|skirt/.test(sub);
      const targetH = (short ? kneeY : ankleY) - hipY + torso * 0.12;
      let w = targetH * aspect;
      w = Math.min(Math.max(w, hipW * 1.5), hipW * 3.2);
      const h = Math.min(w / aspect, targetH * 1.05);
      box = { w, h, top: hipY - torso * 0.1, cx: hipX };
    } else if (g.slot === "shoes") {
      // Product photos of shoes come in any shape (side view, top view, a pair stacked), so cap
      // the height as well as the width: shoes are never taller than about a third of the torso.
      const { w, h } = fit(aspect, Math.max(ankleSpread * 1.7, hipW * 1.25), torso * 0.35);
      box = { w, h, top: ankleY - h * 0.35, cx: ankleX };
    }
    if (box) boxes.push({ id: g.id, slot: g.slot, x: box.cx - box.w / 2, y: box.top, w: box.w, h: box.h });
  }
  return boxes.sort((a, b) => ORDER.indexOf(a.slot) - ORDER.indexOf(b.slot));
}
