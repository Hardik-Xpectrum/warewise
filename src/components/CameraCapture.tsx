"use client";
import { useEffect, useRef, useState } from "react";
import { CloseIcon } from "./Icons";

/**
 * Full-screen camera for adding clothes fast: shoot piece after piece without leaving the camera.
 * Each shot is handed to `onShot` straight away so it uploads and gets tagged while you take the
 * next one. Uses the rear camera on phones; the stream stops the moment the camera closes.
 */
export default function CameraCapture({ onShot, onClose }: { onShot: (file: File) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState(() =>
    typeof navigator !== "undefined" && "mediaDevices" in navigator && typeof navigator.mediaDevices?.getUserMedia === "function" ? "" : "This browser can't open the camera here. Choose photos instead.",
  );
  const [count, setCount] = useState(0);
  const [flash, setFlash] = useState(false);
  const [last, setLast] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1920 } }, audio: false })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play();
        }
      })
      .catch(() => setError("Camera access was blocked. Allow the camera for this site, or choose photos instead."));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => () => {
    if (last) URL.revokeObjectURL(last);
  }, [last]);

  function shoot() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    c.toBlob(
      (blob) => {
        if (!blob) return;
        const file = new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" });
        onShot(file);
        setCount((n) => n + 1);
        setLast(URL.createObjectURL(blob));
        setFlash(true);
        setTimeout(() => setFlash(false), 120);
        navigator.vibrate?.(15);
      },
      "image/jpeg",
      0.9,
    );
  }

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black text-white" role="dialog" aria-modal="true" aria-label="Take photos of your clothes">
      <div className="flex items-center justify-between px-4 py-3 text-xs font-semibold tracking-[0.1em] uppercase">
        <span>{count ? `${count} added · keep going` : "One piece per photo"}</span>
        <button className="grid h-10 w-10 place-items-center" onClick={onClose} aria-label="Close camera">
          <CloseIcon className="h-6 w-6" />
        </button>
      </div>
      <div className="relative flex-1 overflow-hidden">
        {error ? (
          <p className="absolute inset-0 grid place-items-center p-8 text-center text-sm">{error}</p>
        ) : (
          <video ref={video} className="h-full w-full object-cover" playsInline muted />
        )}
        {/* A frame to aim at: one garment, flat or hanging, filling most of it. */}
        {!error ? <div aria-hidden className="pointer-events-none absolute inset-[12%] border border-white/60" /> : null}
        {flash ? <div aria-hidden className="absolute inset-0 bg-white/70" /> : null}
      </div>
      <div className="grid grid-cols-3 items-center px-6 pb-10 pt-5">
        <div>
          {last ? (
            // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
            <img src={last} alt="Last photo" className="h-14 w-14 border border-white/40 object-cover" />
          ) : null}
        </div>
        <button
          className="mx-auto grid h-[76px] w-[76px] place-items-center rounded-full border-4 border-white transition active:scale-90 disabled:opacity-40"
          onClick={shoot}
          disabled={Boolean(error)}
          aria-label="Take photo"
        >
          <span className="h-[60px] w-[60px] rounded-full bg-white" />
        </button>
        <button className="justify-self-end text-xs font-semibold tracking-[0.1em] uppercase" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
