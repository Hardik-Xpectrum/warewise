"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { CloseIcon, ShirtIcon } from "@/components/Icons";
import ItemThumb from "@/components/ItemThumb";
import type { Item } from "@/components/types";
import Uploader from "@/components/Uploader";
import { toast } from "@/components/Toaster";
import { api, errorText } from "@/lib/api";
import { morphNavigate } from "@/lib/morph";
import { invalidate, setQueryData, useApi } from "@/lib/query";
import { browserClient } from "@/lib/supabase/browser";
import FilterSheet, { activeFilters, EMPTY_FILTERS as EMPTY, sortItems, SORTS, type Filters, type Sort } from "./FilterSheet";
import FittingRoom, { ROOM_SLOTS, toggleInRoom, type Room, type RoomSlot } from "./FittingRoom";

const ROOM_KEY = "warewise:fitting-room";
type RoomState = { room: Room; history: string[] };
const EMPTY_ROOM: RoomState = { room: {}, history: [] };

// The fitting room lives in sessionStorage (this browser tab). Read through an external store so
// the server render and the first client render agree (both empty), then the saved room appears.
const roomListeners = new Set<() => void>();
let roomCache: { raw: string | null; value: RoomState } = { raw: null, value: EMPTY_ROOM };
function readRoom(): RoomState {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(ROOM_KEY);
  } catch {
    /* private mode or blocked storage: start empty */
  }
  if (raw !== roomCache.raw) {
    let value = EMPTY_ROOM;
    try {
      if (raw) value = JSON.parse(raw);
    } catch {
      /* corrupt entry: start empty */
    }
    roomCache = { raw, value };
  }
  return roomCache.value;
}
function writeRoom(next: RoomState) {
  try {
    sessionStorage.setItem(ROOM_KEY, JSON.stringify(next));
  } catch {
    roomCache = { raw: JSON.stringify(next), value: next }; // storage blocked: keep it in memory
  }
  roomListeners.forEach((l) => l());
}
const subscribeRoom = (l: () => void) => {
  roomListeners.add(l);
  return () => roomListeners.delete(l);
};

