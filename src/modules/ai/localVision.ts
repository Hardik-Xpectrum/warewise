// The keyless, on-device tagger's pure parts: what each garment label means, how a garment's
// colours are named from its pixels, and which body-parsing labels make up its cut-out. The
// models that feed these live in localModels.ts.
import { COLORS, COLOR_SWATCH, PATTERNS, type Category } from "@/modules/wardrobe/taxonomy";

export type GarmentDef = { label: string; category: Category; subcategory: string; formality: number; fabric?: string; seasons?: string[] };

// What CLIP chooses between. Labels read naturally in "a photo of {label}" and cover everyday
// Indian and western wardrobes; each maps to the tags the rest of the app uses.
export const GARMENTS: GarmentDef[] = [
  { label: "a t-shirt", category: "top", subcategory: "t-shirt", formality: 2, fabric: "cotton" },
  { label: "a graphic print t-shirt", category: "top", subcategory: "graphic t-shirt", formality: 1, fabric: "cotton" },
  { label: "a polo shirt", category: "top", subcategory: "polo shirt", formality: 2, fabric: "cotton" },
  { label: "a shirt with a collar and buttons", category: "top", subcategory: "shirt", formality: 3, fabric: "cotton" },
  { label: "a long Indian kurta tunic", category: "top", subcategory: "kurta", formality: 3, fabric: "cotton" },
  { label: "a sweater", category: "top", subcategory: "sweater", formality: 2, fabric: "wool", seasons: ["winter"] },
  { label: "a hoodie", category: "top", subcategory: "hoodie", formality: 1, fabric: "cotton", seasons: ["winter"] },
  { label: "a sweatshirt", category: "top", subcategory: "sweatshirt", formality: 1, fabric: "cotton", seasons: ["winter"] },
  { label: "a tank top", category: "top", subcategory: "tank top", formality: 1, fabric: "cotton", seasons: ["summer"] },
  { label: "a women's blouse with frills", category: "top", subcategory: "blouse", formality: 3 },
  { label: "a crop top", category: "top", subcategory: "crop top", formality: 2 },
  { label: "a pair of jeans", category: "bottom", subcategory: "jeans", formality: 2, fabric: "denim" },
  { label: "a pair of chinos", category: "bottom", subcategory: "chinos", formality: 3, fabric: "cotton" },
  { label: "formal trousers", category: "bottom", subcategory: "trousers", formality: 4 },
  { label: "a pair of shorts", category: "bottom", subcategory: "shorts", formality: 1, seasons: ["summer"] },
  { label: "track pants", category: "bottom", subcategory: "track pants", formality: 1 },
  { label: "a skirt", category: "bottom", subcategory: "skirt", formality: 2 },
  { label: "a dress", category: "one_piece", subcategory: "dress", formality: 3 },
  { label: "a saree", category: "one_piece", subcategory: "saree", formality: 4, seasons: ["all"] },
  { label: "a lehenga", category: "one_piece", subcategory: "lehenga", formality: 5 },
  { label: "a jumpsuit", category: "one_piece", subcategory: "jumpsuit", formality: 2 },
  { label: "a tailored suit blazer", category: "outer", subcategory: "blazer", formality: 4 },
  { label: "a jacket", category: "outer", subcategory: "jacket", formality: 2 },
  { label: "a denim jacket", category: "outer", subcategory: "denim jacket", formality: 2, fabric: "denim" },
  { label: "a leather jacket", category: "outer", subcategory: "leather jacket", formality: 2, fabric: "leather" },
  { label: "a winter coat", category: "outer", subcategory: "coat", formality: 3, fabric: "wool", seasons: ["winter"] },
  { label: "a sleeveless Nehru jacket vest", category: "outer", subcategory: "nehru jacket", formality: 4 },
  { label: "a pair of sneakers", category: "shoes", subcategory: "sneakers", formality: 2 },
  { label: "a pair of sports running shoes", category: "shoes", subcategory: "sports shoes", formality: 1 },
  { label: "a pair of formal leather shoes", category: "shoes", subcategory: "formal shoes", formality: 4, fabric: "leather" },
  { label: "a pair of loafers", category: "shoes", subcategory: "loafers", formality: 3, fabric: "leather" },
  { label: "a pair of sandals", category: "shoes", subcategory: "sandals", formality: 1, seasons: ["summer"] },
  { label: "a pair of high heels", category: "shoes", subcategory: "heels", formality: 4 },
  { label: "a pair of boots", category: "shoes", subcategory: "boots", formality: 3, seasons: ["winter", "monsoon"] },
  { label: "a pair of sunglasses", category: "accessory", subcategory: "sunglasses", formality: 2 },
  { label: "a handbag", category: "accessory", subcategory: "handbag", formality: 3 },
  { label: "a wrist watch", category: "accessory", subcategory: "watch", formality: 3 },
  { label: "a belt", category: "accessory", subcategory: "belt", formality: 3, fabric: "leather" },
  { label: "a cap", category: "accessory", subcategory: "cap", formality: 1 },
  { label: "a scarf", category: "accessory", subcategory: "scarf", formality: 2 },
];

// Photos that aren't clothing at all; if one of these wins, the upload is refused.
export const NOT_CLOTHING = ["food on a plate", "a landscape", "an animal", "a screenshot of text", "a room interior with furniture"];

