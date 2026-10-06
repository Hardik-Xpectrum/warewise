// Thin line icons (1.5px strokes, 24px grid) in one place, so every screen uses the same set.
type P = { className?: string; filled?: boolean };
const base = (className = "h-5 w-5") => ({
  className,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

export const SearchIcon = ({ className }: P) => (
  <svg {...base(className)}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>
);
export const UserIcon = ({ className }: P) => (
  <svg {...base(className)}><circle cx="12" cy="8" r="4" /><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" /></svg>
);
export const HeartIcon = ({ className, filled }: P) => (
  <svg {...base(className)} fill={filled ? "currentColor" : "none"}>
    <path d="M12 20s-7.5-4.6-7.5-10.1A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20Z" />
  </svg>
);
export const SunIcon = ({ className }: P) => (
  <svg {...base(className)}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" /></svg>
);
export const HangerIcon = ({ className }: P) => (
  <svg {...base(className)}><path d="M12 7.5a2 2 0 1 1 2-2M12 7.5v1.2L3.2 15.4A1.5 1.5 0 0 0 4.1 18h15.8a1.5 1.5 0 0 0 .9-2.6L12 8.7" /></svg>
);
export const SparkIcon = ({ className }: P) => (
  <svg {...base(className)}><path d="M12 3.5 13.8 9 19.5 11l-5.7 2L12 18.5 10.2 13 4.5 11l5.7-2L12 3.5Z" /><path d="M19 3v3M17.5 4.5h3" /></svg>
);
export const ShirtIcon = ({ className }: P) => (
  <svg {...base(className)}><path d="M8.5 3.5 4 6l2 4.5 2-1V20.5h8V9.5l2 1L20 6l-4.5-2.5a3.5 3.5 0 0 1-7 0Z" /></svg>
);
export const MenuIcon = ({ className }: P) => (
  <svg {...base(className)}><path d="M4 7h16M4 12h16M4 17h16" /></svg>
);
export const ArrowIcon = ({ className }: P) => (
  <svg {...base(className)}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
export const CloseIcon = ({ className }: P) => (
  <svg {...base(className)}><path d="M6 6l12 12M18 6 6 18" /></svg>
);
