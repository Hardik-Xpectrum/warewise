// Which AI try-on passes dress a whole outfit. Models like Leffa dress one garment per pass, so a
// top + bottom outfit takes two passes, each on the previous result. Pure and unit-tested.

export type PassGarment = { id: string; slot: string };
export type TryOnPass = { garmentId: string; region: "upper_body" | "lower_body" | "dresses"; model: "viton_hd" | "dress_code"; label: string };

/**
 * A dress is one pass. Otherwise the visible upper garment (a layer beats the top under it) goes
 * first, then the bottom, so the top's hem sits naturally over the trousers' waist.
 */
export function planPasses(garments: PassGarment[]): TryOnPass[] {
  const dress = garments.find((g) => g.slot === "one_piece");
  if (dress) return [{ garmentId: dress.id, region: "dresses", model: "dress_code", label: "dress" }];
  const passes: TryOnPass[] = [];
  const upper = garments.find((g) => g.slot === "outer") ?? garments.find((g) => g.slot === "top");
  if (upper) passes.push({ garmentId: upper.id, region: "upper_body", model: "viton_hd", label: upper.slot === "outer" ? "layer" : "top" });
  const bottom = garments.find((g) => g.slot === "bottom");
  if (bottom) passes.push({ garmentId: bottom.id, region: "lower_body", model: "dress_code", label: "bottom" });
  return passes;
}

/** "Try again in 18:52:11" in a Hugging Face quota error -> "in about 19 hours". */
export function retryHint(message: string): string | null {
  const m = message.match(/try again in (\d+):(\d+):(\d+)/i);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]) + (Number(m[3]) > 0 ? 1 : 0);
  if (minutes < 60) return `in about ${Math.max(1, minutes)} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `in about ${hours} hour${hours === 1 ? "" : "s"}`;
}
