"use client";
import { useEffect, useRef, useState } from "react";
import { loadGarments, type CanvasGarment } from "@/components/TryOnCanvas";
import { errorText } from "@/lib/api";
import { uploadAvatarPhoto } from "@/lib/avatarUpload";
import { MirrorSession } from "@/lib/mirror";
import { getVideoLandmarker } from "@/lib/pose";
import type { RenderGarment } from "@/lib/tryonRender";

type State = "idle" | "starting" | "running";

/**
 * Live, Lenskart-style mirror: the camera feed with the outfit fitted to your body in real time.
 * Pose tracking and drawing run on this device; no video leaves the browser.
 */
export default function LiveMirror({ garments, onAvatarAdded }: { garments: CanvasGarment[]; onAvatarAdded: (id: string) => Promise<void> }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const session = useRef<MirrorSession | null>(null);
  const clothes = useRef<RenderGarment[]>([]);
  const [state, setState] = useState<State>("idle");
  const [studio, setStudio] = useState(true);
  const [hint, setHint] = useState("");
  const [fps, setFps] = useState(0);
  const [ms, setMs] = useState(0);
  const [message, setMessage] = useState("");
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (session.current) session.current.studio = studio;
  }, [studio]);

  useEffect(() => {
    let cancelled = false;
    loadGarments(garments).then((g) => {
      if (cancelled) return;
      clothes.current = g;
      if (session.current) session.current.garments = g;
    });
    return () => {
      cancelled = true;
    };
  }, [garments]);

  function stop() {
    session.current?.stop();
    session.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setState("idle");
  }
  useEffect(() => stop, []);

  async function start() {
    setMessage("");
    setState("starting");
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 720 } }, audio: false });
      const v = video.current!;
      v.srcObject = stream.current;
      await v.play();
      await Promise.all([getVideoLandmarker(false), getVideoLandmarker(true)]);
      const s = new MirrorSession(v, canvas.current!, { onHint: setHint, onFps: (f, w) => { setFps(f); setMs(w); } });
      s.garments = clothes.current;
      s.studio = studio;
      session.current = s;
      setState("running");
      s.start();
    } catch (err) {
      stop();
      setMessage(err instanceof DOMException && err.name === "NotAllowedError" ? "Camera access was blocked. Allow it in the browser's site settings." : errorText(err));
    }
  }

  async function snapshot() {
    const c = canvas.current;
    if (!c) return;
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "warewise-mirror.png";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** 3-2-1, then the raw (un-mirrored, outfit-free) camera frame becomes a new avatar photo. */
  async function useAsAvatar() {
    for (let n = 3; n > 0; n--) {
      setCountdown(n);
      await new Promise((r) => setTimeout(r, 1000));
    }
    setCountdown(0);
    const v = video.current;
    if (!v) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.92));
    if (!blob) return;
    try {
      const added = await uploadAvatarPhoto(blob, (step) => setMessage(`Saving avatar: ${step}…`));
      await onAvatarAdded(added.id);
      setMessage(added.warnings.length ? `Added to your avatar. ${added.warnings.join(" ")}` : "Added to your avatar photos.");
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-none border border-line bg-surface-2">
        <video ref={video} playsInline muted className="hidden" />
        <canvas ref={canvas} className={`mx-auto block max-h-[70vh] w-full object-contain ${state === "running" ? "" : "hidden"}`} aria-label="Live try-on mirror" />
        {state !== "running" ? (
          <div className="flex aspect-[4/3] flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="font-medium">Live mirror</p>
            <p className="max-w-sm text-sm text-muted">Stand back so your whole body is in view. The outfit follows you as you move. Everything runs on this device; no video is uploaded.</p>
            <button className="btn-primary" onClick={start} disabled={state === "starting"}>{state === "starting" ? "Starting camera…" : "Start camera"}</button>
          </div>
        ) : null}
        {state === "running" && hint ? <p className="absolute inset-x-0 top-3 mx-auto w-fit bg-black/70 px-3 py-1 text-xs text-white">{hint}</p> : null}
        {countdown ? <p className="absolute inset-0 flex items-center justify-center text-7xl font-semibold text-white drop-shadow-lg">{countdown}</p> : null}
      </div>
      {state === "running" ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button className="btn-ghost" onClick={snapshot}>Save snapshot</button>
          <button className="btn-ghost" onClick={useAsAvatar} disabled={countdown > 0}>Use as avatar photo</button>
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={studio} onChange={(e) => setStudio(e.target.checked)} /> Studio background
          </label>
          <button className="btn-ghost" onClick={stop}>Stop</button>
          <span className="text-xs text-muted" title="Frames per second, and processing time per frame on this device">{fps} fps · {ms} ms</span>
        </div>
      ) : null}
      {message ? <p className="text-center text-sm text-muted">{message}</p> : null}
    </div>
  );
}
