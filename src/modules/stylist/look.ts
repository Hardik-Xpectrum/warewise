// Outfit tools built on the harmony score: mood and colour filters, "Complete the look" around one
// chosen piece, and Shop Scan ("should I buy this?"). Pure functions, unit-tested, no AI needed.
import type { Category } from "@/modules/wardrobe/taxonomy";
import { colourKind, harmonyScore } from "./harmony";
import { filterCandidates, OCCASIONS, pairScore, type Candidate, type Climate, type Occasion, type OutfitPick } from "./rules";

export const MOODS = {
  any: "Any mood",
  calm: "Calm & easy",
  bold: "Bold & bright",
  minimal: "Minimal",
  playful: "Playful",
} as const;
export type Mood = keyof typeof MOODS;

const main = (c: Candidate) => c.colors[0];
const patterned = (c: Candidate) => Boolean(c.pattern && !["solid", "textured"].includes(c.pattern)) || main(c) === "multi";
const hues = (pieces: Candidate[]) => new Set(pieces.map(main).filter((c) => colourKind(c) === "colour"));

/** Does an outfit match the chosen mood and (optional) colour? */
export function lookFits(pieces: Candidate[], mood: Mood = "any", color?: string | null): boolean {
  if (color && !pieces.some((p) => p.colors.includes(color))) return false;
  const h = hues(pieces).size;
  const patterns = pieces.filter(patterned).length;
  switch (mood) {
    case "calm":
      return h <= 1 && patterns <= 1;
    case "minimal":
      return h === 0 && patterns === 0;
    case "bold":
      return h >= 1 || patterns >= 1;
    case "playful":
      return patterns >= 1 || h >= 2;
    default:
      return true;
  }
}

export function describeLook(pieces: Candidate[]): string {
  return pieces.map((p) => [main(p), p.subcategory ?? p.category].filter(Boolean).join(" ")).join(" + ");
}

type Slot = { category: Category; pick: Candidate };

/** Best piece of a category to go with `with`, by harmony and pairing rules. */
function bestWith(pool: Candidate[], category: Category, withPieces: Candidate[], exclude: Set<string>): Candidate | undefined {
  let top: Candidate | undefined;
  let topScore = -Infinity;
  for (const c of pool) {
    if (c.category !== category || exclude.has(c.id)) continue;
    const s = harmonyScore([...withPieces, c]).score + withPieces.reduce((acc, p) => acc + pairScore(p, c), 0) * 3;
    if (s > topScore) {
      top = c;
      topScore = s;
    }
  }
  return top;
}

/**
 * Outfits built around one chosen piece ("Complete the look"). The anchor is always included;
 * the rest come from pieces that suit the occasion and weather, ranked by colour harmony.
 */
export function completeTheLook(
  all: Candidate[],
  anchorId: string,
  occasion: Occasion,
  climate: Climate,
  max = 3,
  bias: (pieces: Candidate[]) => number = () => 0,
): OutfitPick[] {
  const anchor = all.find((c) => c.id === anchorId);
  if (!anchor) return [];
  const pool = filterCandidates(all, occasion, climate).filter((c) => c.id !== anchor.id);
  // Occasion rules can rule out everything; the chosen piece still deserves suggestions.
  const wide = pool.length >= 2 ? pool : all.filter((c) => c.id !== anchor.id);

  // The main piece(s) that complete the base outfit, varied across suggestions.
  const partners: Category[] =
    anchor.category === "top" ? ["bottom"] : anchor.category === "bottom" ? ["top"] : anchor.category === "one_piece" ? [] : ["top", "bottom"];
  const bases: Candidate[][] = [];
  if (!partners.length) bases.push([anchor]);
  else if (partners.length === 1) {
    for (const p of wide.filter((c) => c.category === partners[0])) bases.push([anchor, p]);
  } else {
    for (const t of wide.filter((c) => c.category === "top"))
      for (const b of wide.filter((c) => c.category === "bottom")) bases.push([anchor, t, b]);
    for (const o of wide.filter((c) => c.category === "one_piece")) bases.push([anchor, o]);
  }
  const rank = (p: Candidate[]) => harmonyScore(p).score + pairs(p) + bias(p) * 6;
  bases.sort((a, b) => rank(b) - rank(a));

  const used = new Set<string>();
  const out: OutfitPick[] = [];
  for (const base of bases) {
    if (out.length >= max) break;
    const others = base.filter((p) => p.id !== anchor.id);
    if (others.some((p) => used.has(p.id))) continue;
    const pieces = [...base];
    const extras: Slot[] = [];
    const want: Category[] = [];
    if (anchor.category !== "shoes") want.push("shoes");
    if ((climate.needsLayer || climate.band === "cold") && anchor.category !== "outer") want.push("outer");
    for (const category of want) {
      const pick = bestWith(wide, category, pieces, new Set(pieces.map((p) => p.id)));
      if (pick) extras.push({ category, pick });
    }
    extras.forEach((e) => pieces.push(e.pick));
    others.forEach((p) => used.add(p.id));
    const h = harmonyScore(pieces);
    out.push({
      items: pieces.map((p) => ({ id: p.id, slot: p.category })),
      why: `${describeLook(pieces)}: built around your ${anchor.subcategory ?? anchor.category} for ${OCCASIONS[occasion].label.toLowerCase()}. ${h.reasons[0] ?? ""}`.trim(),
    });
  }
  return out;
}

