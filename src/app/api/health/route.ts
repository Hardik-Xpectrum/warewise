import { adminClient } from "@/lib/supabase/admin";
import { loadAiConfig } from "@/modules/ai/config";

export const dynamic = "force-dynamic";

/**
 * Liveness + readiness for uptime monitors: 200 when the database answers and the AI config
 * loads, 503 otherwise. Reports only up/down per dependency, never error details.
 */
export async function GET() {
  const started = Date.now();
  const checks: Record<string, boolean> = {};
  try {
    const { error } = await adminClient().from("profiles").select("id").limit(1);
    checks.database = !error;
  } catch {
    checks.database = false;
  }
  try {
    checks.aiConfig = Object.keys(loadAiConfig().jobs).length > 0;
  } catch {
    checks.aiConfig = false;
  }
  const ok = Object.values(checks).every(Boolean);
  return Response.json(
    { ok, checks, latencyMs: Date.now() - started, time: new Date().toISOString() },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
