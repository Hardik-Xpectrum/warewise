// What the web app does when a service reports back. Pure mapping (event → row patch) is separate
// from the database work so it can be unit-tested.
import type { ItemProcessed, ServiceEvent } from "@warewise/contracts";

/** The wardrobe_items update for a finished vision job (the duplicate check is added by the caller). */
export function itemPatch(ev: ItemProcessed): Record<string, unknown> {
  if (!ev.ok || !ev.tags || !ev.paths) {
    return {
      status: "failed",
      status_reason: ev.error?.userFacing ? ev.error.message : "We couldn't process this photo. Try again, or use a clearer photo.",
    };
  }
  const t = ev.tags;
  return {
    status: "ready",
    status_reason: null,
    category: t.category,
    subcategory: t.subcategory ?? null,
    colors: t.colors,
    pattern: t.pattern,
    seasons: t.seasons,
    fabric: t.fabric ?? null,
    formality: t.formality,
    fit: t.fit,
    brand: t.brand ?? null,
    ai_tags: t,
    ai_confidence: t.confidence,
    clean_path: ev.paths.clean,
    thumb_path: ev.paths.thumb,
    cutout_path: ev.paths.cutout ?? null,
    phash: ev.phash ?? null,
    image_path: ev.paths.clean,
  };
}

/** The tryon_results update for a finished render. */
export function tryonPatch(ev: Extract<ServiceEvent, { type: "tryon.ready" | "tryon.failed" }>, now = new Date()): Record<string, unknown> {
  const finished_at = now.toISOString();
  return ev.type === "tryon.ready"
    ? { status: "ready", result_path: ev.renderPath, engine: "service:tryon", error: ev.note ?? null, finished_at }
    : { status: "failed", error: ev.message, finished_at };
}

/** The avatar_models update for a failed build (a successful one needs the service's mesh path). */
export function avatarFailedPatch(ev: Extract<ServiceEvent, { type: "avatar.failed" }>, now = new Date()): Record<string, unknown> {
  return { status: "failed", error: ev.message, provider_ref: null, finished_at: now.toISOString() };
}
