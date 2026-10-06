"use client";
import ItemThumb from "@/components/ItemThumb";
import PageSkeleton from "@/components/PageSkeleton";
import { useApi } from "@/lib/query";
import { CATEGORY_LABELS, type Category } from "@/modules/wardrobe/taxonomy";

type Card = { id: string; label: string; thumbUrl: string | null; wears: number; costPerWear: number | null };
type Summary = {
  totalItems: number;
  wornLast90Days: number;
  utilizationPct: number;
  totalWears: number;
  byCategory: Record<string, number>;
  mostWorn: Card[];
  neverWorn: Card[];
  bestValue: Card[];
};

function Row({ title, hint, cards, show }: { title: string; hint: string; cards: Card[]; show: (c: Card) => string }) {
  if (!cards.length) return null;
  return (
    <section>
      <h2 className="font-semibold">{title}</h2>
      <p className="mb-3 text-sm text-muted">{hint}</p>
      <ul className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        {cards.map((c) => (
          <li key={c.id}>
            <ItemThumb url={c.thumbUrl} alt={c.label} className="aspect-square" />
            <p className="mt-1 truncate text-xs capitalize">{c.label}</p>
            <p className="text-xs text-muted">{show(c)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function InsightsView() {
  const { data: s, error } = useApi<Summary>("/insights/summary");
  if (error) return <p className="text-danger">{error}</p>;
  if (!s) return <PageSkeleton />;

  const maxCat = Math.max(1, ...Object.values(s.byCategory));
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Insights</h1>
        <p className="text-sm text-muted">
          {s.totalWears
            ? `You've worn ${s.wornLast90Days} of your ${s.totalItems} pieces in the last 90 days.`
            : "Tap \u201cI wore this\u201d on an outfit or item and this page starts telling you what you really wear."}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="card p-4"><p className="text-3xl font-semibold">{s.utilizationPct}%</p><p className="text-xs text-muted">of your wardrobe worn in the last 90 days</p></div>
        <div className="card p-4">
          <p className="text-3xl font-semibold tabular-nums">{s.wornLast90Days}<span className="text-base text-muted"> / {s.totalItems}</span></p>
          <p className="text-xs text-muted">pieces in rotation (worn in the last 90 days)</p>
        </div>
        <div className="card p-4"><p className="text-3xl font-semibold">{s.totalWears}</p><p className="text-xs text-muted">wears logged</p></div>
      </div>
      <section>
        <h2 className="mb-3 font-semibold">What you own</h2>
        <ul className="space-y-2">
          {Object.entries(s.byCategory).sort((a, b) => b[1] - a[1]).map(([cat, n]) => (
            <li key={cat} className="grid grid-cols-[140px_1fr_32px] items-center gap-3 text-sm">
              <span className="text-muted">{CATEGORY_LABELS[cat as Category] ?? cat}</span>
              <span className="h-1.5 bg-accent" style={{ width: `${(n / maxCat) * 100}%` }} />
              <span className="text-right tabular-nums">{n}</span>
            </li>
          ))}
        </ul>
      </section>
      <Row title="Most worn" hint="Your real favourites." cards={s.mostWorn} show={(c) => `${c.wears} wears`} />
      <Row title="Never worn" hint="Owned for over two weeks and never logged. Ask the stylist to use them." cards={s.neverWorn} show={() => "0 wears"} />
      <Row title="Best value" hint="Lowest cost per wear, from the price you entered." cards={s.bestValue} show={(c) => `₹${c.costPerWear} per wear`} />
    </div>
  );
}