// How each pattern is described to CLIP, with the garment's name filled in ("a shirt with stripes").
export const PATTERN_PROMPTS: Record<Exclude<(typeof PATTERNS)[number], "other">, string> = {
  solid: "a plain {} in one solid colour with no pattern",
  striped: "a {} with stripes",
  checked: "a {} with a checked plaid pattern",
  floral: "a {} with a floral print",
  printed: "a {} with a large graphic print or logo",
  embroidered: "a {} with embroidery",
  textured: "a chunky knitted {}",
};

/**
 * Picks the pattern from CLIP scores (aligned with PATTERN_PROMPTS' keys). CLIP likes to see a
 * pattern in plain clothes, so a pattern has to clearly beat "solid" to be chosen.
 */
export function pickPattern(scores: number[]): (typeof PATTERNS)[number] {
  const keys = Object.keys(PATTERN_PROMPTS) as (keyof typeof PATTERN_PROMPTS)[];
  const solid = scores[keys.indexOf("solid")];
  let best = keys.indexOf("solid");
  // Embroidery is the one CLIP over-reads most (any seam or button), so it needs a stronger lead.
  const lead = (k: string) => (k === "embroidered" ? 3 : 1.6);
  for (let i = 0; i < keys.length; i++) if (keys[i] !== "solid" && scores[i] > solid * lead(keys[i]) && scores[i] > scores[best]) best = i;
  return keys[best];
}

/** Picks the best garment from CLIP scores (aligned with GARMENTS then NOT_CLOTHING). */
export function pickGarment(scores: number[]): { garment: GarmentDef | null; confidence: number } {
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  if (best >= GARMENTS.length) return { garment: null, confidence: scores[best] };
  // Merge a label's share with its category siblings for a steadier confidence.
  const cat = GARMENTS[best].category;
  const catShare = GARMENTS.reduce((s, g, i) => (g.category === cat ? s + scores[i] : s), 0);
  return { garment: GARMENTS[best], confidence: Math.round(Math.min(1, catShare) * 100) / 100 };
}

// sRGB → CIELAB, for colour distances that match what people see.
function toLab([r, g, b]: [number, number, number]): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
// "Silver" and "gold" are for metallic pieces; plain fabric in those tones reads as grey or mustard.
const PALETTE = COLORS.filter((c) => c !== "multi" && c !== "silver" && c !== "gold").map((name) => ({ name, lab: toLab(hex(COLOR_SWATCH[name])) }));

export function nearestColor(rgb: [number, number, number]): string {
  const lab = toLab(rgb);
  let best = PALETTE[0];
  let bestD = Infinity;
  for (const p of PALETTE) {
    const d = (lab[0] - p.lab[0]) ** 2 + (lab[1] - p.lab[1]) ** 2 + (lab[2] - p.lab[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best.name;
}

/**
 * Names a garment's colours from its RGBA pixels (only opaque ones count): each pixel votes for
 * its nearest palette colour; colours with at least `minShare` of the vote are kept, biggest first.
 */
export function namedColors(rgba: Uint8Array, minShare = 0.12, stride = 3): string[] {
  const votes = new Map<string, number>();
  let total = 0;
  const cache = new Map<number, string>();
  for (let i = 0; i < rgba.length; i += 4 * stride) {
    if (rgba[i + 3] < 200) continue;
    // Quantise to 32 levels per channel so the palette lookup is cached.
    const key = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
    let name = cache.get(key);
    if (!name) {
      name = nearestColor([rgba[i], rgba[i + 1], rgba[i + 2]]);
      cache.set(key, name);
    }
    votes.set(name, (votes.get(name) ?? 0) + 1);
    total++;
  }
  if (!total) return [];
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const kept = ranked.filter(([, n]) => n / total >= minShare).map(([c]) => c);
  return (kept.length ? kept : [ranked[0][0]]).slice(0, 3);
}

// Body-parsing labels (segformer_b2_clothes) that belong to each category's garment.
const PERSON = ["Hair", "Face", "Left-arm", "Right-arm", "Left-leg", "Right-leg"];
const CLOTHING = ["Hat", "Upper-clothes", "Skirt", "Pants", "Dress", "Belt", "Left-shoe", "Right-shoe", "Bag", "Scarf", "Sunglasses"];
const FOR_CATEGORY: Record<Category, string[]> = {
  top: ["Upper-clothes", "Dress"],
  outer: ["Upper-clothes", "Dress"],
  bottom: ["Pants", "Skirt"],
  one_piece: ["Dress", "Upper-clothes", "Skirt", "Pants"],
  shoes: ["Left-shoe", "Right-shoe"],
  accessory: ["Hat", "Bag", "Sunglasses", "Belt", "Scarf"],
};

/**
 * Which parsing labels make the cut-out. When someone is wearing the garment, only the parts for
 * its category (a kurta's upper-clothes, not the trousers under it). On a product photo there's
 * no body to separate from, and the parser's labels are shakier, so all clothing counts.
 */
export function cutoutLabels(areaByLabel: Record<string, number>, category: Category): string[] {
  const person = PERSON.reduce((s, l) => s + (areaByLabel[l] ?? 0), 0);
  return person > 0.01 ? FOR_CATEGORY[category] : CLOTHING;
}
