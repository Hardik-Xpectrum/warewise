"use client";
import { useCallback, useState } from "react";
import { browserClient } from "@/lib/supabase/browser";
import Turnstile from "./Turnstile";

// Bot protection for the email link, on when a Turnstile site key is configured.
const TURNSTILE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || null;

export default function LoginForm({
  next,
  emailEnabled,
  googleEnabled,
  devMailboxUrl,
}: {
  next: string;
  emailEnabled: boolean;
  googleEnabled: boolean;
  devMailboxUrl: string | null;
}) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");
  const [captcha, setCaptcha] = useState<string | null>(null);
  const onToken = useCallback((t: string | null) => setCaptcha(t), []);
  const redirectTo = () => `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

  async function google() {
    const { error } = await browserClient().auth.signInWithOAuth({ provider: "google", options: { redirectTo: redirectTo() } });
    if (error) {
      setState("error");
      setMessage(error.message);
    }
  }

  async function magicLink(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    const { error } = await browserClient().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo(), captchaToken: captcha ?? undefined },
    });
    if (error) {
      setState("error");
      setMessage(error.message);
    } else setState("sent");
  }

  return (
    <div className="mt-8 space-y-6">
      <button className="btn-primary w-full py-3" onClick={google} disabled={!googleEnabled}>
        Continue with Google
      </button>
      {!googleEnabled ? (
        <p className="text-sm text-muted">
          Google sign-in isn&apos;t set up on this server yet{emailEnabled ? "; use the email link below for now" : ""}. See &ldquo;Google sign-in&rdquo; in the README.
        </p>
      ) : null}
      {emailEnabled ? (
        <form onSubmit={magicLink} className="space-y-2 border-t border-line pt-6">
          <label className="label" htmlFor="email">Or get a sign-in link by email</label>
          <input id="email" type="email" required className="input" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          {TURNSTILE_KEY ? <Turnstile siteKey={TURNSTILE_KEY} onToken={onToken} /> : null}
          <button className="btn-ghost w-full" disabled={state === "sending" || Boolean(TURNSTILE_KEY && !captcha)}>
            {state === "sending" ? "Sending…" : "Email me a link"}
          </button>
          {state === "sent" ? (
            devMailboxUrl ? (
              <p className="text-sm text-ok">
                Link sent. This is a local server, so the email goes to the{" "}
                <a className="underline" href={devMailboxUrl} target="_blank" rel="noopener noreferrer">local test mailbox</a>, not your real inbox. Open the link in this same browser.
              </p>
            ) : (
              <p className="text-sm text-ok">Check your inbox for the sign-in link, and open it in this same browser.</p>
            )
          ) : null}
        </form>
      ) : null}
      {state === "error" ? <p className="text-sm text-danger">{message}</p> : null}
    </div>
  );
}
