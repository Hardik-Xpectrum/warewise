import "server-only";
// Image-to-3D providers for the 3D avatar. Each turns one photo into a textured GLB model on the
// provider's GPUs, so the app needs none. Providers are chosen by the "avatar3d" job in the AI
// config: free Hugging Face Spaces first (TRELLIS, Stable Fast 3D), then paid APIs (fal.ai, Tripo,
// Meshy); switching or adding one is a config change.
import type { ModelConfig } from "./config";

export type Ref3d = { modelKey: string; task: string; statusUrl?: string; resultUrl?: string };
export type Poll3d = { state: "running"; progress?: number } | { state: "done"; glbUrl?: string; glb?: Buffer } | { state: "failed"; error: string };

const MAX_GLB_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Response parsers: pure, so they are unit-tested without calling (and paying for) the APIs.
// ---------------------------------------------------------------------------------------------

/** fal.ai queue status: IN_QUEUE | IN_PROGRESS | COMPLETED (errors come back as COMPLETED + error on the result). */
export function parseFalStatus(json: unknown): "running" | "completed" {
  const status = (json as { status?: string })?.status;
  return status === "COMPLETED" ? "completed" : "running";
}

/** fal.ai result: Trellis returns model_mesh; other 3D models use model_glb / model. */
export function parseFalResult(json: unknown): Poll3d {
  const j = json as { model_mesh?: { url?: string }; model_glb?: { url?: string }; model?: { url?: string }; detail?: unknown; error?: unknown };
  const url = j?.model_mesh?.url ?? j?.model_glb?.url ?? j?.model?.url;
  if (url) return { state: "done", glbUrl: url };
  return { state: "failed", error: `fal.ai returned no model${j?.detail || j?.error ? `: ${JSON.stringify(j.detail ?? j.error).slice(0, 200)}` : ""}` };
}

/** Tripo v3: { code, data: { status: queued|running|success|failed|cancelled|banned, progress, output: { model_url } } }. */
export function parseTripoTask(json: unknown): Poll3d {
  const j = json as { code?: number; message?: string; data?: { status?: string; progress?: number; output?: { model_url?: string; pbr_model_url?: string } } };
  if (j?.code !== 0) return { state: "failed", error: `Tripo error ${j?.code}: ${j?.message ?? "unknown"}` };
  const d = j.data ?? {};
  if (d.status === "success") {
    const url = d.output?.pbr_model_url ?? d.output?.model_url;
    return url ? { state: "done", glbUrl: url } : { state: "failed", error: "Tripo finished without a model URL" };
  }
  if (d.status === "failed" || d.status === "cancelled" || d.status === "banned") return { state: "failed", error: `Tripo task ${d.status}` };
  return { state: "running", progress: d.progress };
}

/** Meshy: { status: PENDING|IN_PROGRESS|SUCCEEDED|FAILED|CANCELED, progress, model_urls: { glb }, task_error: { message } }. */
export function parseMeshyTask(json: unknown): Poll3d {
  const j = json as { status?: string; progress?: number; model_urls?: { glb?: string }; task_error?: { message?: string } };
  if (j?.status === "SUCCEEDED") return j.model_urls?.glb ? { state: "done", glbUrl: j.model_urls.glb } : { state: "failed", error: "Meshy finished without a GLB" };
  if (j?.status === "FAILED" || j?.status === "CANCELED") return { state: "failed", error: `Meshy task ${j.status.toLowerCase()}${j.task_error?.message ? `: ${j.task_error.message}` : ""}` };
  return { state: "running", progress: j?.progress };
}

/** A GLB starts with the ASCII magic "glTF" and version 2. */
export function isGlb(buf: Buffer): boolean {
  return buf.length > 20 && buf.toString("ascii", 0, 4) === "glTF" && buf.readUInt32LE(4) === 2;
}

// ---------------------------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------------------------

function key(model: ModelConfig): string {
  const k = model.apiKeyEnv ? process.env[model.apiKeyEnv] : undefined;
  if (!k) throw new Error(`${model.apiKeyEnv ?? "API key"} is not set`);
  return k;
}

async function json(res: Response, what: string): Promise<unknown> {
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  if (!res.ok) throw new Error(`${what} failed (${res.status}): ${typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)}`);
  return body;
}

const dataUri = (jpeg: Buffer) => `data:image/jpeg;base64,${jpeg.toString("base64")}`;

