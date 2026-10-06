import "server-only";
// 3D avatar models: an image-to-3D API turns the user's avatar photo (or a realistic try-on image,
// so the model wears the outfit) into a textured GLB. Runs as a background job because providers
// take 1–3 minutes; a slow job saves the provider's task id and resumes on the next run.
import sharp from "sharp";
import { z } from "zod";
import { adminClient } from "@/lib/supabase/admin";
import { loadAiConfig } from "@/modules/ai/config";
import { downloadGlb, poll3d, submit3d, type Ref3d } from "@/modules/ai/model3d";
import { signedUrls } from "@/modules/media/signing";
import { AppError, errors } from "@/modules/platform/errors";
import { must, type AuthedContext } from "@/modules/platform/http";
import { errorFields, log } from "@/modules/platform/log";
import { BUCKET } from "@/modules/wardrobe/service";
import { retryHint } from "./plan";
import type { BuildAvatarRequest } from "@warewise/contracts";
import { callService, serviceEnabled, ServiceError } from "@/modules/services/client";

export const DAILY_3D_MODELS = 3; // each model costs real money on the provider
const POLL_BUDGET_MS = 200_000; // stay under the job route's 300 s limit, then resume next run
const JOB_VISIBILITY_S = 280;

const ScanViews = z.object({ front: z.string(), back: z.string(), left: z.string(), right: z.string() });
export type ScanViews = z.infer<typeof ScanViews>;

export const CreateModelSchema = z.discriminatedUnion("source", [
  z.object({ source: z.enum(["avatar", "tryon"]), sourceId: z.uuid() }),
  // A 360° body scan: four cut-out views the phone picked from a turn video.
  z.object({ source: z.literal("scan"), views: ScanViews }),
]);

type Row = {
  id: string;
  user_id: string;
  source_kind: "avatar" | "tryon" | "scan";
  source_id: string;
  scan_views: ScanViews | null;
  status: string;
  engine: string | null;
  provider_ref: Ref3d | null;
};

/** Models in the avatar3d chain that can run now (their API key is set, or they need none). */
function configuredChain() {
  const config = loadAiConfig();
  const job = config.jobs.avatar3d;
  if (!job) return [];
  return job.chain
    .map((key) => ({ key, model: config.models[key] }))
    // Usable when it needs no key (mock, token-optional free Spaces) or its key is set.
    .filter(({ model }) => model && (model.provider === "mock-3d" || model.tokenOptional || (model.apiKeyEnv && process.env[model.apiKeyEnv])));
}

export function model3dAvailable() {
  return serviceEnabled("avatar") || configuredChain().length > 0;
}

export async function createAvatarModel(ctx: AuthedContext, input: z.infer<typeof CreateModelSchema>) {
  const { data: consent } = await ctx.supabase.from("consents").select("granted").eq("kind", "avatar_ai").order("decided_at", { ascending: false }).limit(1).maybeSingle();
  if (consent?.granted !== true) {
    throw new AppError(403, "consent-required", "Consent needed", "A 3D model sends your photo to a third-party 3D service. Turn on AI try-on consent first.");
  }
  if (!model3dAvailable()) {
    throw new AppError(503, "not-configured", "3D models aren't set up", "Add FAL_KEY, TRIPO_API_KEY or MESHY_API_KEY to the server's environment to enable AI 3D avatars.");
  }
  // The source must be the user's own (RLS) and, for try-ons, finished.
  let sourceId: string;
  let scanViews: ScanViews | null = null;
  if (input.source === "scan") {
    // Views must be this user's own scan uploads (the insert policy checks the same).
    const own = Object.values(input.views).every((p) => p.startsWith(`${ctx.userId}/scan/`) && !p.includes(".."));
    if (!own) throw errors.badRequest("Scan views must be your own scan uploads");
    scanViews = input.views;
    sourceId = crypto.randomUUID(); // a scan has no other row to point at; this id names it
  } else if (input.source === "avatar") {
    const { data } = await ctx.supabase.from("avatar_photos").select("id").eq("id", input.sourceId).maybeSingle();
    if (!data) throw errors.notFound("Avatar photo");
    sourceId = input.sourceId;
  } else {
    const { data } = await ctx.supabase.from("tryon_results").select("id,status").eq("id", input.sourceId).maybeSingle();
    if (!data) throw errors.notFound("Try-on");
    if (data.status !== "ready") throw errors.badRequest("That try-on isn't finished yet");
    sourceId = input.sourceId;
  }
  const { data: count, error } = await ctx.supabase.rpc("take_usage", { p_kind: "model3d_calls", p_cap: DAILY_3D_MODELS });
  if (error) throw new Error(error.message);
  if (count === -1) throw errors.quota(`You can make ${DAILY_3D_MODELS} 3D models a day.`);
  return must(
    await ctx.supabase.from("avatar_models").insert({ user_id: ctx.userId, source_kind: input.source, source_id: sourceId, scan_views: scanViews }).select("id,status").single(),
    "Queue 3D model",
  ) as { id: string; status: string };
}

