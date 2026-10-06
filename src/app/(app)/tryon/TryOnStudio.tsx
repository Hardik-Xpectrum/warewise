"use client";
import { CloseIcon } from "@/components/Icons";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ItemThumb from "@/components/ItemThumb";
import TryOnCanvas, { type CanvasGarment, type TryOnCanvasHandle } from "@/components/TryOnCanvas";
import PageSkeleton from "@/components/PageSkeleton";
import { toast } from "@/components/Toaster";
import type { Item } from "@/components/types";
import { api, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/query";
import { fitFor, TOP_SIZES, type UserSizes } from "@/modules/tryon/fit";
import { SAMPLE_MODEL } from "@/modules/tryon/sampleModel";
import { slotFor, takeOff, wear } from "@/modules/tryon/wear";
import AvatarManager from "./AvatarManager";
import Avatar3D from "./Avatar3D";
import LiveMirror from "./LiveMirror";
import type { AvatarPhoto, SavedOutfit, TryOnResult } from "./types";

const SLOTS = [
  { slot: "top", label: "Top" },
  { slot: "outer", label: "Layer" },
  { slot: "bottom", label: "Bottom" },
  { slot: "one_piece", label: "Dress / one-piece" },
  { slot: "shoes", label: "Shoes" },
] as const;
type Slot = (typeof SLOTS)[number]["slot"];
type Selection = Partial<Record<Slot, string>>;

function selectionFrom(itemIds: string[], items: Item[]): Selection {
  const sel: Selection = {};
  for (const id of itemIds) {
    const it = items.find((i) => i.id === id);
    const slot = it ? slotFor(it) : null;
    if (slot) sel[slot] ??= id;
  }
  return sel;
}

export default function TryOnStudio({ initialOutfitId, initialItemIds = null }: { initialOutfitId: string | null; initialItemIds?: string[] | null }) {
  // Everything below comes from the shared cache, so returning to this tab is instant.
  const avatarQ = useApi<{ max: number; photos: AvatarPhoto[] }>("/avatar");
  const itemsQ = useApi<{ items: Item[] }>("/items?lifecycle=active&limit=100");
  const outfitsQ = useApi<{ outfits: SavedOutfit[] }>("/outfits");
  const resultsQ = useApi<{ results: TryOnResult[] }>("/tryon");
  const meQ = useApi<{ consents: { ai_training: boolean; analytics: boolean; avatar_ai: boolean }; body_profile: Record<string, unknown> }>("/me");

  const avatar = avatarQ.data ?? null;
  const items = useMemo(() => (itemsQ.data?.items ?? []).filter((i) => i.status === "ready"), [itemsQ.data]);
  const outfits = useMemo(() => outfitsQ.data?.outfits ?? [], [outfitsQ.data]);
  const results = resultsQ.data?.results ?? [];
  const aiConsent = meQ.data?.consents.avatar_ai ?? false;
  const bodyProfile = useMemo(() => meQ.data?.body_profile ?? {}, [meQ.data]);
  const sizes = meQ.data ? (bodyProfile as UserSizes) : null;

  const [chosenAvatarId, setAvatarId] = useState<string | null>(null);
  const avatarId =
    chosenAvatarId && avatar?.photos.some((p) => p.id === chosenAvatarId)
      ? chosenAvatarId
      : avatar?.photos.find((p) => p.is_primary)?.id ?? avatar?.photos[0]?.id ?? null;

  // Until the user picks something, show the outfit they came for (or their latest).
  const start = outfits.find((o) => o.id === initialOutfitId) ?? outfits[0];
  const [picked, setPicked] = useState<Selection | null>(null);
  const [chosenOutfitId, setOutfitId] = useState<string | null>(null);
  const selection: Selection = useMemo(
    () => picked ?? (initialItemIds?.length ? selectionFrom(initialItemIds, items) : start ? selectionFrom(start.items.map((i) => i.id), items) : {}),
    [picked, start, items, initialItemIds],
  );
  const outfitId = chosenOutfitId ?? (initialItemIds?.length ? "" : start?.id ?? "");

  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<"photo" | "live" | "3d">("photo");
  // What the stage shows on "On my photo": the instant preview, or the realistic AI render.
  // null = automatic: the realistic render when one exists for this outfit, else the preview.
  const [view, setView] = useState<"preview" | "realistic" | null>(null);
  const [askConsent, setAskConsent] = useState(false);
  const canvasRef = useRef<TryOnCanvasHandle>(null);
  const pendingStarted = useRef<string | null>(null); // the render this visit asked for

  const loadAvatar = useCallback(
    async (selectId?: string) => {
      invalidate("/avatar");
      await avatarQ.refresh();
      if (selectId) setAvatarId(selectId);
      invalidate("/today");
    },
    [avatarQ],
  );
  const loadResults = resultsQ.refresh;

  const pending = results.some((r) => r.status === "pending");
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => loadResults(), 5000);
    return () => clearInterval(t);
  }, [pending, loadResults]);

  const photo = avatar?.photos.find((p) => p.id === avatarId) ?? null;
  // The AI render for exactly this photo and these clothes, if one exists (newest first), so the
  // same outfit is never generated twice: the free GPU time is precious.
  const selectedIds = Object.values(selection).filter(Boolean) as string[];
  const selectionKey = [...selectedIds].sort().join(",");
  const match = results.find((r) => r.avatar_photo_id === photo?.id && [...r.item_ids].sort().join(",") === selectionKey && r.status !== "failed")
    ?? results.find((r) => r.avatar_photo_id === photo?.id && [...r.item_ids].sort().join(",") === selectionKey);
  const showRealistic = (view ?? (match?.status === "ready" ? "realistic" : "preview")) === "realistic" && Boolean(match);

  // When the render for what's on screen finishes, show it.
  const matchReady = match?.status === "ready" ? match.id : null;
  const [seenReady, setSeenReady] = useState<string | null>(null);
  if (matchReady && matchReady !== seenReady) {
    setSeenReady(matchReady);
    if (pendingStarted.current === matchReady) setView("realistic");
  }
  const garments: CanvasGarment[] = useMemo(
    () =>
      Object.values(selection)
        .map((id) => items.find((i) => i.id === id))
        .filter((i): i is Item => Boolean(i))
        .map((i) => ({
          id: i.id,
          slot: slotFor(i) ?? i.category!,
          subcategory: i.subcategory,
          url: i.cutoutUrl ?? i.imageUrl,
          isCutout: Boolean(i.cutoutUrl),
          fit: fitFor(i.category!, i.size_label, sizes).scale,
        })),
    [selection, items, sizes],
  );
  const fitNotes = Object.values(selection)
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is Item => Boolean(i))
    .map((i) => ({ item: i, fit: fitFor(i.category!, i.size_label, sizes) }));
  const missing = {
    top: garments.some((g) => ["top", "outer", "one_piece"].includes(g.slot)) && !sizes?.top_size,
    waist: garments.some((g) => g.slot === "bottom") && !sizes?.waist_in,
    shoe: garments.some((g) => g.slot === "shoes") && !sizes?.shoe_uk,
  };

  async function saveProfile(patch: Record<string, unknown>) {
    const next = { ...bodyProfile, ...patch };
    const undo = meQ.mutate((m) => (m ? { ...m, body_profile: next } : m));
    try {
      await api("/me", { method: "PATCH", json: { body_profile: next } });
      invalidate("/today");
    } catch (err) {
      undo();
      throw err;
    }
  }

  async function saveSizes(patch: Partial<UserSizes>) {
    try {
      await saveProfile(patch);
      toast("Sizes saved to your profile");
    } catch (err) {
      toast(errorText(err), "error");
    }
  }
  const canvasAvatar = useMemo(() => (photo ? { id: photo.id, imageUrl: photo.imageUrl, width: photo.width, height: photo.height, pose: photo.pose } : null), [photo]);
  // Until there's a photo of you, clothes go on an illustrated sample model so Try-on isn't empty.
  const usingSample = !canvasAvatar;
  const previewAvatar = canvasAvatar ?? SAMPLE_MODEL;

  /** Tap a piece: it goes on (replacing what it should), or comes off if it's already on. */
  function toggle(item: Item) {
    setOutfitId("");
    setView(null);
    setPicked(wear(selection, item));
  }
  function remove(slot: Slot) {
    setOutfitId("");
    setView(null);
    setPicked(takeOff(selection, slot));
  }

  function pickOutfit(id: string) {
    setOutfitId(id);
    setView(null);
    const o = outfits.find((x) => x.id === id);
    if (o) setPicked(selectionFrom(o.items.map((i) => i.id), items));
  }

  async function setConsent(v: boolean) {
    const consents = { ...(meQ.data?.consents ?? { ai_training: false, analytics: false, avatar_ai: false }), avatar_ai: v };
    const undo = meQ.mutate((m) => (m ? { ...m, consents } : m));
    try {
      await api("/me/consents", { method: "PUT", json: consents });
    } catch (err) {
      undo();
      throw err;
    }
  }

  async function realistic() {
    setMessage("");
    if (!aiConsent) {
      setAskConsent(true);
      return;
    }
    try {
      // Always the photo shown in the preview, so what you see is what the AI dresses.
      const created = await api<{ id: string }>("/tryon", { method: "POST", json: { avatarPhotoId: photo?.id, itemIds: selectedIds } });
      pendingStarted.current = created?.id ?? null;
      setView("realistic");
      await loadResults();
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  async function agreeAndRun() {
    try {
      await setConsent(true);
      setAskConsent(false);
      const created = await api<{ id: string }>("/tryon", { method: "POST", json: { avatarPhotoId: photo?.id, itemIds: selectedIds } });
      pendingStarted.current = created?.id ?? null;
      setView("realistic");
      await loadResults();
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  function openResult(r: TryOnResult) {
    setAvatarId(r.avatar_photo_id);
    setOutfitId("");
    setPicked(selectionFrom(r.item_ids, items));
    setView("realistic");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function removeResult(id: string) {
    await api(`/tryon/${id}`, { method: "DELETE" });
    await loadResults();
  }

  // Wait for the wardrobe too, or the page would flash "your wardrobe is empty" while it loads.
  if (!avatar || (!itemsQ.data && !itemsQ.error)) return avatarQ.error ? <p className="text-danger">{avatarQ.error}</p> : <PageSkeleton />;
  const hasUpper = garments.some((g) => ["top", "outer", "one_piece", "bottom"].includes(g.slot));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Try-on</h1>
          <p className="text-sm text-muted">Pick clothes on the right; see them on you instantly, then make it realistic with AI.</p>
        </div>
      </div>

      <AvatarManager photos={avatar.photos} max={avatar.max} selectedId={avatarId} onSelect={setAvatarId} onChange={loadAvatar} />

      {!items.length ? (
        <div className="card p-6 text-sm text-muted">
          Your wardrobe is empty. <Link className="underline" href="/wardrobe">Add clothes</Link> or load the sample wardrobe there to try things on.
        </div>
      ) : null}

      {items.length ? (
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-w-0 space-y-3">
            <div className="flex justify-center border-b border-line text-xs font-semibold tracking-[0.1em] uppercase" role="tablist">
              {(["photo", "3d", "live"] as const).map((m) => (
                <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={`-mb-px flex-1 border-b-2 px-4 py-3 transition-colors ${mode === m ? "border-text text-text" : "border-transparent text-muted hover:text-text"}`}>
                  {m === "photo" ? "On my photo" : m === "3d" ? "3D avatar" : "Live mirror"}
                </button>
              ))}
            </div>
            {mode === "live" ? (
              <LiveMirror garments={garments} onAvatarAdded={loadAvatar} />
            ) : mode === "3d" ? (
              <Avatar3D
                avatar={canvasAvatar}
                garments={garments}
                sizes={sizes}
                heightCm={(bodyProfile.height_cm as number | undefined) ?? null}
                onSaveProfile={saveProfile}
                tryons={results}
                aiConsent={aiConsent}
                onConsent={setConsent}
              />
            ) : (
              <>
                {usingSample ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 border border-line bg-surface-2 px-3 py-2 text-xs">
                    <span><strong className="font-semibold tracking-[0.1em] uppercase">Sample model</strong> · add a photo of yourself above to see these clothes on you.</span>
                  </div>
                ) : null}

                {/* Everything you have on, each removable: nothing stays on by surprise. */}
                <WearingBar selection={selection} items={items} onRemove={remove} onClear={() => { setOutfitId(""); setView(null); setPicked({}); }} />

                {/* Preview (instant, on this device) or Realistic (AI render of this exact outfit). */}
                {match ? (
                  <div className="flex justify-center" role="tablist" aria-label="View">
                    {(["preview", "realistic"] as const).map((v) => (
                      <button
                        key={v}
                        role="tab"
                        aria-selected={(v === "realistic") === showRealistic}
                        onClick={() => setView(v)}
                        className="border px-4 py-1.5 text-[11px] font-semibold tracking-[0.1em] uppercase"
                        style={(v === "realistic") === showRealistic ? { background: "var(--text)", color: "var(--bg)", borderColor: "var(--text)" } : { borderColor: "var(--line)" }}
                      >
                        {v === "preview" ? "Quick preview" : "Realistic"}
                      </button>
                    ))}
                  </div>
                ) : null}

                <div className="relative mx-auto w-fit max-w-full">
                  {showRealistic && match?.status === "ready" && match.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
                    <img src={match.imageUrl} alt="You wearing this outfit (AI render)" className="animate-rise mx-auto block max-h-[75vh] w-auto bg-surface-2 object-contain" />
                  ) : (
                    <TryOnCanvas ref={canvasRef} avatar={previewAvatar} garments={garments} />
                  )}
                  {showRealistic && match?.status === "pending" ? <RenderProgress since={match.created_at} /> : null}
                  {showRealistic && match?.status === "failed" ? (
                    <div className="absolute inset-x-4 bottom-4 border border-line bg-bg p-3 text-sm">
                      <p className="font-medium">The AI couldn&apos;t finish this one.</p>
                      <p className="mt-1 text-muted">{match.error}</p>
                    </div>
                  ) : null}
                  {showRealistic && match?.status === "ready" ? (
                    <span className="absolute left-3 top-3 bg-bg px-2 py-1 text-[10px] font-semibold tracking-[0.12em] uppercase">AI render</span>
                  ) : null}
                </div>

                <p className="text-center text-xs text-muted">
                  {showRealistic && match?.status === "ready"
                    ? match.error ?? "Rendered by AI from your photo and these clothes."
                    : "Quick preview: garments fitted to the shoulders, arms, hips and legs on this device. Free and unlimited."}
                </p>

                {/* The realistic render: the main action, right under the image. */}
                <div className="mx-auto max-w-md space-y-2">
                  {askConsent ? (
                    <div className="card space-y-3 p-3 text-sm">
                      <p className="font-medium">Make it realistic with AI</p>
                      <p className="text-xs text-muted">
                        Your photo and these clothes are sent to free AI try-on models on Hugging Face (IDM-VTON and Leffa), which draw you wearing them. It takes 1–3 minutes. Personal, non-commercial use. You can switch this off in Profile.
                      </p>
                      <div className="flex gap-2">
                        <button className="btn-ghost flex-1" onClick={() => setAskConsent(false)}>Not now</button>
                        <button className="btn-primary flex-1" onClick={agreeAndRun}>Agree and render</button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className={match?.status === "ready" ? "btn-ghost w-full" : "btn-primary w-full"}
                      disabled={!hasUpper || pending || !photo}
                      onClick={realistic}
                    >
                      {pending ? "Rendering…" : match?.status === "ready" ? "Render again" : "Make it realistic (AI)"}
                    </button>
                  )}
                  {!photo ? <p className="text-center text-xs text-muted">Add a photo of yourself above to get a realistic render.</p> : null}
                  {photo && !hasUpper ? <p className="text-center text-xs text-muted">Pick a top, bottom, layer or dress first.</p> : null}
                  {message ? <p className="text-center text-sm text-danger" role="alert">{message}</p> : null}
                </div>

                {fitNotes.length ? (
                  <ul className="mx-auto max-w-md space-y-1 text-sm">
                    {fitNotes.map(({ item, fit }) => (
                      <li key={item.id} className="flex justify-between gap-3">
                        <span className="capitalize">{item.subcategory ?? item.category}{item.size_label ? ` · ${item.size_label}` : ""}</span>
                        {fit.note ? (
                          <span className={/small|tight/.test(fit.note) ? "text-danger" : /big|loose|oversized/.test(fit.note) ? "text-warn" : "text-ok"}>{fit.note}</span>
                        ) : item.size_label ? (
                          <span className="text-muted">add your sizes to see the fit</span>
                        ) : (
                          <Link className="text-muted underline" href={`/wardrobe/${item.id}`}>add the size on its label</Link>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {!showRealistic ? (
                  <div className="flex justify-center gap-2">
                    <button className="btn-ghost" onClick={() => canvasRef.current?.download()}>Save preview</button>
                  </div>
                ) : null}
              </>
            )}
          </div>

          <div className="min-w-0 space-y-4">
            <div>
              <label className="label" htmlFor="outfit">Saved outfit</label>
              <select id="outfit" className="input" value={outfitId} onChange={(e) => pickOutfit(e.target.value)}>
                <option value="">Mix and match below</option>
                {outfits.map((o) => <option key={o.id} value={o.id}>{o.name ?? "Outfit"}</option>)}
              </select>
            </div>
            {SLOTS.map(({ slot, label }) => {
              const options = items.filter((i) => slotFor(i) === slot);
              if (!options.length) return null;
              return (
                <div key={slot}>
                  <span className="label">{label}{slot === "outer" ? " (goes over your top)" : ""}</span>
                  <ul className="flex gap-2 overflow-x-auto pb-1">
                    <li>
                      <button type="button" onClick={() => remove(slot)} aria-pressed={!selection[slot]} className="flex h-16 w-16 items-center justify-center border-2 text-xs text-muted" style={{ borderColor: !selection[slot] ? "var(--text)" : "var(--line)" }}>None</button>
                    </li>
                    {options.map((i) => (
                      <li key={i.id}>
                        <button type="button" onClick={() => toggle(i)} aria-pressed={selection[slot] === i.id} aria-label={i.subcategory ?? slot} className="block h-16 w-16 border-2" style={{ borderColor: selection[slot] === i.id ? "var(--text)" : "transparent" }}>
                          <ItemThumb url={i.thumbUrl} alt={i.subcategory ?? slot} className="h-full w-full" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}

            {missing.top || missing.waist || missing.shoe ? (
              <div className="card space-y-2 p-3">
                <p className="text-sm font-medium">Your sizes</p>
                <p className="text-xs text-muted">Tell us your size to see how these clothes will fit you. Saved to your profile.</p>
                <div className="grid grid-cols-3 gap-2">
                  {missing.top ? (
                    <select className="input" aria-label="Your top size" defaultValue="" onChange={(e) => e.target.value && saveSizes({ top_size: e.target.value as UserSizes["top_size"] })}>
                      <option value="" disabled>Top size</option>
                      {TOP_SIZES.map((s) => <option key={s}>{s}</option>)}
                    </select>
                  ) : null}
                  {missing.waist ? (
                    <input className="input" type="number" min={22} max={50} placeholder="Waist in" aria-label="Your waist in inches" onBlur={(e) => e.target.value && saveSizes({ waist_in: Number(e.target.value) })} />
                  ) : null}
                  {missing.shoe ? (
                    <input className="input" type="number" min={2} max={15} step={0.5} placeholder="Shoe UK" aria-label="Your UK shoe size" onBlur={(e) => e.target.value && saveSizes({ shoe_uk: Number(e.target.value) })} />
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {results.length ? (
        <section>
          <h2 className="mb-3 text-xs font-semibold tracking-[0.14em] uppercase">Your AI try-ons</h2>
          <ul className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            {results.map((r) => (
              <li key={r.id} className="group relative">
                <button className="block w-full text-left" onClick={() => openResult(r)} aria-label="Show this try-on">
                  {r.status === "ready" && r.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
                    <img src={r.imageUrl} alt="" className="aspect-[3/4] w-full bg-surface-2 object-contain" />
                  ) : (
                    <div className={`flex aspect-[3/4] items-center justify-center bg-surface-2 p-2 text-center text-[11px] text-muted ${r.status === "pending" ? "skeleton" : ""}`}>
                      {r.status === "pending" ? "Rendering…" : "Couldn't finish"}
                    </div>
                  )}
                </button>
                <button className="absolute right-1 top-1 grid h-7 w-7 place-items-center bg-bg/90 text-muted opacity-0 transition group-hover:opacity-100 hover:text-danger focus:opacity-100" onClick={() => removeResult(r.id)} aria-label="Delete try-on" title="Delete try-on">
                  <CloseIcon className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Over the image while the AI works: elapsed time and what to expect. */
function RenderProgress({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.round((now - new Date(since).getTime()) / 1000));
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  return (
    <div className="absolute inset-0 grid place-items-center bg-bg/60 backdrop-blur-[2px]" role="status" aria-live="polite">
      <div className="bg-bg px-5 py-4 text-center shadow-lg">
        <div className="skeleton mx-auto mb-3 h-1 w-40" aria-hidden />
        <p className="text-sm font-medium">Dressing you · {clock}</p>
        <p className="mt-1 text-xs text-muted">Usually 1–3 minutes on the free GPU. You can keep browsing.</p>
      </div>
    </div>
  );
}

const SLOT_ORDER: Slot[] = ["outer", "top", "one_piece", "bottom", "shoes"];

function WearingBar({ selection, items, onRemove, onClear }: { selection: Selection; items: Item[]; onRemove: (slot: Slot) => void; onClear: () => void }) {
  const on = SLOT_ORDER.map((slot) => ({ slot, item: items.find((i) => i.id === selection[slot]) })).filter((x): x is { slot: Slot; item: Item } => Boolean(x.item));
  if (!on.length) return <p className="text-center text-xs text-muted">Pick clothes on the right to try them on.</p>;
  return (
    <div className="flex flex-wrap items-center justify-center gap-2" aria-label="Wearing">
      {on.map(({ slot, item }) => (
        <button
          key={slot}
          type="button"
          onClick={() => onRemove(slot)}
          className="flex items-center gap-1.5 border border-line py-1 pl-1 pr-2 text-xs capitalize hover:border-text"
          aria-label={`Take off ${item.subcategory ?? slot}`}
        >
          <ItemThumb url={item.thumbUrl} alt="" className="h-7 w-7" />
          {item.subcategory ?? slot}
          <CloseIcon className="h-3.5 w-3.5 text-muted" />
        </button>
      ))}
      {on.length > 1 ? (
        <button type="button" className="px-2 text-xs text-muted underline underline-offset-4 hover:text-text" onClick={onClear}>
          Clear
        </button>
      ) : null}
    </div>
  );
}
