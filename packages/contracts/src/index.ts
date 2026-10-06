// The contract between the Warewise web app and its services (vision, avatar, try-on).
// Every request and event that crosses a service boundary is defined here, once, with zod, so
// both sides validate the same shapes. Optional fields are `.nullish()`: the Python services send
// null for an absent value. Services never read each other's tables: they talk
// through these messages. See docs/microservices.md for the rules.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Service identities and auth
// ---------------------------------------------------------------------------

export const SERVICES = ["web", "vision", "avatar", "tryon"] as const;
export type ServiceName = (typeof SERVICES)[number];

/**
 * Service-to-service token: `<iss>.<aud>.<exp>.<hex hmac>` signed with the shared
 * SERVICE_SECRET (HMAC-SHA256). Short-lived (default 5 min), bound to the sender and receiver,
 * sent as `Authorization: Service <token>`. The acting user, when there is one, travels in the
 * request body (userId), never as a login session: services trust the web app to have checked it.
 */
export function signServiceToken(iss: ServiceName, aud: ServiceName, secret: string, ttlSeconds = 300): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${iss}.${aud}.${exp}`;
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

export function verifyServiceToken(token: string | null | undefined, expectedAud: ServiceName, secret: string): { ok: true; iss: ServiceName } | { ok: false; reason: string } {
  if (!token) return { ok: false, reason: "missing token" };
  const parts = token.replace(/^Service\s+/i, "").split(".");
  if (parts.length !== 4) return { ok: false, reason: "malformed token" };
  const [iss, aud, exp, sig] = parts;
  if (!SERVICES.includes(iss as ServiceName)) return { ok: false, reason: "unknown issuer" };
  if (aud !== expectedAud) return { ok: false, reason: "wrong audience" };
  if (!/^\d+$/.test(exp) || Number(exp) < Math.floor(Date.now() / 1000)) return { ok: false, reason: "expired" };
  const want = createHmac("sha256", secret).update(`${iss}.${aud}.${exp}`).digest();
  const got = Buffer.from(sig, "hex");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "bad signature" };
  return { ok: true, iss: iss as ServiceName };
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();
/** A path inside the private Supabase Storage bucket "wardrobe", always "<userId>/...". */
export const StoragePath = z.string().min(3).max(300).regex(/^[0-9a-f-]{36}\/[\w./-]+$/, "must be <userId>/<path>");

export const Slot = z.enum(["top", "outer", "bottom", "one_piece", "shoes", "accessory"]);

/** RFC 7807 problem details, the error body of every service (same as the web API). */
export const Problem = z.object({ type: z.string(), title: z.string(), status: z.number().int(), detail: z.string().nullish() });
export type Problem = z.infer<typeof Problem>;

/** What every job-creating endpoint answers: 202 Accepted with the job id. */
export const JobAccepted = z.object({ jobId: uuid, status: z.enum(["queued", "running", "done", "failed"]), cached: z.boolean().default(false) });
export type JobAccepted = z.infer<typeof JobAccepted>;

// ---------------------------------------------------------------------------
// Vision service: tag a garment photo and cut it out
// POST /v1/items/process  (web → vision)      → 202 JobAccepted
// GET  /v1/jobs/:jobId                         → VisionJobStatus
// event item.processed (vision → web callback)
// ---------------------------------------------------------------------------

export const ProcessItemRequest = z.object({
  jobId: uuid, // the web app picks it (idempotency key): resending the same jobId never duplicates work
  userId: uuid,
  itemId: uuid,
  imagePath: StoragePath, // the uploaded original
});
export type ProcessItemRequest = z.infer<typeof ProcessItemRequest>;

export const ItemTags = z.object({
  category: Slot,
  subcategory: z.string().nullable(),
  colors: z.array(z.string()).max(3),
  pattern: z.string(),
  seasons: z.array(z.string()),
  fabric: z.string().nullable(),
  formality: z.number().int().min(1).max(5),
  fit: z.string(),
  brand: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  model: z.string(), // which tagger produced them, e.g. "gemini-2.5-flash-lite" or "local-vision"
});
export type ItemTags = z.infer<typeof ItemTags>;

export const ItemProcessed = z.object({
  type: z.literal("item.processed"),
  jobId: uuid,
  userId: uuid,
  itemId: uuid,
  ok: z.boolean(),
  tags: ItemTags.nullish(),
  paths: z.object({ clean: StoragePath, thumb: StoragePath, cutout: StoragePath.nullable() }).nullish(),
  phash: z.string().nullish(),
  // ok=false: userFacing errors are shown as-is ("This photo doesn't look like clothing").
  error: z.object({ message: z.string(), userFacing: z.boolean(), retryable: z.boolean() }).nullish(),
});
export type ItemProcessed = z.infer<typeof ItemProcessed>;

/** GET /v1/jobs/:jobId on the vision service. */
export const VisionJobStatus = z.object({
  jobId: uuid,
  itemId: uuid,
  status: z.enum(["queued", "running", "done", "failed"]),
  attempts: z.number().int(),
  tags: ItemTags.nullish(),
  paths: z.object({ clean: StoragePath, thumb: StoragePath, cutout: StoragePath.nullable() }).nullish(),
  error: z.string().nullish(),
});
export type VisionJobStatus = z.infer<typeof VisionJobStatus>;

// ---------------------------------------------------------------------------
// Avatar service: build and keep each user's 3D avatar, versioned
// POST /v1/avatars/build   (web → avatar)      → 202 JobAccepted
// GET  /v1/avatars/:userId                     → AvatarCurrent (404 if none)
// GET  /v1/avatars/:userId/versions            → AvatarVersion[]
// DELETE /v1/avatars/:userId                   → 204 (account deletion: removes all versions and files)
// event avatar.ready | avatar.failed (avatar → web callback)
// ---------------------------------------------------------------------------

export const ScanKind = z.enum(["photo", "body360", "face"]);

export const BuildAvatarRequest = z.object({
  jobId: uuid,
  userId: uuid,
  kind: ScanKind,
  // Cut-out person images (transparent PNG/WebP) chosen on the device. "photo": front only.
  // "body360": front + back + left + right (the app picks them from a turn video on the phone).
  // "face": a face mesh made on the device (GLB) plus its texture.
  views: z.object({ front: StoragePath, back: StoragePath.nullish(), left: StoragePath.nullish(), right: StoragePath.nullish() }).nullish(),
  faceMesh: StoragePath.nullish(),
  faceTexture: StoragePath.nullish(), // the face mesh's texture image, when it isn't packed into the GLB
  heightCm: z.number().min(100).max(230).nullable(),
  sizes: z.object({ topSize: z.string().nullish(), waistIn: z.number().nullish(), shoeUk: z.number().nullish() }).nullish(),
});
export type BuildAvatarRequest = z.infer<typeof BuildAvatarRequest>;

export const Measurements = z.record(z.string(), z.number()); // cm: heightCm, chestCm, waistCm, hipCm, shoulderCm, ...
/** Where each measurement came from, keyed like Measurements. */
export const MeasurementSources = z.record(z.string(), z.enum(["measured", "size", "average"]));

export const AvatarVersion = z.object({
  userId: uuid,
  version: z.number().int().positive(), // goes up by one with every successful build; renders are cached per version
  kind: ScanKind,
  meshPath: StoragePath.nullable(), // the body .glb
  faceMeshPath: StoragePath.nullable(),
  faceTexturePath: StoragePath.nullable().default(null), // also embedded in the face GLB when it has UVs
  measurements: Measurements,
  measurementSources: MeasurementSources.default({}),
  textured: z.boolean().default(false), // false: shape only (e.g. a 3D service's texturing step was down)
  engine: z.string(), // e.g. "hunyuan3d-2mv", "trellis-multi", "trellis"
  createdAt: z.string(),
});
export type AvatarVersion = z.infer<typeof AvatarVersion>;

export const AvatarCurrent = AvatarVersion.extend({
  meshUrl: z.string().url().nullable(), // short-lived signed URLs
  faceMeshUrl: z.string().url().nullable(),
  faceTextureUrl: z.string().url().nullable().default(null),
  building: z.boolean(), // a newer build is in progress
});
export type AvatarCurrent = z.infer<typeof AvatarCurrent>;

export const AvatarReady = z.object({ type: z.literal("avatar.ready"), jobId: uuid, userId: uuid, version: z.number().int().positive() });
export const AvatarFailed = z.object({ type: z.literal("avatar.failed"), jobId: uuid, userId: uuid, message: z.string(), retryable: z.boolean() });

// ---------------------------------------------------------------------------
// Try-on service: dress the user in an outfit, cached
// POST /v1/renders          (web → tryon)      → 202 JobAccepted (cached: true + status done on a cache hit)
// GET  /v1/renders/:jobId                      → RenderStatus
// DELETE /v1/users/:userId/renders             → 204 (account deletion)
// event tryon.ready | tryon.failed (tryon → web callback)
// ---------------------------------------------------------------------------

export const RenderGarment = z.object({
  itemId: uuid,
  slot: Slot,
  description: z.string().max(120), // "mustard cotton kurta"
  imagePath: StoragePath,
  cutoutPath: StoragePath.nullable(),
  updatedAt: z.string(), // part of the cache key: an edited item renders again
});

export const RenderRequest = z.object({
  jobId: uuid,
  userId: uuid,
  personImagePath: StoragePath, // the avatar photo the render is drawn on
  avatarVersion: z.number().int().positive().nullable(), // when set, the render is also wrapped onto that 3D avatar
  garments: z.array(RenderGarment).min(1).max(6),
  // The person photo's 33 body landmarks (normalised 0..1), for the offline composite engine.
  pose: z.array(z.object({ x: z.number(), y: z.number(), visibility: z.number().nullish() })).length(33).nullish(),
});
export type RenderRequest = z.infer<typeof RenderRequest>;

export const RenderStatus = z.object({
  jobId: uuid,
  status: z.enum(["queued", "running", "done", "failed"]),
  cacheKey: z.string(),
  renderPath: StoragePath.nullable(), // the 2D realistic render (WebP)
  textureForAvatar: z.object({ version: z.number().int(), texturePath: StoragePath, backTexturePath: StoragePath.nullable().default(null) }).nullable(), // 3D re-texture, when requested
  note: z.string().nullable(), // "AI dressed the top and bottom." / what was skipped
  error: z.string().nullable(),
});
export type RenderStatus = z.infer<typeof RenderStatus>;

export const TryonReady = z.object({ type: z.literal("tryon.ready"), jobId: uuid, userId: uuid, renderPath: StoragePath, note: z.string().nullable() });
export const TryonFailed = z.object({ type: z.literal("tryon.failed"), jobId: uuid, userId: uuid, message: z.string(), quota: z.boolean() });

// ---------------------------------------------------------------------------
// Events to the web app: POST {WEB_URL}/api/internal/events  (Authorization: Service <token>, aud "web")
// The web app answers 2xx when stored; services retry with backoff (1, 4, 16, 60 min) otherwise.
// Events are idempotent by (type, jobId).
// ---------------------------------------------------------------------------

export const ServiceEvent = z.discriminatedUnion("type", [ItemProcessed, AvatarReady, AvatarFailed, TryonReady, TryonFailed]);
export type ServiceEvent = z.infer<typeof ServiceEvent>;

/**
 * The cache key for a render: same person photo (or avatar version), same garments in the same
 * state and the same engine → same key → served from cache, no GPU time. The engine is part of
 * the key so an offline composite is never served once the AI models are back.
 */
export function renderCacheKey(req: Pick<RenderRequest, "personImagePath" | "avatarVersion" | "garments">, engine = "ai"): string {
  const garments = [...req.garments].sort((a, b) => a.itemId.localeCompare(b.itemId)).map((g) => `${g.itemId}@${g.updatedAt}`);
  const raw = [engine, req.personImagePath, req.avatarVersion ?? "-", ...garments].join("|");
  return createHmac("sha256", "warewise-render-cache").update(raw).digest("hex").slice(0, 32);
}