export async function listAvatarModels(ctx: AuthedContext) {
  const rows = must(
    await ctx.supabase.from("avatar_models").select("id,source_kind,source_id,status,engine,model_path,bytes,error,created_at").order("created_at", { ascending: false }).limit(10),
    "List 3D models",
  ) as { id: string; source_kind: string; source_id: string; status: string; engine: string | null; model_path: string | null; bytes: number | null; error: string | null; created_at: string }[];
  const urls = await signedUrls(ctx.supabase, BUCKET, rows.map((r) => r.model_path).filter((p): p is string => Boolean(p)));
  return {
    available: model3dAvailable(),
    dailyLimit: DAILY_3D_MODELS,
    models: rows.map(({ model_path, ...r }) => ({ ...r, url: model_path ? urls.get(model_path) ?? null : null })),
  };
}

export async function deleteAvatarModel(ctx: AuthedContext, id: string) {
  const { data } = await ctx.supabase.from("avatar_models").select("model_path").eq("id", id).maybeSingle();
  if (!data) throw errors.notFound("3D model");
  if (data.model_path) await adminClient().storage.from(BUCKET).remove([data.model_path]);
  must(await ctx.supabase.from("avatar_models").delete().eq("id", id), "Delete 3D model");
}

// ---------------------------------------------------------------------------------------------
// Job runner (service role)
// ---------------------------------------------------------------------------------------------

type Job = { msg_id: number; read_ct: number; message: { model_id: string; user_id: string } };

export async function runModel3dJobs(requestId: string): Promise<number> {
  const db = adminClient();
  const { data, error } = await db.rpc("read_model3d_jobs", { p_qty: 1, p_vt: JOB_VISIBILITY_S });
  if (error) throw new Error(`read_model3d_jobs: ${error.message}`);
  const jobs = (data ?? []) as Job[];
  for (const job of jobs) await processModel(job, requestId);
  return jobs.length;
}

/** The Storage path of a model's source image (a scan's front view for scans). */
async function sourcePath(row: Row): Promise<string | null> {
  const db = adminClient();
  if (row.source_kind === "scan") return row.scan_views?.front ?? null;
  return row.source_kind === "avatar"
    ? ((await db.from("avatar_photos").select("path").eq("id", row.source_id).eq("user_id", row.user_id).maybeSingle()).data?.path ?? null)
    : ((await db.from("tryon_results").select("result_path").eq("id", row.source_id).eq("user_id", row.user_id).maybeSingle()).data?.result_path ?? null);
}

/** The source photo as providers want it: a JPEG on white, at most 1024 px. Without the avatar
 * service, a scan is built from its front view only (the in-app engines take one image). */
async function sourceImage(row: Row): Promise<Buffer | null> {
  const db = adminClient();
  const path = await sourcePath(row);
  if (!path) return null;
  const { data } = await db.storage.from(BUCKET).download(path);
  if (!data) return null;
  return sharp(Buffer.from(await data.arrayBuffer()))
    .flatten({ background: "#ffffff" })
    .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 92 })
    .toBuffer();
}

async function handToAvatarService(job: Job, row: Row, fail: (message: string) => Promise<void>, requestId: string) {
  const db = adminClient();
  const path = await sourcePath(row);
  if (!path) return fail("The source photo was deleted");
  const { data: profile } = await db.from("profiles").select("body_profile").eq("id", row.user_id).maybeSingle();
  const bp = (profile?.body_profile ?? {}) as { height_cm?: number | null; top_size?: string; waist_in?: number | null; shoe_uk?: number | null };
  const body: BuildAvatarRequest = {
    jobId: row.id,
    userId: row.user_id,
    // A 360° scan sends all four views (built with a multi-view engine); otherwise one photo.
    kind: row.scan_views ? "body360" : "photo",
    views: row.scan_views ?? { front: path },
    heightCm: bp.height_cm ?? null,
    sizes: { topSize: bp.top_size ?? null, waistIn: bp.waist_in ?? null, shoeUk: bp.shoe_uk ?? null },
  };
  try {
    await callService("avatar", "POST", "/v1/avatars/build", body);
    await db.from("avatar_models").update({ engine: "service:avatar", provider_ref: { service: "avatar" } }).eq("id", row.id).eq("user_id", row.user_id);
    await db.rpc("finish_model3d_job", { p_msg_id: job.msg_id });
  } catch (err) {
    if (err instanceof ServiceError && err.status >= 400 && err.status < 500) {
      log("error", "avatar service refused the build", { requestId, id: row.id, ...errorFields(err) });
      return fail(err.problem?.detail ?? "The 3D avatar couldn't start.");
    }
    log("warn", "avatar service unreachable; will retry", { requestId, id: row.id, ...errorFields(err) });
  }
}

