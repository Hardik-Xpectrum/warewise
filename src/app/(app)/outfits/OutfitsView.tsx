"use client";
import Link from "next/link";
import { useState } from "react";
import { HeartIcon } from "@/components/Icons";
import ItemThumb from "@/components/ItemThumb";
import PageSkeleton from "@/components/PageSkeleton";
import { toast } from "@/components/Toaster";
import type { Item } from "@/components/types";
import { api, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/query";

type Outfit = {
  id: string;
  name: string | null;
  occasion: string | null;
  source: string;
  isFavorite: boolean;
  timesWorn: number;
  items: { id: string; slot: string; subcategory: string | null; colors: string[]; thumbUrl: string | null }[];
};
type List = { outfits: Outfit[] };

export default function OutfitsView({ initialFavorites = false }: { initialFavorites?: boolean }) {
  const [favoritesOnly, setFavoritesOnly] = useState(initialFavorites);
  const [building, setBuilding] = useState(false);
  const [popped, setPopped] = useState<string | null>(null); // the heart just tapped, so only it animates
  const key = `/outfits${favoritesOnly ? "?favorite=true" : ""}`;
  const { data, error, mutate } = useApi<List>(key);
  const outfits = data?.outfits;

  /** Optimistic: the list changes at once; on failure it snaps back and says why. */
  async function act(change: (xs: Outfit[]) => Outfit[], call: () => Promise<unknown>, note: string) {
    const undo = mutate((d) => (d ? { outfits: change(d.outfits) } : d));
    try {
      await call();
      if (note) toast(note);
      invalidate("/outfits");
      invalidate("/insights");
    } catch (err) {
      undo();
      toast(errorText(err), "error");
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Outfits</h1>
          <p className="text-sm text-muted">Looks you liked in the stylist, saved, or built yourself.</p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={() => setFavoritesOnly((f) => !f)} aria-pressed={favoritesOnly}>
            <HeartIcon filled={favoritesOnly} className="h-4 w-4" /> {favoritesOnly ? "Favourites" : "All outfits"}
          </button>
          <button className="btn-primary" onClick={() => setBuilding((b) => !b)}>{building ? "Close" : "Build an outfit"}</button>
        </div>
      </div>
      {building ? <Builder onSaved={() => { setBuilding(false); invalidate("/outfits"); }} /> : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {!outfits && !error ? <PageSkeleton /> : null}
      {outfits && !outfits.length ? (
        <div className="card p-8 text-center text-muted">
          {favoritesOnly ? "No favourites yet. Swipe right on a look in the stylist to keep it here." : "No saved outfits yet. Ask the stylist and swipe right, or build one."}
        </div>
      ) : null}
      <ul className="grid grid-cols-2 gap-x-3 gap-y-10 sm:gap-x-4 lg:grid-cols-3">
        {outfits?.map((o) => (
          <li key={o.id} className="animate-rise space-y-3">
            {/* Product tile: a 2×2 look of the pieces, the heart in the corner. */}
            <div className="relative">
              <ul className="grid grid-cols-2 gap-1">
                {o.items.slice(0, 4).map((i) => (
                  <li key={i.id}><ItemThumb url={i.thumbUrl} alt={i.subcategory ?? i.slot} className="aspect-[3/4]" /></li>
                ))}
              </ul>
              <button
                className={`absolute right-2 top-2 grid h-10 w-10 place-items-center bg-bg/90 transition hover:scale-105 ${o.isFavorite && popped === o.id ? "animate-heart" : ""}`}
                style={{ color: o.isFavorite ? "var(--heart)" : "var(--text)" }}
                aria-label={o.isFavorite ? "Remove from favourites" : "Add to favourites"}
                aria-pressed={o.isFavorite}
                onClick={() => {
                  if (!o.isFavorite) setPopped(o.id);
                  act(
                    (xs) => (favoritesOnly && o.isFavorite ? xs.filter((x) => x.id !== o.id) : xs.map((x) => (x.id === o.id ? { ...x, isFavorite: !x.isFavorite } : x))),
                    () => api(`/outfits/${o.id}`, { method: "PATCH", json: { is_favorite: !o.isFavorite } }),
                    o.isFavorite ? "Removed from favourites" : "Added to favourites",
                  );
                }}
              >
                <HeartIcon filled={o.isFavorite} />
              </button>
            </div>
            <div>
              <p className="truncate text-sm">{o.name ?? "Outfit"}</p>
              <p className="text-xs text-muted capitalize">{o.occasion ?? "any occasion"} · worn {o.timesWorn}×</p>
            </div>
            {/* Two tiles a row on phones: the actions shrink to fit under a half-width tile. */}
            <div className="flex flex-wrap gap-x-2 gap-y-1.5 [&>*]:px-3 sm:[&>*]:px-5">
              <Link className="btn-primary" href={`/tryon?outfit=${o.id}`}>Try on</Link>
              <button
                className="btn-ghost"
                onClick={() => act((xs) => xs.map((x) => (x.id === o.id ? { ...x, timesWorn: x.timesWorn + 1 } : x)), () => api("/wear-log", { method: "POST", json: { outfitId: o.id } }), "Logged as worn today")}
              >
                I wore this
              </button>
              <button
                className="btn px-2 text-muted underline-offset-4 hover:text-danger hover:underline"
                onClick={() => confirm("Delete this outfit?") && act((xs) => xs.filter((x) => x.id !== o.id), () => api(`/outfits/${o.id}`, { method: "DELETE" }), "Outfit deleted")}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Builder({ onSaved }: { onSaved: () => void }) {
  const { data } = useApi<{ items: Item[] }>("/items?lifecycle=active&limit=100");
  const items = (data?.items ?? []).filter((i) => i.status === "ready");
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  async function save() {
    try {
      await api("/outfits", { method: "POST", json: { name: name || "My outfit", itemIds: picked } });
      toast("Outfit saved");
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="card space-y-3 p-4">
      <input className="input" placeholder="Outfit name, e.g. Monday office" value={name} onChange={(e) => setName(e.target.value)} />
      <ul className="grid grid-cols-4 gap-2 sm:grid-cols-8">
        {items.map((i) => {
          const on = picked.includes(i.id);
          return (
            <li key={i.id}>
              <button type="button" aria-pressed={on} onClick={() => setPicked((p) => (on ? p.filter((x) => x !== i.id) : [...p, i.id].slice(0, 8)))} className={`w-full rounded-none border-2 ${on ? "border-accent" : "border-transparent"}`}>
                <ItemThumb url={i.thumbUrl} alt={i.subcategory ?? "item"} className="aspect-square" />
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-3">
        <button className="btn-primary" disabled={!picked.length} onClick={save}>Save outfit ({picked.length})</button>
        {error ? <span className="text-sm text-danger">{error}</span> : null}
      </div>
    </div>
  );
}
