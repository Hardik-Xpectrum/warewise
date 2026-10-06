import "server-only";
import sharp from "sharp";
import { adminClient } from "@/lib/supabase/admin";
import { log } from "@/modules/platform/log";
import { planPasses } from "@/modules/tryon/plan";
import { placeGarments, type Pose } from "@/modules/tryon/placement";
import { AiUnavailableError, type Attempt } from "./chain";
import { loadAiConfig, type ModelConfig } from "./config";

export type TryOnGarment = {
  id: string;
  slot: string;
  subcategory: string | null;
  description: string;
  photo: Buffer; // garment photo as uploaded (with background), for AI models
  cutout: Buffer | null; // transparent cut-out, for compositing
};

export type TryOnRequest = {
  person: Buffer; // avatar cut-out, transparent
  pose: Pose;
  garments: TryOnGarment[];
  userId: string;
  requestId: string;
};

export type TryOnResult = { image: Buffer; modelKey: string; note?: string };

/** Lays garment cut-outs over the avatar with sharp: the same placement as the browser preview. */
async function composite(req: TryOnRequest): Promise<Buffer> {
  const base = sharp(req.person);
  const { width = 768, height = 1024 } = await base.metadata();
  const usable = req.garments.filter((g) => g.cutout);
  const inputs = await Promise.all(
    usable.map(async (g) => {
      const m = await sharp(g.cutout!).metadata();
      return { g, aspect: (m.width ?? 1) / (m.height ?? 1) };
    }),
  );
  const boxes = placeGarments(req.pose, width, height, inputs.map(({ g, aspect }) => ({ id: g.id, slot: g.slot, subcategory: g.subcategory, aspect })));
  const layers = await Promise.all(
    boxes.map(async (b) => {
      const g = usable.find((x) => x.id === b.id)!;
      const input = await sharp(g.cutout!).resize(Math.max(1, Math.round(b.w)), Math.max(1, Math.round(b.h)), { fit: "fill" }).toBuffer();
      return { input, left: Math.round(b.x), top: Math.round(b.y) };
    }),
  );
  // Garments may hang past the photo edge; extend the canvas, composite, then crop back.
  // sharp runs extract before extend inside one pipeline, so this takes two passes.
  const pad = Math.round(Math.max(width, height) * 0.5);
  const padded = await sharp(req.person)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .composite(layers.map((l) => ({ ...l, left: l.left + pad, top: l.top + pad })))
    .png()
    .toBuffer();
  return sharp(padded).extract({ left: pad, top: pad, width, height }).flatten({ background: "#f4f1ec" }).webp({ quality: 85 }).toBuffer();
}

/** Person or garment photo as the try-on models expect it: 768 x 1024 JPEG on white. */
async function modelInput(image: Buffer, margin = 0): Promise<Buffer> {
  const inner = await sharp(image).flatten({ background: "#ffffff" }).resize(Math.round(768 * (1 - 2 * margin)), Math.round(1024 * (1 - 2 * margin)), { fit: "contain", background: "#ffffff" }).toBuffer();
  return sharp(inner).resize(768, 1024, { fit: "contain", background: "#ffffff" }).jpeg({ quality: 92 }).toBuffer();
}

