import "server-only";
import { aiChat, jobPromptVersion } from "@/modules/ai/router";
import { extractJson } from "@/modules/ai/json";
import { loadPrompt } from "@/modules/ai/prompts";
import { TAGGER_JSON_SCHEMA, TaggerOutputSchema, type TaggerOutput } from "@/modules/wardrobe/schemas";
import { COLORS, FITS, PATTERNS, SEASONS } from "@/modules/wardrobe/taxonomy";

export class TaggingRejected extends Error {}

function systemPrompt(): string {
  return loadPrompt("tagger", jobPromptVersion("tagger"))
    .replace("{{COLORS}}", COLORS.join(", "))
    .replace("{{PATTERNS}}", PATTERNS.join(", "))
    .replace("{{SEASONS}}", SEASONS.join(", "))
    .replace("{{FITS}}", FITS.join(", "));
}

/** Asks the `tagger` job to describe one garment photo; validates, with one repair attempt. */
export async function tagImage(
  image: Buffer,
  ctx: { userId: string; requestId: string },
): Promise<{ tags: TaggerOutput; interactionId?: string }> {
  const dataUrl = `data:image/webp;base64,${image.toString("base64")}`;
  const messages = [
    { role: "system" as const, content: systemPrompt() },
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Tag this item. Reply with the JSON object only." },
        { type: "image_url" as const, image_url: { url: dataUrl } },
      ],
    },
  ];

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await aiChat({
      job: "tagger",
      messages:
        attempt === 0
          ? messages
          : [...messages, { role: "user", content: `Your last reply was invalid (${lastError}). Reply again with valid JSON only.` }],
      json: { name: "item_tags", schema: TAGGER_JSON_SCHEMA as unknown as Record<string, unknown> },
      needsImages: true,
      userId: ctx.userId,
      requestId: ctx.requestId,
    });
    const parsed = TaggerOutputSchema.safeParse(extractJson(res.message.content));
    if (parsed.success) {
      const tags = parsed.data;
      if (!tags.is_clothing) throw new TaggingRejected("This photo doesn't look like clothing. Try another photo.");
      if (tags.item_count > 1) throw new TaggingRejected("Several items found. Photograph one item at a time.");
      return { tags, interactionId: res.interactionId };
    }
    lastError = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  }
  throw new Error(`Tagger returned invalid output twice: ${lastError}`);
}
