"use client";
import { useEffect } from "react";
import { CloseIcon } from "@/components/Icons";
import type { Item } from "@/components/types";
import { CATEGORIES, CATEGORY_LABELS, COLORS, COLOR_SWATCH, LIFECYCLES, SEASONS } from "@/modules/wardrobe/taxonomy";

export type Filters = { category: string; color: string; season: string; lifecycle: string; q: string };
export const EMPTY_FILTERS: Filters = { category: "", color: "", season: "", lifecycle: "", q: "" };

export const SORTS = {
  newest: "Newest first",
  oldest: "Oldest first",
  name: "Name A–Z",
  formal: "Most formal first",
  colour: "By colour",
} as const;
export type Sort = keyof typeof SORTS;

/** Sorts one page of items on this device (the list is at most 100 items). */
export function sortItems(items: Item[], sort: Sort): Item[] {
  const name = (i: Item) => (i.subcategory ?? i.category ?? "").toLowerCase();
  const colourRank = (i: Item) => {
    const k = COLORS.indexOf((i.colors[0] ?? "multi") as (typeof COLORS)[number]);
    return k < 0 ? COLORS.length : k;
  };
  const by: Record<Sort, (a: Item, b: Item) => number> = {
    newest: (a, b) => b.created_at.localeCompare(a.created_at),
    oldest: (a, b) => a.created_at.localeCompare(b.created_at),
    name: (a, b) => name(a).localeCompare(name(b)),
    formal: (a, b) => (b.formality ?? 0) - (a.formality ?? 0),
    colour: (a, b) => colourRank(a) - colourRank(b),
  };
  return [...items].sort(by[sort]);
}

/** Readable labels for the active filters, each removable on its own. */
export function activeFilters(f: Filters): { key: keyof Filters; label: string }[] {
  const out: { key: keyof Filters; label: string }[] = [];
  if (f.category) out.push({ key: "category", label: CATEGORY_LABELS[f.category as keyof typeof CATEGORY_LABELS] ?? f.category });
  if (f.color) out.push({ key: "color", label: f.color });
  if (f.season) out.push({ key: "season", label: f.season });
  if (f.lifecycle) out.push({ key: "lifecycle", label: f.lifecycle });
  return out;
}

/**
 * Filter & sort, H&M style: one sheet with every option as a tap target instead of a row of
 * dropdowns. A bottom sheet on phones, a panel from the right on larger screens. Changes apply
 * live; the footer button just closes it and says how many pieces match.
 */
export default function FilterSheet({
  filters,
  sort,
  count,
  onChange,
  onSort,
  onClose,
}: {
  filters: Filters;
  sort: Sort;
  count: number | null;
  onChange: (f: Filters) => void;
  onSort: (s: Sort) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  const pick = (key: keyof Filters, value: string) => onChange({ ...filters, [key]: filters[key] === value ? "" : value });
  const any = activeFilters(filters).length > 0 || sort !== "newest";

  return (
    <div className="fixed inset-x-0 top-0 z-50 h-dvh" role="dialog" aria-modal="true" aria-label="Filter and sort">
      <button className="absolute inset-0 bg-black/40" aria-label="Close filters" onClick={onClose} />
      <div className="sheet-panel absolute inset-x-0 bottom-0 flex max-h-[88vh] flex-col bg-bg sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[400px]">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-xs font-semibold tracking-[0.14em] uppercase">Filter &amp; sort</h2>
          <button className="grid h-9 w-9 place-items-center" onClick={onClose} aria-label="Close filters">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-7 overflow-y-auto px-5 py-5">
          <Group title="Sort by">
            {(Object.keys(SORTS) as Sort[]).map((s) => (
              <Option key={s} on={sort === s} onClick={() => onSort(s)} radio>
                {SORTS[s]}
              </Option>
            ))}
          </Group>
          <Group title="Category">
            {CATEGORIES.map((c) => (
              <Option key={c} on={filters.category === c} onClick={() => pick("category", c)}>
                {CATEGORY_LABELS[c]}
              </Option>
            ))}
          </Group>
          <div>
            <p className="label">Colour</p>
            <div className="grid grid-cols-6 gap-x-2 gap-y-3">
              {COLORS.map((c) => {
                const on = filters.color === c;
                return (
                  <button key={c} type="button" aria-pressed={on} onClick={() => pick("color", c)} className="flex flex-col items-center gap-1 text-[10px] capitalize">
                    <span
                      className="h-8 w-8 rounded-full border"
                      style={{ background: COLOR_SWATCH[c], borderColor: on ? "var(--text)" : "var(--line)", boxShadow: on ? "0 0 0 2px var(--bg), 0 0 0 3px var(--text)" : undefined }}
                    />
                    <span className={on ? "font-semibold" : "text-muted"}>{c.replace("-", " ")}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <Group title="Season">
            {SEASONS.filter((s) => s !== "all").map((s) => (
              <Option key={s} on={filters.season === s} onClick={() => pick("season", s)}>
                {s}
              </Option>
            ))}
          </Group>
          <Group title="Status">
            {LIFECYCLES.map((s) => (
              <Option key={s} on={filters.lifecycle === s} onClick={() => pick("lifecycle", s)}>
                {s === "active" ? "In my wardrobe" : s}
              </Option>
            ))}
          </Group>
        </div>

        <div className="flex gap-3 border-t border-line px-5 py-4">
          <button
            className="btn-ghost flex-1"
            disabled={!any}
            onClick={() => {
              onChange({ ...EMPTY_FILTERS, q: filters.q });
              onSort("newest");
            }}
          >
            Clear all
          </button>
          <button className="btn-primary flex-1" onClick={onClose}>
            {count === null ? "Show items" : `Show ${count} item${count === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="label">{title}</p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function Option({ on, onClick, radio, children }: { on: boolean; onClick: () => void; radio?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role={radio ? "radio" : undefined}
      aria-checked={radio ? on : undefined}
      aria-pressed={radio ? undefined : on}
      onClick={onClick}
      className="border px-3 py-2 text-xs capitalize transition"
      style={on ? { background: "var(--text)", color: "var(--bg)", borderColor: "var(--text)" } : { borderColor: "var(--line)" }}
    >
      {children}
    </button>
  );
}
