"use client";
import Link from "next/link";
import { useState } from "react";
import ItemThumb from "@/components/ItemThumb";
import { api, errorText } from "@/lib/api";
import { CATEGORIES, CATEGORY_LABELS, COLORS, FORMALITY_LABELS, PATTERNS, type Category } from "@/modules/wardrobe/taxonomy";

type Card = { id: string; label: string; thumbUrl: string | null };
type Scan = {
  verdict: "GET IT" | "MAYBE" | "SKIP IT";
  newOutfits: number;
  reasons: string[];
  bestMatches: (Card & { score: number })[];
  similarOwned: Card[];
  product?: { title: string | null; image: string; price: string | null; url: string };
  tags?: { category: Category; subcategory: string | null; colors: string[]; pattern: string; formality: number };
};

// Verdict tags in the square house style; all combinations pass WCAG AA contrast.
const TONE = { "GET IT": "bg-text text-bg border-text", MAYBE: "border-text text-text", "SKIP IT": "border-danger text-danger" } as const;

/** Shop Scan: describe something you're about to buy and see if it earns a place in your wardrobe. */
export default function ShopScan() {
  const [category, setCategory] = useState<Category>("top");
  const [subcategory, setSubcategory] = useState("");
  const [color, setColor] = useState("white");
  const [pattern, setPattern] = useState("solid");
  const [formality, setFormality] = useState(3);
  const [scan, setScan] = useState<Scan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [link, setLink] = useState("");

  /** Paste a product link: the shop's photo is tagged by AI and the form fills itself in. */
  async function scanLink(e: React.FormEvent) {
    e.preventDefault();
    if (!link.trim()) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<Scan>("/shopping/scan-link", { method: "POST", json: { url: link } });
      setScan(r);
      if (r.tags) {
        setCategory(r.tags.category);
        setSubcategory(r.tags.subcategory ?? "");
        setColor(r.tags.colors[0] ?? "multi");
        setPattern(r.tags.pattern);
        setFormality(r.tags.formality);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setScan(await api<Scan>("/shopping/scan", { method: "POST", json: { category, subcategory: subcategory || undefined, colors: [color], pattern, formality } }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-4 p-4">
      <div>
        <h2 className="font-semibold">Shop Scan: should I buy this?</h2>
        <p className="text-sm text-muted">Paste a product link, or describe the piece. Warewise checks how many good outfits it makes with what you own, and whether you already have one.</p>
      </div>
      <form onSubmit={scanLink} className="flex gap-2">
        <label className="sr-only" htmlFor="scan-link">Product link</label>
        <input
          id="scan-link"
          className="input"
          type="url"
          inputMode="url"
          placeholder="Paste a link from Myntra, AJIO, Amazon, Flipkart, H&M, Zara…"
          value={link}
          onChange={(e) => setLink(e.target.value)}
        />
        <button className="btn-primary shrink-0" disabled={busy || !link.trim()}>{busy && link ? "Reading…" : "Scan link"}</button>
      </form>
      <p className="eyebrow">Or describe it</p>
      <form onSubmit={run} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <select className="input" value={category} onChange={(e) => setCategory(e.target.value as Category)} aria-label="Category">
          {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
        </select>
        <input className="input" placeholder="Type, e.g. linen shirt" value={subcategory} onChange={(e) => setSubcategory(e.target.value)} maxLength={40} aria-label="Type" />
        <select className="input capitalize" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Main colour">
          {COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="input capitalize" value={pattern} onChange={(e) => setPattern(e.target.value)} aria-label="Pattern">
          {PATTERNS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className="input" value={formality} onChange={(e) => setFormality(Number(e.target.value))} aria-label="Formality">
          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{FORMALITY_LABELS[n]}</option>)}
        </select>
        <button className="btn-primary" disabled={busy}>{busy ? "Scanning…" : "Scan it"}</button>
      </form>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {scan ? (
        <div className="space-y-3">
          {scan.product ? (
            <a href={scan.product.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 border border-line p-2 hover:border-text">
              {/* eslint-disable-next-line @next/next/no-img-element -- shop CDN image, shown as the shop serves it */}
              <img src={scan.product.image} alt="" className="h-16 w-12 bg-surface-2 object-contain" referrerPolicy="no-referrer" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{scan.product.title ?? "Product"}</span>
                <span className="block text-xs text-muted">{scan.product.price ? `₹${scan.product.price} · ` : ""}AI read it as: {scan.tags?.colors[0]} {scan.tags?.subcategory ?? scan.tags?.category}</span>
              </span>
            </a>
          ) : null}
          <div className="flex items-center gap-3">
            <span className={`border px-3 py-1.5 text-xs font-bold tracking-[0.12em] ${TONE[scan.verdict]}`}>{scan.verdict}</span>
            <ul className="text-sm">
              {scan.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </div>
          {scan.bestMatches.length ? (
            <div>
              <p className="label">Goes best with</p>
              <ul className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                {scan.bestMatches.map((m) => (
                  <li key={m.id}>
                    <Link href={`/wardrobe/${m.id}`}><ItemThumb url={m.thumbUrl} alt={m.label} className="aspect-square" /></Link>
                    <p className="mt-1 truncate text-center text-xs capitalize text-muted">{m.label} · {m.score}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {scan.similarOwned.length ? (
            <div>
              <p className="label">You already own</p>
              <ul className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                {scan.similarOwned.map((m) => (
                  <li key={m.id}>
                    <Link href={`/wardrobe/${m.id}`}><ItemThumb url={m.thumbUrl} alt={m.label} className="aspect-square" /></Link>
                    <p className="mt-1 truncate text-center text-xs capitalize text-muted">{m.label}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
