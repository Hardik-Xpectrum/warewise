// Personal taste learned from what the user does: likes, dislikes, saves and what they actually
// wear. It nudges rankings (never overrides the occasion and weather rules) and gives the AI a
// one-line summary. Pure functions, unit-tested; no AI needed.
import { colourKind } from "./harmony";
import type { Candidate } from "./rules";

export type TasteEvent = { kind: "like" | "dislike" | "saved" | "worn"; itemIds: string[]; daysAgo: number };

export type Taste = {
  events: number;
  colours: Map<string, number>; // main colour -> preference, roughly -1..1
  pairs: Map<string, number>; // "beige|navy" -> preference for wearing the two together
  items: Map<string, number>; // item id -> preference
  patterned: number; // > 0 likes prints, < 0 prefers plain
  formality: number | null; // weighted average formality of liked or worn outfits
};

const WEIGHT: Record<TasteEvent["kind"], number> = { like: 1, saved: 1.5, worn: 1, dislike: -1.5 };
const HALF_LIFE_DAYS = 45; // older signals count for less: taste changes

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const isPatterned = (c: Candidate) => Boolean(c.pattern && !["solid", "textured"].includes(c.pattern)) || c.colors[0] === "multi";

export function learnTaste(events: TasteEvent[], byId: Map<string, Candidate>): Taste {
  const colours = new Map<string, number>();
  const pairs = new Map<string, number>();
  const items = new Map<string, number>();
  let patterned = 0, formSum = 0, formW = 0;
  const bump = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

  for (const e of events) {
    const pieces = e.itemIds.map((id) => byId.get(id)).filter((c): c is Candidate => Boolean(c));
    if (!pieces.length) continue;
    const w = WEIGHT[e.kind] * Math.pow(0.5, Math.max(0, e.daysAgo) / HALF_LIFE_DAYS);
    const mains = [...new Set(pieces.map((p) => p.colors[0]).filter(Boolean))];
    for (const c of mains) bump(colours, c, w);
    for (let i = 0; i < mains.length; i++) for (let j = i + 1; j < mains.length; j++) bump(pairs, pairKey(mains[i], mains[j]), w);
    for (const p of pieces) {
      bump(items, p.id, w);
      patterned += (isPatterned(p) ? 1 : -0.3) * w;
      if (p.formality !== null && w > 0) {
        formSum += p.formality * w;
        formW += w;
      }
    }
  }
  // Squash to about -1..1 so a long history can't swamp the occasion rules.
  const squash = (m: Map<string, number>) => {
    for (const [k, v] of m) m.set(k, Math.tanh(v / 3));
    return m;
  };
  return {
    events: events.length,
    colours: squash(colours),
    pairs: squash(pairs),
    items: squash(items),
    patterned: Math.tanh(patterned / 5),
    formality: formW ? formSum / formW : null,
  };
}

/** How much this user would like the outfit, about -3..3. Zero when there's no history. */
export function tasteScore(taste: Taste | null, pieces: Candidate[]): number {
  if (!taste || !taste.events) return 0;
  let s = 0;
  const mains = [...new Set(pieces.map((p) => p.colors[0]).filter(Boolean))];
  for (const c of mains) s += (taste.colours.get(c) ?? 0) * 0.6;
  for (let i = 0; i < mains.length; i++) for (let j = i + 1; j < mains.length; j++) s += (taste.pairs.get(pairKey(mains[i], mains[j])) ?? 0) * 0.8;
  for (const p of pieces) {
    s += (taste.items.get(p.id) ?? 0) * 0.5;
    if (isPatterned(p)) s += taste.patterned * 0.5;
  }
  return Math.max(-3, Math.min(3, s));
}

/** One line for the AI prompt and the UI, e.g. "likes navy and beige; prefers plain pieces". */
export function describeTaste(taste: Taste | null): string | null {
  if (!taste || taste.events < 2) return null;
  const top = (m: Map<string, number>, sign: 1 | -1) =>
    [...m.entries()].filter(([, v]) => v * sign > 0.2).sort((a, b) => (b[1] - a[1]) * sign).slice(0, 3).map(([k]) => k);
  const parts: string[] = [];
  const liked = top(taste.colours, 1).filter((c) => colourKind(c) !== "unknown");
  const disliked = top(taste.colours, -1);
  const pair = top(taste.pairs, 1)[0];
  if (liked.length) parts.push(`likes ${liked.join(", ")}`);
  if (pair) parts.push(`often pairs ${pair.replace("|", " with ")}`);
  if (disliked.length) parts.push(`tends to reject ${disliked.join(", ")}`);
  if (taste.patterned > 0.25) parts.push("enjoys prints and patterns");
  if (taste.patterned < -0.25) parts.push("prefers plain pieces");
  if (taste.formality !== null) parts.push(taste.formality >= 3.5 ? "dresses on the smarter side" : taste.formality <= 2 ? "dresses casually" : "mostly smart casual");
  return parts.length ? parts.join("; ") : null;
}

/** Items the user owns but hasn't worn for a while (or ever), best first: to bring them back. */
export function neglected(all: Candidate[], minDays = 30): Candidate[] {
  return all
    .filter((c) => ["top", "bottom", "one_piece", "outer"].includes(c.category))
    .filter((c) => c.lastWornDaysAgo === null || c.lastWornDaysAgo >= minDays)
    .sort((a, b) => (b.lastWornDaysAgo ?? 999) - (a.lastWornDaysAgo ?? 999));
}
