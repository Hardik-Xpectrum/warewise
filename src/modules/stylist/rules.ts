// The stylist's hard rules and rule-based fallback. Pure functions, so they are unit-tested and
// keep working when every AI model is unavailable.
import { NEUTRAL_COLORS, type Category } from "@/modules/wardrobe/taxonomy";
import { harmonyScore } from "./harmony";
import type { Weather } from "./weather";

export const OCCASIONS = {
  office: { label: "Office", min: 3, max: 5 },
  interview: { label: "Interview", min: 4, max: 5 },
  wedding: { label: "Wedding", min: 4, max: 5 },
  festive: { label: "Festival / puja", min: 3, max: 5 },
  date: { label: "Date", min: 2, max: 4 },
  party: { label: "Party", min: 2, max: 4 },
  casual: { label: "Casual outing", min: 1, max: 3 },
  travel: { label: "Travel", min: 1, max: 3 },
  gym: { label: "Gym / sport", min: 1, max: 2 },
  other: { label: "Something else", min: 1, max: 5 },
} as const;
export type Occasion = keyof typeof OCCASIONS;

export type Candidate = {
  id: string;
  category: Category;
  subcategory: string | null;
  colors: string[];
  pattern: string | null;
  seasons: string[];
  formality: number | null;
  fabric: string | null;
  lastWornDaysAgo: number | null;
};

export type OutfitPick = { items: { id: string; slot: Category }[]; why: string };

const HEAVY_FABRICS = ["wool", "fleece", "velvet", "corduroy", "leather", "tweed"];
const RECENT_DAYS = 3;

export type Climate = { band: "hot" | "warm" | "mild" | "cold"; rainy: boolean; needsLayer: boolean };

export function climateOf(weather: Weather | null, month = new Date().getMonth()): Climate {
  if (!weather) {
    // No forecast: a rough Indian-season default from the month.
    const band = month >= 3 && month <= 5 ? "hot" : month >= 10 || month <= 1 ? "mild" : "warm";
    return { band, rainy: month >= 5 && month <= 8, needsLayer: false };
  }
  const t = weather.tempMaxC;
  const band = t >= 32 ? "hot" : t >= 25 ? "warm" : t >= 17 ? "mild" : "cold";
  return { band, rainy: weather.rainChancePct >= 50, needsLayer: weather.tempMinC < 16 };
}

function seasonFits(item: Candidate, climate: Climate): boolean {
  if (!item.seasons.length || item.seasons.includes("all")) return true;
  const ok = new Set<string>();
  if (climate.band === "hot" || climate.band === "warm") ok.add("summer");
  if (climate.band === "mild") ["summer", "winter"].forEach((s) => ok.add(s));
  if (climate.band === "cold") ok.add("winter");
  if (climate.rainy) ok.add("monsoon");
  return item.seasons.some((s) => ok.has(s));
}

function formalityFits(item: Candidate, occasion: Occasion): boolean {
  if (item.formality === null) return true;
  const { min, max } = OCCASIONS[occasion];
  // Shoes and accessories get one level of slack; a smart watch works almost anywhere.
  const slack = item.category === "shoes" || item.category === "accessory" ? 1 : 0;
  return item.formality >= min - slack && item.formality <= max + slack;
}

/** Hard rules: the AI only ever sees items that pass these. */
export function filterCandidates(items: Candidate[], occasion: Occasion, climate: Climate): Candidate[] {
  return items.filter((item) => {
    if (item.lastWornDaysAgo !== null && item.lastWornDaysAgo < RECENT_DAYS && item.category !== "shoes") return false;
    if (!formalityFits(item, occasion)) return false;
    if (!seasonFits(item, climate)) return false;
    if (climate.band === "hot" && item.fabric && HEAVY_FABRICS.includes(item.fabric) && item.category !== "shoes") return false;
    if (item.category === "outer" && climate.band === "hot") return false;
    return true;
  });
}

function pieceScore(item: Candidate, occasion: Occasion): number {
  const { min, max } = OCCASIONS[occasion];
  const mid = (min + max) / 2;
  const formality = item.formality === null ? 0 : -Math.abs(item.formality - mid);
  const freshness = item.lastWornDaysAgo === null ? 1.5 : Math.min(item.lastWornDaysAgo / 7, 1.5);
  return formality + freshness;
}

function isNeutral(item: Candidate) {
  return item.colors.length > 0 && NEUTRAL_COLORS.has(item.colors[0]);
}

function isPatterned(item: Candidate) {
  return Boolean(item.pattern && item.pattern !== "solid" && item.pattern !== "textured");
}

/** How well two pieces go together: neutrals pair with anything; two patterns clash. */
export function pairScore(a: Candidate, b: Candidate): number {
  let score = 0;
  if (isNeutral(a) || isNeutral(b)) score += 2;
  else if (a.colors[0] && a.colors[0] === b.colors[0]) score -= 1; // head-to-toe same bold colour
  if (isPatterned(a) && isPatterned(b)) score -= 3;
  if (a.formality !== null && b.formality !== null) score -= Math.abs(a.formality - b.formality);
  return score;
}

function best<T>(xs: T[], score: (x: T) => number): T | undefined {
  let top: T | undefined;
  let topScore = -Infinity;
  for (const x of xs) {
    const s = score(x);
    if (s > topScore) {
      top = x;
      topScore = s;
    }
  }
  return top;
}

