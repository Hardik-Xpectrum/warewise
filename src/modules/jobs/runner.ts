import "server-only";
import { runModel3dJobs } from "@/modules/tryon/models3d";
import { PHOTO_CACHE_CONTROL } from "@/modules/media/signing";
import { adminClient } from "@/lib/supabase/admin";
import { AiUnavailableError } from "@/modules/ai/router";
import { errorFields, log } from "@/modules/platform/log";
import { BUCKET } from "@/modules/wardrobe/service";
import { BadImageError, makeCutout, processImage } from "./image";
import { hammingHex } from "./phash";
import { TaggingRejected, tagImage } from "./tagger";
import { runTryOnJobs } from "@/modules/tryon/service";
import { callService, serviceEnabled, ServiceError } from "@/modules/services/client";

const BATCH_SIZE = 8; // stays under the free Gemini per-minute limit and Vercel's function time
const VISIBILITY_SECONDS = 60;
const MAX_ATTEMPTS = 3;
const DUPLICATE_DISTANCE = 6;

type Job = { msg_id: number; read_ct: number; message: { item_id: string; user_id: string } };

export type RunSummary = { read: number; done: number; failed: number; retrying: number; deferred: number };

/**
 * Processes queued media jobs. Called by pg_cron every minute and right after an upload; safe to
 * run concurrently because each job is hidden from other readers while it is being processed.
 */
export async function runMediaJobs(requestId: string): Promise<RunSummary> {
  const db = adminClient();
  const { data, error } = await db.rpc("read_media_jobs", { p_qty: BATCH_SIZE, p_vt: VISIBILITY_SECONDS });
  if (error) throw new Error(`read_media_jobs: ${error.message}`);
  const jobs = (data ?? []) as Job[];
  const summary: RunSummary = { read: jobs.length, done: 0, failed: 0, retrying: 0, deferred: 0 };

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const outcome = await processJob(job, requestId);
    summary[outcome]++;
    if (outcome === "deferred") {
      // Every model is out of free quota: put the rest back without spending their attempts.
      for (const rest of jobs.slice(i + 1)) {
        await db.rpc("requeue_media_job", { p_msg_id: rest.msg_id, p_delay_seconds: 120 });
        summary.deferred++;
      }
      break;
    }
  }
  if (jobs.length) log("info", "media jobs run", { requestId, ...summary });
  return summary;
}

async function processJob(job: Job, requestId: string): Promise<keyof Omit<RunSummary, "read">> {
  const db = adminClient();
  const { item_id: itemId, user_id: userId } = job.message;

  const { data: item } = await db
    .from("wardrobe_items")
    .select("id,user_id,status,image_path,vision_job_id")
    .eq("id", itemId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!item || item.status !== "processing") {
    await db.rpc("finish_media_job", { p_msg_id: job.msg_id });
    return "done";
  }

  // With the vision service switched on (VISION_URL), hand the photo over and let it report back
  // (POST /api/internal/events). It owns the retries from here.
  if (serviceEnabled("vision")) return handToVision(job, item, requestId);

  try {
    const download = await db.storage.from(BUCKET).download(item.image_path);
    if (download.error) throw new Error(`download: ${download.error.message}`);
    const processed = await processImage(Buffer.from(await download.data.arrayBuffer()));

    // Tag before storing anything, so a rejected photo leaves no files behind.
    const { tags } = await tagImage(processed.clean, { userId, requestId });

    const cleanPath = `${userId}/clean/${itemId}.webp`;
    const thumbPath = `${userId}/thumb/${itemId}.webp`;
    const store = db.storage.from(BUCKET);
    for (const [path, body] of [[cleanPath, processed.clean], [thumbPath, processed.thumb]] as const) {
      const up = await store.upload(path, body, { contentType: "image/webp", upsert: true, cacheControl: PHOTO_CACHE_CONTROL });
      if (up.error) throw new Error(`upload ${path}: ${up.error.message}`);
    }
    // Transparent cut-out for the try-on preview; skipped when the garment can't be separated.
    const cutout = await makeCutout(processed.clean, tags.category);
    const cutoutPath = cutout ? `${userId}/cutout/${itemId}.webp` : null;
    if (cutout && cutoutPath) {
      const up = await store.upload(cutoutPath, cutout, { contentType: "image/webp", upsert: true, cacheControl: PHOTO_CACHE_CONTROL });
      if (up.error) throw new Error(`upload ${cutoutPath}: ${up.error.message}`);
    }

    const duplicateOf = await findDuplicate(userId, itemId, processed.phash, tags.category, tags.colors[0]);
    const { error: updateError } = await db
      .from("wardrobe_items")
      .update({
        status: "ready",
        status_reason: null,
        category: tags.category,
        subcategory: tags.subcategory ?? null,
        colors: tags.colors,
        pattern: tags.pattern,
        seasons: tags.seasons,
        fabric: tags.fabric ?? null,
        formality: tags.formality,
        fit: tags.fit,
        brand: tags.brand ?? null,
        ai_tags: tags,
        ai_confidence: tags.confidence,
        clean_path: cleanPath,
        thumb_path: thumbPath,
        cutout_path: cutoutPath,
        phash: processed.phash,
        duplicate_of: duplicateOf,
        image_path: cleanPath,
      })
      .eq("id", itemId)
      .eq("user_id", userId);
    if (updateError) throw new Error(`update item: ${updateError.message}`);

    // Keep only the processed copies; the original is the biggest file and storage is 1 GB.
    if (item.image_path !== cleanPath) await store.remove([item.image_path]);
    await db.rpc("finish_media_job", { p_msg_id: job.msg_id });
    return "done";
  } catch (err) {
    if (err instanceof AiUnavailableError && err.reason === "quota") {
      await db.rpc("requeue_media_job", { p_msg_id: job.msg_id, p_delay_seconds: 120 });
      return "deferred";
    }
    const userFacing = err instanceof BadImageError || err instanceof TaggingRejected;
    const giveUp = userFacing || job.read_ct >= MAX_ATTEMPTS;
    log(userFacing ? "info" : "error", "media job failed", {
      requestId, itemId, attempt: job.read_ct, giveUp, ...errorFields(err),
    });
    if (!giveUp) return "retrying"; // the message reappears after the visibility timeout
    await db
      .from("wardrobe_items")
      .update({
        status: "failed",
        status_reason: userFacing ? (err as Error).message : "We couldn't read this photo. Retry, or tag it by hand.",
      })
      .eq("id", itemId)
      .eq("user_id", userId);
    await db.rpc("give_up_media_job", { p_msg_id: job.msg_id });
    return "failed";
  }
}

