"use client";
import { usePathname } from "next/navigation";

/** Each page softly rises in when you switch tabs (skipped for people who prefer less motion). */
export default function PageTransition({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <div key={path} className="animate-rise">
      {children}
    </div>
  );
}
