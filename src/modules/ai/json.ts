/**
 * Pulls the first JSON object out of a model reply. Free models sometimes wrap JSON in prose or
 * code fences even when asked not to.
 */
export function extractJson(text: string | null | undefined): unknown {
  if (!text) return undefined;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
