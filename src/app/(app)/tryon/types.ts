import type { Landmark } from "@/modules/tryon/placement";

export type AvatarPhoto = {
  id: string;
  width: number;
  height: number;
  pose: { landmarks: Landmark[] };
  quality: number;
  is_primary: boolean;
  imageUrl: string | null;
};

export type TryOnResult = {
  id: string;
  status: "pending" | "ready" | "failed";
  engine: string;
  error: string | null;
  imageUrl: string | null;
  avatar_photo_id: string | null;
  item_ids: string[];
  created_at: string;
  finished_at: string | null;
};

export type SavedOutfit = { id: string; name: string | null; items: { id: string }[] };
