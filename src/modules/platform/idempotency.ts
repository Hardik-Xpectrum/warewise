import "server-only";
import { errors } from "./errors";
import type { AuthedContext } from "./http";

/**
 * Runs `create` once per Idempotency-Key per user; a retried request gets the first response back,
 * so a flaky mobile upload never creates two items.
 */
export async function idempotent<T extends object>(ctx: AuthedContext, create: () => Promise<T>): Promise<{ body: T; replayed: boolean }> {
  const key = ctx.req.headers.get("idempotency-key");
  if (!key || key.length > 100) throw errors.badRequest("Idempotency-Key header is required (max 100 chars)");

  const { data: existing } = await ctx.supabase.from("idempotency_keys").select("response").eq("key", key).maybeSingle();
  if (existing) return { body: existing.response as T, replayed: true };

  const body = await create();
  const { error } = await ctx.supabase.from("idempotency_keys").insert({ user_id: ctx.userId, key, response: body });
  if (error && error.code !== "23505") throw new Error(`idempotency: ${error.message}`);
  return { body, replayed: false };
}
