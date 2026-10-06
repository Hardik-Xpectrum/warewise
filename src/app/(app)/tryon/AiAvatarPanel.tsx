"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CloseIcon } from "@/components/Icons";
import { toast } from "@/components/Toaster";
import { api, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/query";
import type { TryOnResult } from "./types";

type Model = { id: string; source_kind: "avatar" | "tryon" | "scan"; status: "pending" | "ready" | "failed"; engine: string | null; bytes: number | null; error: string | null; created_at: string; url: string | null };
type Models = { available: boolean; dailyLimit: number; models: Model[] };

const ENGINE: Record<string, string> = { "hf-trellis": "TRELLIS (free)", "hf-sf3d": "Stable Fast 3D (free)", "fal-trellis": "fal.ai Trellis", "tripo-v3": "Tripo", "meshy-lite": "Meshy", "mock-3d": "Demo model" };

/**
 * Generates a real textured 3D model of the user with an image-to-3D service (no GPU in the app):
 * from their avatar photo, or from their latest realistic try-on so the model wears the outfit.
 */
export default function AiAvatarPanel({
  photoId,
  tryons,
  consent,
  onConsent,
  selectedUrl,
  onSelect,
}: {
  photoId: string | null;
  tryons: TryOnResult[];
  consent: boolean;
  onConsent: (v: boolean) => Promise<void>;
  selectedUrl: string | null;
  onSelect: (url: string | null) => void;
}) {
  const q = useApi<Models>("/avatar/models");
  const models = q.data?.models ?? [];
  const pending = models.some((m) => m.status === "pending");
  const lastTryOn = tryons.find((t) => t.status === "ready");
  const [source, setSource] = useState<"avatar" | "tryon">(lastTryOn ? "tryon" : "avatar");
  const [busy, setBusy] = useState(false);

  // While a model is generating, check every 5 seconds.
  const refresh = q.refresh;
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [pending, refresh]);

  // Show the newest finished model when nothing is picked yet.
  const newest = models.find((m) => m.status === "ready" && m.url);
  useEffect(() => {
    if (!selectedUrl && newest?.url) onSelect(newest.url);
  }, [newest?.url, selectedUrl, onSelect]);

  async function generate() {
    const sourceId = source === "tryon" ? lastTryOn?.id : photoId;
    if (!sourceId) return;
    setBusy(true);
    try {
      await api("/avatar/models", { method: "POST", json: { source, sourceId } });
      toast("Making your 3D model. It takes 1–3 minutes.");
      invalidate("/avatar/models");
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(m: Model) {
    const undo = q.mutate((d) => (d ? { ...d, models: d.models.filter((x) => x.id !== m.id) } : d));
    if (m.url === selectedUrl) onSelect(null);
    try {
      await api(`/avatar/models/${m.id}`, { method: "DELETE" });
    } catch (err) {
      undo();
      toast(errorText(err), "error");
    }
  }

  if (!q.data) return <div className="skeleton h-28" />;

  if (!q.data.available) {
    return (
      <section className="card space-y-2 p-4 text-sm">
        <h3 className="eyebrow text-text">AI 3D avatar</h3>
        <p className="text-muted">
          Turns your photo into a real, textured 3D model using a cloud 3D service (TRELLIS on Hugging Face, fal.ai, Tripo or Meshy). It isn&apos;t switched on for this server yet: the owner adds an API key
          (<code>FAL_KEY</code>, <code>TRIPO_API_KEY</code> or <code>MESHY_API_KEY</code>).
        </p>
      </section>
    );
  }

  const canGenerate = consent && !busy && !pending && (source === "tryon" ? Boolean(lastTryOn) : Boolean(photoId));

  return (
    <section className="card space-y-4 p-4 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="eyebrow text-text">AI 3D avatar</h3>
        <span className="text-xs text-muted">Up to {q.data.dailyLimit} a day · 1–3 minutes each</span>
      </div>

      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="label">Make it from</legend>
        {/* The best source: a slow turn in front of the phone gives every side of you. */}
        <Link href="/scan" className="flex items-start gap-2 border border-text p-3 hover:bg-surface-2 sm:col-span-2">
          <span className="mt-0.5 bg-text px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.1em] text-bg uppercase">Best</span>
          <span>
            <span className="block font-medium">A 360° body scan</span>
            <span className="text-xs text-muted">One slow turn in front of your phone: your real shape from every side</span>
          </span>
        </Link>
        <label className={`flex cursor-pointer items-start gap-2 border p-3 ${source === "avatar" ? "border-text" : "border-line"}`}>
          <input type="radio" name="src" className="mt-0.5" checked={source === "avatar"} onChange={() => setSource("avatar")} disabled={!photoId} />
          <span>
            <span className="block font-medium">My photo</span>
            <span className="block text-xs text-muted">{photoId ? "You as you are in your avatar photo" : "Add an avatar photo first"}</span>
          </span>
        </label>
        <label className={`flex cursor-pointer items-start gap-2 border p-3 ${source === "tryon" ? "border-text" : "border-line"}`}>
          <input type="radio" name="src" className="mt-0.5" checked={source === "tryon"} onChange={() => setSource("tryon")} disabled={!lastTryOn} />
          <span>
            <span className="block font-medium">Wearing my last AI try-on</span>
            <span className="block text-xs text-muted">{lastTryOn ? "The model wears that outfit" : "Make a realistic try-on first"}</span>
          </span>
        </label>
      </fieldset>

      {!consent ? (
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" className="mt-0.5" checked={consent} onChange={(e) => onConsent(e.target.checked).catch((err) => toast(errorText(err), "error"))} />
          <span>Send my photo to a third-party 3D service (TRELLIS on Hugging Face, or fal.ai, Tripo or Meshy) to make the model. You can switch this off any time.</span>
        </label>
      ) : null}

      <button className="btn-primary w-full" disabled={!canGenerate} onClick={generate}>
        {pending ? "Making your 3D model…" : busy ? "Starting…" : "Make my 3D avatar"}
      </button>

      {models.length ? (
        <ul className="divide-y divide-line border-y border-line">
          {models.map((m) => (
            <li key={m.id} className="flex items-center gap-3 py-2">
              <button
                type="button"
                className={`flex-1 text-left ${m.url && m.url === selectedUrl ? "font-semibold" : ""}`}
                disabled={m.status !== "ready"}
                onClick={() => m.url && onSelect(m.url)}
              >
                <span className="block">
                  {m.source_kind === "scan" ? "360° body scan" : m.source_kind === "tryon" ? "Wearing a try-on" : "From my photo"} · {new Date(m.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                </span>
                <span className={`block text-xs ${m.status === "failed" ? "text-danger" : "text-muted"}`}>
                  {m.status === "pending" ? "Generating…" : m.status === "failed" ? m.error ?? "Failed" : `${ENGINE[m.engine ?? ""] ?? m.engine} · ${m.bytes ? `${(m.bytes / 1e6).toFixed(1)} MB` : ""}`}
                </span>
              </button>
              {m.status === "ready" && m.url ? (
                <a className="text-xs font-semibold tracking-[0.08em] uppercase underline-offset-4 hover:underline" href={m.url} download={`warewise-avatar-${m.id.slice(0, 8)}.glb`}>
                  .glb
                </a>
              ) : null}
              <button className="grid h-7 w-7 place-items-center text-muted hover:text-danger" onClick={() => remove(m)} aria-label="Delete 3D model" title="Delete">
                <CloseIcon className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
