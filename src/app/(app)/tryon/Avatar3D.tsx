"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadGarments, type CanvasAvatar, type CanvasGarment } from "@/components/TryOnCanvas";
import { errorText } from "@/lib/api";
import { drawOutfit, loadImage } from "@/lib/tryonRender";
import type { UserSizes } from "@/modules/tryon/fit";
import { estimateMeasurements, type Measurements } from "@/modules/tryon/measure";
import AiAvatarPanel from "./AiAvatarPanel";
import type { TryOnResult } from "./types";

const LABELS: [keyof Omit<Measurements, "sources">, string, "lengths" | "chest" | "waist" | null][] = [
  ["heightCm", "Height", null],
  ["shoulderCm", "Shoulder width", "lengths"],
  ["chestCm", "Chest", "chest"],
  ["waistCm", "Waist", "waist"],
  ["hipCm", "Hips", "waist"],
  ["armCm", "Arm length", "lengths"],
  ["torsoCm", "Torso", "lengths"],
  ["inseamCm", "Inside leg", "lengths"],
];

const SOURCE_TEXT = { photo: "from your photo", average: "average", size: "from your size", estimate: "estimated" } as const;

/**
 * A 3D avatar sized from your measurements (lengths from your photo, girths from your sizes),
 * dressed in the chosen clothes. Drag to turn it; everything renders on this device.
 */
