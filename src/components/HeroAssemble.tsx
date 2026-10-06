import { garmentSvg, type Shape } from "@/modules/samples/garments";
import { placeGarments } from "@/modules/tryon/placement";
import { SAMPLE_MODEL } from "@/modules/tryon/sampleModel";

// The landing hero: a flat-lay of pieces that lifts off and assembles onto the sample model, holds,
// then drops back, on a loop. Listed back to front, the order they are worn in. Final positions come from the same placement code as Try-on, so
// the pieces land exactly where the app would put them.
const PIECES: { id: string; slot: string; shape: Shape; color: string; w: number; h: number; from: { left: number; top: number; rot: number } }[] = [
  { id: "loafers", slot: "shoes", shape: "loafers", color: "#7a4a2a", w: 400, h: 170, from: { left: 2, top: 78, rot: -4 } },
  { id: "jeans", slot: "bottom", shape: "jeans", color: "#35507a", w: 360, h: 520, from: { left: 76, top: 30, rot: 7 } },
  { id: "shirt", slot: "top", shape: "shirt", color: "#dfe7f1", w: 400, h: 500, from: { left: 1, top: 4, rot: -9 } },
  { id: "blazer", slot: "outer", shape: "blazer", color: "#2b2f3a", w: 400, h: 500, from: { left: 74, top: 2, rot: 10 } },
];
const dataUri = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

// The stage is 4:5; the model fills its height, so it is 50% of the width, centred.
const MODEL_LEFT = 25;
const MODEL_W = 50;

export default function HeroAssemble() {
  const { width: W, height: H, pose } = SAMPLE_MODEL;
  const boxes = new Map(placeGarments(pose, W, H, PIECES.map((p) => ({ id: p.id, slot: p.slot, aspect: p.w / p.h }))).map((b) => [b.id, b]));
  return (
    <figure className="hero-stage relative mx-auto aspect-[4/5] w-full max-w-[460px] overflow-hidden bg-surface-2" aria-label="Pieces from a wardrobe assembling into an outfit on a model">
      {/* eslint-disable-next-line @next/next/no-img-element -- static illustration */}
      <img src={SAMPLE_MODEL.imageUrl} alt="" className="absolute inset-y-0 h-full" style={{ left: `${MODEL_LEFT}%`, width: `${MODEL_W}%` }} />
      {PIECES.map((p, i) => {
        const b = boxes.get(p.id)!;
        const left = MODEL_LEFT + (b.x / W) * MODEL_W;
        const top = (b.y / H) * 100;
        const width = (b.w / W) * MODEL_W;
        // Pieces on the right of the flat-lay are anchored to the right edge so they stay in frame.
        const fromLeft = p.from.left > 50 ? 100 - width - (100 - p.from.left) / 10 : p.from.left;
        const vars = {
          left: `${left}%`,
          top: `${top}%`,
          width: `${width}%`,
          "--dx": `${fromLeft - left}cqw`,
          "--dy": `${p.from.top - top}cqh`,
          "--r": `${p.from.rot}deg`,
          animationDelay: `${i * 180}ms`,
        } as React.CSSProperties;
        return (
          // eslint-disable-next-line @next/next/no-img-element -- inline SVG data URI
          <img key={p.id} src={dataUri(garmentSvg(p.shape, p.color))} alt="" className="hero-piece garment-shadow absolute" style={vars} />
        );
      })}
      <figcaption className="hero-caption absolute inset-x-4 bottom-4 flex items-center justify-between bg-bg px-3 py-2 text-[11px] font-semibold tracking-[0.1em] uppercase">
        <span>Office · Pune 27°C</span>
        <span className="border border-text px-1.5 py-0.5 tabular-nums">92</span>
      </figcaption>
    </figure>
  );
}
