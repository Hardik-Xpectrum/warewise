// Simple flat illustrations of garments, drawn as SVG, for the sample wardrobe. They have transparent
// backgrounds, so they also work as try-on cut-outs.

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v + amount * 255)));
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => c(v).toString(16).padStart(2, "0")).join("")}`;
}

const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;

export type Shape = "tshirt" | "shirt" | "kurta" | "trousers" | "jeans" | "dress" | "blazer" | "sneakers" | "loafers";

export function garmentSvg(shape: Shape, color: string): string {
  const dark = shade(color, -0.18);
  const light = shade(color, 0.12);
  const line = `stroke="${dark}" stroke-width="4" stroke-linejoin="round"`;
  switch (shape) {
    case "tshirt":
      return svg(400, 480, `
        <path d="M140 30 L260 30 Q262 50 282 56 L362 96 L332 170 L292 150 L292 460 L108 460 L108 150 L68 170 L38 96 L118 56 Q138 50 140 30 Z" fill="${color}" ${line}/>
        <path d="M150 32 Q200 84 250 32" fill="none" ${line}/>`);
    case "shirt":
      return svg(400, 500, `
        <path d="M140 30 L260 30 L352 88 L384 336 L344 342 L302 170 L302 480 L98 480 L98 170 L56 342 L16 336 L48 88 Z" fill="${color}" ${line}/>
        <path d="M150 30 L200 78 L250 30 L262 58 L200 100 L138 58 Z" fill="${light}" ${line}/>
        <line x1="200" y1="100" x2="200" y2="478" ${line}/>
        ${[150, 220, 290, 360, 430].map((y) => `<circle cx="212" cy="${y}" r="5" fill="${dark}"/>`).join("")}`);
    case "kurta":
      return svg(400, 560, `
        <path d="M150 30 L250 30 L340 80 L372 300 L336 306 L300 160 L306 540 L236 540 L230 470 L170 470 L164 540 L94 540 L100 160 L64 306 L28 300 L60 80 Z" fill="${color}" ${line}/>
        <rect x="170" y="22" width="60" height="22" rx="6" fill="${dark}"/>
        <line x1="200" y1="44" x2="200" y2="200" ${line}/>
        <path d="M130 120 Q200 140 270 120" fill="none" stroke="${light}" stroke-width="6"/>`);
    case "trousers":
    case "jeans":
      return svg(360, 520, `
        <path d="M80 20 L280 20 L304 500 L206 500 L180 130 L154 500 L56 500 Z" fill="${color}" ${line}/>
        <rect x="80" y="20" width="200" height="26" fill="${dark}"/>
        ${shape === "jeans" ? `<path d="M110 50 Q120 110 170 118 M250 50 Q240 110 190 118" fill="none" stroke="${light}" stroke-width="4" stroke-dasharray="8 6"/>` : `<line x1="118" y1="50" x2="104" y2="496" stroke="${light}" stroke-width="3"/><line x1="242" y1="50" x2="256" y2="496" stroke="${light}" stroke-width="3"/>`}`);
    case "dress":
      return svg(400, 560, `
        <path d="M150 30 L168 30 L176 70 L224 70 L232 30 L250 30 L266 70 L258 210 L352 540 L48 540 L142 210 L134 70 Z" fill="${color}" ${line}/>
        <path d="M142 210 Q200 230 258 210" fill="none" stroke="${dark}" stroke-width="8"/>`);
    case "blazer":
      return svg(400, 500, `
        <path d="M140 30 L260 30 L352 88 L384 360 L344 366 L304 170 L304 480 L96 480 L96 170 L56 366 L16 360 L48 88 Z" fill="${color}" ${line}/>
        <path d="M160 30 L200 210 L240 30 Z" fill="#f2efe9"/>
        <path d="M140 30 L200 240 L150 150 L120 90 Z M260 30 L200 240 L250 150 L280 90 Z" fill="${dark}"/>
        <circle cx="200" cy="300" r="7" fill="${light}"/><circle cx="200" cy="350" r="7" fill="${light}"/>
        <path d="M120 330 L170 330" stroke="${dark}" stroke-width="5"/>`);
    case "sneakers":
    case "loafers": {
      const sole = shape === "sneakers" ? "#f7f7f5" : shade(color, -0.3);
      const shoe = (dx: number) => `
        <path d="M${20 + dx} 120 Q${18 + dx} 80 ${60 + dx} 76 L${110 + dx} 62 Q${140 + dx} 52 ${160 + dx} 80 L${182 + dx} 112 Q${190 + dx} 138 ${164 + dx} 142 L${30 + dx} 142 Q${20 + dx} 138 ${20 + dx} 120 Z" fill="${color}" ${line}/>
        <rect x="${18 + dx}" y="138" width="170" height="16" rx="7" fill="${sole}" ${line}/>
        ${shape === "sneakers" ? `<path d="M${95 + dx} 72 L${125 + dx} 92 M${105 + dx} 66 L${135 + dx} 86" stroke="${dark}" stroke-width="4"/>` : `<path d="M${90 + dx} 80 Q${125 + dx} 72 ${150 + dx} 90" fill="none" stroke="${light}" stroke-width="5"/>`}`;
      return svg(400, 170, shoe(0) + shoe(200));
    }
  }
}

export type SampleItem = {
  key: string;
  shape: Shape;
  hex: string;
  category: "top" | "bottom" | "one_piece" | "outer" | "shoes";
  subcategory: string;
  colors: string[];
  pattern: string;
  seasons: string[];
  fabric: string;
  formality: number;
  fit: string;
  price_inr: number;
};

export const SAMPLE_ITEMS: SampleItem[] = [
  { key: "white-tee", shape: "tshirt", hex: "#f4f4f1", category: "top", subcategory: "t-shirt", colors: ["white"], pattern: "solid", seasons: ["all"], fabric: "cotton", formality: 2, fit: "regular", price_inr: 499 },
  { key: "black-tee", shape: "tshirt", hex: "#262626", category: "top", subcategory: "t-shirt", colors: ["black"], pattern: "solid", seasons: ["all"], fabric: "cotton", formality: 2, fit: "regular", price_inr: 599 },
  { key: "navy-shirt", shape: "shirt", hex: "#1f3a68", category: "top", subcategory: "formal shirt", colors: ["navy"], pattern: "solid", seasons: ["all"], fabric: "cotton", formality: 4, fit: "slim", price_inr: 1499 },
  { key: "blue-shirt", shape: "shirt", hex: "#8fb3dc", category: "top", subcategory: "oxford shirt", colors: ["light-blue"], pattern: "solid", seasons: ["summer", "monsoon"], fabric: "cotton", formality: 3, fit: "regular", price_inr: 1299 },
  { key: "maroon-kurta", shape: "kurta", hex: "#7a1f2e", category: "top", subcategory: "kurta", colors: ["maroon"], pattern: "solid", seasons: ["all"], fabric: "cotton silk", formality: 4, fit: "regular", price_inr: 1999 },
  { key: "blue-jeans", shape: "jeans", hex: "#3d5a86", category: "bottom", subcategory: "jeans", colors: ["blue"], pattern: "solid", seasons: ["all"], fabric: "denim", formality: 2, fit: "regular", price_inr: 1799 },
  { key: "beige-chinos", shape: "trousers", hex: "#cdb78f", category: "bottom", subcategory: "chinos", colors: ["beige"], pattern: "solid", seasons: ["all"], fabric: "cotton", formality: 3, fit: "slim", price_inr: 1599 },
  { key: "grey-trousers", shape: "trousers", hex: "#4a4d52", category: "bottom", subcategory: "formal trousers", colors: ["grey"], pattern: "solid", seasons: ["all"], fabric: "poly-viscose", formality: 5, fit: "slim", price_inr: 2199 },
  { key: "olive-dress", shape: "dress", hex: "#6b7340", category: "one_piece", subcategory: "midi dress", colors: ["olive"], pattern: "solid", seasons: ["summer"], fabric: "linen", formality: 3, fit: "regular", price_inr: 2499 },
  { key: "navy-blazer", shape: "blazer", hex: "#22304f", category: "outer", subcategory: "blazer", colors: ["navy"], pattern: "solid", seasons: ["winter", "all"], fabric: "wool blend", formality: 5, fit: "slim", price_inr: 4999 },
  { key: "white-sneakers", shape: "sneakers", hex: "#f2f2ee", category: "shoes", subcategory: "sneakers", colors: ["white"], pattern: "solid", seasons: ["all"], fabric: "leather", formality: 2, fit: "regular", price_inr: 2999 },
  { key: "brown-loafers", shape: "loafers", hex: "#6b4226", category: "shoes", subcategory: "loafers", colors: ["brown"], pattern: "solid", seasons: ["all"], fabric: "leather", formality: 4, fit: "regular", price_inr: 3499 },
];

export const SAMPLE_OUTFITS = [
  { name: "Weekend casual", occasion: "casual", keys: ["white-tee", "blue-jeans", "white-sneakers"] },
  { name: "Office ready", occasion: "office", keys: ["navy-shirt", "grey-trousers", "navy-blazer", "brown-loafers"] },
  { name: "Festive evening", occasion: "festive", keys: ["maroon-kurta", "beige-chinos", "brown-loafers"] },
];
