import "server-only";
import type { AvatarCurrent, ServiceEvent } from "@warewise/contracts";
import { adminClient } from "@/lib/supabase/admin";
import { findDuplicate } from "@/modules/jobs/runner";
import { log } from "@/modules/platform/log";
import { BUCKET } from "@/modules/wardrobe/service";
import { callService } from "./client";
import { avatarFailedPatch, itemPatch, tryonPatch } from "./events";

/**
 * Applies one service event to the web app's tables. Idempotent: each (type, jobId) is recorded in
 * service_events and applied once; a redelivery is acknowledged without doing anything.
 * Returns false when the event is for a job this app no longer has (also acknowledged).
 */
export async function applyServiceEvent(ev: ServiceEvent, requestId: string): Promise<"applied" | "duplicate" | "stale"> {
  const db = adminClient();
  const { error: dup } = await db.from("service_events").insert({ type: ev.type, job_id: ev.jobId, user_id: ev.userId });
  if (dup) {
    if (dup.code === "23505") return "duplicate";
    throw new Error(`service_events: ${dup.message}`);
  }
  try {
    const applied = await apply(ev, requestId);
    if (!applied) log("info", "stale service event ignored", { requestId, type: ev.type, jobId: ev.jobId });
    return applied ? "applied" : "stale";
  } catch (err) {
    // Not applied: forget it, so the service's retry gets another go.
    await db.from("service_events").delete().eq("type", ev.type).eq("job_id", ev.jobId);
    throw err;
  }
}

async function apply(ev: ServiceEvent, requestId: string): Promise<boolean> {
  const db = adminClient();
  switch (ev.type) {
    case "item.processed": {
      // Only the job the item is waiting for counts (a retry gets a new job id).
      const { data: item } = await db.from("wardrobe_items").select("id,status,image_path,vision_job_id").eq("id", ev.itemId).eq("user_id", ev.userId).maybeSingle();
      if (!item || item.vision_job_id !== ev.jobId || item.status !== "processing") return false;
      const patch = itemPatch(ev);
      if (patch.status === "ready" && ev.phash && ev.tags) {
        patch.duplicate_of = await findDuplicate(ev.userId, ev.itemId, ev.phash, ev.tags.category, ev.tags.colors[0]);
      }
      const { error } = await db.from("wardrobe_items").update(patch).eq("id", ev.itemId).eq("user_id", ev.userId);
      if (error) throw new Error(`update item: ${error.message}`);
      // Keep only the processed copies, as the in-process runner does: the original is the biggest file.
      if (patch.status === "ready" && item.image_path && item.image_path !== patch.clean_path) {
        await db.storage.from(BUCKET).remove([item.image_path]);
      }
      return true;
    }
    case "tryon.ready":
    case "tryon.failed": {
      const { data, error } = await db.from("tryon_results").update(tryonPatch(ev)).eq("id", ev.jobId).eq("user_id", ev.userId).eq("status", "pending").select("id");
      if (error) throw new Error(`update try-on: ${error.message}`);
      return Boolean(data?.length);
    }
    case "avatar.ready": {
      // The event carries the version; the mesh path and engine come from the service.
      const current = await callService<AvatarCurrent>("avatar", "GET", `/v1/avatars/${ev.userId}`);
      if (!current || current.version < ev.version) throw new Error(`avatar ${ev.userId} v${ev.version} not readable yet`);
      const { data, error } = await db
        .from("avatar_models")
        .update({ status: "ready", model_path: current.meshPath, engine: `service:${current.engine}`, provider_ref: { avatarVersion: ev.version }, error: null, finished_at: new Date().toISOString() })
        .eq("id", ev.jobId)
        .eq("user_id", ev.userId)
        .eq("status", "pending")
        .select("id");
      if (error) throw new Error(`update avatar model: ${error.message}`);
      log("info", "avatar model ready", { requestId, jobId: ev.jobId, version: ev.version });
      return Boolean(data?.length);
    }
    case "avatar.failed": {
      const { data, error } = await db.from("avatar_models").update(avatarFailedPatch(ev)).eq("id", ev.jobId).eq("user_id", ev.userId).eq("status", "pending").select("id");
      if (error) throw new Error(`update avatar model: ${error.message}`);
      return Boolean(data?.length);
    }
  }
}