/**
 * dHash compares greyscale structure only, so two same-cut shirts in different colours look alike.
 * A duplicate must also share the category and main colour.
 */
async function handToVision(job: Job, item: { id: string; user_id: string; image_path: string; vision_job_id: string | null }, requestId: string) {
  const db = adminClient();
  const jobId = item.vision_job_id ?? crypto.randomUUID();
  if (!item.vision_job_id) await db.from("wardrobe_items").update({ vision_job_id: jobId }).eq("id", item.id).eq("user_id", item.user_id);
  try {
    await callService("vision", "POST", "/v1/items/process", { jobId, userId: item.user_id, itemId: item.id, imagePath: item.image_path });
    await db.rpc("finish_media_job", { p_msg_id: job.msg_id });
    return "done" as const;
  } catch (err) {
    // A request the service refuses won't work next time either; anything else (asleep, network) is retried.
    if (err instanceof ServiceError && err.status >= 400 && err.status < 500) {
      log("error", "vision service refused the item", { requestId, itemId: item.id, ...errorFields(err) });
      await db.from("wardrobe_items").update({ status: "failed", status_reason: "We couldn't process this photo. Try again." }).eq("id", item.id).eq("user_id", item.user_id);
      await db.rpc("give_up_media_job", { p_msg_id: job.msg_id });
      return "failed" as const;
    }
    log("warn", "vision service unreachable; will retry", { requestId, itemId: item.id, ...errorFields(err) });
    return "retrying" as const;
  }
}

export async function findDuplicate(userId: string, itemId: string, phash: string, category: string, mainColor: string | undefined): Promise<string | null> {
  let q = adminClient()
    .from("wardrobe_items")
    .select("id,phash")
    .eq("user_id", userId)
    .eq("category", category)
    .neq("id", itemId)
    .not("phash", "is", null)
    .is("deleted_at", null);
  if (mainColor) q = q.contains("colors", [mainColor]);
  const { data } = await q;
  let best: { id: string; d: number } | null = null;
  for (const row of data ?? []) {
    const d = hammingHex(phash, row.phash as string);
    if (d <= DUPLICATE_DISTANCE && (!best || d < best.d)) best = { id: row.id as string, d };
  }
  return best?.id ?? null;
}

/** Everything the scheduler wakes up for: garment photos, then AI try-ons. */
export async function runAllJobs(requestId: string) {
  const media = await runMediaJobs(requestId);
  const tryons = await runTryOnJobs(requestId);
  const models3d = await runModel3dJobs(requestId);
  return { ...media, tryons, models3d };
}