export default function WardrobeView() {
  const router = useRouter();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  // The query string behind the cache key; typing in search waits 300 ms before it changes.
  const [query, setQuery] = useState("");
  useEffect(() => {
    const next = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
    const t = setTimeout(() => setQuery(next), filters.q ? 300 : 0);
    return () => clearTimeout(t);
  }, [filters]);
  const { data, error: loadError, refresh } = useApi<{ items: Item[] }>(`/items?${query}`);
  const [sort, setSort] = useState<Sort>("newest");
  const [filterOpen, setFilterOpen] = useState(false);
  const closeFilters = useCallback(() => setFilterOpen(false), []);
  const items = useMemo(() => (data ? sortItems(data.items, sort) : null), [data, sort]);
  const [error, setError] = useState("");

  // Fitting room: what you're trying on while you browse, kept for this browser tab.
  const roomState = useSyncExternalStore(subscribeRoom, readRoom, () => EMPTY_ROOM);
  const [sheetOpen, setSheetOpen] = useState(false);
  const { room, history } = roomState;
  const saveRoom = writeRoom;
  const toggle = (item: Item) =>
    saveRoom({ room: toggleInRoom(room, item), history: [item.id, ...history.filter((id) => id !== item.id)].slice(0, 12) });
  const inRoom = (id: string) => Object.values(room).includes(id);
  const roomCount = Object.keys(room).length;
  const allItems = items ?? [];

  // Live status: Realtime pushes item updates; a slow poll covers dropped connections.
  const processing = items?.some((i) => i.status === "processing") ?? false;
  useEffect(() => {
    const supabase = browserClient();
    let channel: ReturnType<typeof supabase.channel> | undefined;
    let cancelled = false;
    supabase.auth.getUser().then(({ data }) => {
      // The effect may have been cleaned up while we waited (React runs effects twice in dev).
      if (cancelled || !data.user) return;
      channel = supabase
        .channel(`wardrobe-items-${crypto.randomUUID()}`)
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "wardrobe_items", filter: `user_id=eq.${data.user.id}` }, () => invalidate("/items"))
        .subscribe();
    });
    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, []);
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [processing, refresh]);

  const load = useCallback(() => {
    invalidate("/items");
    invalidate("/today");
    invalidate("/shopping");
    invalidate("/insights");
  }, []);

  const hasSamples = items?.some((i) => i.is_sample) ?? false;
  async function samples(add: boolean) {
    try {
      await api("/samples", { method: add ? "POST" : "DELETE" });
      toast(add ? "Sample wardrobe added" : "Sample items removed");
      load();
      invalidate("/outfits");
    } catch (err) {
      setError(errorText(err));
    }
  }

  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const filtered = Object.values(filters).some(Boolean);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Your wardrobe</h1>
          <p className="text-sm text-muted">{items ? `${items.length} item${items.length === 1 ? "" : "s"}${filtered ? " match" : ""}` : "\u00a0"}</p>
        </div>
        {hasSamples ? (
          <button className="btn-ghost" onClick={() => samples(false)}>Remove sample items</button>
        ) : items?.length ? (
          <button className="btn-ghost" onClick={() => samples(true)}>Add sample items</button>
        ) : null}
      </div>

      <div id="add" className="scroll-mt-20">
        <Uploader onUploaded={load} />
      </div>

      {/* Search plus one Filter & sort button; the active filters show as removable tags. */}
      <div className="space-y-3">
        <div className="flex gap-2">
          <input className="input" type="search" placeholder="Search: kurta, linen…" value={filters.q} onChange={set("q")} aria-label="Search your wardrobe" />
          <button type="button" className="btn-ghost shrink-0" onClick={() => setFilterOpen(true)} aria-haspopup="dialog">
            <FilterIcon /> Filter &amp; sort{activeFilters(filters).length ? ` (${activeFilters(filters).length})` : ""}
          </button>
        </div>
        {activeFilters(filters).length || sort !== "newest" ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {activeFilters(filters).map((f) => (
              <button key={f.key} className="flex items-center gap-1 border border-text px-2 py-1 capitalize" onClick={() => setFilters((x) => ({ ...x, [f.key]: "" }))} aria-label={`Remove filter ${f.label}`}>
                {f.label} <CloseIcon className="h-3 w-3" />
              </button>
            ))}
            {sort !== "newest" ? <span className="text-muted">Sorted: {SORTS[sort]}</span> : null}
            <button className="text-muted underline underline-offset-4 hover:text-text" onClick={() => { setFilters((x) => ({ ...EMPTY, q: x.q })); setSort("newest"); }}>
              Clear all
            </button>
          </div>
        ) : null}
      </div>
      {filterOpen ? <FilterSheet filters={filters} sort={sort} count={items?.length ?? null} onChange={setFilters} onSort={setSort} onClose={closeFilters} /> : null}

      {error || loadError ? <p className="text-sm text-danger">{error || loadError}</p> : null}

      {items && items.length === 0 ? (
        <div className="card p-8 text-center text-muted">
          {filtered ? "Nothing matches these filters." : "No clothes yet. Add a few photos to get started: a top, a bottom and some shoes is enough for the stylist."}
          {!filtered ? (
            <div className="mt-4">
              <button className="btn-ghost" onClick={() => samples(true)}>Load a sample wardrobe to explore</button>
              <p className="mt-2 text-xs">12 illustrated items and 3 outfits, clearly marked and removable in one tap.</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {!items && !loadError ? (
        <ul className="grid grid-cols-2 gap-x-3 gap-y-8 sm:grid-cols-3 lg:grid-cols-4" aria-busy="true" aria-label="Loading wardrobe">
          {Array.from({ length: 8 }, (_, i) => <li key={i} className="skeleton aspect-[3/4]" />)}
        </ul>
      ) : null}

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start lg:gap-8">
      {/* Product grid: tall images, no card chrome, small captions underneath. */}
      <ul className="grid grid-cols-2 gap-x-3 gap-y-8 sm:grid-cols-3">
        {items?.map((item) => (
          <li key={item.id} className="animate-rise">
            {/* Seeding the item page's cache lets it draw at once, so the photo morphs from the grid
                into place. Modified clicks (new tab) keep the normal link behaviour. */}
            <Link
              href={`/wardrobe/${item.id}`}
              className="group block"
              onClick={(e) => {
                setQueryData<Item>(`/items/${item.id}`, (cur) => cur ?? item);
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                const thumb = e.currentTarget.querySelector<HTMLElement>("[data-thumb]");
                if (!thumb) return;
                e.preventDefault();
                morphNavigate(thumb, item.id, () => router.push(`/wardrobe/${item.id}`));
              }}
            >
              <div className="relative">
                {item.status === "ready" && ROOM_SLOTS.includes(item.category as RoomSlot) ? (
                  <button
                    type="button"
                    className="absolute right-2 top-2 z-10 grid h-9 w-9 place-items-center transition hover:scale-105"
                    style={inRoom(item.id) ? { background: "var(--text)", color: "var(--bg)" } : { background: "color-mix(in srgb, var(--bg) 90%, transparent)", color: "var(--text)" }}
                    aria-pressed={inRoom(item.id)}
                    aria-label={inRoom(item.id) ? `Take off ${item.subcategory ?? item.category}` : `Try on ${item.subcategory ?? item.category}`}
                    title={inRoom(item.id) ? "In the fitting room" : "Try on"}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      toggle(item);
                    }}
                  >
                    <ShirtIcon className="h-5 w-5" />
                  </button>
                ) : null}
                {/* Cut-outs on one backdrop read like studio product shots; photos are the fallback. */}
                <div data-thumb className="wipe-reveal">
                  <ItemThumb url={item.cutoutUrl ?? item.thumbUrl} alt={item.subcategory ?? "Clothing item"} className="aspect-[3/4] p-3 transition-opacity group-hover:opacity-90" />
                </div>
                <div className="absolute left-2 top-2 flex flex-wrap gap-1">
                  {item.is_sample ? <span className="bg-bg px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.1em] uppercase">Sample</span> : null}
                  {item.lifecycle !== "active" ? <span className="bg-bg px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.1em] uppercase">{item.lifecycle}</span> : null}
                  {item.duplicate_of ? <span className="bg-bg px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.1em] text-danger uppercase">Duplicate?</span> : null}
                </div>
              </div>
              <div className="mt-2.5 space-y-0.5">
                {item.status === "processing" ? (
                  <p className="text-sm text-muted">Tagging…</p>
                ) : item.status === "failed" ? (
                  <p className="text-sm text-danger">Needs attention</p>
                ) : (
                  <>
                    <p className="truncate text-sm capitalize group-hover:underline">{item.subcategory ?? item.category}</p>
                    <p className="truncate text-xs text-muted capitalize">
                      {[item.colors.join(", "), item.size_label ? `Size ${item.size_label}` : null].filter(Boolean).join(" · ")}
                    </p>
                  </>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>

      {/* Desktop: the fitting room sits beside the grid and follows you down the page. */}
      <aside className="sticky top-28 hidden lg:block">
        <FittingRoom room={room} items={allItems} history={history} onToggle={toggle} onClear={() => saveRoom({ room: {}, history })} />
      </aside>
      </div>

      {/* Phone: a floating button opens the fitting room as a bottom sheet. */}
      <button
        type="button"
        className="fixed bottom-24 right-4 z-30 flex items-center gap-2 px-4 py-3 text-xs font-semibold tracking-[0.1em] uppercase shadow-lg lg:hidden"
        style={{ background: "var(--text)", color: "var(--bg)" }}
        onClick={() => setSheetOpen(true)}
        aria-haspopup="dialog"
      >
        <ShirtIcon className="h-4 w-4" /> Fitting room{roomCount ? ` · ${roomCount}` : ""}
      </button>
      {sheetOpen ? (
        <div className="fixed inset-x-0 top-0 z-50 h-dvh lg:hidden" role="dialog" aria-modal="true" aria-label="Fitting room">
          <button className="absolute inset-0 bg-black/40" aria-label="Close fitting room" onClick={() => setSheetOpen(false)} />
          <div className="animate-rise absolute inset-x-0 bottom-0 max-h-[88vh] overflow-y-auto border-t border-line bg-bg p-4 pb-8">
            <FittingRoom room={room} items={allItems} history={history} onToggle={toggle} onClear={() => saveRoom({ room: {}, history })} onClose={() => setSheetOpen(false)} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FilterIcon() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  );
}
