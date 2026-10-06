"use client";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, errorText } from "@/lib/api";
import { finishScan, framesFromVideoFile, sampleFrame, type ScanFrame, type ScanResult } from "@/lib/bodyScan";
import { useApi } from "@/lib/query";
import { framingProblem, TurnTracker, type Phase } from "@/modules/tryon/scan360";

type Stage = "intro" | "camera" | "processing" | "done" | "error";

const COUNTDOWN_S = 5;
const MAX_TURN_S = 40;
const SAMPLE_EVERY_MS = 150;

const PHASE_CUE: Record<Phase, string> = {
  front: "Turn slowly to your right",
  side1: "Keep turning…",
  back: "Halfway: keep going",
  side2: "Almost there",
  done: "Done",
};

/** Says a short cue out loud (you're a couple of metres from the screen), where the browser can. */
function say(text: string) {
  try {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  } catch {
    /* no voice: the cue is on screen too */
  }
}

/**
 * The 360° body scan: prop the phone up, step back, turn slowly once. The phone follows the turn,
 * keeps the sharpest front / side / back frames, cuts you out of them and uploads only those four;
 * the 3D avatar is then built from all four views. A recorded turn video works too.
 */
export default function BodyScan({ onFinished }: { onFinished?: (r: ScanResult) => void }) {
  const me = useApi<{ consents: { ai_training: boolean; analytics: boolean; avatar_ai: boolean } }>("/me");
  const [stage, setStage] = useState<Stage>("intro");
  const [cue, setCue] = useState("");
  const [progress, setProgress] = useState(0);
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [agree, setAgree] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const cancelled = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const consented = me.data?.consents.avatar_ai === true;
  // Known only in the browser (https + a camera API); false while server-rendering.
  const canCamera = useSyncExternalStore(
    noSubscription,
    () => window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia),
    () => false,
  );

  useEffect(() => {
    cancelled.current = false; // dev mode mounts twice; a real unmount sets it again below
    return () => {
      cancelled.current = true;
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function ensureConsent() {
    if (consented) return;
    const consents = { ...(me.data?.consents ?? { ai_training: false, analytics: false, avatar_ai: false }), avatar_ai: true };
    await api("/me/consents", { method: "PUT", json: consents });
    me.mutate((m) => (m ? { ...m, consents } : m));
  }

  async function process(frames: ScanFrame[]) {
    setStage("processing");
    try {
      const r = await finishScan(frames, setStep);
      setResult(r);
      setStage("done");
      say("Scan done");
      onFinished?.(r);
    } catch (err) {
      setError(errorText(err));
      setStage("error");
    }
  }

  async function startCamera() {
    setError("");
    try {
      await ensureConsent();
      // The camera's best resolution, in its own shape (asking for a portrait shape makes laptop
      // cameras crop and zoom), and its widest zoom where the browser lets us set it.
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
      const track = s.getVideoTracks()[0];
      const zoom = (track?.getCapabilities?.() as { zoom?: { min: number } } | undefined)?.zoom;
      if (zoom) await track.applyConstraints({ advanced: [{ zoom: zoom.min } as MediaTrackConstraintSet] }).catch(() => {});
      cancelled.current = false;
      stream.current = s;
      setCue("");
      setProgress(0);
      setStage("camera"); // the effect above attaches the stream and runs the capture
    } catch (err) {
      stream.current?.getTracks().forEach((t) => t.stop());
      setError(err instanceof DOMException && err.name === "NotAllowedError" ? "Camera access was blocked. Allow the camera for this site, or upload a turn video instead." : errorText(err));
      setStage("error");
    }
  }

  /** Framing check, a countdown, then the turn, sampled ~7 times a second until it's complete. */
  async function runCapture(v: HTMLVideoElement) {
    // 1. Wait until head to feet are in view (step back from the phone).
    let ready = 0;
    let lastCue = "";
    while (!cancelled.current && ready < 6) {
      const f = await sampleFrame(v, 0);
      const problem = framingProblem(f?.landmarks ?? null);
      const text = problem ?? "Perfect, hold still";
      setCue(text);
      if (text !== lastCue) say(text);
      lastCue = text;
      ready = problem ? 0 : ready + 1;
      await sleep(250);
    }
    // 2. Countdown.
    for (let n = COUNTDOWN_S; n > 0 && !cancelled.current; n--) {
      setCue(`Arms a little away from your body… ${n}`);
      if (n === COUNTDOWN_S) say("Arms a little away from your body. Keep your head facing the way your body faces");
      await sleep(1000);
    }
    say("Now turn slowly to your right");
    // 3. The turn.
    const tracker = new TurnTracker();
    const frames: ScanFrame[] = [];
    const start = performance.now();
    while (!cancelled.current && tracker.phase !== "done" && performance.now() - start < MAX_TURN_S * 1000) {
      const t0 = performance.now();
      const f = await sampleFrame(v, Math.round(t0 - start));
      if (f) {
        frames.push(f);
        const before = tracker.phase;
        const phase = tracker.update(f);
        if (phase !== before) say(PHASE_CUE[phase]);
        setCue(PHASE_CUE[phase]);
        setProgress(tracker.progress);
      }
      await sleep(Math.max(0, SAMPLE_EVERY_MS - (performance.now() - t0)));
    }
    stream.current?.getTracks().forEach((t) => t.stop());
    if (cancelled.current) return;
    await process(frames);
  }

  /** The <video> only exists once the camera stage has rendered, so the stream is attached here. */
  function attachVideo(v: HTMLVideoElement | null) {
    video.current = v;
    const s = stream.current;
    if (!v || !s || v.srcObject === s) return;
    v.srcObject = s;
    v.play()
      .then(() => runCapture(v))
      .catch((err) => {
        s.getTracks().forEach((t) => t.stop());
        setError(errorText(err));
        setStage("error");
      });
  }

  async function fromVideo(file: File | undefined) {
    if (!file) return;
    setError("");
    try {
      await ensureConsent();
      setStage("processing");
      setStep("Reading your video (on this device)");
      const frames = await framesFromVideoFile(file, (share) => setStep(`Reading your video (on this device): ${Math.round(share * 100)}%`));
      await process(frames);
    } catch (err) {
      setError(errorText(err));
      setStage("error");
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  if (stage === "camera") {
    return (
      <div className="fixed inset-x-0 top-0 z-[60] flex h-dvh flex-col bg-black text-white" role="dialog" aria-modal="true" aria-label="360° body scan">
        <video ref={attachVideo} className="absolute inset-0 h-full w-full object-contain" style={{ transform: "scaleX(-1)" }} playsInline muted />
        <div className="relative mt-auto space-y-4 bg-gradient-to-t from-black/80 to-transparent p-6 pb-10 text-center">
          <ProgressRing value={progress} />
          <p className="text-2xl font-semibold" role="status" aria-live="polite">{cue || "Starting the camera…"}</p>
          <button
            className="text-xs font-semibold tracking-[0.1em] uppercase underline underline-offset-4"
            onClick={() => {
              cancelled.current = true;
              stream.current?.getTracks().forEach((t) => t.stop());
              setStage("intro");
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <section className="space-y-5" aria-label="360° body scan">
      {stage === "intro" || stage === "error" ? (
        <>
          <div>
            <h2 className="text-xl font-semibold">360° body scan</h2>
            <p className="mt-1 text-sm text-muted">One slow turn in front of your phone gives your 3D avatar your real shape from every side.</p>
          </div>
          <ol className="grid gap-2 text-sm sm:grid-cols-2">
            {[
              ["Prop your phone up", "at waist height, against something steady"],
              ["Step back about 2.5 m", "until your head and feet are on screen"],
              ["Fitted clothes, arms slightly out", "a plain background helps"],
              ["Turn slowly once, in place", "about 15 seconds, head in line with your body (not looking at the phone); it tells you when to stop"],
            ].map(([a, b], i) => (
              <li key={a} className="flex gap-3 border border-line p-3">
                <span className="grid h-6 w-6 shrink-0 place-items-center bg-text text-xs font-semibold text-bg">{i + 1}</span>
                <span>
                  <span className="block font-medium">{a}</span>
                  <span className="text-muted">{b}</span>
                </span>
              </li>
            ))}
          </ol>
          {error ? <p className="border border-danger p-3 text-sm text-danger" role="alert">{error}</p> : null}
          {!consented ? (
            <label className="flex items-start gap-2 text-xs text-muted">
              <input type="checkbox" className="mt-0.5" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              <span>
                Send the four cut-out views (front, back and sides, not the video) to a third-party 3D service to build my avatar. You can turn this off in Profile.
              </span>
            </label>
          ) : null}
          <div className="flex flex-wrap gap-3">
            {canCamera ? (
              <button className="btn-primary" disabled={!consented && !agree} onClick={startCamera}>
                Start the scan
              </button>
            ) : null}
            <button className="btn-ghost" disabled={!consented && !agree} onClick={() => fileInput.current?.click()}>
              Upload a turn video
            </button>
            <input ref={fileInput} type="file" accept="video/*" hidden onChange={(e) => fromVideo(e.target.files?.[0])} />
          </div>
          {!canCamera ? (
            <p className="text-xs text-muted">The live camera needs a secure (https) page. Record the turn with your camera app and upload it instead.</p>
          ) : (
            <p className="text-xs text-muted">Recording elsewhere? Upload a 10–20 second video of one slow turn instead. Either way, the video stays on this device.</p>
          )}
        </>
      ) : null}

      {stage === "processing" ? (
        <div className="space-y-3 py-6 text-center" role="status" aria-live="polite">
          <div className="skeleton mx-auto h-1 w-48" aria-hidden />
          <p className="text-sm font-medium">{step || "Working…"}</p>
        </div>
      ) : null}

      {stage === "done" && result ? (
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Scan done</h2>
          <ul className="grid grid-cols-4 gap-2">
            {(["front", "left", "back", "right"] as const).map((v) => (
              <li key={v} className="space-y-1 text-center">
                {/* eslint-disable-next-line @next/next/no-img-element -- local preview */}
                <img src={result.previews[v]} alt={`${v} view`} className="aspect-[3/4] w-full bg-surface-2 object-contain" />
                <span className="text-[11px] font-semibold tracking-[0.1em] text-muted uppercase">{v}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted">Your 3D avatar is being built from these four views. It takes about a minute; you&apos;ll find it on Try-on → 3D avatar → AI 3D.</p>
          <div className="flex flex-wrap gap-3">
            <Link className="btn-primary" href="/tryon">Go to Try-on</Link>
            <button className="btn-ghost" onClick={() => { setResult(null); setStage("intro"); }}>Scan again</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ProgressRing({ value }: { value: number }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  return (
    <svg width="84" height="84" viewBox="0 0 84 84" className="mx-auto" aria-label={`Turn ${Math.round(value * 100)}% done`}>
      <circle cx="42" cy="42" r={r} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="6" />
      <circle
        cx="42" cy="42" r={r} fill="none" stroke="#ffffff" strokeWidth="6" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - value)} transform="rotate(-90 42 42)"
        style={{ transition: "stroke-dashoffset 400ms ease" }}
      />
    </svg>
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noSubscription = () => () => {};
