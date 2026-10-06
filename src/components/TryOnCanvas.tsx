"use client";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { drawOutfit, garmentShape, loadImage, type RenderGarment } from "@/lib/tryonRender";
import type { Landmark } from "@/modules/tryon/placement";

export type CanvasAvatar = { id: string; imageUrl: string | null; width: number; height: number; pose: { landmarks: Landmark[] } };
export type CanvasGarment = { id: string; slot: string; subcategory: string | null; url: string | null; isCutout: boolean; fit?: number };
export type TryOnCanvasHandle = { download: () => Promise<void> };

export async function loadGarments(garments: CanvasGarment[]): Promise<RenderGarment[]> {
  const loaded = await Promise.all(
    garments.map(async (g): Promise<RenderGarment | null> => {
      if (!g.url) return null;
      try {
        const img = await loadImage(g.url);
        return { id: g.id, slot: g.slot, subcategory: g.subcategory, img, isCutout: g.isCutout, fit: g.fit, shape: garmentShape(img, g.isCutout) };
      } catch {
        return null;
      }
    }),
  );
  return loaded.filter((g): g is RenderGarment => Boolean(g));
}

/** Instant, private try-on preview: garments warped onto the avatar photo's body, in the browser. */
const TryOnCanvas = forwardRef<TryOnCanvasHandle, { avatar: CanvasAvatar; garments: CanvasGarment[] }>(function TryOnCanvas({ avatar, garments }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState("");

  useImperativeHandle(ref, () => ({
    async download() {
      const c = canvas.current;
      if (!c) return;
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "warewise-tryon.png";
      a.click();
      URL.revokeObjectURL(a.href);
    },
  }));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const c = canvas.current;
      if (!c || !avatar.imageUrl) return;
      try {
        const [person, clothes] = await Promise.all([loadImage(avatar.imageUrl), loadGarments(garments)]);
        if (cancelled) return;
        // Small photos are drawn larger so the garments stay sharp (the photo itself is upscaled).
        const k = Math.min(2.5, Math.max(1, 1400 / person.naturalHeight));
        const W = Math.round(person.naturalWidth * k);
        const H = Math.round(person.naturalHeight * k);
        c.width = W;
        c.height = H;
        const g = c.getContext("2d")!;
        g.fillStyle = "#f4f1ec";
        g.fillRect(0, 0, W, H);
        g.drawImage(person, 0, 0, W, H);
        drawOutfit(g, W, H, avatar.pose.landmarks, clothes);
        setError("");
      } catch {
        if (!cancelled) setError("Couldn't load the images. Reload the page to refresh the links.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [avatar, garments]);

  return (
    <div>
      <canvas ref={canvas} className="mx-auto block max-h-[70vh] w-auto max-w-full rounded-none border border-line bg-surface-2" aria-label="Try-on preview" />
      {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
    </div>
  );
});

export default TryOnCanvas;
