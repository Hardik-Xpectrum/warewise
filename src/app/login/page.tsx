import Link from "next/link";
import Logo from "@/components/Logo";
import { redirect } from "next/navigation";
import { createUserClient } from "@/lib/supabase/server";
import { publicEnv } from "@/lib/env";
import LoginForm from "./LoginForm";

/** Asks Supabase Auth which sign-in providers are switched on, so we never show a dead button. */
async function googleEnabled(): Promise<boolean> {
  try {
    const res = await fetch(`${publicEnv.supabaseUrl()}/auth/v1/settings`, {
      headers: { apikey: publicEnv.supabaseKey() },
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(3000),
    });
    const settings = (await res.json()) as { external?: { google?: boolean } };
    return settings.external?.google === true;
  } catch {
    return true; // if in doubt, show it; Supabase will explain any problem
  }
}

export default async function LoginPage(props: PageProps<"/login">) {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getClaims();
  const { next, error } = await props.searchParams;
  if (data?.claims?.sub) redirect(typeof next === "string" && next.startsWith("/") ? next : "/today");

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-12">
      <Link href="/"><Logo /></Link>
      <h1 className="mt-10 text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-2 text-sm text-muted">Decide what to wear from the clothes you already own.</p>
      {error ? <p className="mt-6 text-sm text-danger">Sign-in didn&apos;t complete. Links work once, expire after an hour, and must be opened in the same browser you requested them from. Please request a new one.</p> : null}
      <LoginForm
        next={typeof next === "string" ? next : "/today"}
        emailEnabled={publicEnv.emailLoginEnabled()}
        devMailboxUrl={publicEnv.devMailboxUrl()}
        googleEnabled={await googleEnabled()}
      />
      <p className="mt-10 text-xs text-muted">
        By continuing you agree to the <a className="underline" href="/terms">terms</a> and to how we handle your photos, described in the <a className="underline" href="/privacy">privacy notice</a>.
      </p>
    </main>
  );
}
