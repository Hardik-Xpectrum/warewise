// Reads the occasion from what the user typed ("dinner date tomorrow", "office meeting"), so the
// words win over a dropdown they didn't touch. Pure and unit-tested.
import type { Occasion } from "./rules";

const WORDS: [Occasion, RegExp][] = [
  ["interview", /\binterview/],
  ["wedding", /\b(wedding|shaadi|sangeet|mehendi|reception|haldi)\b/],
  ["festive", /\b(festival|festive|puja|pooja|diwali|holi|eid|navratri|garba|onam|pongal|christmas)\b/],
  ["date", /\b(date|dinner date|romantic)\b/],
  ["party", /\b(party|club|clubbing|birthday|night out|cocktail)\b/],
  ["gym", /\b(gym|workout|run|running|yoga|sport|sports|football|cricket)\b/],
  ["travel", /\b(travel|trip|flight|airport|train|vacation|holiday)\b/],
  ["office", /\b(office|work|meeting|client|presentation|conference|formal)\b/],
  ["casual", /\b(casual|hangout|hang out|brunch|coffee|friends|chill|weekend|errands|shopping|movie)\b/],
];

/** The occasion the text names, or null if it doesn't clearly name one. */
export function occasionFromText(text: string): Occasion | null {
  const t = text.toLowerCase();
  for (const [occasion, re] of WORDS) if (re.test(t)) return occasion;
  return null;
}
