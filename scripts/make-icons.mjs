// Builds every app icon from the logo paths in src/components/Logo.tsx: a black square with the
// white collar and red tie (the logo's dark-background version). Run: node scripts/make-icons.mjs
import { writeFileSync } from "node:fs";
import sharp from "sharp";

const COLLAR = ["M6 10L29 19L20 46Z", "M58 10L35 19L44 46Z"];
const TIE = ["M27.5 18H36.5L34.5 27H29.5Z", "M29.3 28.5H34.7L38.5 50L32 58L25.5 50Z"];
const BG = "#111111";
const RED = "#ff5a6e"; // the dark-mode heart red: reads on black

/** The mark centred on a square; `pad` is the fraction of the square left around it. */
const icon = ({ rx = 0, pad = 0.16 } = {}) => {
  const s = 64 * (1 - 2 * pad);
  const o = 64 * pad;
  const paths = [...COLLAR.map((d) => `<path d="${d}" fill="#ffffff"/>`), ...TIE.map((d) => `<path d="${d}" fill="${RED}"/>`)].join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="${rx}" fill="${BG}"/><g transform="translate(${o} ${o}) scale(${s / 64})">${paths}</g></svg>`;
};

// Browser tab: slightly rounded, small padding so the mark stays large at 16 px.
writeFileSync("src/app/icon.svg", icon({ rx: 12, pad: 0.1 }));
// Installed app (manifest): full-bleed square, extra padding for the OS mask.
writeFileSync("public/app-icon.svg", icon({ pad: 0.2 }));
await sharp(Buffer.from(icon({ pad: 0.2 }))).resize(192, 192).png().toFile("public/icon-192.png");
await sharp(Buffer.from(icon({ pad: 0.2 }))).resize(512, 512).png().toFile("public/icon-512.png");
// iPhone home screen (Next serves app/apple-icon.png as the apple-touch-icon).
await sharp(Buffer.from(icon({ pad: 0.16 }))).resize(180, 180).png().toFile("src/app/apple-icon.png");
console.log("icons written");
