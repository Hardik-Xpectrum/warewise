import "server-only";
import { PHOTO_CACHE_CONTROL, signedUrls } from "@/modules/media/signing";
import sharp from "sharp";
import { z } from "zod";
import { adminClient } from "@/lib/supabase/admin";
import { AiUnavailableError } from "@/modules/ai/chain";
import { retryHint } from "./plan";
import { aiTryOn, type TryOnGarment } from "@/modules/ai/tryon";
import { AppError, errors } from "@/modules/platform/errors";
import { must, type AuthedContext } from "@/modules/platform/http";
import { errorFields, log } from "@/modules/platform/log";
import { BUCKET } from "@/modules/wardrobe/service";
import type { Pose } from "./placement";
import { slotFor } from "./wear";
import type { RenderRequest } from "@warewise/contracts";
import { callService, serviceEnabled, ServiceError } from "@/modules/services/client";

export const DAILY_AI_TRYONS = 10; // the free GPU allowance is the real limit; this stops runaway use

export const CreateTryOnSchema = z
  .object({
    avatarPhotoId: z.uuid().optional(),
    outfitId: z.uuid().optional(),
    itemIds: z.array(z.uuid()).max(6).optional(),
  })
  .refine((v) => v.outfitId || v.itemIds?.length, "Give an outfitId or itemIds");

async function latestConsent(ctx: AuthedContext, kind: string) {
  const { data } = await ctx.supabase.from("consents").select("granted").eq("kind", kind).order("decided_at", { ascending: false }).limit(1).maybeSingle();
  return data?.granted === true;
}

/** Queues a realistic AI try-on. Needs the separate avatar_ai consent: it sends body photos to a third party. */
export async function createAiTryOn(ctx: AuthedContext, input: z.infer<typeof CreateTryOnSchema>) {
  if (!(await latestConsent(ctx, "avatar_ai"))) {
    throw new AppError(403, "consent-required", "Consent needed", "Realistic try-on sends your avatar photo to a third-party AI. Turn it on first.");
  }
  let avatarId = input.avatarPhotoId;
  if (!avatarId) {
    const { data } = await ctx.supabase.from("avatar_photos").select("id").eq("is_primary", true).maybeSingle();
    avatarId = data?.id;
  }
  if (!avatarId) throw errors.badRequest("Add a photo to your avatar first");
  const { data: avatar } = await ctx.supabase.from("avatar_photos").select("id").eq("id", avatarId).maybeSingle();
  if (!avatar) throw errors.notFound("Avatar photo");

  let itemIds = input.itemIds ?? [];
  if (input.outfitId) {
    const rows = must(await ctx.supabase.from("outfit_items").select("item_id").eq("outfit_id", input.outfitId), "Load outfit") as { item_id: string }[];
    if (!rows.length) throw errors.notFound("Outfit");
    itemIds = rows.map((r) => r.item_id);
  }
  const items = must(await ctx.supabase.from("wardrobe_items").select("id,category").in("id", itemIds).eq("status", "ready"), "Load items") as { id: string; category: string }[];
  if (items.length !== new Set(itemIds).size) throw errors.badRequest("Some items are missing or not ready");
  if (!items.some((i) => ["top", "outer", "one_piece", "bottom"].includes(i.category))) {
    throw errors.badRequest("AI try-on dresses clothes, not shoes or accessories: include a top, bottom, layer or dress");
  }

  const { data: count, error } = await ctx.supabase.rpc("take_usage", { p_kind: "tryon_calls", p_cap: DAILY_AI_TRYONS });
  if (error) throw new Error(error.message);
  if (count === -1) throw errors.quota(`You can make ${DAILY_AI_TRYONS} AI try-ons a day. The instant preview has no limit.`);

  return must(
    await ctx.supabase
      .from("tryon_results")
      .insert({ user_id: ctx.userId, avatar_photo_id: avatarId, outfit_id: input.outfitId ?? null, item_ids: itemIds, engine: "ai" })
      .select("id,status")
      .single(),
    "Create try-on",
  ) as { id: string; status: string };
}