function pairs(pieces: Candidate[]) {
  let s = 0;
  for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) s += pairScore(pieces[i], pieces[j]) * 3;
  return s;
}

export type ScanInput = { category: Category; subcategory?: string | null; colors: string[]; pattern?: string | null; formality?: number | null };
export type ScanVerdict = {
  verdict: "GET IT" | "MAYBE" | "SKIP IT";
  newOutfits: number;
  bestMatches: { id: string; score: number }[];
  similarOwned: string[];
  reasons: string[];
};

/**
 * Shop Scan: would this piece earn its place? Counts the good outfits (harmony >= 70) it makes
 * with what you own, and flags near-copies you already have.
 */
export function shopScan(all: Candidate[], input: ScanInput): ScanVerdict {
  const item: Candidate = {
    id: "__scan__",
    category: input.category,
    subcategory: input.subcategory ?? null,
    colors: input.colors,
    pattern: input.pattern ?? "solid",
    seasons: ["all"],
    formality: input.formality ?? null,
    fabric: null,
    lastWornDaysAgo: null,
  };
  const of = (c: Category) => all.filter((x) => x.category === c);
  const combos: Candidate[][] = [];
  if (item.category === "top") of("bottom").forEach((b) => combos.push([item, b]));
  else if (item.category === "bottom") of("top").forEach((t) => combos.push([t, item]));
  else if (item.category === "one_piece") combos.push([item]);
  else {
    // Shoes, layers and accessories finish existing outfits.
    for (const t of of("top")) for (const b of of("bottom")) combos.push([t, b, item]);
    for (const o of of("one_piece")) combos.push([o, item]);
  }
  const scored = combos.map((pieces) => ({ pieces, score: harmonyScore(pieces).score - (formalityGap(pieces) >= 3 ? 20 : 0) }));
  const good = scored.filter((s) => s.score >= 70);
  const partnerScore = new Map<string, number>();
  for (const s of good)
    for (const p of s.pieces) if (p.id !== item.id) partnerScore.set(p.id, Math.max(partnerScore.get(p.id) ?? 0, s.score));
  const bestMatches = [...partnerScore.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id, score]) => ({ id, score }));

  const similarOwned = all
    .filter((x) => x.category === item.category && x.colors[0] === item.colors[0] && patterned(x) === patterned(item))
    .filter((x) => !item.subcategory || !x.subcategory || x.subcategory === item.subcategory)
    .map((x) => x.id);

  const reasons: string[] = [];
  const newOutfits = item.category === "one_piece" ? (good.length ? 1 : 0) : good.length;
  if (item.category === "one_piece") reasons.push(good.length ? "A complete outfit on its own" : "The colours are hard to style");
  else reasons.push(newOutfits ? `Makes ${newOutfits} good outfit${newOutfits === 1 ? "" : "s"} with what you own` : "Doesn't pair well with anything you own yet");
  if (similarOwned.length) reasons.push(`You already own ${similarOwned.length} very similar piece${similarOwned.length === 1 ? "" : "s"}`);
  if (item.category === "shoes" || item.category === "outer") {
    const current = of(item.category).length;
    if (!current) reasons.push(`Your first ${item.category === "shoes" ? "pair of shoes" : "layer"}: finishes every outfit`);
  }

  let verdict: ScanVerdict["verdict"];
  const firstOfKind = !of(item.category).length && item.category !== "accessory";
  if (similarOwned.length >= 1 && !firstOfKind) verdict = newOutfits >= 3 && similarOwned.length === 1 ? "MAYBE" : "SKIP IT";
  else if (newOutfits >= 3 || (firstOfKind && newOutfits >= 1)) verdict = "GET IT";
  else if (newOutfits >= 1) verdict = "MAYBE";
  else verdict = "SKIP IT";
  return { verdict, newOutfits, bestMatches, similarOwned, reasons };
}

function formalityGap(pieces: Candidate[]) {
  const f = pieces.map((p) => p.formality).filter((x): x is number => typeof x === "number");
  return f.length >= 2 ? Math.max(...f) - Math.min(...f) : 0;
}
