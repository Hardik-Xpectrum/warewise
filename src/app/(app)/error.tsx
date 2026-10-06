"use client";
import { useEffect } from "react";

/** Catches a crash in any app page so the rest of the app (nav, other tabs) keeps working. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="card mx-auto max-w-md space-y-3 p-6 text-center" role="alert">
      <h1 className="text-lg font-semibold">Something went wrong on this page</h1>
      <p className="text-sm text-muted">Your wardrobe is safe. Try again, or pick another tab.</p>
      {error.digest ? <p className="text-xs text-muted">Reference: {error.digest}</p> : null}
      <button className="btn-primary" onClick={reset}>Try again</button>
    </div>
  );
}
