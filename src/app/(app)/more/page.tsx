import Link from "next/link";

export const metadata = { title: "More · Warewise" };

const ITEMS = [
  { href: "/outfits", label: "Outfits", hint: "Saved looks and what you wore" },
  { href: "/plan", label: "Plan", hint: "Plan your week and pack for a trip" },
  { href: "/insights", label: "Insights", hint: "What you wear, cost per wear, forgotten pieces" },
  { href: "/shop", label: "Shop", hint: "What's missing, and Shop Scan before you buy" },
  { href: "/profile", label: "Profile", hint: "Sizes, city, privacy and your account" },
];

/** The phone tab bar has five slots; everything else is one tap away here. */
export default function MorePage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">More</h1>
      <ul className="card divide-y divide-line">
        {ITEMS.map((i) => (
          <li key={i.href}>
            <Link href={i.href} className="flex items-center justify-between gap-3 p-4 transition hover:bg-surface-2">
              <span>
                <span className="block font-medium">{i.label}</span>
                <span className="block text-sm text-muted">{i.hint}</span>
              </span>
              <span aria-hidden className="text-muted">›</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="hidden text-xs text-muted md:block">Tip: on a keyboard, press ⌘K (Ctrl K) to jump anywhere.</p>
    </div>
  );
}
