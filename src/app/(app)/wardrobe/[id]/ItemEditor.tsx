"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import CompleteLook from "@/components/CompleteLook";
import ItemThumb from "@/components/ItemThumb";
import type { Item } from "@/components/types";
import { toast } from "@/components/Toaster";
import { api, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/query";
import { CATEGORIES, CATEGORY_LABELS, COLORS, FITS, FORMALITY_LABELS, LIFECYCLES, PATTERNS, SEASONS } from "@/modules/wardrobe/taxonomy";

type Similar = Item & { distance: number };

export default function ItemEditor({ id }: { id: string }) {
  const router = useRouter();
  const itemQuery = useApi<Item>(`/items/${id}`);
  const item = itemQuery.data ?? null;
  const setItem = (next: Item) => itemQuery.mutate(() => next);
  const similar = useApi<{ items: Similar[] }>(item?.status === "ready" ? `/items/${id}/similar` : null).data?.items ?? [];
  const [draft, setDraft] = useState<Partial<Item>>({});
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  if (!item) return itemQuery.error ? <p className="text-danger">{itemQuery.error}</p> : status ? <p className="text-danger">{status}</p> : <div className="grid gap-6 md:grid-cols-[320px_1fr]" aria-busy="true" aria-label="Loading"><div className="skeleton aspect-square" /><div className="skeleton h-96" /></div>;
  const v = { ...item, ...draft };
  const change = <K extends keyof Item>(k: K, value: Item[K]) => setDraft((d) => ({ ...d, [k]: value }));
  const toggle = (k: "colors" | "seasons", value: string, max: number) => {
    const current = v[k];
    const next = current.includes(value) ? current.filter((x) => x !== value) : [...current, value].slice(-max);
    change(k, next);
  };

  async function save() {
    setBusy(true);
    try {
      const updated = await api<Item>(`/items/${id}`, { method: "PATCH", json: draft });
      setItem(updated);
      setDraft({});
      invalidate("/items?");
      invalidate("/today");
      toast("Saved. Thanks, corrections help the tagger improve.");
    } catch (err) {
      setStatus(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm("Delete this item and its photos? This can't be undone.")) return;
    await api(`/items/${id}`, { method: "DELETE" });
    invalidate("/items");
    invalidate("/today");
    invalidate("/outfits");
    toast("Item deleted");
    router.push("/wardrobe");
  }

  async function retry() {
    await api(`/items/${id}/retry`, { method: "POST" });
    setItem({ ...item!, status: "processing", status_reason: null });
  }

  async function wore() {
    await api("/wear-log", { method: "POST", json: { itemIds: [id] } });
    invalidate("/insights");
    invalidate("/today");
    toast("Logged as worn today");
  }

  const dirty = Object.keys(draft).length > 0;

  return (
    <div className="space-y-6">
      <Link href="/wardrobe" className="text-sm text-muted hover:text-text">← Wardrobe</Link>
      <div className="grid gap-6 md:grid-cols-[320px_1fr]">
        <div className="space-y-3">
          <div data-morph={item.id}>
            <ItemThumb url={item.cutoutUrl ?? item.imageUrl} alt={item.subcategory ?? "Item"} className="aspect-square p-4" />
          </div>
          {item.status === "processing" ? <p className="text-sm text-muted">Tagging in progress. This page shows AI tags once ready.</p> : null}
          {item.status === "failed" ? (
            <div className="card space-y-2 p-3">
              <p className="text-sm text-danger">{item.status_reason}</p>
              <button className="btn-ghost" onClick={retry}>Retry tagging</button>
              <p className="text-xs text-muted">Or fill in the details yourself and save.</p>
            </div>
          ) : null}
          {item.ai_confidence !== null && !item.user_verified ? (
            <p className="text-xs text-muted">Tagged by AI ({Math.round(item.ai_confidence * 100)}% sure). Please check the details.</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost" onClick={wore}>I wore this today</button>
            <button className="btn-danger" onClick={remove}>Delete</button>
          </div>
        </div>

        <div className="card space-y-4 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="f-category">Category</label>
              <select id="f-category" className="input" value={v.category ?? ""} onChange={(e) => change("category", e.target.value)}>
                <option value="" disabled>Choose…</option>
                {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="f-type">Type</label>
              <input id="f-type" className="input" value={v.subcategory ?? ""} placeholder="e.g. kurta, chinos" onChange={(e) => change("subcategory", e.target.value || null)} />
            </div>
            <div>
              <label className="label" htmlFor="f-pattern">Pattern</label>
              <select id="f-pattern" className="input" value={v.pattern ?? ""} onChange={(e) => change("pattern", e.target.value)}>
                <option value="" disabled>Choose…</option>
                {PATTERNS.map((p) => <option key={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="f-formality">Formality</label>
              <select id="f-formality" className="input" value={v.formality ?? ""} onChange={(e) => change("formality", Number(e.target.value))}>
                <option value="" disabled>Choose…</option>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} · {FORMALITY_LABELS[n]}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="f-fabric">Fabric</label>
              <input id="f-fabric" className="input" value={v.fabric ?? ""} onChange={(e) => change("fabric", e.target.value || null)} />
            </div>
            <div>
              <label className="label" htmlFor="f-fit">Fit</label>
              <select id="f-fit" className="input" value={v.fit ?? ""} onChange={(e) => change("fit", e.target.value)}>
                <option value="" disabled>Choose…</option>
                {FITS.map((f) => <option key={f}>{f}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="f-brand">Brand</label>
              <input id="f-brand" className="input" value={v.brand ?? ""} onChange={(e) => change("brand", e.target.value || null)} />
            </div>
            <div>
              <label className="label" htmlFor="f-size">Size on the label</label>
              <input id="f-size" className="input" placeholder="e.g. M, 32, UK 9" maxLength={12} value={v.size_label ?? ""} onChange={(e) => change("size_label", e.target.value || null)} />
            </div>
            <div>
              <label className="label" htmlFor="f-price">Price paid (₹, for cost per wear)</label>
              <input id="f-price" className="input" type="number" min={0} value={v.price_inr ?? ""} onChange={(e) => change("price_inr", e.target.value === "" ? null : Number(e.target.value))} />
            </div>
            <div>
              <label className="label" htmlFor="f-status">Status</label>
              <select id="f-status" className="input" value={v.lifecycle} onChange={(e) => change("lifecycle", e.target.value as Item["lifecycle"])}>
                {LIFECYCLES.map((l) => <option key={l}>{l}</option>)}
              </select>
            </div>
          </div>

          <div>
            <span className="label">Colours (up to 3, main first)</span>
            <div className="flex flex-wrap gap-1.5">
              {COLORS.map((c) => (
                <button key={c} type="button" onClick={() => toggle("colors", c, 3)} className={`chip ${v.colors.includes(c) ? "border-accent! bg-accent! text-accent-contrast!" : ""}`} aria-pressed={v.colors.includes(c)}>{c}</button>
              ))}
            </div>
          </div>
          <div>
            <span className="label">Seasons</span>
            <div className="flex flex-wrap gap-1.5">
              {SEASONS.map((s) => (
                <button key={s} type="button" onClick={() => toggle("seasons", s, 4)} className={`chip ${v.seasons.includes(s) ? "border-accent! bg-accent! text-accent-contrast!" : ""}`} aria-pressed={v.seasons.includes(s)}>{s}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="label" htmlFor="f-notes">Notes</label>
            <textarea id="f-notes" className="input" rows={2} value={v.notes ?? ""} onChange={(e) => change("notes", e.target.value || null)} />
          </div>

          <div className="flex items-center gap-3">
            <button className="btn-primary" disabled={!dirty || busy} onClick={save}>{busy ? "Saving…" : "Save changes"}</button>
            {status ? <span className="text-sm text-muted">{status}</span> : null}
          </div>
        </div>
      </div>

      {item.status === "ready" && item.category ? <CompleteLook itemId={item.id} /> : null}

      {similar.length ? (
        <section>
          <h2 className="mb-2 font-semibold">Looks similar</h2>
          <p className="mb-3 text-sm text-muted">Possible duplicates of this photo.</p>
          <ul className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            {similar.map((s) => (
              <li key={s.id}>
                <Link href={`/wardrobe/${s.id}`}><ItemThumb url={s.thumbUrl} alt={s.subcategory ?? "Similar item"} className="aspect-square" /></Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
