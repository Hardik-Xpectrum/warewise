"use client";
import { CloseIcon } from "@/components/Icons";
import { useRef, useState } from "react";
import { api, errorText } from "@/lib/api";
import { uploadAvatarPhoto } from "@/lib/avatarUpload";
import type { AvatarPhoto } from "./types";

/** Up to 5 photos of the user. Each is cut out and measured on the device before upload. */
export default function AvatarManager({
  photos,
  max,
  selectedId,
  onSelect,
  onChange,
}: {
  photos: AvatarPhoto[];
  max: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: (selectId?: string) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const full = photos.length >= max;

  async function add(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    const room = max - photos.length;
    const list = Array.from(files).slice(0, room);
    const notes: string[] = [];
    try {
      for (const [i, file] of list.entries()) {
        const added = await uploadAvatarPhoto(file, (step) => setStatus(`Photo ${i + 1} of ${list.length}: ${step}…`));
        notes.push(...added.warnings);
        await onChange(added.id); // show the new photo straight away
      }
      setStatus(notes.length ? `Added. Note: ${[...new Set(notes)].join(" ")}` : "Added.");
      if (files.length > room) setStatus((s) => `${s} Only ${max} photos are kept; the rest were skipped.`);
    } catch (err) {
      setStatus(errorText(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function makePrimary(id: string) {
    await api(`/avatar/photos/${id}`, { method: "PATCH", json: { is_primary: true } });
    await onChange();
  }

  async function remove(id: string) {
    if (!confirm("Delete this avatar photo?")) return;
    await api(`/avatar/photos/${id}`, { method: "DELETE" });
    await onChange();
  }

  const fileInput = <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => add(e.target.files)} />;

  // Once there's a photo, the photos shrink to a strip so the try-on itself leads the page.
  if (photos.length) {
    return (
      <section className="flex flex-wrap items-center gap-3" aria-label="Your photos">
        <span className="eyebrow">You</span>
        <ul className="flex gap-2">
          {photos.map((p) => (
            <li key={p.id} className="group relative">
              <button
                type="button"
                onClick={() => onSelect(p.id)}
                aria-pressed={selectedId === p.id}
                aria-label="Use this photo"
                title={`${Math.round(p.quality * 100)}% body fit${p.is_primary ? " · main photo" : ""}`}
                className="block h-16 w-12 border-2 bg-surface-2"
                style={{ borderColor: selectedId === p.id ? "var(--text)" : "transparent" }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL */}
                <img src={p.imageUrl ?? ""} alt="" className="h-full w-full object-contain" />
              </button>
              <div className="absolute -right-2 -top-2 hidden gap-0.5 group-hover:flex group-focus-within:flex">
                {!p.is_primary ? (
                  <button className="grid h-6 place-items-center bg-bg px-1 text-[10px] shadow" onClick={() => makePrimary(p.id)} title="Make this your main photo">Main</button>
                ) : null}
                <button className="grid h-6 w-6 place-items-center bg-bg text-muted shadow hover:text-danger" onClick={() => remove(p.id)} aria-label="Delete photo" title="Delete photo">
                  <CloseIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
        {!full ? (
          <button className="btn-ghost px-3 py-2" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? "Working…" : "+ Photo"}
          </button>
        ) : null}
        {fileInput}
        {status ? <p className="w-full text-xs text-muted">{status}</p> : null}
      </section>
    );
  }

  return (
    <section className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">Add a photo of yourself</h2>
          <p className="text-sm text-muted">Then every outfit can be shown on you. Up to {max} photos.</p>
        </div>
        <button className="btn-primary" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? "Working…" : "Add photos"}
        </button>
        {fileInput}
      </div>
      <div className="rounded-none bg-surface-2 p-4 text-sm">
        <p className="font-medium">Tips for a good avatar</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
          <li>Full body, head to feet, standing straight and facing the camera</li>
          <li>Arms slightly away from your body; fitted clothes</li>
          <li>Only you in the photo, good light, a plain background helps</li>
          <li>Add up to 5 photos, e.g. front, a relaxed pose and a different outfit</li>
        </ul>
      </div>
      {status ? <p className="text-sm text-muted">{status}</p> : null}
      <p className="text-xs text-muted">
        Photos are cut out and measured on your device, then stored privately. They only leave Warewise if you ask for a realistic AI render.
      </p>
    </section>
  );
}
