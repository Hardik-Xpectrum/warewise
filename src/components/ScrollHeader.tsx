"use client";
import { useEffect, useState } from "react";

/** The sticky header; it tightens and gains a soft shadow once the page scrolls. */
export default function ScrollHeader({ children }: { children: React.ReactNode }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <header className="header-shell sticky top-0 z-20 border-b border-line bg-bg/95 backdrop-blur" data-scrolled={scrolled}>
      {children}
    </header>
  );
}
