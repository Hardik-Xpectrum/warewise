"use client";
import PageSkeleton from "@/components/PageSkeleton";
import { useApi } from "@/lib/query";
import ShopScan from "./ShopScan";

type Gap = { id: string; suggestion: string; reason: string; unlocksOutfits: number; links: { store: string; url: string }[] };

export default function ShopView() {
  const { data, error } = useApi<{ gaps: Gap[]; itemCount: number }>("/shopping/gaps");
  if (error) return <p className="text-danger">{error}</p>;
  if (!data) return <PageSkeleton />;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">What&apos;s missing</h1>
        <p className="text-sm text-muted">Buy less, but better: pieces that unlock the most new outfits with what you already own.</p>
      </div>
      <ShopScan />
      {data.itemCount < 3 ? <div className="card p-6 text-muted">Add a few more items first; gaps make sense once your basics are in.</div> : null}
      {data.itemCount >= 3 && !data.gaps.length ? <div className="card p-6 text-muted">No obvious gaps. Your wardrobe covers the basics well.</div> : null}
      <ul className="space-y-3">
        {data.gaps.map((g) => (
          <li key={g.id} className="card p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-medium">{g.suggestion}</p>
              <span className="chip">unlocks about {g.unlocksOutfits} outfit{g.unlocksOutfits === 1 ? "" : "s"}</span>
            </div>
            <p className="mt-1 text-sm text-muted">{g.reason}</p>
            <div className="mt-3 flex gap-2">
              {g.links.map((l) => (
                <a key={l.store} className="btn-ghost" href={l.url} target="_blank" rel="noopener noreferrer">Search {l.store} ↗</a>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
