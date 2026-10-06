import { z } from "zod";
import { CATEGORIES, COLORS, FITS, LIFECYCLES, PATTERNS, SEASONS } from "./taxonomy";

const colorSet = new Set<string>(COLORS);
const seasonSet = new Set<string>(SEASONS);

/** Tagger output. Lenient on purpose: unknown colours or seasons are dropped rather than failing the photo. */
export const TaggerOutputSchema = z.object({
  is_clothing: z.boolean(),
  item_count: z.coerce.number().int().min(0).default(1),
  category: z.enum(CATEGORIES),
  subcategory: z.string().trim().toLowerCase().max(40).nullish(),
  colors: z
    .array(z.string().trim().toLowerCase())
    .transform((cs) => cs.filter((c) => colorSet.has(c)).slice(0, 3)),
  pattern: z.enum(PATTERNS).catch("other"),
  seasons: z
    .array(z.string().trim().toLowerCase())
    .transform((ss) => {
      const kept = ss.filter((s) => seasonSet.has(s));
      return kept.length ? kept : ["all"];
    }),
  fabric: z.string().trim().toLowerCase().max(30).nullish(),
  formality: z.coerce.number().int().min(1).max(5),
  fit: z.enum(FITS).catch("regular"),
  brand: z.string().trim().max(40).nullish(),
  confidence: z.coerce.number().min(0).max(1).catch(0.5),
});
export type TaggerOutput = z.infer<typeof TaggerOutputSchema>;

/** JSON Schema sent to models that support structured output. */
export const TAGGER_JSON_SCHEMA = {
  type: "object",
  properties: {
    is_clothing: { type: "boolean" },
    item_count: { type: "integer" },
    category: { type: "string", enum: [...CATEGORIES] },
    subcategory: { type: "string" },
    colors: { type: "array", items: { type: "string", enum: [...COLORS] }, maxItems: 3 },
    pattern: { type: "string", enum: [...PATTERNS] },
    seasons: { type: "array", items: { type: "string", enum: [...SEASONS] } },
    fabric: { type: "string", nullable: true },
    formality: { type: "integer", minimum: 1, maximum: 5 },
    fit: { type: "string", enum: [...FITS] },
    brand: { type: "string", nullable: true },
    confidence: { type: "number" },
  },
  required: ["is_clothing", "item_count", "category", "colors", "pattern", "seasons", "formality", "fit", "confidence"],
} as const;

export const CreateItemSchema = z.object({
  imagePath: z.string().min(1).max(300),
});

// Fields a user may correct. Setting any AI-tagged field records a correction for the dataset.
export const ItemPatchSchema = z
  .object({
    category: z.enum(CATEGORIES),
    subcategory: z.string().trim().max(40).nullable(),
    colors: z.array(z.enum(COLORS)).max(3),
    pattern: z.enum(PATTERNS),
    seasons: z.array(z.enum(SEASONS)).min(1),
    fabric: z.string().trim().max(30).nullable(),
    formality: z.number().int().min(1).max(5),
    fit: z.enum(FITS),
    brand: z.string().trim().max(40).nullable(),
    price_inr: z.number().min(0).max(1_000_000).nullable(),
    size_label: z.string().trim().max(12).nullable(),
    notes: z.string().trim().max(500).nullable(),
    lifecycle: z.enum(LIFECYCLES),
  })
  .partial()
  .strict();
export type ItemPatch = z.infer<typeof ItemPatchSchema>;

export const ItemListQuerySchema = z.object({
  category: z.enum(CATEGORIES).optional(),
  color: z.enum(COLORS).optional(),
  season: z.enum(SEASONS).optional(),
  lifecycle: z.enum(LIFECYCLES).optional(),
  q: z.string().trim().max(60).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(60),
});
export type ItemListQuery = z.infer<typeof ItemListQuerySchema>;