async function processModel(job: Job, requestId: string) {
  const db = adminClient();
  const { model_id: id, user_id: userId } = job.message;
  const update = (patch: Record<string, unknown>) => db.from("avatar_models").update(patch).eq("id", id).eq("user_id", userId);
  const fail = async (message: string) => {
    await update({ status: "failed", error: message, provider_ref: null, finished_at: new Date().toISOString() });
    await db.rpc("give_up_model3d_job", { p_msg_id: job.msg_id });
  };

  const { data } = await db.from("avatar_models").select("id,user_id,source_kind,source_id,scan_views,status,engine,provider_ref").eq("id", id).eq("user_id", userId).maybeSingle();
  const row = data as Row | null;
  if (!row || row.status !== "pending") {
    await db.rpc("finish_model3d_job", { p_msg_id: job.msg_id });
    return;
  }

  // With the avatar service switched on (AVATAR_URL), it builds and versions the model and reports back.
  if (serviceEnabled("avatar")) return handToAvatarService(job, row, fail, requestId);

  try {
    const config = loadAiConfig();
    let ref = row.provider_ref;
    // 1. Submit to the first configured provider that accepts it (unless a previous run already did).
    if (!ref) {
      const image = await sourceImage(row);
      if (!image) return fail("The source photo was deleted");
      const errorsSeen: string[] = [];
      for (const { key, model } of configuredChain()) {
        if (model.limits.perDay || model.limits.perMinute) {
          const { data: ok } = await db.rpc("take_model_quota", { p_model: key, p_per_minute: model.limits.perMinute ?? null, p_per_day: model.limits.perDay ?? null });
          if (ok === false) {
            errorsSeen.push(`${key}: daily quota used`);
            continue;
          }
        }
        try {
          ref = await submit3d(key, model, image);
          await update({ provider_ref: ref, engine: key });
          break;
        } catch (err) {
          errorsSeen.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
          log("warn", "3D provider submit failed", { requestId, key, error: errorsSeen.at(-1) });
        }
      }
      if (!ref) {
        const all = errorsSeen.join("; ");
        if (/quota|exceeded/i.test(all)) {
          const hint = retryHint(all);
          return fail(
            `The free 3D service's GPU quota is used up${hint ? `; it resets ${hint}` : " for today"}. A free Hugging Face token (HF_TOKEN) gives your own quota, or add a fal.ai, Tripo or Meshy key.`,
          );
        }
        return fail(`No 3D service could take the photo right now. ${all.slice(0, 300)}`);
      }
    }

    // 2. Poll until done, within this run's time budget; otherwise the job resumes on the next run.
    const model = config.models[ref.modelKey];
    const started = Date.now();
    for (;;) {
      const r = await poll3d(model, ref);
      if (r.state === "failed") return fail(r.error.slice(0, 300));
      if (r.state === "done") {
        const glb = r.glb ?? (await downloadGlb(r.glbUrl!));
        const path = `${userId}/models/${id}.glb`;
        const up = await db.storage.from(BUCKET).upload(path, glb, { contentType: "model/gltf-binary", upsert: true, cacheControl: "604800" });
        if (up.error) throw new Error(`upload: ${up.error.message}`);
        await update({ status: "ready", model_path: path, bytes: glb.length, provider_ref: null, finished_at: new Date().toISOString() });
        await db.from("ai_interactions").insert({
          user_id: userId, job: "avatar3d", model_key: ref.modelKey, provider_model: model.model, prompt_version: "v1",
          request: { source: row.source_kind }, response: { bytes: glb.length }, latency_ms: Date.now() - started, status: "ok", request_id: requestId,
        });
        await db.rpc("finish_model3d_job", { p_msg_id: job.msg_id });
        return;
      }
      if (Date.now() - started > POLL_BUDGET_MS) return; // still generating: the message reappears after its visibility timeout
      await new Promise((res) => setTimeout(res, 3000));
    }
  } catch (err) {
    log("error", "3D model job failed", { requestId, id, ...errorFields(err) });
    if (job.read_ct >= 4) return fail("Making the 3D model failed. Please try again later.");
    // Otherwise the job reappears after its visibility timeout and resumes (the provider task id is saved).
  }
}
