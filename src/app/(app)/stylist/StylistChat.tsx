"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { CloseIcon, SparkIcon } from "@/components/Icons";
import SwipeDeck from "@/components/SwipeDeck";
import type { OutfitCardData } from "@/components/types";
import { api, errorText } from "@/lib/api";
import { occasionFromText } from "@/modules/stylist/intent";
import { MOODS } from "@/modules/stylist/look";
import { OCCASIONS } from "@/modules/stylist/rules";
import { COLORS } from "@/modules/wardrobe/taxonomy";

type Turn = { role: "user" | "assistant"; text: string; outfits: OutfitCardData[]; preview?: OutfitCardData; error?: boolean };
type Occ = keyof typeof OCCASIONS;

// The occasions people ask about most, as one-tap starters; the rest are under "More options".
const STARTERS: { occasion: Occ; prompt: string }[] = [
  { occasion: "office", prompt: "Office day" },
  { occasion: "casual", prompt: "Casual outing" },
  { occasion: "date", prompt: "Date night" },
  { occasion: "party", prompt: "Party" },
  { occasion: "wedding", prompt: "Wedding" },
  { occasion: "festive", prompt: "Festival / puja" },
  { occasion: "interview", prompt: "Interview" },
  { occasion: "travel", prompt: "Travel day" },
];

function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Reads a Server-Sent Events response body and calls back once per event. */
async function readSse(res: Response, onEvent: (event: string, data: unknown) => void) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const event = raw.match(/^event: (.*)$/m)?.[1] ?? "message";
      const data = raw.match(/^data: (.*)$/m)?.[1];
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

