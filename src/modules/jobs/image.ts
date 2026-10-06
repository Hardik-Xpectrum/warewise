import "server-only";
import sharp, { type Metadata } from "sharp";
import { keyOutBackground } from "./cutout";
import type { Category } from "@/modules/wardrobe/taxonomy";
import { dHashFromPixels } from "./phash";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ACCEPTED_FORMATS = new Set(["jpeg", "png", "webp"]);
// 40 megapixels: any real phone photo, but a tiny file that decodes to gigabytes is refused.
const MAX_PIXELS = 40_000_000;

export class BadImageError extends Error {}

export type ProcessedImage = {
  clean: Buffer; // 1024 px max, WebP, no metadata (EXIF and GPS removed)
  thumb: Buffer; // 320 px max, WebP
  phash: string;
};

/** Validates by file contents (not name), strips metadata, and produces the two stored variants. */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  if (input.byteLength > MAX_UPLOAD_BYTES) throw new BadImageError("Photo is larger than 10 MB");

  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    throw new BadImageError("This file is not a readable image");
  }
  if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) throw new BadImageError("Use a JPEG, PNG or WebP photo");
  if ((meta.width ?? 0) > 8000 || (meta.height ?? 0) > 8000) throw new BadImageError("Photo dimensions are too large");

  // rotate() applies the EXIF orientation; sharp drops all metadata on output by default.
  const base = sharp(input, { limitInputPixels: MAX_PIXELS }).rotate();
  const [clean, thumb, pixels] = await Promise.all([
    base.clone().resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(),
    base.clone().resize({ width: 320, height: 320, fit: "inside", withoutEnlargement: true }).webp({ quality: 70 }).toBuffer(),
    base.clone().flatten({ background: "#ffffff" }).greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer(),
  ]);
  return { clean, thumb, phash: dHashFromPixels(pixels) };
}

/**
 * Transparent, tightly cropped garment cut-out for the try-on preview. The clothes parser (on this
 * machine) handles real photos, including someone wearing the piece; plain-background keying is
 * the fallback. Null when neither finds the garment cleanly.
 */
export async function makeCutout(clean: Buffer, category?: Category | null): Promise<Buffer | null> {
  // The clothes parser runs only where it's switched on (your machine): on a small serverless host
  // its 260 MB of models and native runtime don't fit, and keying is used instead.
  if (process.env.LOCAL_VISION === "1" && category && category !== "accessory") {
    try {
      const { parseCutout } = await import("@/modules/ai/localModels");
      const cut = await parseCutout(clean, category);
      if (cut) return cut;
    } catch {
      /* models unavailable here (e.g. a small serverless host): fall back to keying */
    }
  }
  const { data, info } = await sharp(clean).resize({ width: 640, height: 640, fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const keyed = keyOutBackground(data, info.width, info.height);
  if (!keyed) return null;
  return sharp(Buffer.from(keyed), { raw: { width: info.width, height: info.height, channels: 4 } })
    .trim({ threshold: 1 })
    .webp({ quality: 85, alphaQuality: 90 })
    .toBuffer();
}
