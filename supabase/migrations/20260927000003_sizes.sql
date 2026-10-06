-- Size label on wardrobe items (e.g. "M", "32", "UK 9"), used with the user's own sizes (stored in
-- profiles.body_profile) to show how loose or tight a garment will sit in the try-on preview.
alter table public.wardrobe_items add column size_label text check (char_length(size_label) <= 12);
