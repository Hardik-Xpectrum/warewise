// Body-fitted garment warping. A garment cut-out is split into strips (torso, sleeves, legs); each
// strip is mapped onto the matching body segment from pose landmarks and drawn as textured
// triangles. Pure maths, shared by the static preview and the live mirror, and unit-tested.
import type { Landmark } from "./placement";

export type Pt = { x: number; y: number };
export type Tri = [Pt, Pt, Pt];
export type TriPair = { src: Tri; dst: Tri };

/** Shape of a garment cut-out, in 0..1 image coordinates, measured from its transparency. */
export type GarmentShape = {
  top: number; // first row wide enough to be the garment (skips a hanger hook)
  bottom: number;
  bodyL: number; // torso edges below the sleeves (tops)
  bodyR: number;
  waistL: number; // edges of the top row (waistband, for bottoms)
  waistR: number;
  reachL: number; // outermost extent: sleeve tips or leg edges
  reachR: number;
  armpitY: number; // tops: where sleeves meet the torso
  crotchY: number; // bottoms: where the legs split
  hemL: [number, number]; // bottoms: left leg hem extent
  hemR: [number, number];
  parts: Part[]; // separate blobs, largest first (e.g. the two shoes of a pair)
};

/** A separate blob in the image: centre, size along its own long axis, and that axis' angle. */
export type Part = { cx: number; cy: number; len: number; wid: number; angle: number };

/** Connected blobs of solid pixels (4-neighbour), with principal-axis orientation from their moments. */
export function findParts(alpha: Uint8Array | Uint8ClampedArray, width: number, height: number): Part[] {
  const label = new Int32Array(width * height);
  const parts: (Part & { area: number })[] = [];
  let next = 0;
  for (let start = 0; start < width * height; start++) {
    if (alpha[start] <= 96 || label[start]) continue;
    next++;
    const stack = [start];
    label[start] = next;
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    const pts: number[] = [];
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % width, y = (p - x) / width;
      n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      pts.push(p);
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
        if (q >= 0 && !label[q] && alpha[q] > 96) {
          label[q] = next;
          stack.push(q);
        }
      }
    }
    if (n < 12) continue;
    const cx = sx / n, cy = sy / n;
    const vxx = sxx / n - cx * cx, vyy = syy / n - cy * cy, vxy = sxy / n - cx * cy;
    const angle = 0.5 * Math.atan2(2 * vxy, vxx - vyy);
    const ux = Math.cos(angle), uy = Math.sin(angle);
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (const p of pts) {
      const x = (p % width) - cx, y = Math.floor(p / width) - cy;
      const a = x * ux + y * uy, b = -x * uy + y * ux;
      if (a < minA) minA = a; if (a > maxA) maxA = a;
      if (b < minB) minB = b; if (b > maxB) maxB = b;
    }
    // Centre of the oriented box (not the centroid), so the whole blob fits when mapped.
    const ma = (minA + maxA) / 2, mb = (minB + maxB) / 2;
    parts.push({
      cx: (cx + ma * ux - mb * uy) / width,
      cy: (cy + ma * uy + mb * ux) / height,
      len: (maxA - minA + 1) / width,
      wid: (maxB - minB + 1) / height,
      angle,
      area: n,
    });
  }
  parts.sort((a, b) => b.area - a.area);
  const biggest = parts[0]?.area ?? 0;
  return parts.filter((p) => p.area >= biggest * 0.25).slice(0, 2).map(({ area: _area, ...p }) => { void _area; return p; });
}

/**
 * Measures a garment from its alpha channel (row-major, width x height, 0..255).
 * Robust enough for flat product photos on a transparent background.
 */
