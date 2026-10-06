"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef, useState } from "react";
import { HangerIcon, MenuIcon, ShirtIcon, SparkIcon, SunIcon } from "./Icons";

export const LINKS = [
  { href: "/today", label: "Today" },
  { href: "/wardrobe", label: "Wardrobe" },
  { href: "/stylist", label: "Stylist" },
  { href: "/tryon", label: "Try-on" },
  { href: "/outfits", label: "Outfits" },
  { href: "/plan", label: "Plan" },
  { href: "/insights", label: "Insights" },
  { href: "/shop", label: "Shop" },
];

// Phones get five tabs with icons; the rest live under More.
const MOBILE = [
  { href: "/today", label: "Today", Icon: SunIcon },
  { href: "/wardrobe", label: "Wardrobe", Icon: HangerIcon },
  { href: "/stylist", label: "Stylist", Icon: SparkIcon },
  { href: "/tryon", label: "Try-on", Icon: ShirtIcon },
  { href: "/more", label: "More", Icon: MenuIcon },
];
const UNDER_MORE = ["/more", "/outfits", "/plan", "/insights", "/shop", "/profile", "/admin"];

export default function NavLinks({ isAdmin, compact = false }: { isAdmin: boolean; compact?: boolean }) {
  const path = usePathname();
  const on = (href: string) => path === href || path.startsWith(`${href}/`);

  if (compact) {
    return (
      <ul className="grid grid-cols-5">
        {MOBILE.map(({ href, label, Icon }) => {
          const active = on(href) || (href === "/more" && UNDER_MORE.some(on));
          return (
            <li key={href}>
              <Link href={href} aria-current={active ? "page" : undefined} className={`flex flex-col items-center gap-1 pb-2.5 pt-2 text-[10px] font-semibold tracking-[0.08em] uppercase ${active ? "text-text" : "text-muted"}`}>
                <Icon className="h-5 w-5" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    );
  }

  return <DesktopLinks links={isAdmin ? [...LINKS, { href: "/admin", label: "Admin" }] : LINKS} on={on} path={path} />;
}

/**
 * Desktop nav: one underline that slides to the current page (and follows the pointer on hover),
 * rather than each link fading its own underline in and out.
 */
function DesktopLinks({ links, on, path }: { links: typeof LINKS; on: (href: string) => boolean; path: string }) {
  const list = useRef<HTMLUListElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null);
  const target = hover ?? links.find((l) => on(l.href))?.href ?? null;

  useLayoutEffect(() => {
    const measure = () => {
      const el = target ? list.current?.querySelector<HTMLElement>(`[data-href="${target}"]`) : null;
      setBar(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [target, path]);

  return (
    <ul ref={list} className="relative flex gap-6 text-xs font-semibold tracking-[0.1em] uppercase" onMouseLeave={() => setHover(null)}>
      {links.map((l) => {
        const active = on(l.href);
        return (
          <li key={l.href}>
            <Link
              href={l.href}
              data-href={l.href}
              aria-current={active ? "page" : undefined}
              onMouseEnter={() => setHover(l.href)}
              onFocus={() => setHover(l.href)}
              onBlur={() => setHover(null)}
              className={`block py-1 transition-colors ${active ? "text-text" : "text-muted hover:text-text"}`}
            >
              {l.label}
            </Link>
          </li>
        );
      })}
      <li aria-hidden className="pointer-events-none absolute -bottom-1 h-0.5 bg-text" style={{ left: bar?.left ?? 0, width: bar?.width ?? 0, opacity: bar ? 1 : 0, transition: "left 280ms cubic-bezier(0.2,0.8,0.2,1), width 280ms cubic-bezier(0.2,0.8,0.2,1), opacity 150ms" }} />
    </ul>
  );
}
