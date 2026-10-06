import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Signed image URLs, reused per file for most of their life. A fresh signature on every request
// meant a new URL every time, so browsers re-downloaded every photo on every visit.
const TTL_SECONDS = 24 * 3600;
const REUSE_UNTIL_LEFT_MS = 6 * 3600 * 1000; // re-sign once less than 6 h remain
const MAX_ENTRIES = 5000;

const cache = new Map<string, { url: string; expiresAt: number }>();

/**
 * path -> signed URL for private files. Paths come only from rows the caller could read under RLS,
 * and each sits in its owner's folder, so a cached URL never reaches another user.
 */
export async function signedUrls(supabase: SupabaseClient, bucket: string, paths: Iterable<string>): Promise<Map<string, string>> {
  const now = Date.now();
  const out = new Map<string, string>();
  const missing: string[] = [];
  for (const p of new Set(paths)) {
    const hit = cache.get(`${bucket}/${p}`);
    if (hit && hit.expiresAt - now > REUSE_UNTIL_LEFT_MS) out.set(p, hit.url);
    else missing.push(p);
  }
  if (missing.length) {
    const { data } = await supabase.storage.from(bucket).createSignedUrls(missing, TTL_SECONDS);
    for (const entry of data ?? []) {
      if (!entry.path || !entry.signedUrl) continue;
      out.set(entry.path, entry.signedUrl);
      cache.set(`${bucket}/${entry.path}`, { url: entry.signedUrl, expiresAt: now + TTL_SECONDS * 1000 });
    }
    // Keep memory bounded: Map iterates oldest first.
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  }
  return out;
}

// A cached URL for a deleted file simply 404s: storage checks the object exists on every fetch.

/** Cache-Control for stored photos: paths are unique per upload, so browsers may keep them. */
export const PHOTO_CACHE_CONTROL = "604800";
