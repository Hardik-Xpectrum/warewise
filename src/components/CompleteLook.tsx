"use client";
import { useState } from "react";
import { api, errorText } from "@/lib/api";
import { OCCASIONS, type Occasion } from "@/modules/stylist/rules";
import OutfitCard from "./OutfitCard";
import type { OutfitCardData } from "./types";

/** "Complete the look": outfits built around one item, ranked by colour harmony. */
export default function CompleteLook({ itemId }: { itemId: string }) {
  const [occasion, setOccasion] = useState<Occasion>("casual");
  const [result, setResult] = useState<{ message: string; outfits: OutfitCardData[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function build() {
    setBusy(true);
    setError("");
    try {
      setResult(await api(`/items/${itemId}/complete-look`, { method: "POST", json: { occasion } }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-semibold">Complete the look</h2>
        <p className="text-sm text-muted">Outfits from your wardrobe built around this piece, scored for colour harmony.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <select className="input w-auto" value={occasion} onChange={(e) => setOccasion(e.target.value as Occasion)} aria-label="Occasion">
          {Object.entries(OCCASIONS).map(([k, o]) => <option key={k} value={k}>{o.label}</option>)}
        </select>
        <button className="btn-primary" disabled={busy} onClick={build}>{busy ? "Styling…" : result ? "Try again" : "Style this piece"}</button>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {result ? <p className="text-sm">{result.message}</p> : null}
      <div className="space-y-3">
        {result?.outfits.map((o) => <OutfitCard key={o.outfitId} outfit={o} />)}
      </div>
    </section>
  );
}
