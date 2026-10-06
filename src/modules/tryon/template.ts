// Garment templates. Instead of bending the product photo's own outline (a shirt on a hanger, jeans
// folded in half), we draw a clean garment shape around the body from pose landmarks and fill it
// with the garment's fabric, sampled from the flat, undistorted middle of the photo.
import type { BodyFrame, GarmentShape, Pt } from "./warp";

/** One filled region: a clip outline on the body, and the photo area that textures it. */
export type Piece = {
  outline: Pt[]; // destination polygon (avatar pixels), already smoothed
  quad: [Pt, Pt, Pt, Pt]; // destination quad (TL, TR, BR, BL) the source rect is mapped onto
  src: { x: number; y: number; w: number; h: number }; // normalised 0..1 in the garment photo
  kind: "body" | "sleeve" | "leg" | "band";
  collar?: Pt[]; // neckline curve (left neck, dip, right neck) for a ribbed collar
};

const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const add = (a: Pt, dx: number, dy: number): Pt => ({ x: a.x + dx, y: a.y + dy });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Chaikin corner-cutting: turns a polygon's hard corners into soft, fabric-like curves. */
export function smooth(points: Pt[], iterations = 2): Pt[] {
  let pts = points;
  for (let k = 0; k < iterations; k++) {
    const out: Pt[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      out.push(lerp(a, b, 0.25), lerp(a, b, 0.75));
    }
    pts = out;
  }
  return pts;
}

/** Offset of point p perpendicular to the segment a->b (positive = to the right of travel). */
function side(a: Pt, b: Pt, p: Pt, amount: number): Pt {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: p.x + (-dy / len) * amount, y: p.y + (dx / len) * amount };
}

type TopOpts = { sleeve: "short" | "long" | "none"; length: "hip" | "long" | "knee" | "ankle"; grow: number; flare: number };

