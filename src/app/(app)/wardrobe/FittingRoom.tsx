"use client";
import Link from "next/link";
import { useMemo } from "react";
import { CloseIcon } from "@/components/Icons";
import ItemThumb from "@/components/ItemThumb";
import TryOnCanvas, { type CanvasAvatar, type CanvasGarment } from "@/components/TryOnCanvas";
import type { Item } from "@/components/types";
import { useApi } from "@/lib/query";
import { fitFor, type UserSizes } from "@/modules/tryon/fit";
import { SAMPLE_MODEL } from "@/modules/tryon/sampleModel";
import { slotFor, wear, type Slot, type Wearing } from "@/modules/tryon/wear";
import type { AvatarPhoto } from "../tryon/types";

export type RoomSlot = Slot;
export type Room = Wearing;
export const ROOM_SLOTS: RoomSlot[] = ["top", "outer", "bottom", "one_piece", "shoes"];

/** Puts an item on (or takes it off), with the same rules as Try-on: a new top replaces the old. */
export function toggleInRoom(room: Room, item: Item): Room {
  return wear(room, item);
}

/**
 * The fitting room: your avatar wearing whatever you've tapped "Try on" for, updated instantly as
 * you browse, with the pieces you tried recently underneath. Rendered on this device.
 */
export default function FittingRoom({
  room,
  items,
  history,
  onToggle,
  onClear,
  onClose,
}: {
  room: Room;
  items: Item[];
  history: string[];
  onToggle: (item: Item) => void;
  onClear: () => void;
  onClose?: () => void;
}) {
  const avatarQ = useApi<{ max: number; photos: AvatarPhoto[] }>("/avatar");
  const meQ = useApi<{ body_profile: UserSizes | null }>("/me");
  const photo = avatarQ.data?.photos.find((p) => p.is_primary) ?? avatarQ.data?.photos[0];

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const wearing = ROOM_SLOTS.map((s) => room[s]).filter((id): id is string => Boolean(id)).map((id) => byId.get(id)).filter((i): i is Item => Boolean(i));
  const sizes = meQ.data?.body_profile ?? null;
  // Recomputed only when the room, the items or your sizes change, so the canvas doesn't redraw needlessly.
  const garments: CanvasGarment[] = useMemo(
    () =>
      ROOM_SLOTS.map((slot) => (room[slot] ? byId.get(room[slot]!) : undefined))
        .filter((i): i is Item => Boolean(i))
        .map((i) => ({
          id: i.id,
          slot: slotFor(i) ?? i.category!,
          subcategory: i.subcategory,
          url: i.cutoutUrl ?? i.imageUrl,
          isCutout: Boolean(i.cutoutUrl),
          fit: fitFor(i.category!, i.size_label, sizes).scale,
        })),
    [room, byId, sizes],
  );
  const avatar: CanvasAvatar | null = useMemo(
    () => (photo ? { id: photo.id, imageUrl: photo.imageUrl, width: photo.width, height: photo.height, pose: photo.pose } : null),
    [photo],
  );
  const recent = history.map((id) => byId.get(id)).filter((i): i is Item => Boolean(i)).slice(0, 8);

  return (
    <section className="space-y-3" aria-label="Fitting room">
      <div className="flex items-center justify-between">
        <h2 className="eyebrow text-text">Fitting room</h2>
        <div className="flex items-center gap-3 text-xs">
          {wearing.length ? (
            <button className="font-semibold tracking-[0.08em] text-muted uppercase hover:text-text" onClick={onClear}>
              Clear
            </button>
          ) : null}
          {onClose ? (
            <button className="grid h-8 w-8 place-items-center" onClick={onClose} aria-label="Close fitting room">
              <CloseIcon className="h-5 w-5" />
            </button>
          ) : null}
        </div>
      </div>

      {!avatarQ.data ? (
        <div className="skeleton aspect-[3/4]" />
      ) : (
        <div className="space-y-2">
          <TryOnCanvas avatar={avatar ?? SAMPLE_MODEL} garments={garments} />
          {!avatar ? (
            <p className="text-xs text-muted">
              Sample model. <Link className="underline underline-offset-2 hover:text-text" href="/tryon">Add your photo</Link> to see clothes on you.
            </p>
          ) : null}
        </div>
      )}

      {wearing.length ? (
        <ul className="flex flex-wrap gap-2" aria-label="Wearing">
          {wearing.map((i) => (
            <li key={i.id}>
              <button className="flex items-center gap-1.5 border border-line py-1 pl-1 pr-2 text-xs capitalize hover:border-text" onClick={() => onToggle(i)} aria-label={`Take off ${i.subcategory ?? i.category}`}>
                <ItemThumb url={i.thumbUrl} alt="" className="h-7 w-7" />
                {i.subcategory ?? i.category}
                <CloseIcon className="h-3.5 w-3.5 text-muted" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">Tap the shirt icon on any piece to try it on.</p>
      )}

      {recent.length ? (
        <div>
          <p className="label">Recently tried</p>
          <ul className="flex gap-1.5 overflow-x-auto pb-1">
            {recent.map((i) => (
              <li key={i.id}>
                <button className={`block h-14 w-14 border ${Object.values(room).includes(i.id) ? "border-text" : "border-transparent"}`} onClick={() => onToggle(i)} aria-label={`Try on ${i.subcategory ?? i.category} again`}>
                  <ItemThumb url={i.thumbUrl} alt="" className="h-full w-full" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {wearing.length ? (
        <Link className="btn-ghost w-full" href={`/tryon?items=${wearing.map((i) => i.id).join(",")}`}>
          Open in Try-on (3D, realistic)
        </Link>
      ) : null}
    </section>
  );
}
