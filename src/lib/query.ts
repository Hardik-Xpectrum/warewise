"use client";
// A small shared data cache for API reads (stale-while-revalidate), so tabs open instantly on the
// second visit, identical requests are made once, and writes can update the screen before the
// server answers. Deliberately tiny: one Map, React's useSyncExternalStore, no dependency.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api, errorText } from "./api";

type Entry = { data?: unknown; error?: string; at: number; loading: boolean };

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
const listeners = new Map<string, Set<() => void>>();
const EMPTY: Entry = { at: 0, loading: false };
const DEFAULT_STALE_MS = 30_000;

function emit(key: string) {
  listeners.get(key)?.forEach((l) => l());
}

function write(key: string, patch: Partial<Entry>) {
  store.set(key, { ...(store.get(key) ?? EMPTY), ...patch });
  emit(key);
}

/** Fetches `key` (an API path) once even if many components ask at the same moment. */
export function fetchQuery<T>(key: string, fetcher: (key: string) => Promise<T> = (k) => api<T>(k)): Promise<T> {
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  write(key, { loading: true });
  const p = fetcher(key)
    .then((data) => {
      write(key, { data, error: undefined, at: Date.now(), loading: false });
      return data;
    })
    .catch((err) => {
      write(key, { error: errorText(err), loading: false });
      throw err;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Optimistic update: change cached data now; returns an undo for when the server says no. */
export function setQueryData<T>(key: string, update: (current: T | undefined) => T | undefined): () => void {
  const before = store.get(key)?.data as T | undefined;
  write(key, { data: update(before) });
  return () => write(key, { data: before });
}

/** Marks every cached path starting with `prefix` stale; ones on screen refetch right away. */
export function invalidate(prefix: string) {
  for (const key of store.keys()) {
    if (!key.startsWith(prefix)) continue;
    write(key, { at: 0 });
    if (listeners.get(key)?.size) fetchQuery(key).catch(() => undefined);
  }
}

/** Test helper and sign-out: forget everything. */
export function clearQueryCache() {
  store.clear();
  inflight.clear();
}

// Coming back to the tab refreshes whatever is on screen, like Linear or Notion.
if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    for (const [key, set] of listeners) {
      const e = store.get(key);
      if (set.size && e && Date.now() - e.at > DEFAULT_STALE_MS) fetchQuery(key).catch(() => undefined);
    }
  });
}

export type Query<T> = {
  data: T | undefined;
  error: string | null;
  /** True only while there's nothing to show yet (first load); background refreshes don't flash. */
  loading: boolean;
  refresh: () => Promise<void>;
  mutate: (update: (current: T | undefined) => T | undefined) => () => void;
};

/** Reads an API path through the shared cache. Pass null to skip (e.g. until an id is known). */
export function useApi<T>(key: string | null, opts: { staleMs?: number } = {}): Query<T> {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!key) return () => undefined;
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(cb);
      return () => set!.delete(cb);
    },
    [key],
  );
  const entry = useSyncExternalStore(subscribe, () => (key ? store.get(key) ?? EMPTY : EMPTY), () => EMPTY);

  useEffect(() => {
    if (!key) return;
    const e = store.get(key);
    if (!e || Date.now() - e.at > staleMs) fetchQuery(key).catch(() => undefined);
  }, [key, staleMs]);

  const refresh = useCallback(async () => {
    if (key) await fetchQuery(key).catch(() => undefined);
  }, [key]);
  const mutate = useCallback((update: (current: T | undefined) => T | undefined) => (key ? setQueryData<T>(key, update) : () => undefined), [key]);

  return {
    data: entry.data as T | undefined,
    error: entry.data === undefined ? entry.error ?? null : null,
    loading: entry.data === undefined && !entry.error,
    refresh,
    mutate,
  };
}
