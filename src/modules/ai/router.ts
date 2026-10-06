import "server-only";
import OpenAI, { APIError } from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { adminClient } from "@/lib/supabase/admin";
import { errorFields, log } from "@/modules/platform/log";
import { AiUnavailableError, runChain, type Attempt, type CallOutcome, type ChatRequest, type ChatResult } from "./chain";
import { loadAiConfig, type JobConfig, type ModelConfig } from "./config";
import { mockReply } from "./mock";

export { AiUnavailableError } from "./chain";
export type { ChatRequest, ChatResult } from "./chain";

const clients = new Map<string, OpenAI>();

function clientFor(model: ModelConfig, job: JobConfig): OpenAI {
  const key = `${model.baseURL}|${model.apiKeyEnv}|${job.timeoutMs}|${job.retries}`;
  let client = clients.get(key);
  if (!client) {
    client = new OpenAI({
      baseURL: model.baseURL,
      apiKey: model.apiKeyEnv ? process.env[model.apiKeyEnv] : undefined,
      timeout: job.timeoutMs,
      maxRetries: job.retries,
      defaultHeaders: model.extraHeaders,
    });
    clients.set(key, client);
  }
  return client;
}

function responseFormat(model: ModelConfig, req: ChatRequest): ChatCompletionCreateParamsNonStreaming["response_format"] {
  if (!req.json || req.tools?.length) return undefined;
  if (model.supports.json === "json_schema") {
    return { type: "json_schema", json_schema: { name: req.json.name, schema: req.json.schema, strict: false } };
  }
  if (model.supports.json === "json_object") return { type: "json_object" };
  return undefined;
}

async function callModel(model: ModelConfig, job: JobConfig, req: ChatRequest): Promise<CallOutcome> {
  if (model.provider === "mock") return { ok: true, message: mockReply(req) };
  if (model.provider === "local-vision") return localVisionReply(req);
  try {
    const completion = await clientFor(model, job).chat.completions.create({
      model: model.model,
      messages: req.messages,
      tools: req.tools?.length ? req.tools : undefined,
      response_format: responseFormat(model, req),
      temperature: job.temperature,
    });
    const message = completion.choices[0]?.message;
    if (!message) return { ok: false, kind: "failed", error: "empty response" };
    return {
      ok: true,
      message,
      tokensIn: completion.usage?.prompt_tokens,
      tokensOut: completion.usage?.completion_tokens,
    };
  } catch (err) {
    if (err instanceof APIError && err.status === 429) return { ok: false, kind: "rate_limited", error: "429 rate limited" };
    const status = err instanceof APIError ? `${err.status ?? "network"} ` : "";
    return { ok: false, kind: "failed", error: `${status}${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
  }
}

/** The keyless on-device tagger: reads the request's image, answers in the tagger's JSON shape. */
async function localVisionReply(req: ChatRequest): Promise<CallOutcome> {
  if (req.job !== "tagger") return { ok: false, kind: "failed", error: "local-vision only serves the tagger" };
  if (process.env.LOCAL_VISION !== "1") return { ok: false, kind: "failed", error: "local vision is off (set LOCAL_VISION=1)" };
  let url: string | undefined;
  for (const m of req.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as { type: string; image_url?: { url: string } }[]) if (part.type === "image_url") url ??= part.image_url?.url;
  }
  const b64 = url?.match(/^data:image\/[a-z+]+;base64,(.+)$/)?.[1];
  if (!b64) return { ok: false, kind: "failed", error: "no inline image" };
  try {
    const { localTag } = await import("./localModels");
    const tags = await localTag(Buffer.from(b64, "base64"));
    return { ok: true, message: { role: "assistant", content: JSON.stringify(tags), refusal: null } as ChatResult["message"] };
  } catch (err) {
    return { ok: false, kind: "failed", error: `local vision: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
  }
}

async function takeQuota(modelKey: string, model: ModelConfig): Promise<boolean> {
  if (!model.limits.perMinute && !model.limits.perDay) return true;
  const { data, error } = await adminClient().rpc("take_model_quota", {
    p_model: modelKey,
    p_per_minute: model.limits.perMinute ?? null,
    p_per_day: model.limits.perDay ?? null,
  });
  if (error) {
    log("warn", "quota check failed; allowing call", { modelKey, error: error.message });
    return true;
  }
  return data === true;
}

/** Strips image data so logs keep the request's shape without megabytes of base64. */
function redact(req: ChatRequest) {
  return {
    messages: req.messages.map((m) =>
      Array.isArray(m.content)
        ? { ...m, content: m.content.map((part) => (part.type === "image_url" ? { type: "image_url", image_url: "[image]" } : part)) }
        : m,
    ),
    tools: req.tools?.map((t) => (t.type === "function" ? t.function.name : t.type)),
    json: req.json?.name,
  };
}

async function record(
  req: ChatRequest,
  job: JobConfig,
  attempt: Attempt | undefined,
  result: ChatResult | undefined,
  error?: string,
): Promise<string | undefined> {
  const { data, error: dbError } = await adminClient()
    .from("ai_interactions")
    .insert({
      user_id: req.userId ?? null,
      job: req.job,
      model_key: attempt?.modelKey ?? null,
      provider_model: attempt?.providerModel ?? null,
      prompt_version: job.promptVersion,
      request: redact(req),
      response: result ? { content: result.message.content, tool_calls: result.message.tool_calls ?? null } : null,
      tokens_in: attempt?.tokensIn ?? null,
      tokens_out: attempt?.tokensOut ?? null,
      latency_ms: attempt?.latencyMs ?? null,
      status: result ? "ok" : "error",
      error: error ?? null,
      request_id: req.requestId ?? null,
    })
    .select("id")
    .single();
  if (dbError) log("warn", "could not record ai interaction", { error: dbError.message });
  return data?.id;
}

/** The single entry point for every AI call in the app. */
export async function aiChat(req: ChatRequest): Promise<ChatResult> {
  const config = loadAiConfig();
  const job = config.jobs[req.job];
  if (!job) throw new Error(`Unknown AI job "${req.job}"`);

  try {
    const { result, attempts } = await runChain(job, config.models, req, {
      hasCredentials: (m) => m.provider === "mock" || !m.apiKeyEnv || Boolean(process.env[m.apiKeyEnv]),
      takeQuota,
      call: callModel,
    });
    const ok = attempts.find((a) => a.status === "ok");
    const failures = attempts.filter((a) => a.status === "error");
    if (failures.length) log("warn", "ai fallback used", { job: req.job, requestId: req.requestId, failures });
    result.interactionId = await record(req, job, ok, result);
    return result;
  } catch (err) {
    if (err instanceof AiUnavailableError) {
      log("warn", "ai unavailable", { job: req.job, requestId: req.requestId, reason: err.reason, attempts: err.attempts });
      await record(req, job, undefined, undefined, err.message);
    } else {
      log("error", "ai call crashed", { job: req.job, requestId: req.requestId, ...errorFields(err) });
    }
    throw err;
  }
}

export function jobPromptVersion(jobName: string): string {
  return loadAiConfig().jobs[jobName]?.promptVersion ?? "v1";
}
