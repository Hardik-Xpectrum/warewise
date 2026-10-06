// Wardrobe gap detection. Pure rules, no AI, so it costs nothing and never hits a quota.
import { NEUTRAL_COLORS } from "@/modules/wardrobe/taxonomy";

export type GapItem = { category: string | null; subcategory: string | null; colors: string[]; formality: number | null };

export type Gap = {
  id: string;
  suggestion: string;
  reason: string;
  unlocksOutfits: number;
  query: string;
  links: { store: "Myntra" | "AJIO"; url: string }[];
};

function links(query: string): Gap["links"] {
  const slug = query.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return [
    { store: "Myntra", url: `https://www.myntra.com/${slug}` },
    { store: "AJIO", url: `https://www.ajio.com/search/?text=${encodeURIComponent(query)}` },
  ];
}

export function findGaps(items: GapItem[]): Gap[] {
  const of = (c: string) => items.filter((i) => i.category === c);
  const tops = of("top");
  const bottoms = of("bottom");
  const onePieces = of("one_piece");
  const shoes = of("shoes");
  const formal = (xs: GapItem[]) => xs.filter((i) => (i.formality ?? 0) >= 4);
  const neutral = (xs: GapItem[]) => xs.filter((i) => i.colors[0] && NEUTRAL_COLORS.has(i.colors[0]));
  const has = (xs: GapItem[], word: string) => xs.some((i) => (i.subcategory ?? "").includes(word));

  const gaps: Omit<Gap, "links">[] = [];
  const add = (g: Omit<Gap, "links">) => {
    if (g.unlocksOutfits > 0) gaps.push(g);
  };

  if (!shoes.length) {
    add({ id: "white-sneakers", suggestion: "White sneakers", reason: "You have no footwear saved; white sneakers go with almost every casual outfit.", unlocksOutfits: tops.length * bottoms.length + onePieces.length, query: "white sneakers" });
  }
  if (!neutral(bottoms).length) {
    add({ id: "neutral-bottom", suggestion: "Dark blue jeans or beige chinos", reason: "A neutral bottom pairs with every top you own.", unlocksOutfits: tops.length, query: "dark blue straight jeans" });
  }
  if (!neutral(tops).length) {
    add({ id: "neutral-top", suggestion: "White or grey plain t-shirt", reason: "A neutral top pairs with every bottom you own.", unlocksOutfits: bottoms.length, query: "plain white t-shirt" });
  }
  if (!formal(tops).length) {
    add({ id: "formal-top", suggestion: "White formal shirt", reason: "Nothing office- or interview-ready on top yet.", unlocksOutfits: Math.max(formal(bottoms).length, 1), query: "white formal shirt" });
  }
  if (!formal(bottoms).length && !formal(onePieces).length) {
    add({ id: "formal-bottom", suggestion: "Charcoal formal trousers", reason: "No formal bottoms for office days or interviews.", unlocksOutfits: Math.max(formal(tops).length, 1), query: "charcoal formal trousers" });
  }
  if (!formal(shoes).length && (formal(tops).length || formal(bottoms).length)) {
    add({ id: "formal-shoes", suggestion: "Black or brown formal shoes", reason: "Your formal outfits have no matching shoes.", unlocksOutfits: formal(tops).length * Math.max(formal(bottoms).length, 1), query: "formal shoes" });
  }
  if (!has(tops, "kurta") && !onePieces.some((i) => (i.formality ?? 0) >= 4)) {
    add({ id: "festive", suggestion: "A solid-colour kurta", reason: "Nothing for festivals, pujas or family functions.", unlocksOutfits: Math.max(bottoms.length, 1), query: "solid cotton kurta" });
  }
  if (!of("outer").length && tops.length) {
    add({ id: "layer", suggestion: "A light navy jacket or blazer", reason: "No layer for cool evenings, winter or air-conditioned offices.", unlocksOutfits: tops.length, query: "navy blazer" });
  }

  return gaps.sort((a, b) => b.unlocksOutfits - a.unlocksOutfits).slice(0, 5).map((g) => ({ ...g, links: links(g.query) }));
}
