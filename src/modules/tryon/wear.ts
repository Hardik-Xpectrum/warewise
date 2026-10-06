// What happens when you tap a piece in Try-on or the fitting room. Pure and unit-tested.
//
// People expect a new top to replace what they had on, not pile up underneath. Layering is
// explicit: a real layer (jacket, blazer, coat…) goes over the current top; a new top clears the
// layer; a dress replaces the top and bottom.

export type Slot = "top" | "outer" | "bottom" | "one_piece" | "shoes";
export type Wearing = Partial<Record<Slot, string>>;
export type WearItem = { id: string; category: string | null; subcategory: string | null };

const REAL_LAYER = /blazer|jacket|coat|cardigan|shrug|waistcoat|vest|overshirt|hoodie|sweater/;

/** Where a piece goes. Something filed under layers that isn't really one (a shirt) counts as a top. */
export function slotFor(item: WearItem): Slot | null {
  const c = item.category as Slot | null;
  if (!c || !["top", "outer", "bottom", "one_piece", "shoes"].includes(c)) return null;
  if (c === "outer" && item.subcategory && !REAL_LAYER.test(item.subcategory)) return "top";
  return c;
}

/** Puts `item` on (or takes it off if it's already on). */
export function wear(current: Wearing, item: WearItem): Wearing {
  const slot = slotFor(item);
  if (!slot) return current;
  const worn = (Object.keys(current) as Slot[]).find((s) => current[s] === item.id);
  if (worn) {
    const next = { ...current };
    delete next[worn];
    return next;
  }
  const next: Wearing = { ...current, [slot]: item.id };
  if (slot === "top") {
    delete next.outer; // a new top resets the upper outfit; add a layer again after
    delete next.one_piece;
  }
  if (slot === "bottom") delete next.one_piece;
  if (slot === "one_piece") {
    delete next.top;
    delete next.bottom;
  }
  return next;
}

/** Takes one piece off. */
export function takeOff(current: Wearing, slot: Slot): Wearing {
  const next = { ...current };
  delete next[slot];
  return next;
}
