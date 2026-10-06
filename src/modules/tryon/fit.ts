// How a garment should sit on the user, from the user's sizes and the item's size label.
// Used by the try-on preview to draw roomier or tighter garments and to explain the fit.

export const TOP_SIZES = ["XS", "S", "M", "L", "XL", "XXL", "3XL"] as const;
export type TopSize = (typeof TOP_SIZES)[number];

export type UserSizes = { top_size?: TopSize; waist_in?: number | null; shoe_uk?: number | null };

type ParsedSize = { top?: number; waist?: number; shoe?: number };

/** Reads labels like "M", "xl", "32", "W32 L30", "UK 9", "9.5". */
export function parseSizeLabel(label: string | null | undefined, slot: string): ParsedSize {
  if (!label) return {};
  const clean = label.trim().toUpperCase();
  const top = TOP_SIZES.indexOf(clean.replace(/\s+/g, "") as TopSize);
  if (top >= 0) return { top };
  const num = Number(clean.match(/(\d+(\.\d+)?)/)?.[1]);
  if (!Number.isFinite(num)) return {};
  if (slot === "shoes") return { shoe: num };
  if (slot === "bottom" && num >= 22 && num <= 50) return { waist: num };
  // Chest sizes in inches (36, 38, 40...) map roughly onto letter sizes.
  if (num >= 32 && num <= 50) return { top: Math.max(0, Math.min(TOP_SIZES.length - 1, Math.round((num - 34) / 2))) };
  return {};
}

export type Fit = { scale: number; note: string | null };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Width multiplier for drawing, and a short note ("1 size big: relaxed fit"). */
export function fitFor(slot: string, sizeLabel: string | null | undefined, user: UserSizes | null | undefined): Fit {
  const item = parseSizeLabel(sizeLabel, slot);
  if (!user) return { scale: 1, note: null };

  if ((slot === "top" || slot === "outer" || slot === "one_piece") && item.top !== undefined && user.top_size) {
    const diff = item.top - TOP_SIZES.indexOf(user.top_size);
    const note = diff === 0 ? "Your size" : diff > 0 ? `${diff} size${diff > 1 ? "s" : ""} big: ${diff > 1 ? "oversized" : "relaxed"} fit` : `${-diff} size${diff < -1 ? "s" : ""} small: ${diff < -1 ? "too tight" : "snug"} fit`;
    return { scale: clamp(1 + diff * 0.08, 0.8, 1.35), note };
  }
  if (slot === "bottom" && item.waist !== undefined && user.waist_in) {
    const diff = item.waist - user.waist_in;
    const note = Math.abs(diff) < 1 ? "Your waist size" : diff > 0 ? `${diff}" bigger waist: loose, needs a belt` : `${-diff}" smaller waist: too tight`;
    return { scale: clamp(1 + diff * 0.025, 0.85, 1.3), note };
  }
  if (slot === "shoes" && item.shoe !== undefined && user.shoe_uk) {
    const diff = item.shoe - user.shoe_uk;
    const note = Math.abs(diff) < 0.5 ? "Your shoe size" : diff > 0 ? `${diff} size${diff > 1 ? "s" : ""} big` : `${-diff} size${diff < -1 ? "s" : ""} small`;
    return { scale: clamp(1 + diff * 0.04, 0.85, 1.2), note };
  }
  return { scale: 1, note: null };
}
