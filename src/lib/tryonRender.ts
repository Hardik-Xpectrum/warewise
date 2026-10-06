"use client";
import type { Landmark } from "@/modules/tryon/placement";
import { templatePieces, type Piece } from "@/modules/tryon/template";
import { affineFromTriangles, analyzeShape, bodyFrame, DEFAULT_SHAPE, inflate, warpGarment, type BodyFrame, type GarmentShape, type TriPair } from "@/modules/tryon/warp";

export type RenderGarment = { id: string; slot: string; subcategory: string | null; img: HTMLImageElement; shape: GarmentShape; isCutout: boolean; fit?: number };

const ORDER = ["shoes", "bottom", "one_piece", "top", "outer"];

const images = new Map<string, Promise<HTMLImageElement>>();

/** Loads an image once per file (signed URLs change, the file does not). CORS keeps canvases exportable. */
export function loadImage(url: string): Promise<HTMLImageElement> {
  const key = url.split("?")[0];
  let p = images.get(key);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => {
        images.delete(key);
        reject(new Error("image failed to load"));
      };
      img.src = url;
    });
    images.set(key, p);
  }
  return p;
}

const shapes = new WeakMap<HTMLImageElement, GarmentShape>();

/** Measures a cut-out's outline (sleeves, waist, legs) from its transparency, at low resolution. */
export function garmentShape(img: HTMLImageElement, isCutout: boolean): GarmentShape {
  if (!isCutout) return DEFAULT_SHAPE;
  let s = shapes.get(img);
  if (!s) {
    const scale = Math.min(1, 160 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(8, Math.round(img.naturalWidth * scale));
    const h = Math.max(8, Math.round(img.naturalHeight * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, w, h);
    const rgba = g.getImageData(0, 0, w, h).data;
    const alpha = new Uint8ClampedArray(w * h);
    for (let i = 0; i < w * h; i++) alpha[i] = rgba[i * 4 + 3];
    s = analyzeShape(alpha, w, h);
    shapes.set(img, s);
  }
  return s;
}

function drawTriangle(g: CanvasRenderingContext2D, img: HTMLImageElement, t: TriPair) {
  const m = affineFromTriangles(t.src, t.dst);
  if (!m) return;
  const d = inflate(t.dst, 0.9);
  g.save();
  g.beginPath();
  g.moveTo(d[0].x, d[0].y);
  g.lineTo(d[1].x, d[1].y);
  g.lineTo(d[2].x, d[2].y);
  g.closePath();
  g.clip();
  g.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  g.drawImage(img, 0, 0);
  g.restore();
}

function tracePath(g: CanvasRenderingContext2D, pts: { x: number; y: number }[]) {
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) g.lineTo(p.x, p.y);
  g.closePath();
}

const baseColours = new WeakMap<HTMLImageElement, string>();

/**
 * The garment's main fabric colour: the median of its opaque pixels in the middle band, which
 * skips the neck hole, hanger and prints near the centre line.
 */
export function fabricColour(img: HTMLImageElement): string {
  let c = baseColours.get(img);
  if (c) return c;
  const w = 48, h = 48;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const g = cv.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const r: number[] = [], gr: number[] = [], b: number[] = [];
  for (let y = Math.round(h * 0.25); y < h * 0.85; y++)
    for (let x = Math.round(w * 0.15); x < w * 0.85; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] < 220) continue;
      r.push(d[i]);
      gr.push(d[i + 1]);
      b.push(d[i + 2]);
    }
  const med = (xs: number[]) => (xs.length ? xs.sort((p, q) => p - q)[xs.length >> 1] : 128);
  c = `rgb(${med(r)},${med(gr)},${med(b)})`;
  baseColours.set(img, c);
  return c;
}

/** Fills one template piece with its fabric: source rectangle -> destination quad, clipped to the outline. */
function drawPiece(g: CanvasRenderingContext2D, img: HTMLImageElement, piece: Piece, cutout: boolean, plain = false) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const { x, y, w, h } = piece.src;
  const s = [{ x: x * W, y: y * H }, { x: (x + w) * W, y: y * H }, { x: (x + w) * W, y: (y + h) * H }, { x: x * W, y: (y + h) * H }];
  const d = piece.quad;
  g.save();
  tracePath(g, piece.outline);
  g.clip();
  // Solid fabric underneath, so the photo's neck hole or uneven hem never shows the body through.
  if (cutout || plain) {
    g.fillStyle = fabricColour(img);
    g.fill();
  }
  if (!plain) drawTriangle(g, img, { src: [s[0], s[1], s[3]], dst: [d[0], d[1], d[3]] });
  if (!plain) drawTriangle(g, img, { src: [s[1], s[2], s[3]], dst: [d[1], d[2], d[3]] });
  g.restore();
  // Soft seam shadow along the outline gives the piece an edge and some thickness.
  g.save();
  tracePath(g, piece.outline);
  g.clip();
  // Faint: on light clothes a stronger line reads as a grey border rather than a seam.
  g.strokeStyle = "rgba(0,0,0,0.12)";
  g.lineWidth = Math.max(1, (piece.quad[1].x - piece.quad[0].x) * 0.012);
  tracePath(g, piece.outline);
  g.stroke();
  if (piece.collar && !plain) drawCollar(g, piece, cutout ? fabricColour(img) : "rgb(200,200,200)");
  g.restore();
}