export async function listTryOns(ctx: AuthedContext) {
  const rows = must(
    await ctx.supabase.from("tryon_results").select("id,status,engine,error,result_path,outfit_id,avatar_photo_id,item_ids,created_at,finished_at").order("created_at", { ascending: false }).limit(20),
    "List try-ons",
  ) as { id: string; status: string; engine: string; error: string | null; result_path: string | null; outfit_id: string | null; avatar_photo_id: string | null; item_ids: string[]; created_at: string; finished_at: string | null }[];
  const paths = rows.map((r) => r.result_path).filter((p): p is string => Boolean(p));
  const urls = await signedUrls(ctx.supabase, BUCKET, paths);
  return rows.map(({ result_path, ...r }) => ({ ...r, imageUrl: result_path ? urls.get(result_path) ?? null : null }));
}

export async function deleteTryOn(ctx: AuthedContext, id: string) {
  const { data } = await ctx.supabase.from("tryon_results").select("result_path").eq("id", id).maybeSingle();
  if (!data) throw errors.notFound("Try-on");
  must(await ctx.supabase.from("tryon_results").delete().eq("id", id), "Delete try-on");
  if (data.result_path) await ctx.supabase.storage.from(BUCKET).remove([data.result_path]);
}

// ---------------------------------------------------------------------------
// Job side (service role): runs queued AI try-ons.
// ---------------------------------------------------------------------------

type Job = { msg_id: number; read_ct: number; message: { tryon_id: string; user_id: string } };

