import "server-only";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import type { TaggerOutput } from "@/modules/wardrobe/schemas";
import type { Category } from "@/modules/wardrobe/taxonomy";
import { cutoutLabels, GARMENTS, namedColors, NOT_CLOTHING, PATTERN_PROMPTS, pickGarment, pickPattern } from "./localVision";

/**
 * On-device vision, free and keyless: CLIP (zero-shot classification) names the garment and its
 * pattern, and a clothes-parsing model (SegFormer trained on clothing) cuts it out. Both are open
 * models downloaded once from Hugging Face (~150 MB and ~110 MB) into MODEL_CACHE_DIR, then run
 * locally with ONNX Runtime; photos never leave the server.
 */
const CLIP_MODEL = "Xenova/clip-vit-base-patch32";
const PARSER_MODEL = "Xenova/segformer_b2_clothes";

type Transformers = typeof import("@huggingface/transformers");
type Classifier = (image: unknown, labels: string[], opts?: { hypothesis_template?: string }) => Promise<{ label: string; score: number }[]>;
type Segmenter = (image: unknown) => Promise<{ label: string; mask: { data: Uint8Array | Uint8ClampedArray; width: number; height: number } }[]>;

let lib: Promise<Transformers> | undefined;
let classifier: Promise<Classifier> | undefined;
let segmenter: Promise<Segmenter> | undefined;

async function transformers(): Promise<Transformers> {
  lib ??= import("@huggingface/transformers").then((t) => {
    t.env.cacheDir = process.env.MODEL_CACHE_DIR ?? path.join(/* turbopackIgnore: true */ process.cwd(), ".cache", "models");
    t.env.allowLocalModels = false;
    return t;
  });
  return lib;
}

function getClassifier(): Promise<Classifier> {
  classifier ??= transformers().then((t) => t.pipeline("zero-shot-image-classification", CLIP_MODEL, { dtype: "q8" }) as unknown as Classifier);
  return classifier;
}

function getSegmenter(): Promise<Segmenter> {
  segmenter ??= transformers().then((t) => t.pipeline("image-segmentation", PARSER_MODEL, { dtype: "fp32" }) as unknown as Segmenter);
  return segmenter;
}

async function rawImage(image: Buffer) {
  const t = await transformers();
  const { data, info } = await sharp(image).flatten({ background: "#ffffff" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return new t.RawImage(new Uint8ClampedArray(data), info.width, info.height, 3);
}

// Several phrasings, averaged: steadier than one, and covers photos of someone wearing the piece.
const TEMPLATES = ["a photo of {}", "a product photo of {}", "a photo of a person wearing {}"];

/** Scores in the order of `labels`, averaged over the phrasings. */
async function scoresFor(image: unknown, labels: string[], templates = TEMPLATES): Promise<number[]> {
  const total = labels.map(() => 0);
  for (const hypothesis_template of templates) {
    const out = await (await getClassifier())(image, labels, { hypothesis_template });
    const byLabel = new Map(out.map((o) => [o.label, o.score]));
    labels.forEach((l, i) => (total[i] += (byLabel.get(l) ?? 0) / templates.length));
  }
  return total;
}

/**
 * Cuts the garment out of a photo with the clothes parser: an RGBA WebP trimmed to the garment,
 * or null when the parser finds too little (the caller then falls back to the plain-background
 * keyer). Works on product photos and on photos of someone wearing the piece.
 */
export async function parseCutout(image: Buffer, category: Category): Promise<Buffer | null> {
  // The tagger cuts the garment out to read its colours; the media job then asks again for the
  // same photo, so the last few results are kept.
  const key = `${category}:${createHash("sha1").update(image).digest("hex")}`;
  if (!cutouts.has(key)) {
    cutouts.set(key, cutOut(image, category));
    if (cutouts.size > 8) cutouts.delete(cutouts.keys().next().value!);
  }
  return cutouts.get(key)!;
}
const cutouts = new Map<string, Promise<Buffer | null>>();

async function cutOut(image: Buffer, category: Category): Promise<Buffer | null> {
  const img = await rawImage(image);
  const parts = await (await getSegmenter())(img);
  if (!parts.length) return null;
  // Masks come back at the parser's own resolution; work at that size, then scale the colours to it.
  const W = parts[0].mask.width;
  const H = parts[0].mask.height;
  const area: Record<string, number> = {};
  for (const p of parts) {
    let n = 0;
    for (let i = 0; i < p.mask.data.length; i++) if (p.mask.data[i] > 127) n++;
    area[p.label] = n / (W * H);
  }
  const keep = new Set(cutoutLabels(area, category));
  const alpha = Buffer.alloc(W * H);
  let kept = 0;
  for (const p of parts) {
    if (!keep.has(p.label)) continue;
    for (let i = 0; i < W * H; i++) if (p.mask.data[i] > 127 && !alpha[i]) {
      alpha[i] = 255;
      kept++;
    }
  }
  if (kept / (W * H) < 0.02 || !solidEnough(alpha, W, H)) return null;
  // Pull the edge in a pixel or two (it carries some of the photo's backdrop, which shows as a
  // grey halo on the avatar), then soften it so the garment doesn't look stencilled.
  erode(alpha, W, H, Math.max(1, Math.round(Math.max(W, H) * 0.003)));
  const soft = await sharp(alpha, { raw: { width: W, height: H, channels: 1 } }).blur(0.8).extractChannel(0).raw().toBuffer();
  const rgb = await sharp(image).flatten({ background: "#ffffff" }).removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer();
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = soft[i];
  }
  return sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).trim({ threshold: 1 }).webp({ quality: 85, alphaQuality: 90 }).toBuffer();
}