export function analyzeShape(alpha: Uint8Array | Uint8ClampedArray, width: number, height: number): GarmentShape {
  const solid = (x: number, y: number) => alpha[y * width + x] > 96;
  const extent = (y: number): [number, number] | null => {
    let l = -1;
    let r = -1;
    for (let x = 0; x < width; x++) if (solid(x, y)) { if (l < 0) l = x; r = x; }
    return l < 0 ? null : [l, r];
  };
  const rows = Array.from({ length: height }, (_, y) => extent(y));
  const widths = rows.map((e) => (e ? e[1] - e[0] + 1 : 0));
  const maxW = Math.max(1, ...widths);
  let top = widths.findIndex((w) => w > maxW * 0.45);
  if (top < 0) top = 0;
  let bottom = height - 1;
  while (bottom > top && widths[bottom] === 0) bottom--;

  // Torso edges: the extent three quarters of the way down (below the sleeves).
  const bodyRow = rows[Math.round(top + (bottom - top) * 0.75)] ?? [0, width - 1];
  const topRow = rows[Math.min(bottom, top + 2)] ?? [0, width - 1];
  let reachL = width, reachR = 0;
  for (let y = top; y <= top + (bottom - top) * 0.6; y++) {
    const e = rows[y];
    if (e) { reachL = Math.min(reachL, e[0]); reachR = Math.max(reachR, e[1]); }
  }
  // Armpit: first row (from the top) whose extent is back within the torso edges.
  let armpitY = top + (bottom - top) * 0.3;
  for (let y = top; y <= bottom; y++) {
    const e = rows[y];
    if (e && e[0] >= bodyRow[0] - width * 0.02 && e[1] <= bodyRow[1] + width * 0.02 && y > top + (bottom - top) * 0.1) { armpitY = y; break; }
  }
  // Crotch: first row below the waist where the centre column is empty.
  const cx = Math.round((topRow[0] + topRow[1]) / 2);
  let crotchY = top + (bottom - top) * 0.3;
  for (let y = Math.round(top + (bottom - top) * 0.08); y <= bottom; y++) if (!solid(cx, y)) { crotchY = y; break; }
  // Leg hems: solid runs on each side of the centre in the last rows.
  const hemY = Math.max(top, bottom - Math.round((bottom - top) * 0.03));
  const run = (from: number, to: number): [number, number] => {
    let l = -1, r = -1;
    const step = from < to ? 1 : -1;
    for (let x = from; x !== to; x += step) if (solid(x, hemY)) { if (l < 0) l = x; r = x; }
    return l < 0 ? [from, from] : [Math.min(l, r), Math.max(l, r)];
  };
  const hemLeft = run(0, cx);
  const hemRight = run(cx, width);

  const nx = (v: number) => v / width;
  const ny = (v: number) => v / height;
  return {
    top: ny(top),
    bottom: ny(bottom + 1),
    bodyL: nx(bodyRow[0]),
    bodyR: nx(bodyRow[1] + 1),
    waistL: nx(topRow[0]),
    waistR: nx(topRow[1] + 1),
    reachL: nx(reachL),
    reachR: nx(reachR + 1),
    armpitY: ny(armpitY),
    crotchY: ny(crotchY),
    hemL: [nx(hemLeft[0]), nx(hemLeft[1] + 1)],
    hemR: [nx(hemRight[0]), nx(hemRight[1] + 1)],
    parts: findParts(alpha, width, height),
  };
}

/** Fallback when a garment has no cut-out (photo with background): assume a centred garment. */
export const DEFAULT_SHAPE: GarmentShape = {
  top: 0, bottom: 1, bodyL: 0.2, bodyR: 0.8, waistL: 0.1, waistR: 0.9, reachL: 0, reachR: 1, armpitY: 0.3, crotchY: 0.3, hemL: [0.05, 0.48], hemR: [0.52, 0.95],
  parts: [],
};

// A strip is a centreline with a half-width at each point; consecutive points form quads.
type Strip = { c: Pt[]; hw: number[] };

function stripTris(src: Strip, dst: Strip): TriPair[] {
  const side = (s: Strip, i: number, sign: 1 | -1): Pt => {
    const a = s.c[Math.max(0, i - 1)];
    const b = s.c[Math.min(s.c.length - 1, i + 1)];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    // Normal to the centreline, pointing to one side.
    return { x: s.c[i].x + (sign * -dy / len) * s.hw[i], y: s.c[i].y + (sign * dx / len) * s.hw[i] };
  };
  const out: TriPair[] = [];
  for (let i = 0; i < src.c.length - 1; i++) {
    const s = [side(src, i, 1), side(src, i, -1), side(src, i + 1, 1), side(src, i + 1, -1)];
    const d = [side(dst, i, 1), side(dst, i, -1), side(dst, i + 1, 1), side(dst, i + 1, -1)];
    out.push({ src: [s[0], s[1], s[2]], dst: [d[0], d[1], d[2]] }, { src: [s[1], s[3], s[2]], dst: [d[1], d[3], d[2]] });
  }
  return out;
}

