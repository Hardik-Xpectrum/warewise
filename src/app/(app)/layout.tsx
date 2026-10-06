import Link from "next/link";
import CommandPalette from "@/components/CommandPalette";
import HeaderActions from "@/components/HeaderActions";
import Logo from "@/components/Logo";
import NavLinks from "@/components/NavLinks";
import PageTransition from "@/components/PageTransition";
import ScrollHeader from "@/components/ScrollHeader";
import Toaster from "@/components/Toaster";
import { createUserClient } from "@/lib/supabase/server";

type Tip = { href: string; short: string; long: string };

// Rotating tips once the basics are done; one per day so it doesn't flicker between pages.
const DAILY_TIPS: Tip[] = [
  { href: "/stylist", short: "Swipe right to save a look", long: "Swipe right on looks you love · they're saved to favourites" },
  { href: "/shop", short: "Scan before you buy", long: "Thinking of buying something? Shop Scan says if it earns its place" },
  { href: "/today", short: "Log what you wear", long: "Tap “I wore this” and Warewise learns your taste" },
];

/** The most useful next step for this user: clothes first, then a photo, then daily tips. */
async function stripTip(supabase: Awaited<ReturnType<typeof createUserClient>>): Promise<Tip> {
  const [{ count: items }, { count: photos }] = await Promise.all([
    supabase.from("wardrobe_items").select("id", { count: "exact", head: true }).is("deleted_at", null),
    supabase.from("avatar_photos").select("id", { count: "exact", head: true }),
  ]);
  if ((items ?? 0) < 2) return { href: "/today", short: "Start with 5 clothes or a sample", long: "Add 5 clothes, or try Warewise with a sample wardrobe first" };
  if (!photos) return { href: "/tryon", short: "Add a photo to try outfits on", long: "Add a photo of yourself to see every outfit on you" };
  return DAILY_TIPS[new Date().getDate() % DAILY_TIPS.length];
}

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getClaims();
  const isAdmin = (data?.claims?.app_metadata as { role?: string } | undefined)?.role === "admin";
  const tip = await stripTip(supabase);

  return (
    <div className="min-h-screen pb-20 md:pb-0">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:bg-surface focus:px-3 focus:py-1.5">
        Skip to content
      </a>
      {/* Announcement strip: one tip that fits where this user is, and one link. */}
      <Link href={tip.href} className="group flex items-center justify-between bg-text px-4 py-2 text-[11px] font-semibold tracking-[0.12em] text-bg uppercase sm:px-6">
        <span className="sm:hidden">{tip.short}</span>
        <span className="hidden sm:inline">{tip.long}</span>
        <span aria-hidden className="transition-transform group-hover:translate-x-1">→</span>
      </Link>
      <ScrollHeader>
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-4 py-4 sm:px-6">
          <Link href="/today" className="shrink-0"><Logo /></Link>
          <nav className="hidden flex-1 justify-center md:flex" aria-label="Main">
            <NavLinks isAdmin={isAdmin} />
          </nav>
          <HeaderActions />
        </div>
      </ScrollHeader>
      <main id="main" className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <PageTransition>{children}</PageTransition>
      </main>
      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-bg md:hidden" aria-label="Main">
        <NavLinks isAdmin={false} compact />
      </nav>
      <Toaster />
      <CommandPalette />
    </div>
  );
}
