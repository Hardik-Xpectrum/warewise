import "server-only";
import { z } from "zod";
import { adminClient } from "@/lib/supabase/admin";
import { must, type AuthedContext } from "@/modules/platform/http";
import { errorFields, log } from "@/modules/platform/log";
import { TOP_SIZES } from "@/modules/tryon/fit";
import { BUCKET } from "@/modules/wardrobe/service";
import { callService, serviceEnabled } from "@/modules/services/client";

export const CONSENT_POLICY_VERSION = "2026-09-26";

export const ProfilePatchSchema = z
  .object({
    display_name: z.string().trim().min(1).max(60),
    home_city: z.string().trim().max(80).nullable(),
    style_prefs: z
      .object({
        styles: z.array(z.string().trim().max(30)).max(10).optional(),
        favoriteColors: z.array(z.string().trim().max(20)).max(10).optional(),
        avoid: z.string().trim().max(300).optional(),
        gender_presentation: z.enum(["menswear", "womenswear", "both", "unspecified"]).optional(),
      })
      .strict(),
    body_profile: z
      .object({
        body_shape: z.enum(["rectangle", "triangle", "inverted_triangle", "hourglass", "oval", "unspecified"]).optional(),
        height_cm: z.number().int().min(100).max(230).nullable().optional(),
        fit_preference: z.enum(["slim", "regular", "relaxed"]).optional(),
        // Sizes: used by try-on to show how garments of a given size will fit.
        top_size: z.enum(TOP_SIZES).optional(),
        waist_in: z.number().int().min(22).max(50).nullable().optional(),
        shoe_uk: z.number().min(2).max(15).multipleOf(0.5).nullable().optional(),
        // Estimated body measurements (cm) saved from the 3D avatar.
        measurements: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
        notes: z.string().trim().max(300).optional(),
      })
      .strict(),
    // Finishing (or skipping) the welcome flow; stored as a timestamp.
    onboarded: z.literal(true),
  })
  .partial()
  .strict();

// avatar_ai: may avatar photos be sent to a third-party try-on model (separate from everything else).
export const ConsentsSchema = z.object({ ai_training: z.boolean(), analytics: z.boolean(), avatar_ai: z.boolean().optional() });

export async function getProfile(ctx: AuthedContext) {
  const profile = must(
    await ctx.supabase.from("profiles").select("display_name,home_city,style_prefs,body_profile,daily_stylist_cap,onboarded_at").eq("id", ctx.userId).single(),
    "Load profile",
  );
  const consents = must(
    await ctx.supabase.from("consents").select("kind,granted,decided_at").order("decided_at", { ascending: false }),
    "Load consents",
  ) as { kind: string; granted: boolean }[];
  const latest = (kind: string) => consents.find((c) => c.kind === kind)?.granted ?? false;
  return { ...profile, consents: { ai_training: latest("ai_training"), analytics: latest("analytics"), avatar_ai: latest("avatar_ai") } };
}

export async function updateProfile(ctx: AuthedContext, patch: z.infer<typeof ProfilePatchSchema>) {
  const { onboarded, ...fields } = patch;
  const row = onboarded ? { ...fields, onboarded_at: new Date().toISOString() } : fields;
  if (Object.keys(row).length) must(await ctx.supabase.from("profiles").update(row).eq("id", ctx.userId), "Update profile");
  return getProfile(ctx);
}

/** Consents are append-only; the latest row per kind wins. */
export async function setConsents(ctx: AuthedContext, input: z.infer<typeof ConsentsSchema>) {
  must(
    await ctx.supabase.from("consents").insert(
      Object.entries(input)
        .filter(([, granted]) => granted !== undefined)
        .map(([kind, granted]) => ({ user_id: ctx.userId, kind, granted, policy_version: CONSENT_POLICY_VERSION })),
    ),
    "Save consents",
  );
  return getProfile(ctx);
}

