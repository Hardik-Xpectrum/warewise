import type { ChatCompletionMessage } from "openai/resources/chat/completions";
import type { ChatRequest } from "./chain";

/**
 * Offline stand-in for a model, used by config/ai.config.mock.json and tests. It returns valid but
 * generic answers, so the whole app can be clicked through without any API key.
 */
export function mockReply(req: ChatRequest): ChatCompletionMessage {
  let content: string;
  if (req.job === "tagger") {
    content = JSON.stringify({
      is_clothing: true,
      item_count: 1,
      category: "top",
      subcategory: "t-shirt",
      colors: ["black"],
      pattern: "solid",
      seasons: ["all"],
      fabric: "cotton",
      formality: 2,
      fit: "regular",
      brand: null,
      confidence: 0.3,
    });
  } else {
    // The stylist validates this, finds no outfits, and falls back to its rule-based picks.
    content = JSON.stringify({ message: "Here are a few options from your wardrobe (offline mock model).", outfits: [] });
  }
  return { role: "assistant", content, refusal: null } as ChatCompletionMessage;
}
