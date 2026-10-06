import "server-only";
import { adminClient } from "@/lib/supabase/admin";

/** Numbers for the admin page (section 11 of the architecture doc). Only callable by admins. */
export async function adminMetrics() {
  const db = adminClient();
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();

  const [calls, items, corrections, feedback, recs, queue] = await Promise.all([
    db.from("ai_interactions").select("job,model_key,status,latency_ms").gte("created_at", since).limit(5000),
    db.from("wardrobe_items").select("status,user_verified,status_reason").gte("created_at", since).limit(5000),
    db.from("item_corrections").select("item_id").gte("created_at", since).limit(5000),
    db.from("feedback").select("kind").gte("created_at", since).limit(5000),
    db.from("recommendations").select("source").gte("created_at", since).limit(5000),
    db.rpc("media_queue_depth"),
  ]);

  const byJobModel: Record<string, { calls: number; errors: number; latencies: number[] }> = {};
  for (const c of calls.data ?? []) {
    const key = `${c.job} · ${c.model_key ?? "none"}`;
    byJobModel[key] ??= { calls: 0, errors: 0, latencies: [] };
    byJobModel[key].calls++;
    if (c.status !== "ok") byJobModel[key].errors++;
    if (c.latency_ms) byJobModel[key].latencies.push(c.latency_ms);
  }
  const p95 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)] : null);

  const tagged = (items.data ?? []).filter((i) => i.status === "ready").length;
  const correctedItems = new Set((corrections.data ?? []).map((c) => c.item_id)).size;
  const fb = feedback.data ?? [];
  const recommendations = recs.data ?? [];

  return {
    windowDays: 7,
    ai: Object.entries(byJobModel).map(([key, v]) => ({ key, calls: v.calls, errorRatePct: Math.round((v.errors / v.calls) * 100), p95LatencyMs: p95(v.latencies) })),
    tagging: {
      uploaded: items.data?.length ?? 0,
      ready: tagged,
      failed: (items.data ?? []).filter((i) => i.status === "failed").length,
      correctionRatePct: tagged ? Math.round((correctedItems / tagged) * 100) : 0,
    },
    stylist: {
      recommendations: recommendations.length,
      fallbackRatePct: recommendations.length ? Math.round((recommendations.filter((r) => r.source === "rules").length / recommendations.length) * 100) : 0,
      likes: fb.filter((f) => f.kind === "like").length,
      dislikes: fb.filter((f) => f.kind === "dislike").length,
      saves: fb.filter((f) => f.kind === "saved").length,
    },
    queueDepth: queue.data ?? null,
  };
}
