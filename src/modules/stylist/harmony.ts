// Colour harmony score (0-100) for an outfit, from the colour-wheel relationships between its
// pieces' main colours, pattern mixing and formality spread. Pure and explainable: every point
// added or taken away comes with a short reason the UI can show.

// Hue angle (degrees) of each named colour; neutrals have no hue.
const HUE: Record<string, number> = {
  red: 0, maroon: 350, pink: 330, orange: 28, mustard: 45, gold: 45, yellow: 55,
  green: 125, "light-blue": 200, blue: 220, purple: 280,
};
const NEUTRAL = new Set(["black", "white", "grey", "navy", "beige", "cream", "brown", "tan", "olive", "silver"]);
const WARM = new Set(["red", "maroon", "pink", "orange", "mustard", "gold", "yellow"]);

export type HarmonyPiece = { colors: string[]; pattern?: string | null; formality?: number | null; category?: string | null };
export type Harmony = { score: number; label: "Great harmony" | "Good match" | "Okay" | "Clashing"; reasons: string[] };

const hueGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

export function colourKind(c: string | undefined): "neutral" | "colour" | "multi" | "unknown" {
  if (!c) return "unknown";
  if (c === "multi") return "multi";
  if (NEUTRAL.has(c)) return "neutral";
  return c in HUE ? "colour" : "unknown";
}

export function harmonyScore(pieces: HarmonyPiece[]): Harmony {
  const reasons: string[] = [];
  let score = 70;
  const mains = pieces.map((p) => p.colors[0]).filter(Boolean);
  const hues = [...new Set(mains.filter((c) => colourKind(c) === "colour"))];
  const patterned = pieces.filter((p) => (p.pattern && !["solid", "textured"].includes(p.pattern)) || p.colors[0] === "multi");

  if (hues.length === 0) {
    score += 14;
    reasons.push("All-neutral palette: easy and polished");
  } else if (hues.length === 1) {
    score += 20;
    reasons.push(`One accent colour (${hues[0]}) against neutrals`);
    if (mains.filter((c) => c === hues[0]).length > 1) {
      score -= 4;
      reasons.push(`${hues[0]} repeated head to toe`);
    }
  } else {
    const gaps: number[] = [];
    for (let i = 0; i < hues.length; i++) for (let j = i + 1; j < hues.length; j++) gaps.push(hueGap(HUE[hues[i]], HUE[hues[j]]));
    const worst = Math.max(...gaps);
    if (worst <= 45) {
      score += 14;
      reasons.push(`Analogous colours (${hues.join(", ")}) sit well together`);
    } else if (worst >= 120) {
      score += 8;
      reasons.push(`Complementary colours (${hues.join(" + ")}) make a bold contrast`);
    } else if (worst >= 90) {
      score -= 2;
      reasons.push(`${hues.join(" + ")}: a lively mix, keep the rest neutral`);
    } else {
      score -= 16;
      reasons.push(`${hues.join(" + ")} compete with each other`);
    }
    if (hues.length > 2) {
      score -= 12 * (hues.length - 2);
      reasons.push(`${hues.length} strong colours is a lot for one look`);
    }
    const warm = hues.filter((h) => WARM.has(h)).length;
    if (warm && warm < hues.length && worst < 120) {
      score -= 5;
      reasons.push("Warm and cool colours mixed");
    }
  }

  if (patterned.length >= 2) {
    score -= 16;
    reasons.push("Two patterns compete; pair a pattern with plain pieces");
  } else if (patterned.length === 1) {
    score += 4;
    reasons.push("One pattern as the focus");
  }

  const formality = pieces.map((p) => p.formality).filter((f): f is number => typeof f === "number");
  if (formality.length >= 2) {
    const spread = Math.max(...formality) - Math.min(...formality);
    if (spread <= 1) score += 4;
    else if (spread >= 3) {
      score -= 12;
      reasons.push("Very casual and very formal pieces together");
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const label = score >= 85 ? "Great harmony" : score >= 70 ? "Good match" : score >= 55 ? "Okay" : "Clashing";
  return { score, label, reasons };
}
