import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { serverEnv } from "@/lib/env";

/**
 * The AI router's config file. Code refers to jobs ("stylist", "tagger"); this file decides which
 * real models serve them. Changing providers or moving to paid models is an edit here, not in code.
 */
const ModelSchema = z.object({
  // openai-compatible and mock serve chat jobs; local-vision serves the tagger on this machine; hf-* and composite serve tryon; *-3d serve avatar3d.
  provider: z
    .enum(["openai-compatible", "mock", "local-vision", "hf-idm-vton", "hf-leffa", "composite", "hf-trellis", "hf-sf3d", "fal-3d", "tripo-3d", "meshy-3d", "mock-3d"])
    .default("openai-compatible"),
  baseURL: z.string().url().optional(),
  space: z.string().optional(), // Hugging Face Space id for hf-* providers, e.g. "yisol/IDM-VTON"
  // Call without a key when it is missing (e.g. Hugging Face allows anonymous use with a smaller quota).
  tokenOptional: z.boolean().default(false),
  apiKeyEnv: z.string().optional(),
  model: z.string(),
  limits: z
    .object({ perMinute: z.number().int().positive().optional(), perDay: z.number().int().positive().optional() })
    .default({}),
  supports: z
    .object({
      images: z.boolean().default(false),
      tools: z.boolean().default(false),
      json: z.enum(["json_schema", "json_object", "none"]).default("json_object"),
    })
    .default({ images: false, tools: false, json: "json_object" }),
  extraHeaders: z.record(z.string(), z.string()).optional(),
});

const JobSchema = z.object({
  chain: z.array(z.string()).min(1),
  promptVersion: z.string().default("v1"),
  timeoutMs: z.number().int().positive().default(30000),
  retries: z.number().int().min(0).max(5).default(1),
  temperature: z.number().min(0).max(2).optional(),
});

export const AiConfigSchema = z
  .object({
    jobs: z.record(z.string(), JobSchema),
    models: z.record(z.string(), ModelSchema),
  })
  .superRefine((cfg, ctx) => {
    for (const [job, def] of Object.entries(cfg.jobs)) {
      for (const key of def.chain) {
        if (!cfg.models[key]) ctx.addIssue({ code: "custom", message: `Job "${job}" uses unknown model "${key}"` });
      }
    }
  });

export type AiConfig = z.infer<typeof AiConfigSchema>;
export type ModelConfig = AiConfig["models"][string];
export type JobConfig = AiConfig["jobs"][string];

let cached: AiConfig | undefined;

export function loadAiConfig(): AiConfig {
  if (!cached) {
    const file = path.join(/* turbopackIgnore: true */ process.cwd(), serverEnv.aiConfigFile());
    cached = AiConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  }
  return cached;
}
