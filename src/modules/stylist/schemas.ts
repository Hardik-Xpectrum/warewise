import { z } from "zod";
import { CATEGORIES, COLORS, PATTERNS } from "@/modules/wardrobe/taxonomy";
import { MOODS } from "./look";
import { OCCASIONS } from "./rules";

const OccasionSchema = z.enum(Object.keys(OCCASIONS) as [keyof typeof OCCASIONS, ...(keyof typeof OCCASIONS)[]]);

export const StylistMessageSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  occasion: OccasionSchema.default("other"),
  eventDate: z.iso.date().optional(),
  city: z.string().trim().max(80).optional(),
  mood: z.enum(Object.keys(MOODS) as [keyof typeof MOODS, ...(keyof typeof MOODS)[]]).default("any"),
  color: z.enum(COLORS).optional(),
});

export const CompleteLookSchema = z.object({
  occasion: OccasionSchema.default("casual"),
  city: z.string().trim().max(80).optional(),
});

export const ShopScanSchema = z.object({
  category: z.enum(CATEGORIES),
  subcategory: z.string().trim().max(40).optional(),
  colors: z.array(z.enum(COLORS)).min(1).max(3),
  pattern: z.enum(PATTERNS).default("solid"),
  formality: z.number().int().min(1).max(5).optional(),
});
export type StylistMessage = z.infer<typeof StylistMessageSchema>;

/** What the model must return. Slots are re-derived from the real items, so a wrong slot is harmless. */
export const StylistOutputSchema = z.object({
  message: z.string().max(1500).default(""),
  outfits: z
    .array(
      z.object({
        items: z.array(z.object({ id: z.string(), slot: z.enum(CATEGORIES).optional().catch(undefined) })).max(6),
        why: z.string().max(400).default(""),
      }),
    )
    .max(3)
    .default([]),
});
export type StylistOutput = z.infer<typeof StylistOutputSchema>;

export const STYLIST_JSON_SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string" },
    outfits: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" }, slot: { type: "string", enum: [...CATEGORIES] } },
              required: ["id", "slot"],
            },
          },
          why: { type: "string" },
        },
        required: ["items", "why"],
      },
    },
  },
  required: ["message", "outfits"],
} as const;

export const FeedbackSchema = z.object({
  kind: z.enum(["like", "dislike", "regenerate", "saved"]),
  reason: z.string().trim().max(300).optional(),
});