async function fetchResult(url: string, token: string | undefined): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`Could not fetch try-on image: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

type Gradio = Awaited<ReturnType<typeof import("@gradio/client").Client.connect>>;
type Pass = ReturnType<typeof planPasses>[number];

/**
 * One garment onto the current image with one model. IDM-VTON (upper body only) asks the free
 * GPU for about 60 s per run; Leffa (upper, lower and dresses) for 120 s or more, so tops go to
 * IDM-VTON first and Leffa takes the rest. Both are free Hugging Face ZeroGPU Spaces with a small
 * daily GPU allowance (larger with a free HF_TOKEN) and non-commercial licences.
 */
async function runPass(model: ModelConfig, app: Gradio, pass: Pass, garment: TryOnGarment, current: Buffer, token: string | undefined): Promise<Buffer> {
  const { handle_file } = await import("@gradio/client");
  const person = handle_file(new Blob([new Uint8Array(current)], { type: "image/jpeg" }));
  // The garment alone on white, as these models were trained on: the cut-out when there is one
  // (no hanger, room or person wearing it), else the photo.
  const garm = handle_file(new Blob([new Uint8Array(await modelInput(garment.cutout ?? garment.photo, garment.cutout ? 0.08 : 0))], { type: "image/jpeg" }));
  const result =
    model.provider === "hf-idm-vton"
      ? await app.predict("/tryon", {
          dict: { background: person, layers: [], composite: null },
          garm_img: garm,
          garment_des: garment.description,
          is_checked: true,
          is_checked_crop: false,
          denoise_steps: 30,
          seed: 42,
        })
      : await app.predict("/leffa_predict_vt", {
          src_image_path: person,
          ref_image_path: garm,
          ref_acceleration: false,
          step: 30,
          scale: 2.5,
          seed: 42,
          vt_model_type: pass.model,
          vt_garment_type: pass.region,
          vt_repaint: false,
        });
  const out = (result.data as { url?: string }[])[0];
  if (!out?.url) throw new Error("Try-on model returned no image");
  return sharp(await fetchResult(out.url, token)).resize(768, 1024, { fit: "contain", background: "#ffffff" }).jpeg({ quality: 92 }).toBuffer();
}

/** Which models can do a pass, cheapest GPU request first. */
function modelsFor(pass: Pass, available: { key: string; model: ModelConfig }[]) {
  const idm = available.filter((m) => m.model.provider === "hf-idm-vton");
  const leffa = available.filter((m) => m.model.provider === "hf-leffa");
  return pass.region === "upper_body" ? [...idm, ...leffa] : leffa;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  // The Gradio client rejects with plain objects or strings, e.g. 'IndexError' when no person is found.
  if (typeof err === "object" && err) return JSON.stringify(err);
  return String(err);
}

function isQuotaError(err: unknown) {
  return /quota|exceeded|rate limit|429/i.test(errorMessage(err));
}

/**
 * Dresses the avatar photo in the outfit, one garment per pass (a dress; or the top, then the
 * bottom on that result), each pass on the cheapest model that can do it, falling back to the next.
 * If a later pass can't run, the partly dressed result is kept with a note. The models come from
 * the `tryon` job's chain in config; a `composite` entry is the offline last resort.
 */
export async function aiTryOn(req: TryOnRequest): Promise<TryOnResult> {
  const config = loadAiConfig();
  const job = config.jobs.tryon;
  if (!job) throw new Error('No "tryon" job in the AI config');
  const attempts: Attempt[] = [];
  let quotaOnly = true;

  const available: { key: string; model: ModelConfig }[] = [];
  for (const key of job.chain) {
    const model = config.models[key];
    if (!["hf-idm-vton", "hf-leffa"].includes(model.provider)) continue;
    if (model.apiKeyEnv && !process.env[model.apiKeyEnv] && !model.tokenOptional) {
      attempts.push({ modelKey: key, providerModel: model.model, status: "skipped", error: "no api key" });
      continue;
    }
    available.push({ key, model });
  }

  const passes = planPasses(req.garments);
  const started = Date.now();
  const apps = new Map<string, Gradio>();
  let current = await modelInput(req.person);
  const done: string[] = [];
  const used = new Set<string>();
  let stopped = "";

  if (available.length && passes.length) {
    for (const pass of passes) {
      const garment = req.garments.find((g) => g.id === pass.garmentId)!;
      let dressed = false;
      for (const { key, model } of modelsFor(pass, available)) {
        if (model.limits.perMinute || model.limits.perDay) {
          const { data } = await adminClient().rpc("take_model_quota", { p_model: key, p_per_minute: model.limits.perMinute ?? null, p_per_day: model.limits.perDay ?? null });
          if (data === false) {
            attempts.push({ modelKey: key, providerModel: model.model, status: "skipped", error: "free quota used" });
            continue;
          }
        }
        const t = Date.now();
        try {
          const token = model.apiKeyEnv ? process.env[model.apiKeyEnv] : undefined;
          if (!apps.has(key)) {
            const { Client } = await import("@gradio/client");
            apps.set(key, await Client.connect(model.space!, token ? { token: token as `hf_${string}` } : {}));
          }
          current = await runPass(model, apps.get(key)!, pass, garment, current, token);
          attempts.push({ modelKey: key, providerModel: model.model, status: "ok", latencyMs: Date.now() - t });
          done.push(`${pass.label}: ${garment.description}`);
          used.add(key);
          dressed = true;
          break;
        } catch (err) {
          if (!isQuotaError(err)) quotaOnly = false;
          const message = errorMessage(err).slice(0, 300);
          attempts.push({ modelKey: key, providerModel: model.model, status: "error", error: message, latencyMs: Date.now() - t });
          log("warn", "try-on model failed", { requestId: req.requestId, modelKey: key, pass: pass.label, error: message });
        }
      }
      if (!dressed) {
        // Later garments go on top of this one, so stop here (keeping anything already dressed).
        stopped = `The ${pass.label} was skipped: ${quotaOnly ? "the free GPU time ran out" : "the AI couldn't dress it"}.`;
        break;
      }
    }
  }

  if (done.length) {
    const note = `AI dressed the ${done.join(" and ")}.${stopped ? ` ${stopped}` : ""}`;
    const modelKey = [...used].join("+");
    await adminClient().from("ai_interactions").insert({
      user_id: req.userId, job: "tryon", model_key: modelKey, provider_model: modelKey, prompt_version: job.promptVersion,
      request: { garments: req.garments.map((g) => ({ slot: g.slot, description: g.description })) }, response: { note },
      latency_ms: Date.now() - started, status: "ok", request_id: req.requestId,
    });
    return { image: await sharp(current).webp({ quality: 85 }).toBuffer(), modelKey, note };
  }

  // No AI model could dress anything: the offline composite, if the config allows it.
  if (job.chain.some((k) => config.models[k]?.provider === "composite")) {
    return { image: await composite(req), modelKey: "composite", note: "Composite preview (offline engine)" };
  }
  await adminClient().from("ai_interactions").insert({
    user_id: req.userId, job: "tryon", status: "error", error: attempts.map((a) => `${a.modelKey}=${a.error ?? a.status}`).join(", "), request_id: req.requestId,
  });
  throw new AiUnavailableError(passes.length && quotaOnly ? "quota" : "failed", attempts);
}