const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export type BodyFrame = {
  shoulder: [Pt, Pt]; // image-left, image-right
  elbow: [Pt, Pt];
  wrist: [Pt, Pt];
  hip: [Pt, Pt];
  knee: [Pt, Pt];
  ankle: [Pt, Pt];
  foot: [Pt, Pt];
  torso: number;
};

/** Body points in pixels, ordered image-left then image-right (works for photos and mirrored video). */
export function bodyFrame(lm: Landmark[], W: number, H: number): BodyFrame {
  const p = (i: number): Pt => ({ x: lm[i].x * W, y: lm[i].y * H });
  // Whichever of the person's sides appears on the image-left decides the order for every limb,
  // so an arm crossing the body still belongs to its own shoulder.
  const armsLeftFirst = p(11).x <= p(12).x;
  const legsLeftFirst = p(23).x <= p(24).x;
  const ordered = (left: number, right: number, leftFirst: boolean): [Pt, Pt] => (leftFirst ? [p(left), p(right)] : [p(right), p(left)]);
  // Foot = between heel and toe when those are seen below the ankle; otherwise just under the ankle.
  const foot = (toe: number, heel: number, ankle: number): Pt => {
    const seen = (i: number) => (lm[i]?.visibility ?? 1) >= 0.3;
    const f = lerp(p(toe), p(heel), 0.5);
    return seen(toe) && seen(heel) && f.y > p(ankle).y ? f : { x: p(ankle).x, y: p(ankle).y + H * 0.02 };
  };
  const shoulder = ordered(11, 12, armsLeftFirst);
  const hip = ordered(23, 24, legsLeftFirst);
  return {
    shoulder,
    elbow: ordered(13, 14, armsLeftFirst),
    wrist: ordered(15, 16, armsLeftFirst),
    hip,
    knee: ordered(25, 26, legsLeftFirst),
    ankle: ordered(27, 28, legsLeftFirst),
    foot: legsLeftFirst ? [foot(31, 29, 27), foot(32, 30, 28)] : [foot(32, 30, 28), foot(31, 29, 27)],
    torso: Math.max(dist(lerp(shoulder[0], shoulder[1], 0.5), lerp(hip[0], hip[1], 0.5)), H * 0.12),
  };
}

export type WarpInput = {
  slot: string;
  subcategory?: string | null;
  shape: GarmentShape;
  imgW: number;
  imgH: number;
  /** Width multiplier from the fit (1 = your size; >1 roomier, <1 tighter). */
  fit?: number;
};

/**
 * Triangles that map a garment image onto the body. Source points are in garment-image pixels,
 * destination points in avatar/video pixels. Shoes return two rectangles as triangle pairs.
 */
