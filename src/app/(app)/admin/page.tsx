import { notFound } from "next/navigation";
import { createUserClient } from "@/lib/supabase/server";
import { adminMetrics } from "@/modules/platform/metrics";

export const metadata = { title: "Admin · Warewise" };

export default async function AdminPage() {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getClaims();
  if ((data?.claims?.app_metadata as { role?: string } | undefined)?.role !== "admin") notFound();
  const m = await adminMetrics();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Admin · last {m.windowDays} days</h1>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="card p-4"><p className="text-2xl font-semibold">{m.tagging.uploaded}</p><p className="text-xs text-muted">uploads ({m.tagging.failed} failed)</p></div>
        <div className="card p-4"><p className="text-2xl font-semibold">{m.tagging.correctionRatePct}%</p><p className="text-xs text-muted">tag correction rate</p></div>
        <div className="card p-4"><p className="text-2xl font-semibold">{m.stylist.fallbackRatePct}%</p><p className="text-xs text-muted">stylist rule fallback</p></div>
        <div className="card p-4"><p className="text-2xl font-semibold">{m.queueDepth ?? "?"}</p><p className="text-xs text-muted">jobs in queue</p></div>
      </div>
      <section className="card overflow-x-auto p-4">
        <h2 className="mb-2 font-semibold">AI calls</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-muted"><tr><th className="py-1">Job · model</th><th>Calls</th><th>Errors</th><th>p95 latency</th></tr></thead>
          <tbody>
            {m.ai.map((r) => (
              <tr key={r.key} className="border-t border-line"><td className="py-1">{r.key}</td><td>{r.calls}</td><td>{r.errorRatePct}%</td><td>{r.p95LatencyMs ? `${r.p95LatencyMs} ms` : "—"}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <p className="text-sm text-muted">Stylist feedback: {m.stylist.likes} likes, {m.stylist.dislikes} dislikes, {m.stylist.saves} saves from {m.stylist.recommendations} suggestions.</p>
    </div>
  );
}
