"use client";
import { useEffect, useRef, useState } from "react";
import PageSkeleton from "@/components/PageSkeleton";
import { toast } from "@/components/Toaster";
import { api, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/query";
import { browserClient } from "@/lib/supabase/browser";

type Profile = {
  display_name: string | null;
  home_city: string | null;
  daily_stylist_cap: number;
  style_prefs: { styles?: string[]; avoid?: string; gender_presentation?: string };
  body_profile: { body_shape?: string; height_cm?: number | null; fit_preference?: string; notes?: string; top_size?: string; waist_in?: number | null; shoe_uk?: number | null };
  consents: { ai_training: boolean; analytics: boolean; avatar_ai: boolean };
};

const STYLES = ["classic", "minimal", "streetwear", "ethnic", "boho", "sporty", "formal", "trendy"];

type SaveState = "idle" | "saving" | "saved" | "error";

export default function ProfileView() {
  const me = useApi<Profile>("/me");
  // Edits live in a draft over the cached profile and save themselves shortly after you stop typing.
  const [draft, setDraft] = useState<Profile | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [msg, setMsg] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<Profile | null>(null);
  const p = draft ?? me.data;

  // Leaving the page with a pending edit saves it straight away instead of dropping it.
  useEffect(
    () => () => {
      if (timer.current && latest.current) {
        clearTimeout(timer.current);
        void persist(latest.current);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount only
    [],
  );

  if (!p) return me.error ? <p className="text-danger">{me.error}</p> : <PageSkeleton />;

  const setP = (next: Profile) => {
    me.mutate(() => next);
    invalidate("/today"); // city and sizes change Today's weather and checklist
  };

  async function persist(next: Profile) {
    setSaveState("saving");
    try {
      const updated = await api<Profile>("/me", {
        method: "PATCH",
        json: { display_name: next.display_name?.trim() || "Me", home_city: next.home_city?.trim() || null, style_prefs: next.style_prefs, body_profile: next.body_profile },
      });
      // Keep typing smooth: only adopt the server copy if nothing changed meanwhile.
      if (latest.current === next) {
        setP(updated);
        setDraft(null);
        latest.current = null;
      }
      setSaveState("saved");
      setMsg("");
    } catch (err) {
      setSaveState("error");
      setMsg(errorText(err));
    }
  }

  /** Applies an edit now and saves it 700 ms later (choices like chips save almost at once). */
  const set = (patch: Partial<Profile>, delay = 700) => {
    const next = { ...p, ...patch };
    setDraft(next);
    latest.current = next;
    setSaveState("idle");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void persist(next);
    }, delay);
  };
  const pick = (patch: Partial<Profile>) => set(patch, 150);

  async function saveConsents(consents: Profile["consents"]) {
    try {
      const updated = await api<Profile>("/me/consents", { method: "PUT", json: consents });
      setP(draft ? { ...draft, consents: updated.consents } : updated);
      toast("Privacy choices saved");
    } catch (err) {
      setMsg(errorText(err));
    }
  }

  async function deleteAccount() {
    if (prompt('This deletes your photos, outfits and account now. Type "delete" to confirm.') !== "delete") return;
    try {
      await api("/me", { method: "DELETE" });
      // The account is gone but the browser still holds its session token: drop it now, or the
      // app would keep treating this browser as signed in until the token expires.
      await browserClient().auth.signOut({ scope: "local" });
      // Full reload: the session is gone, so no client state should survive.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = "/";
    } catch (err) {
      setMsg(errorText(err));
    }
  }

  const styles = p.style_prefs.styles ?? [];
  const bp = p.body_profile;
  const sizeError = [
    bp.waist_in != null && (bp.waist_in < 22 || bp.waist_in > 50) ? "Waist should be 22–50 inches" : "",
    bp.shoe_uk != null && (bp.shoe_uk < 2 || bp.shoe_uk > 15) ? "Shoe size should be UK 2–15" : "",
    bp.height_cm != null && (bp.height_cm < 100 || bp.height_cm > 230) ? "Height should be 100–230 cm" : "",
  ].filter(Boolean)[0];
  // Sizes are typed digit by digit: only save once the number makes sense.
  const setSize = (patch: Partial<Profile["body_profile"]>) => {
    const next = { ...bp, ...patch };
    const ok = (v: number | null | undefined, lo: number, hi: number) => v == null || (v >= lo && v <= hi);
    if (ok(next.waist_in, 22, 50) && ok(next.shoe_uk, 2, 15) && ok(next.height_cm, 100, 230)) set({ body_profile: next }, 900);
    else setDraft({ ...p, body_profile: next });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <h1 className="text-2xl font-semibold">Profile</h1>
        <SaveStatus state={saveState} />
      </div>
      {msg ? <p className="text-sm text-danger" role="alert">{msg}</p> : null}

      <div className="md:grid md:grid-cols-[180px_minmax(0,1fr)] md:gap-10">
        {/* Section nav: a sticky list on desktop, a scrolling row of tabs on phones. */}
        <nav aria-label="Profile sections" className="-mx-4 mb-6 overflow-x-auto border-b border-line px-4 md:sticky md:top-28 md:mx-0 md:mb-0 md:self-start md:border-0 md:px-0">
          <ul className="flex gap-5 text-xs font-semibold tracking-[0.1em] uppercase md:flex-col md:gap-3">
            {SECTIONS.map((sec) => (
              <li key={sec.id} className="shrink-0">
                <a href={`#${sec.id}`} className="block py-3 text-muted hover:text-text md:py-0">{sec.label}</a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="max-w-2xl space-y-10">
          <Section id="about" title="About you" line="Your city sets the weather for every outfit.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="name">Name</label>
                <input id="name" className="input" value={p.display_name ?? ""} onChange={(e) => set({ display_name: e.target.value })} maxLength={60} />
              </div>
              <div>
                <label className="label" htmlFor="city">Home city (for weather)</label>
                <input id="city" className="input" placeholder="e.g. Pune" value={p.home_city ?? ""} onChange={(e) => set({ home_city: e.target.value })} maxLength={80} />
              </div>
            </div>
          </Section>

          <Section id="style" title="Style" line="The stylist leans towards these and steers clear of what you avoid.">
            <div>
              <span className="label">Your style</span>
              <div className="flex flex-wrap gap-1.5">
                {STYLES.map((s) => {
                  const on = styles.includes(s);
                  return <button key={s} type="button" aria-pressed={on} className={`chip ${on ? "border-accent! bg-accent! text-accent-contrast!" : ""}`} onClick={() => pick({ style_prefs: { ...p.style_prefs, styles: on ? styles.filter((x) => x !== s) : [...styles, s] } })}>{s}</button>;
                })}
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="label" htmlFor="wear">I mostly wear</label>
                <select id="wear" className="input" value={p.style_prefs.gender_presentation ?? "unspecified"} onChange={(e) => pick({ style_prefs: { ...p.style_prefs, gender_presentation: e.target.value } })}>
                  <option value="unspecified">Prefer not to say</option>
                  <option value="menswear">Menswear</option>
                  <option value="womenswear">Womenswear</option>
                  <option value="both">Both</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="fitpref">Preferred fit</label>
                <select id="fitpref" className="input" value={bp.fit_preference ?? "regular"} onChange={(e) => pick({ body_profile: { ...bp, fit_preference: e.target.value } })}>
                  <option value="slim">Slim</option>
                  <option value="regular">Regular</option>
                  <option value="relaxed">Relaxed</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="shape">Body shape (optional)</label>
                <select id="shape" className="input" value={bp.body_shape ?? "unspecified"} onChange={(e) => pick({ body_profile: { ...bp, body_shape: e.target.value } })}>
                  <option value="unspecified">Prefer not to say</option>
                  <option value="rectangle">Rectangle</option>
                  <option value="triangle">Triangle (pear)</option>
                  <option value="inverted_triangle">Inverted triangle</option>
                  <option value="hourglass">Hourglass</option>
                  <option value="oval">Oval</option>
                </select>
              </div>
            </div>
            <div>
              <label className="label" htmlFor="avoid">Anything to avoid?</label>
              <input id="avoid" className="input" placeholder="e.g. no sleeveless tops, no yellow" value={p.style_prefs.avoid ?? ""} onChange={(e) => set({ style_prefs: { ...p.style_prefs, avoid: e.target.value } })} maxLength={300} />
            </div>
          </Section>

          <Section id="sizes" title="Sizes" line="Try-on uses these to show whether a garment will fit, and how loose or tight it sits.">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <label className="label" htmlFor="top-size">Top size</label>
                <select id="top-size" className="input" value={bp.top_size ?? ""} onChange={(e) => pick({ body_profile: { ...bp, top_size: e.target.value || undefined } })}>
                  <option value="">Not set</option>
                  {["XS", "S", "M", "L", "XL", "XXL", "3XL"].map((s) => <option key={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="waist">Waist (inches)</label>
                <input id="waist" type="number" inputMode="numeric" min={22} max={50} className="input" placeholder="e.g. 32" value={bp.waist_in ?? ""} onChange={(e) => setSize({ waist_in: e.target.value ? Number(e.target.value) : null })} />
              </div>
              <div>
                <label className="label" htmlFor="shoe">Shoe (UK / India)</label>
                <input id="shoe" type="number" inputMode="decimal" min={2} max={15} step={0.5} className="input" placeholder="e.g. 9" value={bp.shoe_uk ?? ""} onChange={(e) => setSize({ shoe_uk: e.target.value ? Number(e.target.value) : null })} />
              </div>
              <div>
                <label className="label" htmlFor="height">Height (cm)</label>
                <input id="height" type="number" inputMode="numeric" min={100} max={230} className="input" value={bp.height_cm ?? ""} onChange={(e) => setSize({ height_cm: e.target.value ? Number(e.target.value) : null })} />
              </div>
            </div>
            {sizeError ? <p className="text-xs text-warn">{sizeError}. It saves once it&apos;s in range.</p> : null}
          </Section>

          <Section id="privacy" title="Privacy" line="Each choice saves as soon as you change it.">
            <label className="flex items-start gap-3 text-sm">
              <input type="checkbox" className="mt-1" checked={p.consents.ai_training} onChange={(e) => saveConsents({ ...p.consents, ai_training: e.target.checked })} />
              <span><strong>Help improve Warewise.</strong> Use my tag corrections and outfit feedback to train Warewise&apos;s own models. Off by default; you can switch it off any time.</span>
            </label>
            <label className="flex items-start gap-3 text-sm">
              <input type="checkbox" className="mt-1" checked={p.consents.analytics} onChange={(e) => saveConsents({ ...p.consents, analytics: e.target.checked })} />
              <span>Allow anonymous usage analytics.</span>
            </label>
            <label className="flex items-start gap-3 text-sm">
              <input type="checkbox" className="mt-1" checked={p.consents.avatar_ai} onChange={(e) => saveConsents({ ...p.consents, avatar_ai: e.target.checked })} />
              <span><strong>Realistic AI try-on.</strong> Allow sending my avatar photo and chosen garments to third-party AI services to create try-on images (Leffa and IDM-VTON on Hugging Face) and 3D avatars (TRELLIS on Hugging Face, fal.ai, Tripo or Meshy).</span>
            </label>
            <p className="text-xs text-muted">Read the <a className="underline" href="/privacy">privacy note</a> and <a className="underline" href="/terms">terms</a>. Stylist limit: {p.daily_stylist_cap} requests a day.</p>
          </Section>

          <Section id="account" title="Account" line="Take your data with you, or delete everything.">
            <div className="flex flex-wrap gap-3">
              <form action="/auth/signout" method="post"><button className="btn-ghost">Sign out</button></form>
              {/* A plain link: the browser downloads the JSON file the route returns. */}
              <a className="btn-ghost" href="/api/v1/me/export" download>Download my data</a>
              <button className="btn-danger" onClick={deleteAccount}>Delete account</button>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

const SECTIONS = [
  { id: "about", label: "About you" },
  { id: "style", label: "Style" },
  { id: "sizes", label: "Sizes" },
  { id: "privacy", label: "Privacy" },
  { id: "account", label: "Account" },
];

function Section({ id, title, line, children }: { id: string; title: string; line: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-28 space-y-4" aria-labelledby={`${id}-h`}>
      <div className="border-b border-line pb-3">
        <h2 id={`${id}-h`} className="text-xs font-semibold tracking-[0.14em] uppercase">{title}</h2>
        <p className="mt-1 text-sm text-muted">{line}</p>
      </div>
      {children}
    </section>
  );
}

/** "Saving…" / "Saved" next to the title, so there's no Save button to forget. */
function SaveStatus({ state }: { state: SaveState }) {
  const text = state === "saving" ? "Saving…" : state === "saved" ? "All changes saved" : state === "error" ? "Not saved" : "Changes save automatically";
  return (
    <p role="status" aria-live="polite" className={`text-xs ${state === "error" ? "text-danger" : "text-muted"}`}>
      {state === "saved" ? <span aria-hidden>✓ </span> : null}
      {text}
    </p>
  );
}
