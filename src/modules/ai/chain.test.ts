import { describe, expect, it, vi } from "vitest";
import { AiUnavailableError, runChain, type ChainDeps } from "./chain";
import { AiConfigSchema } from "./config";

const config = AiConfigSchema.parse({
  jobs: { stylist: { chain: ["a", "b", "c"] } },
  models: {
    a: { baseURL: "https://a.example/v1", apiKeyEnv: "A_KEY", model: "model-a", supports: { tools: true, images: false } },
    b: { baseURL: "https://b.example/v1", apiKeyEnv: "B_KEY", model: "model-b", supports: { tools: true, images: true } },
    c: { baseURL: "https://c.example/v1", apiKeyEnv: "C_KEY", model: "model-c", supports: { tools: true, images: true } },
  },
});
const job = config.jobs.stylist;
const ok = { ok: true as const, message: { role: "assistant" as const, content: "{}", refusal: null } };
const req = { job: "stylist", messages: [{ role: "user" as const, content: "hi" }] };

function deps(overrides: Partial<ChainDeps> = {}): ChainDeps {
  return { hasCredentials: () => true, takeQuota: async () => true, call: vi.fn(async () => ok), ...overrides };
}

describe("runChain", () => {
  it("uses the first available model", async () => {
    const { result } = await runChain(job, config.models, req, deps());
    expect(result.modelKey).toBe("a");
  });

  it("skips models without keys or free quota, then falls back on rate limits", async () => {
    const call = vi.fn(async (m: { model: string }) =>
      m.model === "model-b" ? { ok: false as const, kind: "rate_limited" as const, error: "429" } : ok,
    );
    const { result, attempts } = await runChain(job, config.models, req, deps({
      hasCredentials: (m) => m.model !== "model-a",
      call,
    }));
    expect(result.modelKey).toBe("c");
    expect(attempts.map((a) => [a.modelKey, a.status])).toEqual([["a", "skipped"], ["b", "error"], ["c", "ok"]]);
  });

  it("skips models lacking a needed capability", async () => {
    const { result } = await runChain(job, config.models, { ...req, needsImages: true }, deps());
    expect(result.modelKey).toBe("b");
  });

  it("reports quota exhaustion distinctly from failures", async () => {
    await expect(runChain(job, config.models, req, deps({ takeQuota: async () => false }))).rejects.toMatchObject({ reason: "quota" });
    const failing = deps({ call: async () => ({ ok: false as const, kind: "failed" as const, error: "500" }) });
    const err = await runChain(job, config.models, req, failing).catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err.reason).toBe("failed");
  });

  it("rejects a config whose job names an unknown model", () => {
    expect(() => AiConfigSchema.parse({ jobs: { x: { chain: ["nope"] } }, models: {} })).toThrow(/unknown model/);
  });
});
