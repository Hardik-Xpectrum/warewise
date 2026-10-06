"use client";

/** Last-resort boundary for errors in the root layout itself. */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui", display: "grid", placeItems: "center", minHeight: "100vh", margin: 0 }}>
        <div style={{ textAlign: "center" }}>
          <h1>Warewise hit a problem</h1>
          <button onClick={reset}>Reload</button>
        </div>
      </body>
    </html>
  );
}
