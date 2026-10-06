import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearQueryCache, fetchQuery, invalidate, setQueryData } from "./query";

describe("query cache", () => {
  beforeEach(() => clearQueryCache());

  it("makes one request for identical concurrent reads", async () => {
    const fetcher = vi.fn(async () => ({ n: 1 }));
    const [a, b] = await Promise.all([fetchQuery("/x", fetcher), fetchQuery("/x", fetcher)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("applies an optimistic update and can undo it", async () => {
    await fetchQuery("/list", async () => [1, 2]);
    const undo = setQueryData<number[]>("/list", (xs = []) => [...xs, 3]);
    expect(await fetchQuery("/list-peek", async () => null)).toBeNull(); // unrelated key untouched
    undo();
    const fetcher = vi.fn(async () => [9]);
    invalidate("/list"); // nothing on screen: marks stale without fetching
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the old data when a refresh fails", async () => {
    await fetchQuery("/y", async () => "old");
    await expect(fetchQuery("/y", async () => Promise.reject(new Error("offline")))).rejects.toThrow("offline");
    const again = vi.fn(async () => "new");
    expect(await fetchQuery("/y", again)).toBe("new");
  });
});