export default function Avatar3D({
  avatar,
  garments,
  sizes,
  heightCm,
  onSaveProfile,
  tryons = [],
  aiConsent = false,
  onConsent,
}: {
  tryons?: TryOnResult[];
  aiConsent?: boolean;
  onConsent?: (v: boolean) => Promise<void>;
  avatar: CanvasAvatar | null;
  garments: CanvasGarment[];
  sizes: UserSizes | null;
  heightCm: number | null;
  onSaveProfile: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const yaw = useRef(0);
  const spin = useRef(true);
  const [autoSpin, setAutoSpin] = useState(true);
  const [style, setStyle] = useState<"photo" | "mannequin" | "ai">("photo");
  const [aiUrl, setAiUrl] = useState<string | null>(null); // the generated model on show
  const [status, setStatus] = useState("Building your avatar…");
  const [heightInput, setHeightInput] = useState("");

  // The realistic AI render for this photo and exactly these clothes, if one is ready.
  const garmentKey = garments.map((g) => g.id).sort().join(",");
  const render = tryons.find(
    (r) => r.status === "ready" && r.imageUrl && r.avatar_photo_id === avatar?.id && [...r.item_ids].sort().join(",") === garmentKey,
  ) ?? null;
  const renderId = render?.id ?? null;
  // Read through a ref: the list refetches (with fresh signed URLs) while a render is pending, and
  // the 3D scene should only rebuild when the matching render itself changes.
  const renderRef = useRef(render);
  useEffect(() => {
    renderRef.current = render;
  });

  const measurements = useMemo(
    () => estimateMeasurements(avatar?.pose.landmarks ?? null, avatar?.width ?? 0, avatar?.height ?? 0, heightCm, sizes),
    [avatar, heightCm, sizes],
  );

  useEffect(() => {
    spin.current = autoSpin;
  }, [autoSpin]);

  useEffect(() => {
    let disposed = false;
    let frame = 0;
    let cleanup: (() => void) | undefined;
    (async () => {
      const c = canvas.current;
      const box = wrap.current;
      if (!c || !box) return;
      try {
        if (style === "ai") {
          // A generated GLB: nothing to build until one is ready.
          // No model yet: the generate panel takes the canvas's place (see below), nothing to draw.
          if (!aiUrl) return;
          setStatus("Loading your 3D model…");
        }
        const [{ buildAvatar, buildPhotoAvatar, buildGlbAvatar, backView, readAppearance }, clothes, photo] = await Promise.all([
          import("@/lib/avatar3d"),
          loadGarments(garments),
          avatar?.imageUrl ? loadImage(avatar.imageUrl) : Promise.resolve(null),
        ]);
        if (disposed) return;
        const look = photo && avatar ? readAppearance(photo, avatar.pose.landmarks) : { skin: "rgb(200,160,130)", hair: "rgb(40,30,25)", face: null };
        let scene;
        if (style === "ai" && aiUrl) {
          scene = await buildGlbAvatar(c, aiUrl, measurements.heightCm);
        } else if (style === "photo" && photo && avatar && renderId && renderRef.current?.imageUrl) {
          const render = renderRef.current;
          // A realistic AI render of this exact outfit exists: build the 3D figure from it, so the
          // clothes have really replaced yours (the preview can only lay garments over them).
          const img = await loadImage(render.imageUrl!);
          if (disposed) return;
          const front = keyOutWhite(img);
          const lm = landmarksInRender(avatar.pose.landmarks, avatar.width, avatar.height, img.naturalWidth, img.naturalHeight);
          scene = await buildPhotoAvatar(c, front, backView(front, lm, look), measurements.heightCm);
        } else if (style === "photo" && photo && avatar) {
          // The dressed photo on a transparent background, as in "On my photo", then inflated into 3D.
          const scale = Math.min(1, 1100 / photo.naturalHeight);
          const front = document.createElement("canvas");
          front.width = Math.round(photo.naturalWidth * scale);
          front.height = Math.round(photo.naturalHeight * scale);
          const fg = front.getContext("2d")!;
          fg.drawImage(photo, 0, 0, front.width, front.height);
          drawOutfit(fg, front.width, front.height, avatar.pose.landmarks, clothes);
          // The back shows the same garments in plain fabric: prints and logos are front-only.
          const plainBack = document.createElement("canvas");
          plainBack.width = front.width;
          plainBack.height = front.height;
          const bg = plainBack.getContext("2d")!;
          bg.drawImage(photo, 0, 0, front.width, front.height);
          drawOutfit(bg, front.width, front.height, avatar.pose.landmarks, clothes, { plain: true });
          scene = await buildPhotoAvatar(c, front, backView(plainBack, avatar.pose.landmarks, look), measurements.heightCm);
        } else {
          scene = buildAvatar(c, measurements, look, clothes);
        }
        if (disposed) {
          scene.dispose();
          return;
        }
        // Portrait 3:4, but never taller than ~75% of the window, so controls stay in view on
        // wide screens (a full-width 3:4 canvas was taller than the screen).
        const resize = () => {
          const w = Math.min(box.clientWidth, Math.round(window.innerHeight * 0.75 * 0.75));
          scene.renderer.setSize(w, Math.round((w * 4) / 3), true);
        };
        resize();
        const observer = new ResizeObserver(resize);
        observer.observe(box);
        window.addEventListener("resize", resize);
        const tick = () => {
          if (spin.current) yaw.current += 0.006;
          scene.figure.rotation.y = yaw.current;
          scene.renderer.render(scene.scene, scene.camera);
          frame = requestAnimationFrame(tick);
        };
        tick();
        setStatus("");
        cleanup = () => {
          observer.disconnect();
          window.removeEventListener("resize", resize);
          scene.dispose();
        };
      } catch (err) {
        if (!disposed) setStatus(`Couldn't build the 3D avatar: ${errorText(err)}`);
      }
    })();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      cleanup?.();
    };
  }, [avatar, garments, measurements, style, aiUrl, renderId]);

  // Drag to turn.
  const drag = useRef<number | null>(null);
  const onDown = (e: React.PointerEvent) => {
    drag.current = e.clientX;
    setAutoSpin(false);
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (drag.current === null) return;
    yaw.current += (e.clientX - drag.current) * 0.01;
    drag.current = e.clientX;
  };
  const onUp = () => {
    drag.current = null;
  };

  async function snapshot() {
    const c = canvas.current;
    if (!c) return;
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "warewise-avatar.png";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function saveMeasurements() {
    const { sources: _s, ...values } = measurements;
    void _s;
    await onSaveProfile({ measurements: { ...values, estimated_at: new Date().toISOString().slice(0, 10) } });
    setStatus("Measurements saved to your profile.");
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-center gap-1 text-sm" role="radiogroup" aria-label="Avatar style">
        {(["photo", "mannequin", "ai"] as const).map((s) => (
          <button key={s} role="radio" aria-checked={style === s} onClick={() => setStyle(s)} className={`px-3 py-1.5 text-xs font-semibold tracking-[0.08em] uppercase transition-colors ${style === s ? "bg-text text-bg" : "text-muted hover:text-text"}`}>
            {s === "photo" ? "Looks like me" : s === "mannequin" ? "Mannequin" : "AI 3D"}
          </button>
        ))}
      </div>
      {/* Plain CSS gradient: Tailwind's `in oklab` gradients are dropped by Safari. */}
      {style === "ai" && !aiUrl ? (
        // No model yet: show how to make one right where the model will appear.
        <AiAvatarPanel
          photoId={avatar?.id ?? null}
          tryons={tryons}
          consent={aiConsent}
          onConsent={onConsent ?? (async () => undefined)}
          selectedUrl={aiUrl}
          onSelect={setAiUrl}
        />
      ) : (
      <div ref={wrap} className="relative overflow-hidden rounded-none border border-line" style={{ background: "linear-gradient(to bottom, #f6f1ea, #dccfbe)" }}>
        <canvas
          ref={canvas}
          className="mx-auto block cursor-grab touch-none active:cursor-grabbing"
          aria-label="3D avatar, drag to turn"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
        {status ? (
          <p className="absolute inset-x-0 top-3 mx-auto w-fit px-3 py-1 text-xs" style={{ background: "rgba(0,0,0,0.72)", color: "#fff" }}>
            {status}
          </p>
        ) : null}
      </div>
      )}
      {style === "photo" && avatar ? (
        <p className="text-center text-xs text-muted">
          {renderId
            ? "Built from your realistic AI render of this outfit."
            : "Built from the quick preview, so your own clothes can show underneath. Use “Make it realistic” on the “On my photo” tab for a true look, then come back here."}
        </p>
      ) : null}
      {style === "ai" && aiUrl ? (
        <AiAvatarPanel
          photoId={avatar?.id ?? null}
          tryons={tryons}
          consent={aiConsent}
          onConsent={onConsent ?? (async () => undefined)}
          selectedUrl={aiUrl}
          onSelect={setAiUrl}
        />
      ) : null}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button className="btn-ghost" onClick={() => setAutoSpin((s) => !s)}>{autoSpin ? "Stop turning" : "Turn slowly"}</button>
        <button className="btn-ghost" onClick={() => { yaw.current = 0; setAutoSpin(false); }}>Front</button>
        <button className="btn-ghost" onClick={() => { yaw.current = Math.PI; setAutoSpin(false); }}>Back</button>
        <button className="btn-ghost" onClick={snapshot}>Save image</button>
      </div>

      <section className="card space-y-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-semibold">Your measurements</h3>
          <span className="text-xs text-muted">Estimates: lengths from your photo and height, girths from your sizes</span>
        </div>
        {!heightCm ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted">Add your height for real centimetres:</span>
            <input className="input w-28" type="number" min={100} max={230} placeholder="cm" value={heightInput} onChange={(e) => setHeightInput(e.target.value)} aria-label="Your height in cm" />
            <button className="btn-ghost" disabled={!heightInput} onClick={() => onSaveProfile({ height_cm: Number(heightInput) })}>Save</button>
          </div>
        ) : null}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          {LABELS.map(([key, label, src]) => (
            <div key={key} className="flex justify-between gap-2 border-b border-line py-1">
              <dt className="text-muted">{label}</dt>
              <dd className="tabular-nums" title={src ? SOURCE_TEXT[measurements.sources[src]] : heightCm ? "from your profile" : "average"}>
                {measurements[key]} cm
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted">
          Hover a value to see where it came from. A photo from the front can&apos;t measure depth, so chest and waist use your sizes.
        </p>
        <button className="btn-ghost" onClick={saveMeasurements}>Save measurements to profile</button>
      </section>
    </div>
  );
}

/** The AI render with its plain white backdrop made transparent (flood-filled from the edges). */
function keyOutWhite(img: HTMLImageElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  const px = d.data;
  const W = c.width;
  const H = c.height;
  const white = (p: number) => px[p * 4] > 236 && px[p * 4 + 1] > 236 && px[p * 4 + 2] > 236;
  const bg = new Uint8Array(W * H);
  const stack: number[] = [];
  const push = (p: number) => {
    if (!bg[p] && white(p)) {
      bg[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < W; x++) {
    push(x);
    push((H - 1) * W + x);
  }
  for (let y = 0; y < H; y++) {
    push(y * W);
    push(y * W + W - 1);
  }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % W;
    if (x > 0) push(p - 1);
    if (x < W - 1) push(p + 1);
    if (p >= W) push(p - W);
    if (p < W * (H - 1)) push(p + W);
  }
  for (let p = 0; p < W * H; p++) if (bg[p]) px[p * 4 + 3] = 0;
  g.putImageData(d, 0, 0);
  return c;
}

/**
 * The avatar photo's body points, moved into the render's frame: the try-on models get the photo
 * fitted inside a 768 x 1024 white canvas, so the render keeps that framing.
 */
function landmarksInRender(lm: { x: number; y: number; visibility?: number }[], w: number, h: number, rw: number, rh: number) {
  const s = Math.min(rw / w, rh / h);
  const ox = (rw - w * s) / 2;
  const oy = (rh - h * s) / 2;
  return lm.map((p) => ({ ...p, x: (p.x * w * s + ox) / rw, y: (p.y * h * s + oy) / rh }));
}
