"use client";
import { useEffect, useRef, useState } from "react";
import BodyScan from "@/components/BodyScan";
import Logo from "@/components/Logo";
import { toast } from "@/components/Toaster";
import { api, errorText } from "@/lib/api";
import { clearQueryCache } from "@/lib/query";
import { TOP_SIZES } from "@/modules/tryon/fit";

type Wear = "menswear" | "womenswear" | "both" | "unspecified";

// The style quiz: each card is a feeling, shown with the colours it usually lives in.
const STYLES: { id: string; label: string; line: string; colours: string[] }[] = [
  { id: "classic", label: "Classic", line: "Crisp shirts, chinos, timeless", colours: ["#1f2a4d", "#ffffff", "#d9c7a7"] },
  { id: "minimal", label: "Minimal", line: "Few colours, clean lines", colours: ["#1c1c1c", "#9a9a9a", "#f3ead3"] },
  { id: "streetwear", label: "Streetwear", line: "Oversized tees, sneakers", colours: ["#1c1c1c", "#c4122f", "#9a9a9a"] },
  { id: "ethnic", label: "Ethnic", line: "Kurtas, sarees, festive wear", colours: ["#6d1a2a", "#c8a44d", "#e8772e"] },
  { id: "boho", label: "Boho", line: "Prints, flow, earthy", colours: ["#c49a6c", "#6b6b2e", "#eaa0b4"] },
  { id: "sporty", label: "Sporty", line: "Athleisure, comfort first", colours: ["#2f5fb3", "#ffffff", "#1c1c1c"] },
  { id: "formal", label: "Formal", line: "Suits, structure, polish", colours: ["#1c1c1c", "#1f2a4d", "#ffffff"] },
  { id: "trendy", label: "Trendy", line: "What's new this season", colours: ["#6c4a9e", "#f2d02b", "#a7c7e7"] },
];

const STEPS = ["You", "Sizes", "Style", "Scan", "Wardrobe"] as const;

/**
 * First-run onboarding, one question per screen: name and city, sizes, a style quiz, then the
 * first clothes (or the sample wardrobe). Every step can be skipped; each one saves as you go,
 * so leaving halfway keeps what was entered.
 */