/** Output file URL from a Gradio result: the first FileData with a .glb path. */
export function gradioGlbUrl(data: unknown): string | null {
  const walk = (v: unknown): string | null => {
    if (!v || typeof v !== "object") return null;
    const f = v as { url?: string; path?: string };
    if (typeof f.url === "string" && /\.glb($|\?)/i.test(f.path ?? f.url)) return f.url;
    for (const x of Array.isArray(v) ? v : Object.values(v)) {
      const hit = walk(x);
      if (hit) return hit;
    }
    return null;
  };
  return walk(data);
}

/**
 * Free Hugging Face Spaces run the whole generation in one call (about 20–60 s on ZeroGPU), so
 * "submit" waits for the result and "poll" just hands back the file URL.
 */
async function hfSpace3d(model: ModelConfig, image: Buffer): Promise<string> {
  const { Client, handle_file } = await import("@gradio/client");
  const token = model.apiKeyEnv ? process.env[model.apiKeyEnv] : undefined;
  const app = await Client.connect(model.space!, token ? { token: token as `hf_${string}` } : {});
  const file = () => handle_file(new Blob([new Uint8Array(image)], { type: "image/png" }));
  const run = async () => {
    if (model.provider === "hf-trellis") {
      // The Space keeps each visitor's files in a session folder that its page creates on load;
      // without /start_session first, generation fails with FileNotFoundError. Its own
      // preprocessing (cropping, background) then feeds the generator, as in the web page.
      await app.predict("/start_session", {});
      const pre = await app.predict("/preprocess_image", { image: file() });
      const prepared = (pre.data as unknown[])[0] ?? file();
      // Positional: the endpoint has an unnamed input in third place (the multi-image mode state).
      return app.predict("/generate_and_extract_glb", [prepared, [], null, 0, 7.5, 12, 3, 12, "stochastic", 0.95, 1024]);
    }
    // Stable Fast 3D: its background-removal step produces the image the generator reads.
    const bg = await app.predict("/requires_bg_remove", [file(), 0.85]);
    return app.predict("/run_button", [file(), 0.85, (bg.data as unknown[])[1] ?? null, "None", -1, 1024]);
  };
  const result = await Promise.race([run(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("The free 3D service took too long")), 240_000))]);
  const url = gradioGlbUrl(result.data);
  if (!url) throw new Error("The free 3D service returned no model");
  return url;
}

export async function submit3d(modelKey: string, model: ModelConfig, image: Buffer): Promise<Ref3d> {
  const signal = AbortSignal.timeout(60_000);
  switch (model.provider) {
    case "hf-trellis":
    case "hf-sf3d":
      return { modelKey, task: "done", resultUrl: await hfSpace3d(model, image) };
    case "fal-3d": {
      const body = await json(
        await fetch(`https://queue.fal.run/${model.model}`, {
          method: "POST",
          headers: { authorization: `Key ${key(model)}`, "content-type": "application/json" },
          body: JSON.stringify({ image_url: dataUri(image) }),
          signal,
        }),
        "fal.ai submit",
      ) as { request_id: string; status_url?: string; response_url?: string };
      return { modelKey, task: body.request_id, statusUrl: body.status_url, resultUrl: body.response_url };
    }
    case "tripo-3d": {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(image)], { type: "image/jpeg" }), "avatar.jpg");
      const up = await json(
        await fetch("https://openapi.tripo3d.ai/v3/files", { method: "POST", headers: { authorization: `Bearer ${key(model)}` }, body: form, signal }),
        "Tripo upload",
      ) as { code: number; message?: string; data?: { file_token?: string } };
      if (up.code !== 0 || !up.data?.file_token) throw new Error(`Tripo upload error ${up.code}: ${up.message ?? ""}`);
      const task = await json(
        await fetch("https://openapi.tripo3d.ai/v3/generation/image-to-model", {
          method: "POST",
          headers: { authorization: `Bearer ${key(model)}`, "content-type": "application/json" },
          // align_image keeps the model facing the camera like the photo; 50k faces suits the web.
          body: JSON.stringify({ input: up.data.file_token, model: model.model, texture: true, pbr: true, face_limit: 50000, orientation: "align_image" }),
          signal,
        }),
        "Tripo image-to-model",
      ) as { code: number; message?: string; data?: { task_id?: string } };
      if (task.code !== 0 || !task.data?.task_id) throw new Error(`Tripo error ${task.code}: ${task.message ?? ""}`);
      return { modelKey, task: task.data.task_id };
    }
    case "meshy-3d": {
      const body = await json(
        await fetch("https://api.meshy.ai/openapi/v1/image-to-3d", {
          method: "POST",
          headers: { authorization: `Bearer ${key(model)}`, "content-type": "application/json" },
          body: JSON.stringify({ image_url: dataUri(image), ai_model: model.model, should_texture: true, enable_pbr: true, topology: "triangle", target_polycount: 50000 }),
          signal,
        }),
        "Meshy submit",
      ) as { result: string };
      return { modelKey, task: body.result };
    }
    case "mock-3d":
      return { modelKey, task: "mock" };
    default:
      throw new Error(`${model.provider} is not a 3D provider`);
  }
}

