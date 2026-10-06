// Trip packing and week planning: pick an outfit per day that reuses as few pieces as possible,
// so the suitcase stays small, while not wearing the same top two days running. Pure, tested.
import { harmonyScore } from "./harmony";
import { buildRuleOutfits, filterCandidates, type Candidate, type Climate, type Occasion, type OutfitPick } from "./rules";

export type DayPlan = { day: number; occasion: Occasion; outfit: OutfitPick | null };
export type PackResult = { days: DayPlan[]; items: string[]; outfitsCount: number };

const mainIds = (o: OutfitPick) => o.items.filter((i) => i.slot !== "shoes" && i.slot !== "accessory").map((i) => i.id);

/**
 * Greedy capsule: for each day, from that day's candidate outfits, choose the one that adds the
 * fewest new pieces to the bag (ties go to better harmony), never repeating yesterday's main
 * pieces when there is any alternative.
 */
export function planDays(all: Candidate[], occasions: Occasion[], climate: Climate): PackResult {
  const byId = new Map(all.map((c) => [c.id, c]));
  const candidatesFor = new Map<Occasion, OutfitPick[]>();
  const options = (occasion: Occasion) => {
    let list = candidatesFor.get(occasion);
    if (!list) {
      // Plenty of options per occasion; the hard rules (weather, formality) still apply.
      list = buildRuleOutfits(filterCandidates(all, occasion, climate), occasion, climate, 12);
      candidatesFor.set(occasion, list);
    }
    return list;
  };
  const harmony = (o: OutfitPick) => harmonyScore(o.items.map((i) => byId.get(i.id)!).filter(Boolean)).score;

  const packed = new Set<string>();
  const days: DayPlan[] = [];
  let yesterday: string[] = [];
  occasions.forEach((occasion, day) => {
    const list = options(occasion);
    const fresh = list.filter((o) => !mainIds(o).some((id) => yesterday.includes(id)));
    const pool = fresh.length ? fresh : list;
    let best: OutfitPick | null = null;
    let bestCost = Infinity;
    for (const o of pool) {
      const added = o.items.filter((i) => !packed.has(i.id)).length;
      const cost = added * 100 - harmony(o); // fewer new pieces first, then colour harmony
      if (cost < bestCost) {
        best = o;
        bestCost = cost;
      }
    }
    if (best) {
      best.items.forEach((i) => packed.add(i.id));
      yesterday = mainIds(best);
    }
    days.push({ day, occasion, outfit: best });
  });
  return { days, items: [...packed], outfitsCount: days.filter((d) => d.outfit).length };
}