export function warpGarment(g: WarpInput, body: BodyFrame): TriPair[] {
  const S = g.shape;
  const sx = (v: number) => v * g.imgW;
  const sy = (v: number) => v * g.imgH;
  const sub = (g.subcategory ?? "").toLowerCase();
  const [sL, sR] = body.shoulder;
  const [hL, hR] = body.hip;
  const shoulderMid = lerp(sL, sR, 0.5);
  const hipMid = lerp(hL, hR, 0.5);
  const shoulderHalf = dist(sL, sR) / 2;
  const hipHalf = dist(hL, hR) / 2;
  const T = body.torso;
  const fit = g.fit ?? 1;
  const tris: TriPair[] = [];

  if (g.slot === "top" || g.slot === "outer" || g.slot === "one_piece") {
    const grow = g.slot === "outer" ? 1.12 : 1;
    const long = /kurta|tunic|kurti/.test(sub);
    const cxs = sx((S.bodyL + S.bodyR) / 2);
    const halfS = sx(S.bodyR - S.bodyL) / 2;
    // Hem: tops end just below the hips; kurtas at the knee; dresses from their own proportions.
    const kneeMid = lerp(body.knee[0], body.knee[1], 0.5);
    const ankleMid = lerp(body.ankle[0], body.ankle[1], 0.5);
    const hemDst =
      g.slot === "one_piece"
        ? (S.bottom - S.top) / Math.max(0.01, S.bodyR - S.bodyL) > 2.2 ? ankleMid : kneeMid
        : long ? lerp(hipMid, kneeMid, 0.9) : lerp(shoulderMid, hipMid, g.slot === "outer" ? 1.18 : 1.1);
    const neck = lerp(shoulderMid, hipMid, -0.08);
    const src: Strip = {
      c: [{ x: cxs, y: sy(S.top) }, { x: cxs, y: sy(S.armpitY) }, { x: cxs, y: sy(S.bottom) }],
      hw: [halfS, halfS, halfS],
    };
    // Landmarks sit at the joints, so the body edge is a little outside them. When the photo's
    // sleeves are not clearly separate from the body (drop shoulders, a garment on a hanger), the
    // whole top is drawn wider at the shoulders so its sleeve area falls over the upper arms.
    const sleevesSeparate = (S.reachR - S.reachL) / Math.max(0.01, S.bodyR - S.bodyL) >= 1.4;
    const bodyHalf = shoulderHalf * (sleevesSeparate ? 1.08 : 1.5) * grow * fit;
    const hemHalf = Math.max(hipHalf * 1.3, bodyHalf * 0.9) * fit * (g.slot === "one_piece" && hemDst.y > hipMid.y + T ? 1.35 : 1);
    const dst: Strip = {
      c: [neck, lerp(neck, hemDst, (S.armpitY - S.top) / Math.max(0.01, S.bottom - S.top)), hemDst],
      hw: [bodyHalf, sleevesSeparate ? bodyHalf * 0.98 : shoulderHalf * 1.12 * grow * fit, hemHalf],
    };
    tris.push(...stripTris(src, dst));

    // Sleeves, if the garment is wider than its torso.
    const sleeveDepth = sy(S.armpitY - S.top);
    for (const side of sleevesSeparate ? ([0, 1] as const) : []) {
      const reach = side === 0 ? S.reachL : S.reachR;
      const edge = side === 0 ? S.bodyL : S.bodyR;
      if (Math.abs(sx(reach - edge)) < halfS * 0.15) continue;
      const rootSrc = { x: sx(edge), y: sy(S.top) + sleeveDepth / 2 };
      const tipSrc = { x: sx(reach), y: sy(S.top) + sleeveDepth * (/shirt|kurta|jacket|blazer|sweater|hoodie/.test(sub) && !/t-shirt|tee/.test(sub) ? 2.2 : 1.1) };
      const shoulder = body.shoulder[side];
      const longSleeve = dist(rootSrc, tipSrc) > sy(S.bottom - S.top) * 0.45;
      const tipDst = longSleeve ? body.wrist[side] : lerp(shoulder, body.elbow[side], 0.55);
      const rootDst = lerp(shoulder, shoulderMid, 0.05);
      const w0 = sleeveDepth / 2;
      tris.push(
        ...stripTris(
          { c: [rootSrc, lerp(rootSrc, tipSrc, 0.5), tipSrc], hw: [w0, w0 * 0.85, w0 * 0.7] },
          { c: [rootDst, lerp(rootDst, tipDst, 0.5), tipDst], hw: [T * 0.2 * grow * fit, T * 0.16 * grow * fit, T * 0.13 * grow * fit] },
        ),
      );
    }
  } else if (g.slot === "bottom") {
    const short = /shorts|skirt/.test(sub);
    const waistY = sy(S.top);
    const hemY = sy(S.bottom);
    const cx = sx((S.waistL + S.waistR) / 2);
    for (const side of [0, 1] as const) {
      const hem = side === 0 ? S.hemL : S.hemR;
      const waistEdge = side === 0 ? sx(S.waistL) : sx(S.waistR);
      const topC = { x: (waistEdge + cx) / 2, y: waistY };
      const hemC = { x: sx((hem[0] + hem[1]) / 2), y: hemY };
      const src: Strip = { c: [topC, lerp(topC, hemC, 0.5), hemC], hw: [Math.abs(cx - waistEdge) / 2, Math.abs(cx - waistEdge) / 2.4, sx(hem[1] - hem[0]) / 2] };
      const hip = lerp(body.hip[side], hipMid, 0.1);
      const knee = body.knee[side];
      const end = short ? lerp(hip, knee, 0.95) : body.ankle[side];
      const mid = short ? lerp(hip, end, 0.5) : knee;
      tris.push(...stripTris(src, { c: [lerp(hip, hipMid, 0), mid, end], hw: [hipHalf * 0.95 * fit, T * 0.2 * fit, T * 0.16 * fit] }));
    }
  } else if (g.slot === "shoes") {
    // Each shoe is found as its own blob, straightened along its long axis, and set on a foot
    // side-on. One blob (a single shoe) is reused, mirrored, for the other foot.
    const parts = S.parts.length ? S.parts : [{ cx: 0.5, cy: 0.5, len: 1, wid: 1, angle: 0 }];
    const ordered = [...parts].sort((a, b) => a.cx - b.cx);
    for (const side of [0, 1] as const) {
      const part = ordered[Math.min(side, ordered.length - 1)];
      const mirror = ordered.length === 1 && side === 1;
      const ux = Math.cos(part.angle), uy = Math.sin(part.angle);
      // Source corners of the shoe's oriented box, in image pixels.
      const c = { x: sx(part.cx), y: sy(part.cy) };
      const hl = (part.len * g.imgW) / 2, hw = (part.wid * g.imgH) / 2;
      // The angle is within ±90°, so cos >= 0 and the box's -b side is always the upper side:
      // the shoe keeps its top up after straightening.
      const along = (a: number, b: number): Pt => ({ x: c.x + a * ux - b * uy, y: c.y + a * uy + b * ux });
      const sTL = along(-hl, -hw), sTR = along(hl, -hw), sBL = along(-hl, hw), sBR = along(hl, hw);
      const at = body.foot[side];
      const len = Math.max(hipHalf * 1.05, T * 0.34) * fit;
      const h = Math.min(len * (hw / Math.max(1, hl)), T * 0.3);
      const top = at.y - h * 0.7;
      let dTL: Pt = { x: at.x - len / 2, y: top }, dTR: Pt = { x: at.x + len / 2, y: top };
      let dBL: Pt = { x: at.x - len / 2, y: top + h }, dBR: Pt = { x: at.x + len / 2, y: top + h };
      if (mirror) [dTL, dTR, dBL, dBR] = [dTR, dTL, dBR, dBL];
      tris.push({ src: [sTL, sTR, sBL], dst: [dTL, dTR, dBL] }, { src: [sTR, sBR, sBL], dst: [dTR, dBR, dBL] });
    }
  }
  return tris;
}

