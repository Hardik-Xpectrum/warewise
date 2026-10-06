import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { publicEnv, serverEnv } from "@/lib/env";

let client: SupabaseClient | undefined;

/**
 * Service-role client. Bypasses row-level security, so only job handlers, the AI router's logging
 * and account deletion may use it, and they must always scope queries by user id themselves.
 */
export function adminClient(): SupabaseClient {
  client ??= createClient(publicEnv.supabaseUrl(), serverEnv.supabaseSecretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
