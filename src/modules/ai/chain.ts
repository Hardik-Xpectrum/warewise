import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { JobConfig, ModelConfig } from "./config";

export type ChatRequest = {
  job: string;
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  /** Ask for a JSON object; the schema is used where the model supports it. */
  json?: { name: string; schema: Record<string, unknown> };
  needsImages?: boolean;
  userId?: string;
  requestId?: string;
};

export type ChatResult = {
  message: ChatCompletionMessage;
  modelKey: string;
  providerModel: string;
  interactionId?: string;
};

export type CallOutcome =
  | { ok: true; message: ChatCompletionMessage; tokensIn?: number; tokensOut?: number }
  | { ok: false; kind: "rate_limited" | "failed"; error: string };

export type Attempt = {
  modelKey: string;
  providerModel: string;
  status: "ok" | "error" | "skipped";
  error?: string;
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
};

export type ChainDeps = {
  hasCredentials: (model: ModelConfig) => boolean;
  takeQuota: (modelKey: string, model: ModelConfig) => Promise<boolean>;
  call: (model: ModelConfig, job: JobConfig, req: ChatRequest) => Promise<CallOutcome>;
  now?: () => number;
};

/** No model in the chain could take the call (no keys, no free quota, or all failing). */
export class AiUnavailableError extends Error {
  constructor(
    readonly reason: "quota" | "failed",
    readonly attempts: Attempt[],
  ) {
    super(`AI unavailable (${reason}): ${attempts.map((a) => `${a.modelKey}=${a.error ?? a.status}`).join(", ")}`);
  }
}

/**
 * Walks a job's model chain: skips models without keys, without the needed capabilities or out of
 * free quota; moves on when a provider rate-limits or fails. Pure logic, so it is unit-tested.
 */
export async function runChain(
  job: JobConfig,
  models: Record<string, ModelConfig>,
  req: ChatRequest,
  deps: ChainDeps,
): Promise<{ result: ChatResult; attempts: Attempt[] }> {
  const now = deps.now ?? Date.now;
  const attempts: Attempt[] = [];
  let sawQuotaOnly = true;

  for (const modelKey of job.chain) {
    const model = models[modelKey];
    const skip = (error: string) =>
      attempts.push({ modelKey, providerModel: model.model, status: "skipped", error });

    if (!deps.hasCredentials(model)) {
      skip("no api key");
      continue;
    }
    if (req.needsImages && !model.supports.images) {
      skip("no image support");
      continue;
    }
    if (req.tools?.length && !model.supports.tools) {
      skip("no tool support");
      continue;
    }
    if (!(await deps.takeQuota(modelKey, model))) {
      skip("free quota used");
      continue;
    }

    const started = now();
    const outcome = await deps.call(model, job, req);
    const latencyMs = now() - started;
    if (outcome.ok) {
      attempts.push({
        modelKey,
        providerModel: model.model,
        status: "ok",
        latencyMs,
        tokensIn: outcome.tokensIn,
        tokensOut: outcome.tokensOut,
      });
      return { result: { message: outcome.message, modelKey, providerModel: model.model }, attempts };
    }
    if (outcome.kind !== "rate_limited") sawQuotaOnly = false;
    attempts.push({ modelKey, providerModel: model.model, status: "error", error: outcome.error, latencyMs });
  }

  const anyTried = attempts.some((a) => a.status === "error");
  throw new AiUnavailableError(anyTried && !sawQuotaOnly ? "failed" : "quota", attempts);
}
