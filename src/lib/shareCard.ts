"use client";
// A 1080×1920 (Instagram/WhatsApp story) image of an outfit, drawn on a canvas in the browser:
// the pieces as product tiles, the colour-harmony score and the date. Nothing leaves the device
// until the user shares it.
import type { OutfitCardData } from "@/components/types";
import { loadImage } from "./tryonRender";
import { COLLAR_PATHS, TIE_PATHS } from "@/components/Logo";

const HEART = "#c4122f";

const W = 1080;
const H = 1920;

function fitImage(g: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number, pad: number) {
  const s = Math.min((w - pad * 2) / img.naturalWidth, (h - pad * 2) / img.naturalHeight);
  const iw = img.naturalWidth * s, ih = img.naturalHeight * s;
  g.save();
  g.shadowColor = "rgba(0,0,0,0.14)";
  g.shadowBlur = 24;
  g.shadowOffsetY = 12;
  g.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
  g.restore();
}

export async function renderShareCard(outfit: OutfitCardData, title: string): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const font = getComputedStyle(document.body).fontFamily || "system-ui, sans-serif";
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, W, H);

  // Header: the logo (collar and red tie) and the "WareWise" wordmark with its red i, then the date.
  g.save();
  g.translate(90, 100);
  g.fillStyle = "#222222";
  COLLAR_PATHS.forEach((d) => g.fill(new Path2D(d)));
  g.fillStyle = HEART;
  TIE_PATHS.forEach((d) => g.fill(new Path2D(d)));
  g.restore();
  g.font = `700 40px ${font}`;
  g.letterSpacing = "0px";
  let x = 174;
  for (const ch of "WareWise") {
    g.fillStyle = ch === "i" ? HEART : "#222222";
    g.fillText(ch, x, 150);
    x += g.measureText(ch).width;
  }
  g.font = `600 26px ${font}`;
  g.letterSpacing = "5px";
  g.fillStyle = "#5f5f5f";
  g.fillText(new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }).toUpperCase(), 90, 205);
  g.letterSpacing = "0px";
  g.fillStyle = "#222222";
  g.font = `600 76px ${font}`;
  wrapText(g, title, 90, 320, W - 180, 86);

  // Up to four pieces as product tiles (2×2), the way they look in the wardrobe.
  const pieces = outfit.items.slice(0, 4);
  const images = await Promise.all(pieces.map((p) => (p.thumbUrl ? loadImage(p.thumbUrl).catch(() => null) : Promise.resolve(null))));
  // Tiles fill the space between the title and the score block, however many rows there are.
  const gap = 18, caption = 60, top = 470, bottom = H - 360;
  const rows = Math.ceil(pieces.length / 2);
  const tileH = Math.min(((W - 180 - gap) / 2) * 1.25, (bottom - top - (rows - 1) * (gap + caption) - caption) / rows);
  const tileW = tileH / 1.25;
  const left = (W - (tileW * 2 + gap)) / 2;
  pieces.forEach((p, i) => {
    const x = left + (i % 2) * (tileW + gap);
    const y = top + Math.floor(i / 2) * (tileH + gap + caption);
    g.fillStyle = "#f4f3f1";
    g.fillRect(x, y, tileW, tileH);
    const img = images[i];
    if (img) fitImage(g, img, x, y, tileW, tileH, 40);
    g.fillStyle = "#222222";
    g.font = `500 30px ${font}`;
    g.fillText(capitalise(p.label ?? p.slot), x, y + tileH + 42);
  });

  // Harmony score and footer.
  const h = outfit.harmony;
  if (h) {
    const y = H - 250;
    g.strokeStyle = "#222222";
    g.lineWidth = 4;
    g.strokeRect(90, y - 62, 130, 84);
    g.fillStyle = "#222222";
    g.font = `700 52px ${font}`;
    g.textAlign = "center";
    g.fillText(String(h.score), 155, y);
    g.textAlign = "left";
    g.font = `600 30px ${font}`;
    g.letterSpacing = "4px";
    g.fillText(h.label.toUpperCase(), 250, y - 22);
    g.letterSpacing = "0px";
    g.fillStyle = "#5f5f5f";
    g.font = `400 26px ${font}`;
    g.fillText("colour harmony", 250, y + 14);
  }
  g.fillStyle = "#5f5f5f";
  g.font = `500 26px ${font}`;
  g.fillText("Styled from my own wardrobe with Warewise", 90, H - 90);

  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not create the image"))), "image/png"));
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function wrapText(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lineH: number) {
  const words = text.split(" ");
  let line = "";
  let lines = 0;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (g.measureText(test).width > maxW && line) {
      g.fillText(line, x, y + lines * lineH);
      line = w;
      if (++lines === 2) break;
    } else line = test;
  }
  if (lines < 2) g.fillText(line, x, y + lines * lineH);
}

/** Shares the image through the phone's share sheet when possible, otherwise downloads it. */
export async function shareOutfitImage(outfit: OutfitCardData, title: string) {
  const blob = await renderShareCard(outfit, title);
  const file = new File([blob], "warewise-outfit.png", { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title });
    return "shared" as const;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "warewise-outfit.png";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return "downloaded" as const;
}