// Everything a user owns, for "Download my data" (DPDP Act 2023 right to access). Each query runs
// as the user, so row-level security guarantees it is only their rows. Embeddings are omitted.
const EXPORT_TABLES: Record<string, string> = {
  profiles: "id,display_name,home_city,style_prefs,body_profile,created_at",
  consents: "kind,granted,policy_version,decided_at",
  wardrobe_items:
    "id,status,lifecycle,category,subcategory,colors,pattern,seasons,fabric,formality,fit,brand,price_inr,notes,size_label,is_sample,image_path,clean_path,thumb_path,cutout_path,ai_tags,ai_confidence,user_verified,created_at",
  item_corrections: "*",
  outfits: "*",
  outfit_items: "*",
  wear_log: "*",
  wear_log_items: "*",
  conversations: "*",
  messages: "*",
  recommendations: "*",
  feedback: "*",
  avatar_photos: "id,path,width,height,pose,quality,is_primary,created_at",
  tryon_results: "*",
  daily_picks: "*",
  usage_counters: "*",
};

export async function exportAccount(ctx: AuthedContext) {
  const data: Record<string, unknown[]> = {};
  for (const [table, columns] of Object.entries(EXPORT_TABLES)) {
    const { data: rows, error } = await ctx.supabase.from(table).select(columns).limit(10000);
    data[table] = error ? [] : (rows ?? []);
  }
  // Links to every stored photo, valid for 7 days.
  const store = ctx.supabase.storage.from(BUCKET);
  const paths: string[] = [];
  const { data: folders } = await store.list(ctx.userId, { limit: 100 });
  for (const folder of folders ?? []) {
    for (let offset = 0; ; offset += 1000) {
      const { data: files } = await store.list(`${ctx.userId}/${folder.name}`, { limit: 1000, offset });
      paths.push(...(files ?? []).map((f) => `${ctx.userId}/${folder.name}/${f.name}`));
      if (!files || files.length < 1000) break;
    }
  }
  const { data: signed } = paths.length ? await store.createSignedUrls(paths, 7 * 24 * 3600) : { data: [] };
  return {
    exported_at: new Date().toISOString(),
    user_id: ctx.userId,
    note: "Your Warewise data. Photo links expire 7 days after export.",
    data,
    files: (signed ?? []).map((f) => ({ path: f.path, url: f.signedUrl })),
  };
}

/** Deletes every file and row for the user. Rows go through ON DELETE CASCADE from auth.users. */
type Bucket = ReturnType<ReturnType<typeof adminClient>["storage"]["from"]>;

/** Removes every file under `prefix`, recursing into folders (Storage lists one level at a time). */
async function removeFolder(store: Bucket, prefix: string, depth = 0): Promise<void> {
  if (depth > 6) return; // no real folder is this deep; guards against a runaway
  // Pages of 100; a few rounds at most for one folder (a page that removes nothing ends the loop).
  for (let round = 0; round < 50; round++) {
    const { data } = await store.list(prefix, { limit: 100 });
    if (!data?.length) return;
    // Folders come back without an id; files have one.
    for (const folder of data.filter((e) => !e.id)) await removeFolder(store, `${prefix}/${folder.name}`, depth + 1);
    const files = data.filter((e) => e.id).map((e) => `${prefix}/${e.name}`);
    if (!files.length) return;
    await store.remove(files);
  }
}

export async function deleteAccount(ctx: AuthedContext) {
  const admin = adminClient();
  const store = admin.storage.from(BUCKET);
  // The services keep their own records (and the avatar and try-on services their files): ask each
  // one that's switched on to delete everything for this user. A service that can't be reached must
  // not block deletion here; its leftovers are only job rows keyed by a user id that no longer exists.
  await Promise.all(
    ([["vision", `/v1/users/${ctx.userId}`], ["avatar", `/v1/avatars/${ctx.userId}`], ["tryon", `/v1/users/${ctx.userId}/renders`]] as const)
      .filter(([name]) => serviceEnabled(name))
      .map(([name, path]) =>
        callService(name, "DELETE", path).catch((err) => log("warn", "service delete failed", { requestId: ctx.requestId, service: name, ...errorFields(err) })),
      ),
  );
  // Every file under the user's prefix, at any depth: wardrobe photos, cut-outs, avatar photos,
  // try-on results, 3D models (<user>/avatar3d/<job>/body.glb is two folders down).
  await removeFolder(store, ctx.userId);
  const { error } = await admin.auth.admin.deleteUser(ctx.userId);
  if (error) throw new Error(`delete user: ${error.message}`);
  log("info", "account deleted", { requestId: ctx.requestId }); // no personal data in the record
}
