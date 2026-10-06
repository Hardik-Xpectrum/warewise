"use client";
import Link from "next/link";
import { useState } from "react";
import { CloseIcon } from "@/components/Icons";
import ItemThumb from "@/components/ItemThumb";
import PageSkeleton from "@/components/PageSkeleton";
import { toast } from "@/components/Toaster";
import type { OutfitCardData } from "@/components/types";
import { api, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/query";
import { OCCASIONS, type Occasion } from "@/modules/stylist/rules";

type Week = { days: { day: string; suggested: Occasion; outfit: OutfitCardData | null }[] };
type Saved = { outfits: { id: string; name: string | null; occasion: string | null; items: { id: string; thumbUrl: string | null; subcategory: string | null; slot: string }[] }[] };
type Pack = {
  weather: { city: string; tempMinC: number; tempMaxC: number } | null;
  items: { id: string; label?: string; thumbUrl: string | null }[];
  days: { day: number; occasion: Occasion; outfit: OutfitCardData | null }[];
  missing: number;
};

const dayLabel = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

function Mosaic({ items }: { items: { id: string; thumbUrl: string | null; label?: string }[] }) {
  return (
    <ul className="grid grid-cols-2 gap-0.5">
      {items.slice(0, 4).map((i) => (
        <li key={i.id}><ItemThumb url={i.thumbUrl} alt={i.label ?? ""} className="aspect-square" /></li>
      ))}
    </ul>
  );
}

/** Plan the week (Today follows the plan) and pack a small capsule for a trip. */
export default function PlanView() {
  const week = useApi<Week>("/plan");
  const [picking, setPicking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function autoPlan() {
    setBusy(true);
    try {
      week.mutate(() => undefined);
      const next = await api<Week>("/plan/auto", { method: "POST" });
      week.mutate(() => next);
      invalidate("/today");
      toast("Your week is planned");
    } catch (err) {
      toast(errorText(err), "error");
      week.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function clear(day: string) {
    const undo = week.mutate((w) => (w ? { days: w.days.map((d) => (d.day === day ? { ...d, outfit: null } : d)) } : w));
    try {
      await api(`/plan/${day}`, { method: "DELETE" });
      invalidate("/today");
    } catch (err) {
      undo();
      toast(errorText(err), "error");
    }
  }

  return (
    <div className="space-y-12">
      <section className="space-y-5">
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-5">
          <div>
            <p className="eyebrow">Plan</p>
            <h1 className="text-3xl font-semibold tracking-tight">Your week</h1>
            <p className="mt-1 text-sm text-muted">Decide once, get dressed faster. Today shows the planned outfit each morning.</p>
          </div>
          <button className="btn-primary" disabled={busy} onClick={autoPlan}>{busy ? "Planning…" : "Plan my week"}</button>
        </header>

        {!week.data ? (
          <PageSkeleton cards={7} />
        ) : (
          <ol className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:grid sm:grid-cols-4 sm:overflow-visible sm:px-0 lg:grid-cols-7">
            {week.data.days.map((d, i) => (
              <li key={d.day} className="w-40 shrink-0 snap-start space-y-2 sm:w-auto">
                {/* Two fixed lines, so a long occasion never pushes its card below the others. */}
                <div className="min-w-0">
                  <p className={`text-xs font-semibold tracking-[0.1em] uppercase ${i === 0 ? "text-heart" : ""}`}>
                    {i === 0 ? "Today" : dayLabel(d.day)}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted">{OCCASIONS[d.suggested].label}</p>
                </div>
                {d.outfit ? (
                  <div className="group relative">
                    <Mosaic items={d.outfit.items} />
                    <button className="absolute right-1 top-1 grid h-7 w-7 place-items-center bg-bg/90 opacity-80 hover:opacity-100" onClick={() => clear(d.day)} aria-label={`Remove plan for ${dayLabel(d.day)}`}>
                      <CloseIcon className="h-4 w-4" />
                    </button>
                    <div className="mt-1.5 flex gap-2 text-[11px] font-semibold tracking-[0.08em] uppercase">
                      <Link className="underline-offset-4 hover:underline" href={`/tryon?outfit=${d.outfit.outfitId}`}>Try on</Link>
                      <button className="underline-offset-4 hover:underline" onClick={() => setPicking(d.day)}>Change</button>
                    </div>
                  </div>
                ) : (
                  <button className={`grid aspect-square w-full place-items-center border border-dashed text-xs font-semibold tracking-[0.1em] text-muted uppercase transition hover:border-text hover:text-text ${i === 0 ? "border-text/40" : "border-line"}`} onClick={() => setPicking(d.day)}>
                    + Plan
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <TripPacker />

      {picking ? <OutfitPicker day={picking} onClose={() => setPicking(null)} onPicked={() => { setPicking(null); week.refresh(); invalidate("/today"); }} /> : null}
    </div>
  );
}

function OutfitPicker({ day, onClose, onPicked }: { day: string; onClose: () => void; onPicked: () => void }) {
  const saved = useApi<Saved>("/outfits");
  async function pick(outfitId: string) {
    try {
      await api(`/plan/${day}`, { method: "PUT", json: { outfitId } });
      toast(`Planned for ${dayLabel(day)}`);
      onPicked();
    } catch (err) {
      toast(errorText(err), "error");
    }
  }
  return (
    <div className="fixed inset-0 z-50 grid place-items-end sm:place-items-center" role="dialog" aria-modal="true" aria-label={`Choose an outfit for ${dayLabel(day)}`}>
      <button className="absolute inset-0 bg-black/40" aria-label="Close" onClick={onClose} />
      <div className="animate-rise relative max-h-[85vh] w-full overflow-y-auto border border-line bg-bg p-5 sm:max-w-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="eyebrow text-text">Outfit for {dayLabel(day)}</h2>
          <button className="grid h-8 w-8 place-items-center" onClick={onClose} aria-label="Close"><CloseIcon className="h-5 w-5" /></button>
        </div>
        {!saved.data ? (
          <div className="skeleton h-40" />
        ) : !saved.data.outfits.length ? (
          <p className="text-sm text-muted">No saved outfits yet. <Link className="underline" href="/stylist">Ask the stylist</Link> and swipe right on a few looks, or use “Plan my week”.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {saved.data.outfits.map((o) => (
              <li key={o.id}>
                <button className="block w-full text-left" onClick={() => pick(o.id)}>
                  <Mosaic items={o.items} />
                  <p className="mt-1.5 truncate text-sm">{o.name ?? "Outfit"}</p>
                  <p className="text-xs text-muted capitalize">{o.occasion ?? "any occasion"}</p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TripPacker() {
  const [days, setDays] = useState<Occasion[]>(["casual", "casual", "casual"]);
  const [city, setCity] = useState("");
  const [result, setResult] = useState<Pack | null>(null);
  const [busy, setBusy] = useState(false);

  const setCount = (n: number) => setDays((d) => Array.from({ length: n }, (_, i) => d[i] ?? "casual"));

  async function pack(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      setResult(await api<Pack>("/pack", { method: "POST", json: { occasions: days, city: city || undefined } }));
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-5">
      <header className="border-b border-line pb-5">
        <p className="eyebrow">Travel</p>
        <h2 className="text-2xl font-semibold tracking-tight">Pack for a trip</h2>
        <p className="mt-1 text-sm text-muted">The fewest pieces that give you a different outfit every day, with the weather at your destination.</p>
      </header>
      <form onSubmit={pack} className="space-y-4">
        <div className="grid gap-3 sm:max-w-lg sm:grid-cols-[10rem_1fr]">
          <div>
            <label className="label" htmlFor="trip-days">Days</label>
            <select id="trip-days" className="input" value={days.length} onChange={(e) => setCount(Number(e.target.value))}>
              {Array.from({ length: 14 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n} {n === 1 ? "day" : "days"}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="trip-city">Destination</label>
            <input id="trip-city" className="input" placeholder="e.g. Goa" value={city} onChange={(e) => setCity(e.target.value)} maxLength={80} />
          </div>
        </div>
        <div>
          <p className="label">Each day</p>
          <ol className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-3">
            {days.map((o, i) => (
              <li key={i}>
                <label className="mb-1 block text-xs font-semibold tracking-[0.1em] uppercase" htmlFor={`trip-day-${i}`}>Day {i + 1}</label>
                <select
                  id={`trip-day-${i}`}
                  className="input"
                  value={o}
                  onChange={(e) => setDays((d) => d.map((x, j) => (j === i ? (e.target.value as Occasion) : x)))}
                >
                  {Object.entries(OCCASIONS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </li>
            ))}
          </ol>
        </div>
        <button className="btn-primary" disabled={busy}>{busy ? "Packing…" : "Pack my bag"}</button>
      </form>

      {result ? (
        <div className="animate-rise space-y-6">
          <div>
            <p className="text-sm">
              <strong>{result.items.length} pieces</strong> for {result.days.length} {result.days.length === 1 ? "day" : "days"}
              {result.weather ? ` · ${result.weather.city} ${Math.round(result.weather.tempMinC)}–${Math.round(result.weather.tempMaxC)}°C` : ""}
              {result.missing ? ` · ${result.missing} day${result.missing === 1 ? "" : "s"} without a suitable outfit (see Shop for what's missing)` : ""}
            </p>
            <ul className="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-8">
              {result.items.map((i) => (
                <li key={i.id}>
                  <ItemThumb url={i.thumbUrl} alt={i.label ?? ""} className="aspect-[3/4]" />
                  <p className="mt-1 truncate text-[11px] capitalize text-muted">{i.label}</p>
                </li>
              ))}
            </ul>
          </div>
          <ol className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
            {result.days.map((d) => (
              <li key={d.day} className="space-y-1.5">
                <div className="min-w-0">
                  <p className="text-xs font-semibold tracking-[0.1em] uppercase">Day {d.day}</p>
                  <p className="mt-0.5 truncate text-xs text-muted">{OCCASIONS[d.occasion].label}</p>
                </div>
                {d.outfit ? <Mosaic items={d.outfit.items} /> : <div className="grid aspect-square place-items-center bg-surface-2 p-2 text-center text-xs text-muted">Nothing suitable</div>}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
