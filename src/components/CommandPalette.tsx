"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

type Command = { id: string; label: string; hint?: string; keys?: string; run: () => void };

/**
 * ⌘K / Ctrl K opens a jump-anywhere palette; single-key shortcuts work when you're not typing:
 * T today, W wardrobe, S stylist, O outfits, Y try-on, ? opens this list.
 */
export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);

  const commands: Command[] = useMemo(() => {
    const go = (href: string) => () => router.push(href);
    return [
      { id: "today", label: "Today's outfit", keys: "T", run: go("/today") },
      { id: "wardrobe", label: "Wardrobe", keys: "W", run: go("/wardrobe") },
      { id: "add", label: "Add clothes", hint: "Upload photos", run: go("/wardrobe#add") },
      { id: "stylist", label: "Ask the stylist", keys: "S", run: go("/stylist") },
      { id: "tryon", label: "Try on outfits", keys: "Y", run: go("/tryon") },
      { id: "outfits", label: "Saved outfits", keys: "O", run: go("/outfits") },
      { id: "plan", label: "Plan the week", hint: "and pack for a trip", keys: "P", run: go("/plan") },
      { id: "insights", label: "Insights", run: go("/insights") },
      { id: "shop", label: "What's missing", hint: "Shop and Shop Scan", run: go("/shop") },
      { id: "profile", label: "Profile and sizes", run: go("/profile") },
    ];
  }, [router]);

  const shown = commands.filter((c) => `${c.label} ${c.hint ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));

  useEffect(() => {
    const show = () => {
      setQ("");
      setActive(0);
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) setOpen(false);
        else show();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") {
        show();
        return;
      }
      const hit = commands.find((c) => c.keys?.toLowerCase() === e.key.toLowerCase());
      if (hit && !open) hit.run();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("warewise:palette", show); // the header's search icon
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("warewise:palette", show);
    };
  }, [commands, open]);

  if (!open) return null;
  const pick = (c: Command | undefined) => {
    if (!c) return;
    setOpen(false);
    c.run();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-start bg-black/40 px-4 pt-[15vh] backdrop-blur-sm" onMouseDown={() => setOpen(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Jump to"
        className="card animate-rise mx-auto w-full max-w-md overflow-hidden shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm outline-none"
          placeholder="Jump to…"
          aria-label="Jump to a page or action"
          role="combobox"
          aria-expanded="true"
          value={q}
          aria-controls="palette-list"
          aria-activedescendant={shown[active] ? `cmd-${shown[active].id}` : undefined}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(shown.length - 1, a + 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            }
            if (e.key === "Enter") pick(shown[active]);
          }}
        />
        <ul id="palette-list" role="listbox" aria-label="Pages and actions" className="max-h-[60vh] overflow-y-auto p-1">
          {shown.map((c, i) => (
            <li
              key={c.id}
              id={`cmd-${c.id}`}
              role="option"
              aria-selected={i === active}
              className={`flex cursor-pointer items-center justify-between rounded-none px-3 py-2 text-sm ${i === active ? "bg-surface-2" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(c)}
            >
              <span>
                {c.label}
                {c.hint ? <span className="ml-2 text-xs text-muted">{c.hint}</span> : null}
              </span>
              {c.keys ? <kbd className="rounded border border-line px-1.5 text-xs text-muted">{c.keys}</kbd> : null}
            </li>
          ))}
          {!shown.length ? <li className="px-3 py-6 text-center text-sm text-muted">No matches</li> : null}
        </ul>
      </div>
    </div>
  );
}