function topPieces(S: GarmentShape, body: BodyFrame, fit: number, o: TopOpts): Piece[] {
  const [sL, sR] = body.shoulder;
  const [hL, hR] = body.hip;
  const T = body.torso;
  const mid = lerp(sL, sR, 0.5);
  const hipMid = lerp(hL, hR, 0.5);
  const up = { x: (mid.x - hipMid.x) / T, y: (mid.y - hipMid.y) / T }; // unit-ish vector towards the head
  const shoulderHalf = dist(sL, sR) / 2;
  const hipHalf = dist(hL, hR) / 2;
  const w = fit * o.grow;

  // Key points, image-left side first.
  const out = (p: Pt, from: Pt, k: number): Pt => lerp(from, p, 1 + k); // push p away from `from`
  // Shoulder landmarks sit at the joint, below the top of the shoulder: lift the seams to cover it.
  const shoulderEdge = [add(out(sL, mid, 0.07 * w), up.x * T * 0.12, up.y * T * 0.12), add(out(sR, mid, 0.07 * w), up.x * T * 0.12, up.y * T * 0.12)];
  // Crew neck: sits at the base of the neck, high enough to cover what the person wears underneath.
  const neck = [add(lerp(mid, sL, 0.2), up.x * T * 0.25, up.y * T * 0.25), add(lerp(mid, sR, 0.2), up.x * T * 0.25, up.y * T * 0.25)];
  const collarDip = add(mid, up.x * T * 0.15, up.y * T * 0.15);
  const bodyHalf = Math.max(shoulderHalf * 0.92, hipHalf * 1.12) * w;
  const armpitY = lerp(mid, hipMid, 0.36);
  const armpit = [add(armpitY, -bodyHalf, 0), add(armpitY, bodyHalf, 0)];
  const hemCentre =
    o.length === "hip" ? lerp(mid, hipMid, 1.14)
    : o.length === "long" ? lerp(mid, hipMid, 1.3)
    : o.length === "knee" ? lerp(hipMid, lerp(body.knee[0], body.knee[1], 0.5), 1.05)
    : lerp(hipMid, lerp(body.ankle[0], body.ankle[1], 0.5), 0.97);
  const hemHalf = Math.max(hipHalf * 1.18, bodyHalf * 0.92) * (1 + o.flare) * fit;
  const hem = [add(hemCentre, -hemHalf, 0), add(hemCentre, hemHalf, 0)];

  // Fabric: the garment photo's torso, below the collar/hanger and above the hem stitching.
  const bodySrc = {
    x: S.bodyL + (S.bodyR - S.bodyL) * 0.06,
    y: S.top + (S.bottom - S.top) * 0.08,
    w: (S.bodyR - S.bodyL) * 0.88,
    h: (S.bottom - S.top) * 0.88,
  };
  const pieces: Piece[] = [];
  // Hem corners are listed twice so smoothing keeps them nearly square: a tee's hem is straight.
  const torsoOutline = smooth([neck[0], shoulderEdge[0], armpit[0], hem[0], hem[0], hem[1], hem[1], armpit[1], shoulderEdge[1], neck[1], collarDip]);
  const topY = Math.min(neck[0].y, neck[1].y, shoulderEdge[0].y, shoulderEdge[1].y);
  pieces.push({
    kind: "body",
    outline: torsoOutline,
    quad: [
      { x: Math.min(shoulderEdge[0].x, hem[0].x), y: topY },
      { x: Math.max(shoulderEdge[1].x, hem[1].x), y: topY },
      { x: Math.max(shoulderEdge[1].x, hem[1].x), y: Math.max(hem[0].y, hem[1].y) },
      { x: Math.min(shoulderEdge[0].x, hem[0].x), y: Math.max(hem[0].y, hem[1].y) },
    ],
    src: bodySrc,
    collar: [neck[0], collarDip, neck[1]],
  });

  if (o.sleeve !== "none") {
    for (const s of [0, 1] as const) {
      const shoulder = body.shoulder[s];
      const tipCentre = o.sleeve === "long" ? body.wrist[s] : lerp(shoulder, body.elbow[s], 0.55);
      const halfTip = T * (o.sleeve === "long" ? 0.1 : 0.14) * w;
      const sign = s === 0 ? -1 : 1; // outer side is away from the body
      const tipOuter = side(shoulder, tipCentre, tipCentre, -sign * halfTip);
      const tipInner = side(shoulder, tipCentre, tipCentre, sign * halfTip);
      // The sleeve's root reaches into the torso, so the body piece drawn on top hides the join.
      const rootIn = lerp(shoulderEdge[s], mid, 0.25);
      const armpitIn = lerp(armpit[s], armpitY, 0.2);
      const outline = smooth([rootIn, shoulderEdge[s], tipOuter, tipInner, armpit[s], armpitIn], 1);
      // Sleeve fabric: a plain strip from the side of the torso (sleeves in photos are often folded or hidden).
      const strip = { x: s === 0 ? S.bodyL + (S.bodyR - S.bodyL) * 0.08 : S.bodyL + (S.bodyR - S.bodyL) * 0.8, y: S.top + (S.bottom - S.top) * 0.45, w: (S.bodyR - S.bodyL) * 0.12, h: (S.bottom - S.top) * 0.3 };
      const minX = Math.min(...outline.map((p) => p.x)), maxX = Math.max(...outline.map((p) => p.x));
      const minY = Math.min(...outline.map((p) => p.y)), maxY = Math.max(...outline.map((p) => p.y));
      pieces.push({ kind: "sleeve", outline, quad: [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }], src: strip });
    }
  }
  return pieces;
}

