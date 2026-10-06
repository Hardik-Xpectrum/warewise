"use client";
import Link from "next/link";
import { useState } from "react";
import ItemThumb from "@/components/ItemThumb";
import OutfitCard from "@/components/OutfitCard";
import { toast } from "@/components/Toaster";
import type { OutfitCardData } from "@/components/types";
import { api, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/query";
import { OCCASIONS, type Occasion } from "@/modules/stylist/rules";

type Today = {
  day: string;
  occasion: Occasion;
  weather: { city: string; tempMinC: number; tempMaxC: number; rainChancePct: number } | null;
  outfit: OutfitCardData | null;
  shuffles: number;
  sameAsBefore: boolean;
  itemCount: number;
  taste: string | null;
  explain: string | null;
  forgotten: { id: string; label: string; thumbUrl: string | null; days: number | null } | null;
  setup: { items: number; city: boolean; sizes: boolean; avatar: boolean };
};

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

/** First-run checklist: the four things that make suggestions good. Hidden once all are done. */
function SetupChecklist({ setup, onSamples }: { setup: Today["setup"]; onSamples: () => Promise<void> }) {
  const [loading, setLoading] = useState(false);
  const steps = [
    { done: setup.items >= 5, label: `Add 5 clothes (${Math.min(setup.items, 5)}/5)`, hint: "Or load the sample wardrobe to explore first", href: "/wardrobe" },
    { done: setup.city, label: "Set your city", hint: "For weather-aware outfits", href: "/profile" },
    { done: setup.sizes, label: "Add your sizes", hint: "So try-on shows the right fit", href: "/profile" },
    { done: setup.avatar, label: "Add a photo of yourself", hint: "To try outfits on", href: "/tryon" },
  ];
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  return (
    <section className="card animate-rise space-y-3 p-4" aria-label="Get set up">
      <div className="flex items-baseline justify-between">
        <h2 className="eyebrow text-text">Get set up</h2>
        <span className="text-xs text-muted">{done} of {steps.length} done</span>
      </div>
      <div className="h-0.5 overflow-hidden bg-surface-2">
        <div className="h-full bg-accent transition-all" style={{ width: `${(done / steps.length) * 100}%` }} />
      </div>
      {setup.items < 2 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-none bg-surface-2 p-3 text-sm">
          <span className="flex-1">New here? Explore with 12 sample clothes and 3 outfits, clearly marked and removable in one tap.</span>
          <button
            className="btn-primary"
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              await onSamples().finally(() => setLoading(false));
            }}
          >
            {loading ? "Loading…" : "Load sample wardrobe"}
          </button>
        </div>
      ) : null}
      <ol className="grid gap-2 sm:grid-cols-2">
        {steps.map((s) => (
          <li key={s.label}>
            <Link href={s.href} className={`flex items-start gap-3 rounded-none border border-line p-3 transition hover:bg-surface-2 ${s.done ? "bg-surface-2" : ""}`}>
              <span aria-hidden className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center text-xs ${s.done ? "bg-text text-bg" : "border border-text"}`}>{s.done ? "✓" : ""}</span>
              <span>
                <span className={`block text-sm font-medium ${s.done ? "text-muted line-through" : ""}`}>{s.label}</span>
                <span className="block text-xs text-muted">{s.hint}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

function TodaySkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading today's outfit">
      <div className="skeleton h-8 w-64" />
      <div className="skeleton h-4 w-80" />
      <div className="card space-y-3 p-3">
        <div className="skeleton h-9 w-48" />
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton aspect-square" />)}
        </div>
        <div className="skeleton h-4 w-3/4" />
      </div>
    </div>
  );
}

/** Today: one outfit for the day, from your clothes, the weather and what you like. */
export default function TodayView() {
  const today = useApi<Today>("/today");
  const data = today.data;
  const error = today.error;
  const setData = (next: Today) => today.mutate(() => next);
  const [busy, setBusy] = useState(false);

  async function loadSamples() {
    try {
      await api("/samples", { method: "POST" });
      toast("Sample wardrobe added");
      invalidate("/items");
      invalidate("/outfits");
      setData(await api<Today>("/today", { method: "POST", json: {} }));
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  async function shuffle(occasion?: Occasion) {
    setBusy(true);
    try {
      const next = await api<Today>("/today", { method: "POST", json: { occasion: occasion ?? data?.occasion } });
      setData(next);
      if (next.sameAsBefore) toast("That's the only combination for now. Add more clothes for variety.");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="text-danger">{error}</p>;
  if (!data) return <TodaySkeleton />;
  const w = data.weather;

  return (
    <div className="space-y-5">
      <header className="animate-rise space-y-2 border-b border-line pb-6">
        <p className="eyebrow">
          {new Date(`${data.day}T00:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}
          {w ? ` · ${w.city} ${Math.round(w.tempMinC)}–${Math.round(w.tempMaxC)}°C${w.rainChancePct >= 40 ? ` · ${w.rainChancePct}% rain` : ""}` : ""}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">{greeting()}. Here&apos;s what to wear.</h1>
      </header>

      {/* New users see setup first; once there's an outfit, the outfit leads. */}
      {!data.outfit ? <SetupChecklist setup={data.setup} onSamples={loadSamples} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="today-occasion">Occasion</label>
        <select id="today-occasion" className="input w-auto" value={data.occasion} disabled={busy} onChange={(e) => shuffle(e.target.value as Occasion)}>
          {Object.entries(OCCASIONS).map(([k, o]) => <option key={k} value={k}>{o.label}</option>)}
        </select>
        <button className="btn-ghost" disabled={busy || !data.outfit} onClick={() => shuffle()} aria-keyshortcuts="S">
          {busy ? "Shuffling…" : "Shuffle"}
        </button>
        <Link className="btn-ghost" href="/stylist">Ask the stylist</Link>
      </div>

      {data.outfit ? (
        <div className="animate-rise" key={data.outfit.outfitId}>
          <OutfitCard outfit={data.outfit} />
        </div>
      ) : (
        <div className="card space-y-3 p-6 text-center">
          <p className="font-medium">{data.itemCount < 2 ? "Add a few clothes to get your first outfit." : "No outfit fits this occasion yet."}</p>
          {data.explain && data.itemCount >= 2 ? <p className="text-sm text-muted">Why: {data.explain}.</p> : null}
          <div className="flex justify-center gap-2">
            <Link className="btn-primary" href="/wardrobe">Add clothes</Link>
            <Link className="btn-ghost" href="/shop">See what&apos;s missing</Link>
          </div>
        </div>
      )}

      {data.outfit ? <SetupChecklist setup={data.setup} onSamples={loadSamples} /> : null}

      {data.taste ? <p className="text-xs text-muted">Tuned to your taste: {data.taste}. Likes, saves and what you wear keep improving this.</p> : null}

      {data.forgotten ? (
        <Link href={`/wardrobe/${data.forgotten.id}`} className="card animate-rise flex items-center gap-3 p-3 transition hover:bg-surface-2">
          <ItemThumb url={data.forgotten.thumbUrl} alt={data.forgotten.label} className="h-16 w-16 shrink-0" />
          <span className="text-sm">
            <span className="block font-medium capitalize">Bring back your {data.forgotten.label}</span>
            <span className="block text-muted">
              {data.forgotten.days === null ? "You haven't worn it yet." : `Not worn in ${data.forgotten.days} days.`} Tap to see ways to style it.
            </span>
          </span>
        </Link>
      ) : null}
    </div>
  );
}