function describe(pieces: Candidate[], occasion: Occasion, climate: Climate): string {
  const names = pieces.map((p) => [p.colors[0], p.subcategory ?? p.category].filter(Boolean).join(" "));
  const weatherNote = climate.band === "hot" ? " and light enough for the heat" : climate.needsLayer ? " with a layer for the cool evening" : "";
  return `${names.join(" + ")}: right for ${OCCASIONS[occasion].label.toLowerCase()}${weatherNote}.`;
}

/** Rule-based outfits, used when the AI is unavailable or returns nothing valid. */
export function buildRuleOutfits(
  candidates: Candidate[],
  occasion: Occasion,
  climate: Climate,
  max = 3,
  accept: (pieces: Candidate[]) => boolean = () => true,
  bias: (pieces: Candidate[]) => number = () => 0,
): OutfitPick[] {
  const by = (c: Category) =>
    candidates.filter((x) => x.category === c).sort((a, b) => pieceScore(b, occasion) - pieceScore(a, occasion)).slice(0, 8);
  const tops = by("top");
  const bottoms = by("bottom");
  const onePieces = by("one_piece");
  const shoes = by("shoes");
  const outers = by("outer");

  type Base = { pieces: Candidate[]; score: number };
  const bases: Base[] = [];
  for (const t of tops) {
    for (const b of bottoms) {
      bases.push({ pieces: [t, b], score: pieceScore(t, occasion) + pieceScore(b, occasion) + pairScore(t, b) + harmonyScore([t, b]).score / 25 + bias([t, b]) });
    }
  }
  for (const o of onePieces) bases.push({ pieces: [o], score: 2 * pieceScore(o, occasion) + 1 + bias([o]) });
  bases.sort((a, b) => b.score - a.score);

  const used = new Set<string>();
  const outfits: OutfitPick[] = [];
  for (const base of bases) {
    if (outfits.length >= max) break;
    if (base.pieces.some((p) => used.has(p.id))) continue; // vary the main pieces across suggestions
    const pieces = [...base.pieces];
    const shoe = best(shoes, (s) => pieces.reduce((acc, p) => acc + pairScore(p, s), 0) + bias([...pieces, s]) * 0.5);
    if (shoe) pieces.push(shoe);
    if (climate.needsLayer || climate.band === "cold") {
      const outer = best(outers, (o) => pieces.reduce((acc, p) => acc + pairScore(p, o), 0));
      if (outer) pieces.push(outer);
    }
    if (!accept(pieces)) continue;
    base.pieces.forEach((p) => used.add(p.id));
    outfits.push({
      items: pieces.map((p) => ({ id: p.id, slot: p.category })),
      why: describe(pieces, occasion, climate),
    });
  }
  return outfits;
}

/** An AI outfit is accepted only if every id is a real candidate in a sensible slot. */
export function validOutfit(outfit: OutfitPick, byId: Map<string, Candidate>): boolean {
  if (!outfit.items.length) return false;
  const ids = new Set<string>();
  const slots: Category[] = [];
  for (const { id } of outfit.items) {
    const item = byId.get(id);
    if (!item || ids.has(id)) return false;
    ids.add(id);
    slots.push(item.category);
  }
  const count = (c: Category) => slots.filter((s) => s === c).length;
  const complete = (count("top") >= 1 && count("bottom") === 1) || count("one_piece") === 1;
  const noClash = count("one_piece") <= 1 && count("shoes") <= 1 && count("bottom") <= 1 && count("top") <= 2;
  return complete && noClash && !(count("one_piece") && count("bottom"));
}

/** Plain-language reason no outfit fits the occasion, e.g. "no top formal enough for office". */
export function explainGap(all: Candidate[], occasion: Occasion, climate: Climate): string {
  const fitting = filterCandidates(all, occasion, climate);
  const has = (c: Category, xs: Candidate[]) => xs.some((i) => i.category === c);
  const label = OCCASIONS[occasion].label.toLowerCase();
  const { min, max } = OCCASIONS[occasion];
  const why = (c: Category, noun: string) => {
    if (!has(c, all)) return `you have no ${noun} yet`;
    const tooCasual = all.filter((i) => i.category === c).every((i) => (i.formality ?? min) < min);
    const tooFormal = all.filter((i) => i.category === c).every((i) => (i.formality ?? max) > max);
    if (tooCasual) return `your ${noun} are too casual for ${label}`;
    if (tooFormal) return `your ${noun} are too formal for ${label}`;
    return `your ${noun} don't suit today's weather or were worn in the last 3 days`;
  };
  if (!has("one_piece", fitting)) {
    if (!has("top", fitting)) return why("top", "tops");
    if (!has("bottom", fitting)) return why("bottom", "bottoms");
  }
  return "nothing combines into a full outfit";
}

/** When nothing fits the occasion, the closest outfits: same weather rules, any formality. */
export function closestOutfits(all: Candidate[], occasion: Occasion, climate: Climate): OutfitPick[] {
  const relaxed = filterCandidates(all, "other", climate);
  return buildRuleOutfits(relaxed, occasion, climate).map((o) => ({ ...o, why: o.why.replace(": right for", ": closest match for") }));
}