/**
 * The 2x3 affine matrix [a, b, c, d, e, f] (canvas setTransform order) that maps triangle src onto
 * dst: x' = a*x + c*y + e, y' = b*x + d*y + f.
 */
export function affineFromTriangles(src: Tri, dst: Tri): [number, number, number, number, number, number] | null {
  const [p0, p1, p2] = src;
  const [q0, q1, q2] = dst;
  const det = p0.x * (p1.y - p2.y) + p1.x * (p2.y - p0.y) + p2.x * (p0.y - p1.y);
  if (Math.abs(det) < 1e-9) return null;
  const a = (q0.x * (p1.y - p2.y) + q1.x * (p2.y - p0.y) + q2.x * (p0.y - p1.y)) / det;
  const c = (q0.x * (p2.x - p1.x) + q1.x * (p0.x - p2.x) + q2.x * (p1.x - p0.x)) / det;
  const e = (q0.x * (p1.x * p2.y - p2.x * p1.y) + q1.x * (p2.x * p0.y - p0.x * p2.y) + q2.x * (p0.x * p1.y - p1.x * p0.y)) / det;
  const b = (q0.y * (p1.y - p2.y) + q1.y * (p2.y - p0.y) + q2.y * (p0.y - p1.y)) / det;
  const d = (q0.y * (p2.x - p1.x) + q1.y * (p0.x - p2.x) + q2.y * (p1.x - p0.x)) / det;
  const f = (q0.y * (p1.x * p2.y - p2.x * p1.y) + q1.y * (p2.x * p0.y - p0.x * p2.y) + q2.y * (p0.x * p1.y - p1.x * p0.y)) / det;
  return [a, b, c, d, e, f];
}

/** Grow a triangle slightly around its centre so neighbouring triangles overlap and hide seams. */
export function inflate(t: Tri, px = 0.8): Tri {
  const cx = (t[0].x + t[1].x + t[2].x) / 3;
  const cy = (t[0].y + t[1].y + t[2].y) / 3;
  return t.map((p) => {
    const dx = p.x - cx, dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / len) * px, y: p.y + (dy / len) * px };
  }) as Tri;
}

/** Exponential smoothing of landmarks between video frames, to stop garments jittering. */
export function smoothLandmarks(prev: Landmark[] | null, next: Landmark[], alpha = 0.55): Landmark[] {
  if (!prev || prev.length !== next.length) return next;
  return next.map((p, i) => ({
    x: prev[i].x + (p.x - prev[i].x) * alpha,
    y: prev[i].y + (p.y - prev[i].y) * alpha,
    visibility: p.visibility,
  }));
}
