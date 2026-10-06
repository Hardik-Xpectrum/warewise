import Link from "next/link";
import { redirect } from "next/navigation";
import { createUserClient } from "@/lib/supabase/server";
import HeroAssemble from "@/components/HeroAssemble";
import Logo from "@/components/Logo";

const STEPS = [
  { n: "01", title: "Photograph your clothes", body: "Snap each piece once. Warewise removes the background and tags colour, fabric, season and formality." },
  { n: "02", title: "Swipe through looks", body: "Tell the stylist where you're going. Swipe right on looks you love; they're saved and it learns your taste." },
  { n: "03", title: "Try it on", body: "See the outfit on your own photo or a 3D avatar before you get dressed, or before you buy." },
];

export default async function Home() {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getClaims();
  if (data?.claims?.sub) redirect("/today");

  return (
    <div className="min-h-screen">
      <div className="bg-text px-4 py-2 text-center text-[11px] font-semibold tracking-[0.12em] text-bg uppercase">
        <span className="sm:hidden">Free and private · made for India</span>
        <span className="hidden sm:inline">Free and private · made for Indian wardrobes and occasions</span>
      </div>
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <Logo />
          <nav className="flex items-center gap-3">
            <Link href="/login" className="text-xs font-semibold tracking-[0.1em] uppercase hover:underline">Sign in</Link>
            <Link href="/login" className="btn-primary hidden sm:inline-flex">Get started</Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-12 sm:px-6 md:grid-cols-2 md:py-20">
          <div className="space-y-6">
            <p className="eyebrow">Your personal AI stylist</p>
            <h1 className="text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">Wear more of what you already own.</h1>
            <p className="max-w-md text-base text-muted">
              Photograph your clothes once. Every morning Warewise picks an outfit for your day, the occasion and the weather, and shows it on you.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/login" className="btn-primary px-8 py-3.5">Get started</Link>
              <a href="#how" className="btn-ghost px-8 py-3.5">How it works</a>
            </div>
          </div>
          <HeroAssemble />
        </section>

        <section id="how" className="border-t border-line bg-surface-2">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <p className="eyebrow">How it works</p>
            <ol className="mt-6 grid gap-8 md:grid-cols-3">
              {STEPS.map((s) => (
                <li key={s.n} className="space-y-2 border-t border-text pt-4">
                  <p className="text-xs font-semibold tabular-nums">{s.n}</p>
                  <h2 className="text-sm font-semibold tracking-[0.08em] uppercase">{s.title}</h2>
                  <p className="text-sm text-muted">{s.body}</p>
                </li>
              ))}
            </ol>
            <Link href="/login" className="btn-primary mt-10 px-8 py-3.5">Create your wardrobe</Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs text-muted sm:px-6">
          <span className="text-text"><Logo size="sm" /></span>
          <nav className="flex gap-5 tracking-[0.08em] uppercase">
            <Link href="/privacy" className="hover:text-text">Privacy</Link>
            <Link href="/terms" className="hover:text-text">Terms</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