export default function WelcomeFlow({ initialName }: { initialName: string }) {
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(initialName);
  const [city, setCity] = useState("");
  const [topSize, setTopSize] = useState("");
  const [waist, setWaist] = useState("");
  const [shoe, setShoe] = useState("");
  const [height, setHeight] = useState("");
  const [styles, setStyles] = useState<string[]>([]);
  const [wear, setWear] = useState<Wear>("unspecified");
  const [scanned, setScanned] = useState(false);
  // Marks the flow interactive once React has hydrated it (browser tests wait for this).
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.setAttribute("data-hydrated", "");
  }, []);

  const go = (to: number) => {
    setDir(to > step ? 1 : -1);
    setStep(to);
    window.scrollTo({ top: 0 });
  };

  async function save(patch: Record<string, unknown>) {
    setBusy(true);
    try {
      await api("/me", { method: "PATCH", json: patch });
      return true;
    } catch (err) {
      toast(errorText(err), "error");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function next(patch?: Record<string, unknown>) {
    if (patch && !(await save(patch))) return;
    go(step + 1);
  }

  async function finish(where: "samples" | "add" | "skip") {
    setBusy(true);
    try {
      if (where === "samples") await api("/samples", { method: "POST" });
      await api("/me", { method: "PATCH", json: { onboarded: true } });
      clearQueryCache();
      // A full load, not router.replace: the client router may still hold the earlier
      // "/today → /welcome" redirect from before setup was finished.
      window.location.replace(where === "add" ? "/wardrobe#add" : "/today");
    } catch (err) {
      toast(errorText(err), "error");
      setBusy(false);
    }
  }

  const num = (v: string) => (v ? Number(v) : null);

  return (
    <div ref={root} className="mx-auto flex min-h-[100dvh] max-w-xl flex-col px-5 pb-8 pt-6">
      <div className="flex items-center justify-between">
        <Logo />
        <button className="text-xs font-semibold tracking-[0.1em] text-muted uppercase hover:text-text" onClick={() => finish("skip")} disabled={busy}>
          Skip setup
        </button>
      </div>

      {/* Progress: four segments, the current one filling in. */}
      <ol className="mt-6 grid grid-cols-5 gap-1.5" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
        {STEPS.map((s, i) => (
          <li key={s} className="space-y-1.5">
            <div className="h-0.5 overflow-hidden bg-line">
              <div className="h-full bg-text transition-transform duration-500 ease-out" style={{ transform: `scaleX(${i <= step ? 1 : 0})`, transformOrigin: "left" }} />
            </div>
            <p className={`text-[10px] font-semibold tracking-[0.12em] uppercase ${i === step ? "text-text" : "text-muted"}`} aria-current={i === step ? "step" : undefined}>
              {s}
            </p>
          </li>
        ))}
      </ol>

      <div key={step} className={`flex flex-1 flex-col pt-10 ${dir === 1 ? "animate-step-in" : "animate-step-back"}`}>
        {step === 0 ? (
          <Screen
            title="Hi! What should we call you?"
            line="Your stylist uses your city for the weather in every outfit."
            footer={
              <button className="btn-primary w-full" disabled={busy || !name.trim()} onClick={() => next({ display_name: name.trim(), home_city: city.trim() || null })}>
                Continue
              </button>
            }
          >
            <div>
              <label className="label" htmlFor="w-name">Your name</label>
              <input id="w-name" className="input text-base" autoFocus autoComplete="given-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            </div>
            <div>
              <label className="label" htmlFor="w-city">Home city</label>
              <input id="w-city" className="input text-base" placeholder="e.g. Pune, Bengaluru, Delhi" autoComplete="address-level2" value={city} onChange={(e) => setCity(e.target.value)} maxLength={80} />
            </div>
          </Screen>
        ) : null}

        {step === 1 ? (
          <Screen
            title="Your sizes"
            line="Try-on uses these to show how a piece will fit. All optional."
            footer={
              <Nav
                busy={busy}
                onBack={() => go(0)}
                onNext={() =>
                  next({
                    body_profile: {
                      ...(topSize ? { top_size: topSize } : {}),
                      waist_in: num(waist),
                      shoe_uk: num(shoe),
                      height_cm: num(height),
                    },
                  })
                }
              />
            }
          >
            <div>
              <p className="label">Top size</p>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Top size">
                {TOP_SIZES.map((s) => (
                  <Pick key={s} on={topSize === s} onClick={() => setTopSize(topSize === s ? "" : s)} radio>
                    {s}
                  </Pick>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <NumberField id="w-waist" label="Waist (in)" placeholder="32" min={22} max={50} value={waist} onChange={setWaist} />
              <NumberField id="w-shoe" label="Shoe (UK)" placeholder="9" min={2} max={15} step={0.5} value={shoe} onChange={setShoe} />
              <NumberField id="w-height" label="Height (cm)" placeholder="170" min={100} max={230} value={height} onChange={setHeight} />
            </div>
          </Screen>
        ) : null}

        {step === 2 ? (
          <Screen
            title="Which feel like you?"
            line="Pick up to three. The stylist leans towards these."
            footer={<Nav busy={busy} onBack={() => go(1)} onNext={() => next({ style_prefs: { styles, gender_presentation: wear } })} />}
          >
            <div className="grid grid-cols-2 gap-2.5" role="group" aria-label="Styles">
              {STYLES.map((s) => {
                const on = styles.includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setStyles(on ? styles.filter((x) => x !== s.id) : [...styles, s.id].slice(-3))}
                    className="border p-3 text-left transition active:scale-[0.98]"
                    style={on ? { borderColor: "var(--text)", boxShadow: "inset 0 0 0 1px var(--text)" } : { borderColor: "var(--line)" }}
                  >
                    <span className="flex gap-1" aria-hidden>
                      {s.colours.map((c) => (
                        <span key={c} className="h-5 flex-1 border border-line" style={{ background: c }} />
                      ))}
                    </span>
                    <span className="mt-2.5 block text-sm font-semibold">{s.label}</span>
                    <span className="block text-xs text-muted">{s.line}</span>
                  </button>
                );
              })}
            </div>
            <div>
              <p className="label">I mostly wear</p>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="I mostly wear">
                {(["menswear", "womenswear", "both", "unspecified"] as Wear[]).map((w) => (
                  <Pick key={w} on={wear === w} onClick={() => setWear(w)} radio>
                    {w === "unspecified" ? "Prefer not to say" : w}
                  </Pick>
                ))}
              </div>
            </div>
          </Screen>
        ) : null}

        {step === 3 ? (
          <Screen
            title="Scan your body in 3D"
            line="Optional, and best done now: one slow turn in front of your phone makes a 3D avatar with your real shape."
            footer={
              <div className="flex gap-3">
                <button className="btn-ghost flex-1" onClick={() => go(2)} disabled={busy}>Back</button>
                <button className="btn-primary flex-[2]" onClick={() => go(4)} disabled={busy}>{scanned ? "Continue" : "Skip for now"}</button>
              </div>
            }
          >
            <BodyScan onFinished={() => setScanned(true)} />
          </Screen>
        ) : null}

        {step === 4 ? (
          <Screen
            title="Now, your clothes"
            line="Photograph a few pieces (a top, a bottom and shoes is enough), or explore with a sample wardrobe first."
            footer={
              <button className="w-full py-2 text-xs font-semibold tracking-[0.1em] text-muted uppercase hover:text-text" onClick={() => go(3)} disabled={busy}>
                Back
              </button>
            }
          >
            <button className="group block w-full border border-text p-5 text-left transition hover:bg-text hover:text-bg" onClick={() => finish("add")} disabled={busy}>
              <span className="block text-base font-semibold">Add my clothes</span>
              <span className="mt-1 block text-sm opacity-70">Use your camera or choose photos. Warewise tags each piece for you.</span>
            </button>
            <button className="group block w-full border border-line p-5 text-left transition hover:border-text" onClick={() => finish("samples")} disabled={busy}>
              <span className="block text-base font-semibold">{busy ? "Setting up…" : "Explore with a sample wardrobe"}</span>
              <span className="mt-1 block text-sm text-muted">12 illustrated pieces and 3 outfits, clearly marked and removable in one tap.</span>
            </button>
          </Screen>
        ) : null}
      </div>
    </div>
  );
}

function Screen({ title, line, children, footer }: { title: string; line: string; children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted">{line}</p>
      <div className="mt-8 space-y-6">{children}</div>
      <div className="mt-auto pt-10">{footer}</div>
    </>
  );
}

function Nav({ busy, onBack, onNext }: { busy: boolean; onBack: () => void; onNext: () => void }) {
  return (
    <div className="flex gap-3">
      <button className="btn-ghost flex-1" onClick={onBack} disabled={busy}>Back</button>
      <button className="btn-primary flex-[2]" onClick={onNext} disabled={busy}>Continue</button>
    </div>
  );
}

function Pick({ on, onClick, radio, children }: { on: boolean; onClick: () => void; radio?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role={radio ? "radio" : undefined}
      aria-checked={radio ? on : undefined}
      onClick={onClick}
      className="min-w-12 border px-3.5 py-2.5 text-sm capitalize transition"
      style={on ? { background: "var(--text)", color: "var(--bg)", borderColor: "var(--text)" } : { borderColor: "var(--line)" }}
    >
      {children}
    </button>
  );
}

function NumberField(props: { id: string; label: string; placeholder: string; min: number; max: number; step?: number; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="label" htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        className="input text-base"
        type="number"
        inputMode="decimal"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        placeholder={props.placeholder}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  );
}