export async function poll3d(model: ModelConfig, ref: Ref3d): Promise<Poll3d> {
  const signal = AbortSignal.timeout(30_000);
  switch (model.provider) {
    case "hf-trellis":
    case "hf-sf3d":
      return ref.resultUrl ? { state: "done", glbUrl: ref.resultUrl } : { state: "failed", error: "Missing model URL" };
    case "fal-3d": {
      const base = `https://queue.fal.run/${model.model}/requests/${ref.task}`;
      const headers = { authorization: `Key ${key(model)}` };
      const status = parseFalStatus(await json(await fetch(ref.statusUrl ?? `${base}/status`, { headers, signal }), "fal.ai status"));
      if (status === "running") return { state: "running" };
      return parseFalResult(await json(await fetch(ref.resultUrl ?? base, { headers, signal }), "fal.ai result"));
    }
    case "tripo-3d":
      return parseTripoTask(await json(await fetch(`https://openapi.tripo3d.ai/v3/tasks/${ref.task}`, { headers: { authorization: `Bearer ${key(model)}` }, signal }), "Tripo status"));
    case "meshy-3d":
      return parseMeshyTask(await json(await fetch(`https://api.meshy.ai/openapi/v1/image-to-3d/${ref.task}`, { headers: { authorization: `Bearer ${key(model)}` }, signal }), "Meshy status"));
    case "mock-3d":
      return { state: "done", glb: mockGlb() };
    default:
      return { state: "failed", error: `${model.provider} is not a 3D provider` };
  }
}

/** Downloads the finished model (provider URLs are short-lived) and checks it really is a GLB. */
export async function downloadGlb(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Model download failed (${res.status})`);
  const size = Number(res.headers.get("content-length") ?? 0);
  if (size > MAX_GLB_BYTES) throw new Error(`Model is too large (${Math.round(size / 1e6)} MB)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_GLB_BYTES) throw new Error("Model is too large");
  if (!isGlb(buf)) throw new Error("Provider returned something that isn't a GLB model");
  return buf;
}

/**
 * A tiny valid GLB (a 0.5 × 1.7 × 0.3 m box, roughly a person's bounds) for the mock provider,
 * so tests and offline development exercise the whole pipeline without paid APIs.
 */
export function mockGlb(): Buffer {
  const [w, h, d] = [0.25, 1.7, 0.15];
  const p = [
    [-w, 0, -d], [w, 0, -d], [w, h, -d], [-w, h, -d],
    [-w, 0, d], [w, 0, d], [w, h, d], [-w, h, d],
  ];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  const pos = Buffer.alloc(p.length * 12);
  p.flat().forEach((v, i) => pos.writeFloatLE(v, i * 4));
  const ind = Buffer.alloc(idx.length * 2);
  idx.forEach((v, i) => ind.writeUInt16LE(v, i * 2));
  const bin = Buffer.concat([pos, ind]);
  const gltf = {
    asset: { version: "2.0", generator: "warewise-mock" },
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.length, target: 34962 },
      { buffer: 0, byteOffset: pos.length, byteLength: ind.length, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: p.length, type: "VEC3", min: [-w, 0, -d], max: [w, h, d] },
      { bufferView: 1, componentType: 5123, count: idx.length, type: "SCALAR" },
    ],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.8, 0.75, 0.7, 1], metallicFactor: 0, roughnessFactor: 0.9 } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const pad = (b: Buffer, fill: number) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
  const jsonChunk = pad(Buffer.from(JSON.stringify(gltf)), 0x20);
  const binChunk = pad(bin, 0);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const chunk = (type: string, data: Buffer) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.write(type, 4, "ascii");
    return Buffer.concat([h, data]);
  };
  return Buffer.concat([header, chunk("JSON", jsonChunk), chunk("BIN\0", binChunk)]);
}
