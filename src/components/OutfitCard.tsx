"use client";
import Link from "next/link";
import { useState } from "react";
import { api, errorText } from "@/lib/api";
import { invalidate } from "@/lib/query";
import { HeartIcon } from "./Icons";
import ItemThumb from "./ItemThumb";
import { toast } from "./Toaster";
import type { OutfitCardData } from "./types";


/** One suggested outfit with the feedback buttons that feed the training dataset. */
export default function OutfitCard({ outfit }: { outfit: OutfitCardData }) {
  const [done, setDone] = useState<Record<string, boolean>>({});

  async function feedback(kind: "like" | "dislike" | "saved") {
    setDone((d) => ({ ...d, [kind]: true }));
    try {
      // A like saves the outfit as a favourite, from the stylist or anywhere else.
      if (outfit.recommendationId) await api(`/recommendations/${outfit.recommendationId}/feedback`, { method: "POST", json: { kind } });
      else if (kind === "saved") await api(`/outfits/${outfit.outfitId}`, { method: "PATCH", json: { saved: true } });
      else if (kind === "like") await api(`/outfits/${outfit.outfitId}`, { method: "PATCH", json: { saved: true, is_favorite: true } });
      else return;
      // Optimistic: the button flips at once; a failure flips it back and says why.
      toast(kind === "saved" ? "Saved to Outfits" : kind === "like" ? "Liked: saved to your favourites" : "Noted: fewer like this");
      invalidate("/outfits");
      invalidate("/today");
    } catch (err) {
      setDone((d) => ({ ...d, [kind]: false }));
      toast(errorText(err), "error");
    }
  }

  async function wore() {
    setDone((d) => ({ ...d, wore: true }));
    try {
      await api("/wear-log", { method: "POST", json: { outfitId: outfit.outfitId } });
      toast("Logged as worn today");
    } catch (err) {
      setDone((d) => ({ ...d, wore: false }));
      toast(errorText(err), "error");
    }
  }

  async function share() {
    try {
      const { shareOutfitImage } = await import("@/lib/shareCard");
      const how = await shareOutfitImage(outfit, "What I'm wearing");
      if (how === "downloaded") toast("Outfit image saved: ready for your story");
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") toast(errorText(err), "error");
    }
  }

  const h = outfit.harmony;
  const canLike = Boolean(outfit.recommendationId || outfit.harmony);
  const liked = Boolean(done.like);

  return (
    <article className="space-y-3">
      {/* Editorial row of tall images; the heart sits on the first image like a product tile. */}
      <div className="relative">
        <ul className={`grid gap-1 ${outfit.items.length >= 4 ? "grid-cols-2 sm:grid-cols-4" : outfit.items.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
          {outfit.items.map((i) => (
            <li key={i.id}>
              <ItemThumb url={i.thumbUrl} alt={i.label ?? i.slot} className="aspect-[3/4]" />
            </li>
          ))}
        </ul>
        {canLike ? (
          <button
            type="button"
            className={`absolute right-2 top-2 grid h-10 w-10 place-items-center bg-bg/90 transition hover:scale-105 ${liked ? "animate-heart" : ""}`}
            style={{ color: liked ? "var(--heart)" : "var(--text)" }}
            disabled={liked || done.dislike}
            onClick={() => feedback("like")}
            aria-label="Like and save to favourites"
            aria-pressed={liked}
          >
            <HeartIcon filled={liked} className="h-5 w-5" />
          </button>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <p className="text-sm capitalize">{outfit.items.map((i) => i.label ?? i.slot).join(" · ")}</p>
        {h ? (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-xs">
              <span className="border border-text px-1.5 py-0.5 font-semibold tabular-nums">{h.score}</span>
              <span className="font-semibold tracking-[0.08em] uppercase">{h.label}</span>
              <span className="text-muted">colour harmony {h.score}/100 · why?</span>
            </summary>
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted">
              {h.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </details>
        ) : null}
        {outfit.why ? <p className="text-sm text-muted">{outfit.why}</p> : null}
        {outfit.source === "rules" ? <p className="text-xs text-muted">Suggested by Warewise&apos;s rules (AI was unavailable).</p> : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Link className="btn-primary" href={`/tryon?outfit=${outfit.outfitId}`}>Try on</Link>
        <button className="btn-ghost" disabled={done.wore} onClick={wore}>{done.wore ? "Worn today" : "I wore this"}</button>
        <button className="btn-ghost" onClick={share} aria-label="Share this outfit as an image">Share</button>
        {canLike ? (
          <button className="btn-ghost" disabled={done.saved || liked} onClick={() => feedback("saved")}>{done.saved || liked ? "Saved" : "Save"}</button>
        ) : null}
        {outfit.recommendationId ? (
          <button className="btn-ghost" disabled={liked || done.dislike} onClick={() => feedback("dislike")} aria-label="Fewer like this" aria-pressed={Boolean(done.dislike)}>
            Not for me
          </button>
        ) : null}
      </div>
    </article>
  );
}