async function download(path: string | null): Promise<Buffer | null> {
  if (!path) return null;
  const { data, error } = await adminClient().storage.from(BUCKET).download(path);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

export async function runTryOnJobs(requestId: string) {
  const db = adminClient();
  // Two at a time: each can take a minute or more on a free GPU queue.
  const { data, error } = await db.rpc("read_tryon_jobs", { p_qty: 1, p_vt: 420 });
  if (error) throw new Error(`read_tryon_jobs: ${error.message}`);
  const jobs = (data ?? []) as Job[];
  for (const job of jobs) await processTryOn(job, requestId);
  return jobs.length;
}

async function handToTryonService(
  job: Job,
  row: { id: string; avatar_photo_id: string; item_ids: string[] },
  fail: (message: string) => Promise<void>,
  requestId: string,
) {
  const db = adminClient();
  const { user_id: userId } = job.message;
  const { data: avatar } = await db.from("avatar_photos").select("path,pose").eq("id", row.avatar_photo_id).eq("user_id", userId).maybeSingle();
  if (!avatar) return fail("The avatar photo was deleted");
  const { data: items } = await db
    .from("wardrobe_items")
    .select("id,category,subcategory,colors,pattern,fabric,image_path,clean_path,cutout_path,updated_at")
    .in("id", row.item_ids)
    .eq("user_id", userId);
  if (!items?.length) return fail("The clothes for this try-on are missing");
  const landmarks = (avatar.pose as { landmarks?: { x: number; y: number; visibility?: number }[] } | null)?.landmarks;
  const body: RenderRequest = {
    jobId: row.id,
    userId,
    personImagePath: avatar.path,
    avatarVersion: null,
    garments: items.map((it) => ({
      itemId: it.id,
      slot: (slotFor(it) ?? it.category) as RenderRequest["garments"][number]["slot"],
      description: [it.colors?.[0], it.pattern !== "solid" ? it.pattern : null, it.fabric, it.subcategory ?? it.category].filter(Boolean).join(" ").slice(0, 120),
      imagePath: it.clean_path ?? it.image_path,
      cutoutPath: it.cutout_path,
      updatedAt: it.updated_at,
    })),
    pose: landmarks?.length === 33 ? landmarks.map((p) => ({ x: p.x, y: p.y, visibility: p.visibility ?? null })) : null,
  };
  try {
    await callService("tryon", "POST", "/v1/renders", body);
    await db.rpc("finish_tryon_job", { p_msg_id: job.msg_id });
  } catch (err) {
    if (err instanceof ServiceError && err.status >= 400 && err.status < 500) {
      log("error", "try-on service refused the render", { requestId, id: row.id, ...errorFields(err) });
      return fail(err.problem?.detail ?? "AI try-on couldn't start for this outfit.");
    }
    // Asleep or unreachable: the queue message reappears after its visibility timeout.
    log("warn", "try-on service unreachable; will retry", { requestId, id: row.id, ...errorFields(err) });
  }
}

async function processTryOn(job: Job, requestId: string) {
  const db = adminClient();
  const { tryon_id: id, user_id: userId } = job.message;
  const fail = async (message: string) => {
    await db.from("tryon_results").update({ status: "failed", error: message, finished_at: new Date().toISOString() }).eq("id", id).eq("user_id", userId);
    await db.rpc("give_up_tryon_job", { p_msg_id: job.msg_id });
  };

  const { data: row } = await db.from("tryon_results").select("id,status,avatar_photo_id,item_ids").eq("id", id).eq("user_id", userId).maybeSingle();
  if (!row || row.status !== "pending") {
    await db.rpc("finish_tryon_job", { p_msg_id: job.msg_id });
    return;
  }
  // With the try-on service switched on (TRYON_URL), it renders (and caches) and reports back.
  if (serviceEnabled("tryon")) return handToTryonService(job, row, fail, requestId);
  try {
    const { data: avatar } = await db.from("avatar_photos").select("path,pose").eq("id", row.avatar_photo_id).eq("user_id", userId).maybeSingle();
    if (!avatar) return fail("The avatar photo was deleted");
    const { data: items } = await db
      .from("wardrobe_items")
      .select("id,category,subcategory,colors,pattern,fabric,image_path,clean_path,cutout_path")
      .in("id", row.item_ids)
      .eq("user_id", userId);
    const person = await download(avatar.path);
    if (!person || !items?.length) return fail("Photos for this try-on are missing");

    const garments: TryOnGarment[] = [];
    for (const it of items) {
      const photo = await download(it.clean_path ?? it.image_path);
      if (!photo) continue;
      garments.push({
        id: it.id,
        slot: slotFor(it) ?? it.category,
        subcategory: it.subcategory,
        description: [it.colors?.[0], it.pattern !== "solid" ? it.pattern : null, it.fabric, it.subcategory ?? it.category].filter(Boolean).join(" "),
        photo,
        cutout: await download(it.cutout_path),
      });
    }

    const result = await aiTryOn({ person, pose: avatar.pose as Pose, garments, userId, requestId });
    const path = `${userId}/tryon/${id}.webp`;
    const up = await db.storage.from(BUCKET).upload(path, await sharp(result.image).webp({ quality: 85 }).toBuffer(), { contentType: "image/webp", upsert: true, cacheControl: PHOTO_CACHE_CONTROL });
    if (up.error) throw new Error(`upload: ${up.error.message}`);
    await db
      .from("tryon_results")
      .update({ status: "ready", result_path: path, engine: `ai:${result.modelKey}`, error: result.note ?? null, finished_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", userId);
    await db.rpc("finish_tryon_job", { p_msg_id: job.msg_id });
  } catch (err) {
    log("error", "try-on job failed", { requestId, id, ...errorFields(err) });
    if (err instanceof AiUnavailableError) {
      if (err.attempts.some((a) => /IndexError/.test(a.error ?? ""))) {
        return fail("The AI couldn't find a body in this photo. Use a clear, front-facing photo showing your upper body.");
      }
      const hint = err.attempts.map((a) => retryHint(a.error ?? "")).find(Boolean);
      return fail(
        err.reason === "quota"
          ? `The free AI try-on GPU quota is used up${hint ? `; it resets ${hint}` : " for now"}. Adding a free Hugging Face token (HF_TOKEN) gives you your own quota. The instant preview still works.`
          : "The AI try-on service is unavailable right now. The instant preview still works.",
      );
    }
    if (job.read_ct >= 2) return fail("AI try-on failed. Please try again later.");
    // Otherwise the job reappears after its visibility timeout and is retried once.
  }
}
