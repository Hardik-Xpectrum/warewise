// The item vocabulary shared by the tagger, filters, rules engine and UI.

export const CATEGORIES = ["top", "bottom", "one_piece", "outer", "shoes", "accessory"] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  top: "Tops",
  bottom: "Bottoms",
  one_piece: "Dresses & one-piece",
  outer: "Outerwear",
  shoes: "Footwear",
  accessory: "Accessories",
};

export const COLORS = [
  "black", "white", "grey", "navy", "blue", "light-blue", "beige", "cream", "brown", "tan",
  "olive", "green", "red", "maroon", "pink", "purple", "yellow", "mustard", "orange", "gold", "silver", "multi",
] as const;

export const NEUTRAL_COLORS = new Set(["black", "white", "grey", "navy", "beige", "cream", "brown", "tan", "olive"]);

export const PATTERNS = ["solid", "striped", "checked", "floral", "printed", "embroidered", "textured", "other"] as const;

// India-first seasons: most wardrobes split into summer, monsoon and winter wear.
export const SEASONS = ["summer", "monsoon", "winter", "all"] as const;

export const FITS = ["slim", "regular", "relaxed", "oversized", "other"] as const;

export const LIFECYCLES = ["active", "laundry", "lent", "archived"] as const;

export const FORMALITY_LABELS: Record<number, string> = {
  1: "Loungewear",
  2: "Casual",
  3: "Smart casual",
  4: "Business / festive",
  5: "Formal",
};

/** Swatch colours for filters and chips (approximate; "multi" is drawn as a gradient). */
export const COLOR_SWATCH: Record<(typeof COLORS)[number], string> = {
  black: "#1c1c1c", white: "#ffffff", grey: "#9a9a9a", navy: "#1f2a4d", blue: "#2f5fb3", "light-blue": "#a7c7e7",
  beige: "#d9c7a7", cream: "#f3ead3", brown: "#6b4226", tan: "#c49a6c", olive: "#6b6b2e", green: "#2e7d4f",
  red: "#c4122f", maroon: "#6d1a2a", pink: "#eaa0b4", purple: "#6c4a9e", yellow: "#f2d02b", mustard: "#c9a227",
  orange: "#e8772e", gold: "#c8a44d", silver: "#c0c0c0", multi: "conic-gradient(#c4122f, #f2d02b, #2e7d4f, #2f5fb3, #c4122f)",
};
