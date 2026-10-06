"use client";
import { useEffect, useState } from "react";

type Toast = { id: number; text: string; kind: "ok" | "error" };

/** Show a short confirmation from anywhere: toast("Saved to Outfits"). */
export function toast(text: string, kind: Toast["kind"] = "ok") {
  window.dispatchEvent(new CustomEvent("warewise:toast", { detail: { text, kind } }));
}

/** Renders toasts bottom-centre (above the mobile tab bar); each fades out after 3.5 s. */
export default function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    let n = 0;
    const onToast = (e: Event) => {
      const { text, kind } = (e as CustomEvent<Omit<Toast, "id">>).detail;
      const id = ++n;
      setToasts((ts) => [...ts.slice(-2), { id, text, kind }]);
      setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 3500);
    };
    window.addEventListener("warewise:toast", onToast);
    return () => window.removeEventListener("warewise:toast", onToast);
  }, []);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-4 sm:bottom-6" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`animate-rise rounded-full px-4 py-2 text-sm shadow-lg ${t.kind === "error" ? "bg-danger text-white" : "bg-text text-bg"}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
