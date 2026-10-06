"use client";
import { useEffect, useRef, useState } from "react";
import { api, errorText } from "@/lib/api";
import { browserClient } from "@/lib/supabase/browser";
import CameraCapture from "./CameraCapture";

type Job = { key: string; name: string; preview: string; file: File; state: "queued" | "preparing" | "removing" | "uploading" | "saving" | "done" | "error"; error?: string };

const PARALLEL = 2; // two at a time: faster than one, still gentle on phones and the tagger's limits

const MAX_SIDE = 1600;
const BG_PREF_KEY = "warewise.removeBackground";

async function toBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Resizes on the device and re-encodes (WebP, or JPEG where WebP encoding is missing). */
async function prepare(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("This browser can't read that photo format. Try a JPEG or PNG (on iPhone, Safari reads HEIC).");
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const g = canvas.getContext("2d")!;
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const webp = await toBlob(canvas, "image/webp", 0.85);
  if (webp && webp.type === "image/webp") return webp;
  // JPEG has no transparency: paint a white background under cut-outs.
  const flat = document.createElement("canvas");
  flat.width = canvas.width;
  flat.height = canvas.height;
  const f = flat.getContext("2d")!;
  f.fillStyle = "#ffffff";
  f.fillRect(0, 0, flat.width, flat.height);
  f.drawImage(canvas, 0, 0);
  const jpeg = await toBlob(flat, "image/jpeg", 0.88);
  if (!jpeg) throw new Error("Could not encode the photo");
  return jpeg;
}

export default function Uploader({ onUploaded }: { onUploaded: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [removeBg, setRemoveBg] = useState(false);
  const [camera, setCamera] = useState(false);
  const queue = useRef<{ file: File; key: string }[]>([]);
  const running = useRef(0);

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read a per-device preference once on mount
      setRemoveBg(localStorage.getItem(BG_PREF_KEY) === "1");
    } catch {
      /* storage blocked: keep default */
    }
  }, []);

  function toggleBg(v: boolean) {
    setRemoveBg(v);
    try {
      localStorage.setItem(BG_PREF_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  const update = (key: string, patch: Partial<Job>) => setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...patch } : j)));

  async function uploadOne(file: File, key: string) {
    try {
      let source: Blob = file;
      if (removeBg) {
        update(key, { state: "removing" });
        // Runs fully in the browser; the model files download once and are cached.
        const { removeBackground } = await import("@imgly/background-removal");
        source = await removeBackground(file);
      }
      update(key, { state: "preparing" });
      const blob = await prepare(source);

      update(key, { state: "uploading" });
      const target = await api<{ path: string; token: string }>("/uploads", { method: "POST", json: { contentType: blob.type } });
      const { error } = await browserClient().storage.from("wardrobe").uploadToSignedUrl(target.path, target.token, blob, { contentType: blob.type });
      if (error) throw new Error(error.message);

      update(key, { state: "saving" });
      await api("/items", { method: "POST", json: { imagePath: target.path }, headers: { "idempotency-key": key } });
      update(key, { state: "done" });
      onUploaded();
    } catch (err) {
      update(key, { state: "error", error: errorText(err) });
    }
  }

  /** Runs queued uploads, PARALLEL at a time, as photos keep arriving from the camera or picker. */
  function pump() {
    while (running.current < PARALLEL && queue.current.length) {
      const next = queue.current.shift()!;
      running.current += 1;
      void uploadOne(next.file, next.key).finally(() => {
        running.current -= 1;
        pump();
      });
    }
  }

  function add(files: File[]) {
    const list = files.slice(0, 30).map((file) => ({ file, key: crypto.randomUUID() }));
    setJobs((js) => [...list.map(({ file, key }) => ({ key, name: file.name, file, preview: URL.createObjectURL(file), state: "queued" as const })), ...js].slice(0, 40));
    queue.current.push(...list);
    pump();
  }

  function onFiles(files: FileList | null) {
    if (!files?.length) return;
    add(Array.from(files));
    if (input.current) input.current.value = "";
  }

  function retry(job: Job) {
    update(job.key, { state: "queued", error: undefined });
    queue.current.push({ file: job.file, key: job.key });
    pump();
  }

  // Free the preview images when the uploader goes away.
  const jobsRef = useRef(jobs);
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);
  useEffect(() => () => jobsRef.current.forEach((j) => URL.revokeObjectURL(j.preview)), []);

  const recent = jobs.slice(0, 12);
  const pendingCount = jobs.filter((j) => j.state !== "done" && j.state !== "error").length;
  const label: Record<Job["state"], string> = {
    queued: "Waiting…",
    preparing: "Preparing…",
    removing: "Removing background…",
    uploading: "Uploading…",
    saving: "Saving…",
    done: "Added",
    error: "Failed",
  };

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-primary" onClick={() => setCamera(true)}>
          Take photos
        </button>
        <button className="btn-ghost" onClick={() => input.current?.click()}>
          Choose photos
        </button>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={removeBg} onChange={(e) => toggleBg(e.target.checked)} />
          Remove background on this device (slower)
        </label>
        <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />
      </div>
      <p className="mt-2 text-xs text-muted">
        One piece per photo, on a plain background if you can. Keep shooting: each photo uploads and gets tagged while you take the next.
        {pendingCount ? ` ${pendingCount} in progress.` : ""}
      </p>
      {recent.length ? (
        <ul className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="Recent uploads">
          {recent.map((j) => (
            <li key={j.key} className="relative h-20 w-16 shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
              <img src={j.preview} alt={j.name} className={`h-full w-full object-cover ${j.state === "done" ? "" : "opacity-60"}`} />
              <span
                className="absolute inset-x-0 bottom-0 px-1 py-0.5 text-center text-[9px] font-semibold tracking-wide uppercase"
                style={{ background: j.state === "error" ? "var(--danger)" : j.state === "done" ? "var(--text)" : "rgba(0,0,0,0.6)", color: "#fff" }}
                title={j.error}
              >
                {j.state === "done" ? "Added" : j.state === "error" ? "Failed" : label[j.state].replace("…", "")}
              </span>
              {j.state === "error" ? (
                <button className="absolute inset-0" onClick={() => retry(j)} aria-label={`Retry ${j.name}: ${j.error}`} title={`${j.error} · tap to retry`} />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {camera ? <CameraCapture onShot={(f) => add([f])} onClose={() => setCamera(false)} /> : null}
    </div>
  );
}