/** A ribbed crew-neck band along the neckline: fabric colour with a shadow line on each side. */
function drawCollar(g: CanvasRenderingContext2D, piece: Piece, colour: string) {
  const [a, dip, b] = piece.collar!;
  const width = Math.max(2, Math.hypot(b.x - a.x, b.y - a.y) * 0.16);
  const curve = (offset: number) => {
    g.beginPath();
    g.moveTo(a.x, a.y + offset);
    g.quadraticCurveTo(dip.x, dip.y + (dip.y - (a.y + b.y) / 2) + offset, b.x, b.y + offset);
  };
  g.lineCap = "round";
  curve(width * 0.5);
  g.strokeStyle = colour;
  g.lineWidth = width;
  g.stroke();
  curve(width * 0.5);
  g.strokeStyle = "rgba(0,0,0,0.18)";
  g.lineWidth = width;
  g.stroke();
  curve(width * 1.05);
  g.strokeStyle = "rgba(0,0,0,0.35)";
  g.lineWidth = Math.max(1, width * 0.18);
  g.stroke();
  curve(0);
  g.strokeStyle = "rgba(0,0,0,0.3)";
  g.lineWidth = Math.max(1, width * 0.14);
  g.stroke();
}

/** Cylinder-like light and shadow over the garments, so flat photos read as rounded cloth. */
function shade(g: CanvasRenderingContext2D, body: BodyFrame, H: number) {
  g.save();
  g.globalCompositeOperation = "source-atop";
  const band = (x0: number, x1: number, y0: number, y1: number, strength: number) => {
    const grad = g.createLinearGradient(x0, 0, x1, 0);
    grad.addColorStop(0, `rgba(0,0,0,${strength})`);
    grad.addColorStop(0.3, "rgba(0,0,0,0)");
    grad.addColorStop(0.45, "rgba(255,255,255,0.07)");
    grad.addColorStop(0.7, "rgba(0,0,0,0)");
    grad.addColorStop(1, `rgba(0,0,0,${strength})`);
    g.fillStyle = grad;
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
  };
  const [sL, sR] = body.shoulder;
  const [hL, hR] = body.hip;
  const reach = Math.abs(sR.x - sL.x) * 0.75;
  const hipY = (hL.y + hR.y) / 2;
  band(Math.min(sL.x, hL.x) - reach, Math.max(sR.x, hR.x) + reach, 0, hipY + body.torso * 0.25, 0.32);
  for (const side of [0, 1] as const) {
    const hip = body.hip[side];
    const ankle = body.ankle[side];
    const half = Math.max(Math.abs(hR.x - hL.x) * 0.55, body.torso * 0.22);
    const cx = (hip.x + ankle.x) / 2;
    band(cx - half, cx + half, hipY + body.torso * 0.25, H, 0.28);
  }
  // A soft shadow under the collar and above the hem adds depth.
  const neckY = (sL.y + sR.y) / 2;
  const collar = g.createLinearGradient(0, neckY - body.torso * 0.1, 0, neckY + body.torso * 0.15);
  collar.addColorStop(0, "rgba(0,0,0,0.18)");
  collar.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = collar;
  g.fillRect(0, neckY - body.torso * 0.1, g.canvas.width, body.torso * 0.25);
  g.restore();
}

let layer: HTMLCanvasElement | null = null;

/**
 * Draws the outfit fitted to the body: each garment is warped piece by piece (torso, sleeves,
 * legs, one shoe per foot), shaded, and laid over the person with a soft contact shadow.
 */
export function drawOutfit(ctx: CanvasRenderingContext2D, W: number, H: number, landmarks: Landmark[], garments: RenderGarment[], opts: { plain?: boolean } = {}) {
  const body = bodyFrame(landmarks, W, H);
  layer ??= document.createElement("canvas");
  if (layer.width !== W || layer.height !== H) {
    layer.width = W;
    layer.height = H;
  }
  const g = layer.getContext("2d")!;
  g.clearRect(0, 0, W, H);
  const sorted = [...garments].sort((a, b) => ORDER.indexOf(a.slot) - ORDER.indexOf(b.slot));
  for (const gm of sorted) {
    g.save();
    // Photos without a cut-out keep their background; multiply hides a light backdrop.
    if (!gm.isCutout) g.globalCompositeOperation = "multiply";
    const pieces = templatePieces(gm.slot, gm.subcategory, gm.shape, body, gm.fit ?? 1);
    if (pieces) {
      // Sleeves and legs first, then the body and waistband over their joins.
      const rank = { sleeve: 0, leg: 0, body: 1, band: 2 } as const;
      for (const piece of [...pieces].sort((a, b) => rank[a.kind] - rank[b.kind])) drawPiece(g, gm.img, piece, gm.isCutout, opts.plain);
    } else {
      const tris = warpGarment({ slot: gm.slot, subcategory: gm.subcategory, shape: gm.shape, imgW: gm.img.naturalWidth, imgH: gm.img.naturalHeight, fit: gm.fit }, body);
      for (const t of tris) drawTriangle(g, gm.img, t);
    }
    g.restore();
  }
  shade(g, body, H);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.25)";
  ctx.shadowBlur = Math.max(4, W * 0.012);
  ctx.shadowOffsetY = Math.max(2, W * 0.004);
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}
