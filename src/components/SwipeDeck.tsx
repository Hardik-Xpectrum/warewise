"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, errorText } from "@/lib/api";
import { invalidate } from "@/lib/query";
import ItemThumb from "./ItemThumb";
import { toast } from "./Toaster";
import type { OutfitCardData } from "./types";

type Decision = { outfit: OutfitCardData; kind: "like" | "dislike" };

const THRESHOLD = 110; // px of drag that counts as a decision
// Card area size, inline so the deck never collapses even if a stylesheet is stale or blocked.
// On phones the card takes what's left after the header, the action buttons and the tab bar
// (~340 px), so the buttons are never hidden; 460 px at most on larger screens.
const CARD_BOX: React.CSSProperties = { position: "relative", height: "clamp(300px, calc(100dvh - 340px), 460px)" };
const FLY_MS = 260;

/**
 * Stylist suggestions as a swipe deck, like Bumble: swipe (or press →) right to like, which saves
 * the outfit as a favourite; left (or ←) to pass, which teaches Warewise your taste. ↺ undoes.
 */
export default function SwipeDeck({ outfits, streaming = false, preview }: { outfits: OutfitCardData[]; streaming?: boolean; preview?: OutfitCardData }) {
  const [index, setIndex] = useState(0);
  const [history, setHistory] = useState<Decision[]>([]);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [flying, setFlying] = useState<"left" | "right" | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  // The live drag offset: a fast flick can move and release before React re-renders, so the
  // release must read this, not the `drag` state.
  const offset = useRef({ x: 0, y: 0 });
  const deck = useRef<HTMLDivElement>(null);
  const current = outfits[index];
  // Bring the first look into view when it arrives.
  const hasFirst = outfits.length > 0;
  useEffect(() => {
    if (hasFirst) deck.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [hasFirst]);
  const next = outfits[index + 1];

  async function decide(kind: "like" | "dislike") {
    if (!current || flying) return;
    const outfit = current;
    setFlying(kind === "like" ? "right" : "left");
    setTimeout(() => {
      setFlying(null);
      setDrag(null);
      setIndex((i) => i + 1);
      setHistory((h) => [...h, { outfit, kind }]);
    }, FLY_MS);
    if (!outfit.recommendationId) return;
    try {
      await api(`/recommendations/${outfit.recommendationId}/feedback`, { method: "POST", json: { kind } });
      if (kind === "like") {
        toast("Liked: saved to your favourites");
        invalidate("/outfits");
      }
      invalidate("/today"); // taste changed
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  async function undo() {
    const last = history[history.length - 1];
    if (!last || flying) return;
    setHistory((h) => h.slice(0, -1));
    setIndex((i) => Math.max(0, i - 1));
    if (last.kind === "like") {
      try {
        await api(`/outfits/${last.outfit.outfitId}`, { method: "PATCH", json: { is_favorite: false, saved: false } });
        invalidate("/outfits");
        toast("Removed from favourites");
      } catch (err) {
        toast(errorText(err), "error");
      }
    }
  }

  // ← / → decide while the stylist page is open (ignored while typing in the chat box).
  const decideRef = useRef(decide);
  const undoRef = useRef(undo);
  useEffect(() => {
    decideRef.current = decide;
    undoRef.current = undo;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (!deck.current?.isConnected) return;
      if (e.key === "ArrowRight") decideRef.current("like");
      if (e.key === "ArrowLeft") decideRef.current("dislike");
      if (e.key === "Backspace" && (e.metaKey || e.ctrlKey)) undoRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onDown = (e: React.PointerEvent) => {
    if (flying) return;
    start.current = { x: e.clientX, y: e.clientY };
    offset.current = { x: 0, y: 0 };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    offset.current = { x: e.clientX - start.current.x, y: (e.clientY - start.current.y) * 0.3 };
    setDrag(offset.current);
  };
  const onUp = (e: React.PointerEvent) => {
    if (!start.current) return;
    const dx = e.clientX - start.current.x || offset.current.x;
    start.current = null;
    if (dx > THRESHOLD) decide("like");
    else if (dx < -THRESHOLD) decide("dislike");
    else setDrag(null); // spring back
  };

  const liked = history.filter((h) => h.kind === "like").length;
  const dx = flying === "right" ? 700 : flying === "left" ? -700 : drag?.x ?? 0;
  const dy = flying ? drag?.y ?? 0 : drag?.y ?? 0;
  const likeOpacity = Math.max(0, Math.min(1, dx / THRESHOLD));
  const nopeOpacity = Math.max(0, Math.min(1, -dx / THRESHOLD));
  const settling = !drag || flying;

  if (!current) {
    if (streaming && preview && !outfits.length) {
      // The instant rule-built look, shown while the AI works. Not swipeable: it isn't saved yet.
      return (
        <div className="mx-auto w-full max-w-sm" aria-label="Quick pick while the stylist thinks">
          <div style={CARD_BOX} className="animate-rise">
            <div style={{ position: "absolute", inset: 0 }}>
              <DeckCard outfit={preview} />
            </div>
            <span className="absolute left-3 top-3 bg-bg px-2 py-1 text-[10px] font-semibold tracking-[0.12em] uppercase">Quick pick</span>
            <div className="skeleton absolute inset-x-0 bottom-0 h-1" aria-hidden />
          </div>
          <p className="mt-3 text-center text-xs text-muted">Finding more looks for you. You can swipe as soon as they arrive.</p>
        </div>
      );
    }
    if (streaming) return <div className="skeleton mx-auto w-full max-w-sm" style={CARD_BOX} aria-label="Styling your next look" />;
    return outfits.length ? (
      <div className="card animate-rise mx-auto max-w-sm space-y-3 p-6 text-center">
        <p className="font-medium">{outfits.length === 1 ? "That's the only look for now." : `That's all ${outfits.length} looks.`}</p>
        <p className="text-sm text-muted">
          {liked ? `You liked ${liked === 1 && outfits.length === 1 ? "it" : liked}: ${liked === 1 ? "it's" : "they're"} in your favourites.` : "Nothing caught your eye. Ask again with a different mood or occasion."}
        </p>
        <div className="flex justify-center gap-2">
          {liked ? <Link className="btn-primary" href="/outfits">See favourites</Link> : null}
          {history.length ? <button className="btn-ghost" onClick={undo}>↺ Undo last</button> : null}
        </div>
      </div>
    ) : null;
  }

  return (
    <div ref={deck} className="mx-auto w-full max-w-sm select-none" role="group" aria-roledescription="swipe deck" aria-label={`Outfit ${index + 1} of ${outfits.length}${streaming ? "+" : ""}`}>
      <div style={CARD_BOX}>
        {next ? (
          <div style={{ position: "absolute", inset: 0, transform: "scale(0.95)", opacity: 0.7 }} aria-hidden>
            <DeckCard outfit={next} />
          </div>
        ) : null}
        <div
          className="cursor-grab touch-none active:cursor-grabbing"
          style={{
            position: "absolute",
            inset: 0,
            transform: `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`,
            transition: settling ? `transform ${FLY_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)` : "none",
          }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={() => {
            start.current = null;
            setDrag(null); // an interrupted touch springs back, it never counts as a pass
          }}
        >
          <DeckCard outfit={current} />
          <span className="pointer-events-none absolute left-5 top-6 -rotate-12 rounded-none border-4 border-ok px-3 py-1 text-2xl font-extrabold tracking-widest text-ok" style={{ opacity: likeOpacity }}>
            LIKE
          </span>
          <span className="pointer-events-none absolute right-5 top-6 rotate-12 rounded-none border-4 border-danger px-3 py-1 text-2xl font-extrabold tracking-widest text-danger" style={{ opacity: nopeOpacity }}>
            NOPE
          </span>
        </div>
      </div>

      {/* Bumble-style action bar: small rewind · big pass · big like · small try-on. The big
          buttons grow with the drag, so the one you're heading for lights up. */}
      {/* Spacing inline, like the buttons themselves, so the row never collapses if a stylesheet is stale. */}
      <div className="mt-5 flex items-center justify-center" style={{ gap: 20 }}>
        <RoundButton size="sm" label="Undo last swipe" hint="Undo (⌘⌫)" onClick={undo} disabled={!history.length} tone="rewind">
          <Icon path="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
        </RoundButton>
        <RoundButton size="lg" label="Pass on this outfit" hint="Pass (←)" onClick={() => decide("dislike")} tone="pass" active={nopeOpacity}>
          <Icon path="M18 6 6 18M6 6l12 12" strokeWidth={2.6} />
        </RoundButton>
        <RoundButton size="lg" label="Like and save to favourites" hint="Like (→)" onClick={() => decide("like")} tone="like" active={likeOpacity}>
          <Icon path="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2Z" fill />
        </RoundButton>
        <RoundButton size="sm" label="Try this outfit on" hint="Try on" href={`/tryon?outfit=${current.outfitId}`} tone="try">
          <Icon path="M8 3 4 6l2 4 2-1v12h8V9l2 1 2-4-4-3a4 4 0 0 1-8 0Z" />
        </RoundButton>
      </div>
      <p className="mt-2 text-center text-xs text-muted">Swipe right to like and save · left to pass · ← → on a keyboard</p>
    </div>
  );
}

/** The card face: the outfit's pieces, its harmony score and the stylist's reason. */
function DeckCard({ outfit }: { outfit: OutfitCardData }) {
  const h = outfit.harmony;
  const main = outfit.items.filter((i) => i.slot !== "shoes" && i.slot !== "accessory");
  const extras = outfit.items.filter((i) => i.slot === "shoes" || i.slot === "accessory");
  return (
    <article className="overflow-hidden border border-line bg-surface shadow-[0_12px_40px_rgba(0,0,0,0.12)]" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div
        className="bg-surface-2"
        style={{ flex: 1, minHeight: 0, display: "grid", gap: 4, padding: 4, gridTemplateColumns: main.length > 1 ? "1fr 1fr" : "1fr" }}
      >
        {main.map((i) => (
          <ItemThumb key={i.id} url={i.thumbUrl} alt={i.label ?? i.slot} className="h-full min-h-0 w-full" />
        ))}
      </div>
      <div className="space-y-2 p-4">
        <div className="flex items-center gap-2">
          {h ? <span className="border border-text px-1.5 py-0.5 text-xs font-semibold tabular-nums" title={`${h.label}: ${h.reasons.join(" · ")}`}>{h.score}</span> : null}
          <p className="flex-1 truncate text-sm font-medium capitalize">{outfit.items.map((i) => i.label ?? i.slot).join(" · ")}</p>
          {extras.map((i) => (
            <ItemThumb key={i.id} url={i.thumbUrl} alt={i.label ?? i.slot} className="h-9 w-9 shrink-0" />
          ))}
        </div>
        {outfit.why ? <p className="line-clamp-2 text-sm text-muted">{outfit.why}</p> : null}
      </div>
    </article>
  );
}

type Tone = "rewind" | "pass" | "like" | "try";

/**
 * Round action button. Colours are inline (not only utility classes) so the deck keeps its look
 * even if a stylesheet is stale, and each tone gets a clear identity like Bumble's buttons.
 */
function RoundButton({
  size,
  label,
  hint,
  tone,
  onClick,
  href,
  disabled,
  active = 0,
  children,
}: {
  size: "sm" | "lg";
  label: string;
  hint: string;
  tone: Tone;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  active?: number; // 0..1: how far the current drag leans towards this button
  children: React.ReactNode;
}) {
  const px = size === "lg" ? 68 : 48;
  const colours: Record<Tone, { bg: string; fg: string; ring: string }> = {
    rewind: { bg: "var(--surface)", fg: "#d69e2e", ring: "var(--line)" },
    pass: { bg: "var(--surface)", fg: "#9a9087", ring: "var(--line)" },
    like: { bg: "var(--accent)", fg: "var(--accent-contrast)", ring: "transparent" },
    try: { bg: "var(--surface)", fg: "#7c6cf0", ring: "var(--line)" },
  };
  const c = colours[tone];
  const style: React.CSSProperties = {
    width: px,
    height: px,
    borderRadius: 9999,
    display: "grid",
    placeItems: "center",
    background: c.bg,
    color: tone === "pass" && active > 0.3 ? "var(--danger)" : c.fg,
    border: `1px solid ${c.ring}`,
    boxShadow: size === "lg" ? "0 6px 18px rgba(0,0,0,.14), 0 1px 3px rgba(0,0,0,.08)" : "0 2px 8px rgba(0,0,0,.10)",
    transform: `scale(${1 + active * 0.15})`,
    transition: "transform 120ms ease, opacity 120ms ease, color 120ms ease",
    opacity: disabled ? 0.4 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
  };
  const cls = "shrink-0 hover:-translate-y-0.5 active:scale-95 focus-visible:outline-2";
  if (href)
    return (
      <Link href={href} aria-label={label} title={hint} className={cls} style={style}>
        {children}
      </Link>
    );
  return (
    <button type="button" aria-label={label} title={hint} onClick={onClick} disabled={disabled} className={cls} style={style}>
      {children}
    </button>
  );
}

function Icon({ path, fill = false, strokeWidth = 2 }: { path: string; fill?: boolean; strokeWidth?: number }) {
  return (
    <svg aria-hidden width="46%" height="46%" viewBox="0 0 24 24" fill={fill ? "currentColor" : "none"} stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  );
}