/** Shrinks a 0/255 mask by `r` pixels (separable min filter), in place. */
function erode(mask: Buffer, W: number, H: number, r: number) {
  const tmp = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let v = 255;
      for (let k = -r; k <= r && v; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= W || !mask[y * W + xx]) v = 0;
      }
      tmp[y * W + x] = v;
    }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let v = 255;
      for (let k = -r; k <= r && v; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= H || !tmp[yy * W + x]) v = 0;
      }
      mask[y * W + x] = v;
    }
}

/**
 * A real garment fills a good part of its own bounding box; a parse that came out as scattered
 * scraps (close-ups, busy scenes) doesn't, and is better skipped than shown broken.
 */
function solidEnough(alpha: Buffer, W: number, H: number): boolean {
  let minX = W, minY = H, maxX = -1, maxY = -1, n = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (alpha[y * W + x]) {
        n++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  if (!n) return false;
  return n / ((maxX - minX + 1) * (maxY - minY + 1)) >= 0.35;
}

/**
 * Tags one garment photo without any API: CLIP picks the garment and pattern, the colours are
 * named from the cut-out's own pixels. Returns the same shape as the AI tagger.
 */
export async function localTag(image: Buffer): Promise<TaggerOutput> {
  const img = await rawImage(image);
  const labels = [...GARMENTS.map((g) => g.label), ...NOT_CLOTHING];
  const { garment, confidence } = pickGarment(await scoresFor(img, labels));
  if (!garment) {
    return { is_clothing: false, item_count: 1, category: "top", subcategory: null, colors: [], pattern: "other", seasons: ["all"], fabric: null, formality: 2, fit: "regular", brand: null, confidence };
  }
  // Shoes and accessories: the pattern rarely matters and CLIP guesses wildly, so they're plain.
  const pattern = garment.category === "shoes" || garment.category === "accessory" ? "solid" : pickPattern(await scoresFor(img, Object.values(PATTERN_PROMPTS).map((p) => p.replace("{}", garment.subcategory)), ["a photo of {}"]));

  // Colours from the garment itself, not the background: use the cut-out when there is one.
  const cut = await parseCutout(image, garment.category).catch(() => null);
  const { data } = await sharp(cut ?? image).ensureAlpha().resize(160, 160, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
  let colors = namedColors(new Uint8Array(data));
  if (!cut) colors = colors.filter((c) => c !== "white").concat(colors.includes("white") ? ["white"] : []).slice(0, 3); // a white backdrop shouldn't lead

  return {
    is_clothing: true,
    item_count: 1,
    category: garment.category,
    subcategory: garment.subcategory,
    colors,
    pattern,
    seasons: garment.seasons ?? ["all"],
    fabric: garment.fabric ?? null,
    formality: garment.formality,
    fit: "regular",
    brand: null,
    confidence,
  };
}
