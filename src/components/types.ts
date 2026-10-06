// Shapes returned by /api/v1, as the browser sees them.

export type Item = {
  id: string;
  status: "processing" | "ready" | "failed";
  status_reason: string | null;
  lifecycle: "active" | "laundry" | "lent" | "archived";
  category: string | null;
  subcategory: string | null;
  colors: string[];
  pattern: string | null;
  seasons: string[];
  fabric: string | null;
  formality: number | null;
  fit: string | null;
  brand: string | null;
  price_inr: number | null;
  notes: string | null;
  duplicate_of: string | null;
  ai_confidence: number | null;
  user_verified: boolean;
  created_at: string;
  imageUrl: string | null;
  thumbUrl: string | null;
  cutoutUrl: string | null;
  is_sample: boolean;
  size_label: string | null;
};

export type OutfitCardData = {
  recommendationId?: string;
  outfitId: string;
  why?: string;
  source?: string;
  harmony?: { score: number; label: string; reasons: string[] };
  items: { id: string; slot: string; label?: string; thumbUrl: string | null }[];
};