const PHONE = "(max-width: 767px)";
const subscribePhone = (cb: () => void) => {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

export default function StylistChat() {
  const isPhone = useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE).matches, () => false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [occasion, setOccasion] = useState<Occ>("office");
  const [date, setDate] = useState(tomorrowISO());
  const [city, setCity] = useState("");
  const [mood, setMood] = useState<keyof typeof MOODS>("any");
  const [color, setColor] = useState("");
  const [more, setMore] = useState(false);
  const [step, setStep] = useState("");
  const [remaining, setRemaining] = useState<number | null>(null);
  const conversationId = useRef<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const busy = step !== "";
  const inSession = turns.length > 0;

  const updateLast = (fn: (t: Turn) => Turn) => setTurns((ts) => [...ts.slice(0, -1), fn(ts[ts.length - 1])]);

  // A styling session fills the phone screen: the page behind it shouldn't scroll too.
  useEffect(() => {
    if (!inSession || window.matchMedia("(min-width: 768px)").matches) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [inSession]);
  useEffect(() => {
    if (turns.length) bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length]);

  /** Sends a request. A starter chip passes its occasion; typed text can name one too. */
  async function ask(rawText: string, chosen?: Occ) {
    // Words beat the dropdown: typing "casual" or "client meeting" sets the occasion.
    const typed = occasionFromText(rawText);
    const occ = chosen ?? typed ?? occasion;
    if (occ !== occasion) setOccasion(occ);
    const message = rawText.trim() || `What should I wear for ${OCCASIONS[occ].label.toLowerCase()}?`;
    setText("");
    setMore(false);
    setTurns((ts) => [...ts, { role: "user", text: message, outfits: [] }, { role: "assistant", text: "", outfits: [] }]);
    setStep("Starting");
    try {
      conversationId.current ??= (await api<{ id: string }>("/stylist/conversations", { method: "POST" })).id;
      const res = await fetch(`/api/v1/stylist/conversations/${conversationId.current}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: message, occasion: occ, eventDate: date || undefined, city: city || undefined, mood, color: color || undefined }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? body.title ?? `Request failed (${res.status})`);
      }
      await readSse(res, (event, data) => {
        const d = data as Record<string, unknown>;
        if (event === "status") setStep(String(d.step));
        if (event === "preview") updateLast((t) => ({ ...t, preview: d as unknown as OutfitCardData }));
        if (event === "message") updateLast((t) => ({ ...t, text: String(d.text) }));
        if (event === "outfit") updateLast((t) => ({ ...t, outfits: [...t.outfits, d as unknown as OutfitCardData] }));
        if (event === "error") updateLast((t) => ({ ...t, text: `${d.title}. ${d.detail}`, error: true }));
        if (event === "done") setRemaining(Number(d.remainingToday));
      });
    } catch (err) {
      updateLast((t) => ({ ...t, text: errorText(err), error: true }));
    } finally {
      setStep("");
    }
  }

  function endSession() {
    conversationId.current = null;
    setTurns([]);
  }

  const options = (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      <select className="input" value={occasion} onChange={(e) => setOccasion(e.target.value as Occ)} aria-label="Occasion">
        {Object.entries(OCCASIONS).map(([k, o]) => <option key={k} value={k}>{o.label}</option>)}
      </select>
      <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
      <input className="input col-span-2 sm:col-span-1" placeholder="City (defaults to profile)" value={city} onChange={(e) => setCity(e.target.value)} aria-label="City" />
      <select className="input" value={mood} onChange={(e) => setMood(e.target.value as keyof typeof MOODS)} aria-label="Mood">
        {Object.entries(MOODS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
      </select>
      <select className="input capitalize" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Colour to include">
        <option value="">Any colour</option>
        {COLORS.filter((c) => c !== "multi").map((c) => <option key={c} value={c}>With {c}</option>)}
      </select>
    </div>
  );

  const composer = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void ask(text);
      }}
      className="space-y-2"
    >
      {more ? options : null}
      <div className="flex gap-2">
        <input
          className="input"
          placeholder={inSession ? "Tell me what to change, or ask for another occasion" : "e.g. Client meeting, want to look sharp but stay cool"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={1000}
          aria-label="Message the stylist"
        />
        <button className="btn-primary" disabled={busy}>Ask</button>
      </div>
      <div className="flex items-center justify-between text-xs text-muted">
        <button type="button" className="underline underline-offset-4 hover:text-text" onClick={() => setMore((m) => !m)} aria-expanded={more}>
          {more ? "Fewer options" : "More options: date, city, mood, colour"}
        </button>
        {remaining !== null ? <span>{remaining} left today</span> : null}
      </div>
    </form>
  );

  const chips = (compact: boolean) => (
    <div className={compact ? "-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" : "flex flex-wrap gap-2"} role="group" aria-label="Quick occasions">
      {STARTERS.map((s) => (
        <button
          key={s.occasion}
          type="button"
          disabled={busy}
          onClick={() => void ask("", s.occasion)}
          className={`shrink-0 border border-line px-3.5 py-2 text-xs font-semibold tracking-[0.06em] uppercase transition hover:border-text disabled:opacity-40 ${compact ? "" : "sm:px-4 sm:py-2.5"}`}
        >
          {OCCASIONS[s.occasion].label}
        </button>
      ))}
    </div>
  );

  // Before the first request: a chat-first start screen, one tap to begin.
  if (!inSession) {
    return (
      <div className="mx-auto max-w-2xl space-y-8 py-4 sm:py-10">
        <div className="animate-rise space-y-3 text-center">
          <SparkIcon className="mx-auto h-7 w-7" />
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Where are you going?</h1>
          <p className="text-sm text-muted">Pick an occasion or describe your day. I&apos;ll style you from your own wardrobe and the weather.</p>
        </div>
        <div className="animate-rise space-y-6" style={{ animationDelay: "80ms" }}>
          <div className="flex justify-center">{chips(false)}</div>
          <div className="card p-3">{composer}</div>
        </div>
      </div>
    );
  }

  // A styling session: full screen on phones (above the tab bar), inline on larger screens.
  const session = (
    <div className="fixed inset-x-0 top-0 z-40 flex h-dvh flex-col bg-bg md:static md:h-auto md:z-auto md:block md:space-y-5" role="region" aria-label="Styling session">
      <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-3 md:border-0 md:p-0">
        <div>
          <h1 className="text-lg font-semibold md:text-2xl">Stylist</h1>
          <p className="hidden text-sm text-muted md:block">Swipe right on the looks you&apos;d wear.</p>
        </div>
        <button className="btn-ghost px-3 md:px-5" onClick={endSession} aria-label="End this styling session">
          <CloseIcon className="h-4 w-4 md:hidden" />
          <span className="hidden md:inline">New chat</span>
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4 md:overflow-visible md:p-0">
        {turns.map((t, i) =>
          t.role === "user" ? (
            <div key={i} className="animate-rise ml-auto w-fit max-w-[85%] bg-accent px-4 py-2 text-sm text-accent-contrast">{t.text}</div>
          ) : (
            <div key={i} className="space-y-3">
              {t.text ? <p className={`animate-rise text-sm ${t.error ? "text-danger" : ""}`}>{t.text}</p> : null}
              {t.outfits.length || (busy && i === turns.length - 1) ? (
                <SwipeDeck outfits={t.outfits} streaming={busy && i === turns.length - 1} preview={t.preview} />
              ) : null}
            </div>
          ),
        )}
        {busy ? <p className="animate-pulse text-center text-sm text-muted" role="status">{step}…</p> : null}
        <div ref={bottom} />
      </div>

      <div className="space-y-3 border-t border-line bg-bg px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 md:card md:p-3">
        {chips(true)}
        {composer}
      </div>
    </div>
  );
  // On phones the session is portalled to <body>: the page wrapper's entrance animation would
  // otherwise become the containing block for position: fixed and squeeze the session into it.
  return isPhone ? createPortal(session, document.body) : session;
}
