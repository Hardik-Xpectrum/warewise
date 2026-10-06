"use client";
import Link from "next/link";
import { HeartIcon, SearchIcon, UserIcon } from "./Icons";

/** Search (opens the ⌘K palette), favourites and profile, as line icons like a retail header. */
export default function HeaderActions() {
  const btn = "grid h-9 w-9 place-items-center text-text transition hover:opacity-60";
  return (
    <div className="flex items-center gap-1">
      <button type="button" className={btn} aria-label="Search and jump (⌘K)" title="Search (⌘K)" onClick={() => window.dispatchEvent(new Event("warewise:palette"))}>
        <SearchIcon />
      </button>
      <Link href="/outfits?favorites=1" className={btn} aria-label="Favourite outfits" title="Favourites">
        <HeartIcon />
      </Link>
      <Link href="/profile" className={btn} aria-label="Profile" title="Profile">
        <UserIcon />
      </Link>
    </div>
  );
}