function bottomPieces(S: GarmentShape, body: BodyFrame, fit: number, short: boolean): Piece[] {
  const [hL, hR] = body.hip;
  const T = body.torso;
  const hipMid = lerp(hL, hR, 0.5);
  const hipHalf = dist(hL, hR) / 2;
  const waistHalf = Math.max(hipHalf * 1.18, T * 0.28) * fit;
  const waistY = add(hipMid, 0, -T * 0.12);
  const waist = [add(waistY, -waistHalf, 0), add(waistY, waistHalf, 0)];
  const crotch = add(hipMid, 0, T * 0.32);
  const pieces: Piece[] = [];

  // Fabric: the straight upper part of the trousers (a folded or bent lower half is ignored).
  const cx = (S.waistL + S.waistR) / 2;
  const legH = (S.bottom - S.top) * (S.crotchY > S.top + 0.05 && S.crotchY < S.bottom - 0.05 ? 0.55 : 0.4);
  for (const s of [0, 1] as const) {
    const knee = body.knee[s];
    // Full-length trousers reach the top of the shoe, covering whatever the photo shows at the ankle.
    const end = short ? lerp(body.hip[s], knee, 0.95) : lerp(body.ankle[s], body.foot[s], 0.55);
    const kneeHalf = T * 0.17 * fit;
    const endHalf = T * (short ? 0.19 : 0.15) * fit;
    const sign = s === 0 ? -1 : 1;
    const outerKnee = add(knee, sign * kneeHalf, 0);
    const innerKnee = add(knee, -sign * kneeHalf * 0.9, 0);
    const outerEnd = add(end, sign * endHalf, 0);
    const innerEnd = add(end, -sign * endHalf, 0);
    const hipOuter = add(body.hip[s], sign * (waistHalf - hipHalf) * 0.9, 0);
    const outline = smooth(s === 0 ? [waist[0], hipOuter, outerKnee, outerEnd, innerEnd, innerKnee, crotch, add(waistY, 0, 0)] : [add(waistY, 0, 0), crotch, innerKnee, innerEnd, outerEnd, outerKnee, hipOuter, waist[1]], 1);
    const xs = outline.map((p) => p.x), ys = outline.map((p) => p.y);
    const src = s === 0
      ? { x: S.waistL + (cx - S.waistL) * 0.08, y: S.top + (S.bottom - S.top) * 0.06, w: (cx - S.waistL) * 0.84, h: legH }
      : { x: cx + (S.waistR - cx) * 0.08, y: S.top + (S.bottom - S.top) * 0.06, w: (S.waistR - cx) * 0.84, h: legH };
    pieces.push({ kind: "leg", outline, quad: [{ x: Math.min(...xs), y: Math.min(...ys) }, { x: Math.max(...xs), y: Math.min(...ys) }, { x: Math.max(...xs), y: Math.max(...ys) }, { x: Math.min(...xs), y: Math.max(...ys) }], src });
  }
  // Waistband across the front, from the top rows of the photo.
  const band = smooth([waist[0], waist[1], add(waist[1], 0, T * 0.08), add(waist[0], 0, T * 0.08)], 1);
  pieces.push({ kind: "band", outline: band, quad: [waist[0], waist[1], add(waist[1], 0, T * 0.08), add(waist[0], 0, T * 0.08)], src: { x: S.waistL, y: S.top, w: S.waistR - S.waistL, h: (S.bottom - S.top) * 0.06 } });
  return pieces;
}

/** Template pieces for a garment, or null for slots drawn another way (shoes, accessories). */
export function templatePieces(slot: string, subcategory: string | null | undefined, S: GarmentShape, body: BodyFrame, fit = 1): Piece[] | null {
  const sub = (subcategory ?? "").toLowerCase();
  if (slot === "top") {
    const long = /kurta|tunic|kurti/.test(sub);
    const sleeve = /tank|vest|sleeveless|camisole/.test(sub) ? "none" : /shirt|kurta|sweater|hoodie|sweatshirt|long/.test(sub) && !/t-shirt|tee|polo/.test(sub) ? "long" : "short";
    return topPieces(S, body, fit, { sleeve, length: long ? "knee" : "hip", grow: 1, flare: long ? 0.25 : 0 });
  }
  if (slot === "outer") return topPieces(S, body, fit, { sleeve: /vest|gilet|sleeveless/.test(sub) ? "none" : "long", length: "long", grow: 1.1, flare: 0.05 });
  if (slot === "one_piece") {
    const tall = (S.bottom - S.top) / Math.max(0.01, S.bodyR - S.bodyL) > 2.2 || /saree|maxi|gown|lehenga|anarkali/.test(sub);
    return topPieces(S, body, fit, { sleeve: /sleeveless|strap|slip/.test(sub) ? "none" : "short", length: tall ? "ankle" : "knee", grow: 1, flare: 0.45 });
  }
  if (slot === "bottom") return bottomPieces(S, body, fit, /shorts|skirt/.test(sub));
  return null;
}
