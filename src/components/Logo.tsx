// The Warewise logo: a shirt collar whose two points and tie form a W. The collar takes the text
// colour (black on light, white on dark); the tie and the "i" in Wise are the brand red, the same
// red as the favourite heart. The wordmark reads "WareWise". Paths are shared with the app icons
// (scripts/make-icons.mjs).

export const COLLAR_PATHS = ["M6 10L29 19L20 46Z", "M58 10L35 19L44 46Z"];
export const TIE_PATHS = ["M27.5 18H36.5L34.5 27H29.5Z", "M29.3 28.5H34.7L38.5 50L32 58L25.5 50Z"];

/** The collar-and-tie mark on its own (square, 64-unit grid), `size` pixels wide. */
export function LogoMark({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={`shrink-0 ${className}`} aria-hidden>
      {COLLAR_PATHS.map((d) => (
        <path key={d} d={d} fill="currentColor" />
      ))}
      {TIE_PATHS.map((d) => (
        // A style, not a fill attribute: Safari ignores CSS variables in SVG presentation attributes.
        <path key={d} d={d} style={{ fill: "var(--heart)" }} />
      ))}
    </svg>
  );
}

/** The wordmark: "WareWise", both W's capital, with the i in red. */
export function Wordmark({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <span className={className} style={{ letterSpacing: "0.01em", whiteSpace: "nowrap", ...style }} aria-hidden>
      WareW<span style={{ color: "var(--heart)" }}>i</span>se
    </span>
  );
}

const SR_ONLY: React.CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };

/**
 * Mark + wordmark lockup, read out as "WareWise". Layout and sizes are inline so the logo keeps
 * its shape even if a stylesheet is stale or blocked.
 */
export default function Logo({ size = "md", markOnly = false }: { size?: "sm" | "md" | "lg"; markOnly?: boolean }) {
  const { mark, text } = { sm: { mark: 24, text: 15 }, md: { mark: 32, text: 20 }, lg: { mark: 44, text: 28 } }[size];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: Math.round(mark / 3), lineHeight: 1 }}>
      <LogoMark size={mark} />
      {markOnly ? null : <Wordmark style={{ fontSize: text, fontWeight: 700 }} />}
      <span style={SR_ONLY}>WareWise</span>
    </span>
  );
}
