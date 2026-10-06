// End-to-end smoke test against a running app and local Supabase.
//   npm run dev            (in one terminal)
//   npm run smoke          (in another)
// Creates two throwaway users, exercises every API route (wardrobe, stylist, samples, avatar, try-on),
// checks row-level security, then deletes both. Run with AI_CONFIG_FILE=config/ai.config.mock.json.
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

process.loadEnvFile(".env.local");
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const admin = createClient(url, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function makeUser() {
  const email = `smoke-${Date.now()}-${randomBytes(3).toString("hex")}@warewise.test`;
  const password = randomBytes(18).toString("base64url"); // never printed or stored
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const token = data.session.access_token;
  const call = async (path, init = {}) => {
    const res = await fetch(`${BASE}/api/v1${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.json ? { "content-type": "application/json" } : {}), ...init.headers },
      body: init.json ? JSON.stringify(init.json) : init.body,
    });
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* SSE or empty */ }
    return { status: res.status, body, text };
  };
  return { id: created.data.user.id, call };
}

/** Landmarks of a front-facing standing person, as the browser's pose detector would send them. */
function standingPose() {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }));
  const set = (i, x, y) => (lm[i] = { x, y, z: 0, visibility: 0.97 });
  set(0, 0.5, 0.08); set(11, 0.66, 0.2); set(12, 0.34, 0.2); set(23, 0.6, 0.5); set(24, 0.4, 0.5);
  set(25, 0.6, 0.7); set(26, 0.4, 0.7); set(27, 0.6, 0.92); set(28, 0.4, 0.92);
  return lm;
}

/** A simple transparent person silhouette (600x1200), standing in for a cut-out avatar photo. */
async function personImage() {
  const body = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1200"><g fill="#c8a58a"><circle cx="300" cy="100" r="70"/><rect x="190" y="200" width="220" height="420" rx="60"/><rect x="235" y="600" width="55" height="520" rx="25"/><rect x="310" y="600" width="55" height="520" rx="25"/><rect x="120" y="220" width="55" height="380" rx="25"/><rect x="425" y="220" width="55" height="380" rx="25"/></g></svg>`;
  return sharp(Buffer.from(body)).png().toBuffer();
}

async function photo(color) {
  return sharp({ create: { width: 900, height: 1200, channels: 3, background: color } })
    .composite([{ input: Buffer.from(`<svg width="900" height="1200"><rect x="200" y="250" width="500" height="700" rx="60" fill="white" opacity="0.35"/></svg>`) }])
    .jpeg()
    .toBuffer();
}

async function upload(user, color) {
  const target = await user.call("/uploads", { method: "POST", json: { contentType: "image/jpeg" } });
  check(`signed upload URL (${color})`, target.status === 201, JSON.stringify(target.body));
  const storage = createClient(url, anonKey, { auth: { persistSession: false } }).storage.from("wardrobe");
  const put = await storage.uploadToSignedUrl(target.body.path, target.body.token, await photo(color), { contentType: "image/jpeg" });
  check(`upload to storage (${color})`, !put.error, put.error?.message);
  const key = randomUUID();
  const created = await user.call("/items", { method: "POST", json: { imagePath: target.body.path }, headers: { "idempotency-key": key } });
  check(`create item (${color})`, created.status === 202, JSON.stringify(created.body));
  const replay = await user.call("/items", { method: "POST", json: { imagePath: target.body.path }, headers: { "idempotency-key": key } });
  check("idempotent replay returns same item", replay.body.id === created.body.id);
  return created.body.id;
}

async function waitReady(user, ids, seconds = 90) {
  for (let i = 0; i < seconds / 3; i++) {
    const { body } = await user.call("/items");
    const mine = body.items.filter((it) => ids.includes(it.id));
    if (mine.length === ids.length && mine.every((it) => it.status !== "processing")) return mine;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return (await user.call("/items")).body.items;
}

const a = await makeUser();
const b = await makeUser();
try {
  check("health", (await fetch(`${BASE}/api/health`)).ok);
  check("API rejects anonymous calls", (await fetch(`${BASE}/api/v1/items`)).status === 401);
  check("job endpoint rejects a wrong secret", (await fetch(`${BASE}/api/internal/jobs/run`, { method: "POST", headers: { "x-job-secret": "nope" } })).status === 401);

  const ids = [await upload(a, "#1f3b73"), await upload(a, "#c9b79c"), await upload(a, "#6b4226")];
  const items = await waitReady(a, ids);
  check("all items tagged", items.filter((i) => ids.includes(i.id)).every((i) => i.status === "ready"), JSON.stringify(items.map((i) => [i.status, i.status_reason])));
  check("signed image URLs returned", items.every((i) => i.thumbUrl?.includes("/storage/v1/object/sign/")));

  const [topId, bottomId, shoeId] = ids;
  const p1 = await a.call(`/items/${bottomId}`, { method: "PATCH", json: { category: "bottom", subcategory: "chinos", colors: ["beige"], formality: 3 } });
  const p2 = await a.call(`/items/${shoeId}`, { method: "PATCH", json: { category: "shoes", subcategory: "loafers", colors: ["brown"], formality: 3 } });
  const p3 = await a.call(`/items/${topId}`, { method: "PATCH", json: { colors: ["navy"], formality: 3, price_inr: 1200 } });
  check("corrections saved", [p1, p2, p3].every((r) => r.status === 200 && r.body.user_verified), JSON.stringify(p1.body));
  const corrections = await admin.from("item_corrections").select("field").in("item_id", ids);
  check("corrections recorded for the dataset", (corrections.data?.length ?? 0) >= 3);
  check("filter by category", (await a.call("/items?category=bottom")).body.items.length === 1);
  check("similar endpoint", (await a.call(`/items/${topId}/similar`)).status === 200);

  check("RLS: other user cannot read the item", (await b.call(`/items/${topId}`)).status === 404);
  check("RLS: other user sees an empty wardrobe", (await b.call("/items")).body.items.length === 0);
  check("RLS: other user cannot delete the item", (await b.call(`/items/${topId}`, { method: "DELETE" })).status === 404);

  await a.call("/me", { method: "PATCH", json: { home_city: "Pune", style_prefs: { styles: ["classic"] } } });
  const convo = await a.call("/stylist/conversations", { method: "POST" });
  const sse = await a.call(`/stylist/conversations/${convo.body.id}/messages`, { method: "POST", json: { text: "Client meeting, want to look sharp", occasion: "office" } });
  const outfits = [...sse.text.matchAll(/event: outfit\ndata: (.*)/g)].map((m) => JSON.parse(m[1]));
  check("stylist streams an outfit", outfits.length >= 1, sse.text.slice(0, 400));
  check("stylist streams an instant rule-built preview first", sse.text.indexOf("event: preview") !== -1 && sse.text.indexOf("event: preview") < sse.text.indexOf("event: outfit"), sse.text.slice(0, 400));
  check("stylist ends with done", /event: done/.test(sse.text), sse.text.slice(-300));
  const outfit = outfits[0];
  if (outfit) {
    check("outfit uses only the user's items", outfit.items.every((i) => ids.includes(i.id)));
    check("feedback: save", (await a.call(`/recommendations/${outfit.recommendationId}/feedback`, { method: "POST", json: { kind: "saved" } })).status === 200);
    const liked = await a.call(`/recommendations/${outfit.recommendationId}/feedback`, { method: "POST", json: { kind: "like" } });
    check("feedback: like saves the outfit as a favourite", liked.status === 200 && liked.body.favorite === true && (await a.call("/outfits?favorite=true")).body.outfits.some((o) => o.id === outfit.outfitId), JSON.stringify(liked.body));
    check("RLS: other user cannot give feedback", (await b.call(`/recommendations/${outfit.recommendationId}/feedback`, { method: "POST", json: { kind: "like" } })).status === 404);
    const saved = await a.call("/outfits");
    check("saved outfit listed", saved.body.outfits?.length === 1);
    check("wear log", (await a.call("/wear-log", { method: "POST", json: { outfitId: outfit.outfitId } })).status === 201);
  }
  const insights = await a.call("/insights/summary");
  check("insights count the wear", insights.body.totalWears >= 2 && insights.body.totalItems === 3, JSON.stringify(insights.body).slice(0, 200));
  const gaps = await a.call("/shopping/gaps");
  check("shopping gaps", gaps.status === 200 && Array.isArray(gaps.body.gaps));
  const manual = await a.call("/outfits", { method: "POST", json: { name: "Manual", itemIds: [topId, bottomId] } });
  check("manual outfit", manual.status === 201);
  check("RLS: other user cannot use my items in an outfit", (await b.call("/outfits", { method: "POST", json: { name: "x", itemIds: [topId] } })).status === 400);
  check("consents", (await a.call("/me/consents", { method: "PUT", json: { ai_training: true, analytics: false } })).body.consents?.ai_training === true);
  check("bad input gets a problem response", (await a.call("/items/not-a-uuid", { method: "PATCH", json: { formality: 9 } })).status === 400);

  // --- Sample wardrobe -------------------------------------------------------
  const before = (await a.call("/items?limit=100")).body.items.length;
  const samples = await a.call("/samples", { method: "POST" });
  check("load sample wardrobe", samples.status === 201 && samples.body.items === 12, JSON.stringify(samples.body));
  const withSamples = (await a.call("/items?limit=100")).body.items;
  check("sample items listed with cut-outs", withSamples.length === before + 12 && withSamples.filter((i) => i.is_sample).every((i) => i.cutoutUrl));
  check("samples cannot be loaded twice", (await a.call("/samples", { method: "POST" })).status === 409);
  const sampleOutfits = (await a.call("/outfits")).body.outfits;
  const office = sampleOutfits.find((o) => o.name === "Office ready");
  check("sample outfits saved", Boolean(office) && office.items.length === 4);

  // --- Avatar ----------------------------------------------------------------
  const pose = standingPose();
  const addAvatar = async (user, landmarks = pose) => {
    const t = await user.call("/uploads", { method: "POST", json: { contentType: "image/png", purpose: "avatar" } });
    const storage = createClient(url, anonKey, { auth: { persistSession: false } }).storage.from("wardrobe");
    await storage.uploadToSignedUrl(t.body.path, t.body.token, await personImage(), { contentType: "image/png" });
    return user.call("/avatar/photos", { method: "POST", json: { imagePath: t.body.path, pose: { landmarks } } });
  };
  check("avatar upload path is separate", (await a.call("/uploads", { method: "POST", json: { purpose: "avatar" } })).body.path.includes("/raw-avatar/"));
  const hidden = standingPose();
  hidden[23].visibility = 0.05;
  check("avatar rejects a photo without visible hips", (await addAvatar(a, hidden)).status === 400);
  const avatarIds = [];
  for (let i = 0; i < 5; i++) avatarIds.push((await addAvatar(a)).body.id);
  check("five avatar photos accepted", avatarIds.every(Boolean), JSON.stringify(avatarIds));
  check("a sixth avatar photo is refused", (await addAvatar(a)).status === 409);
  const av = (await a.call("/avatar")).body;
  check("avatar lists photos with one main photo and a quality score", av.photos.length === 5 && av.photos.filter((p) => p.is_primary).length === 1 && av.photos[0].quality > 0.8);
  check("set main photo", (await a.call(`/avatar/photos/${avatarIds[2]}`, { method: "PATCH", json: { is_primary: true } })).status === 204);
  check("delete avatar photo", (await a.call(`/avatar/photos/${avatarIds[4]}`, { method: "DELETE" })).status === 204);
  check("RLS: other user sees no avatar photos", (await b.call("/avatar")).body.photos.length === 0);
  check("RLS: other user cannot delete my avatar photo", (await b.call(`/avatar/photos/${avatarIds[0]}`, { method: "DELETE" })).status === 404);

  // --- Try-on ----------------------------------------------------------------
  check("AI try-on needs consent first", (await a.call("/tryon", { method: "POST", json: { outfitId: office.id } })).status === 403);
  await a.call("/me/consents", { method: "PUT", json: { ai_training: true, analytics: false, avatar_ai: true } });
  const queued = await a.call("/tryon", { method: "POST", json: { avatarPhotoId: avatarIds[2], outfitId: office.id } });
  check("AI try-on queued", queued.status === 202, JSON.stringify(queued.body));
  let result;
  for (let i = 0; i < 30; i++) {
    result = (await a.call("/tryon")).body.results.find((r) => r.id === queued.body.id);
    if (result?.status !== "pending") break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  check("try-on result ready with an image", result?.status === "ready" && Boolean(result.imageUrl), JSON.stringify(result));

  // AI 3D avatar (mock provider in the mock config): queue, wait, download a real GLB.
  const model = await a.call("/avatar/models", { method: "POST", json: { source: "tryon", sourceId: queued.body.id } });
  check("3D model queued from a try-on", model.status === 202, JSON.stringify(model.body));
  let m3d;
  for (let i = 0; i < 30; i++) {
    m3d = (await a.call("/avatar/models")).body.models?.find((x) => x.id === model.body.id);
    if (m3d?.status !== "pending") break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  check("3D model ready with a download URL", m3d?.status === "ready" && Boolean(m3d.url), JSON.stringify(m3d));
  if (m3d?.url) {
    const glb = Buffer.from(await (await fetch(m3d.url)).arrayBuffer());
    check("3D model is a GLB file", glb.toString("ascii", 0, 4) === "glTF");
  }
  check("RLS: other user cannot see my 3D models", (await b.call("/avatar/models")).body.models.length === 0);
  check("3D model from someone else's photo is refused", (await b.call("/avatar/models", { method: "POST", json: { source: "avatar", sourceId: avatarIds[0] } })).status === 403 || (await b.call("/avatar/models", { method: "POST", json: { source: "avatar", sourceId: avatarIds[0] } })).status === 404);
  check("delete 3D model", (await a.call(`/avatar/models/${model.body.id}`, { method: "DELETE" })).status === 204);
  check("RLS: other user cannot see my try-ons", (await b.call("/tryon")).body.results.length === 0);
  const shoesId = withSamples.find((i) => i.category === "shoes")?.id;
  check("try-on of shoes alone is refused", (await a.call("/tryon", { method: "POST", json: { itemIds: [shoesId] } })).status === 400);

  // Today, Complete the look and Shop Scan (rules only, no AI quota).
  const today = await a.call("/today");
  check("today picks an outfit with a harmony score", today.status === 200 && today.body.outfit?.items.length >= 2 && typeof today.body.outfit.harmony?.score === "number", JSON.stringify(today.body).slice(0, 200));
  check("today is stable for the day", (await a.call("/today")).body.outfit?.outfitId === today.body.outfit?.outfitId);
  const shuffled = await a.call("/today", { method: "POST", json: {} });
  check("today shuffle", shuffled.status === 200 && shuffled.body.shuffles === 1);
  check("today reports setup progress", typeof today.body.setup?.items === "number" && today.body.setup.avatar === true);
  check("RLS: other user's today is their own", (await b.call("/today")).body.outfit === null);
  const look = await a.call(`/items/${topId}/complete-look`, { method: "POST", json: { occasion: "casual" } });
  check("complete the look keeps the chosen item", look.status === 200 && look.body.outfits.length > 0 && look.body.outfits.every((o) => o.items.some((i) => i.id === topId)), JSON.stringify(look.body).slice(0, 200));
  check("RLS: other user cannot style my item", (await b.call(`/items/${topId}/complete-look`, { method: "POST", json: {} })).status === 404);
  const scan = await a.call("/shopping/scan", { method: "POST", json: { category: "bottom", colors: ["beige"] } });
  check("shop scan gives a verdict", scan.status === 200 && ["GET IT", "MAYBE", "SKIP IT"].includes(scan.body.verdict), JSON.stringify(scan.body).slice(0, 200));
  // Plan the week and pack for a trip.
  const planned = await a.call("/plan/auto", { method: "POST" });
  check("auto-plan fills the week", planned.status === 200 && planned.body.days.length === 7 && planned.body.days.every((d) => d.outfit), JSON.stringify(planned.body).slice(0, 200));
  check("today follows the plan", (await a.call("/today")).body.outfit?.outfitId === planned.body.days[0].outfit?.outfitId);
  check("clear a planned day", (await a.call(`/plan/${planned.body.days[1].day}`, { method: "DELETE" })).status === 204 && !(await a.call("/plan")).body.days[1].outfit);
  check("RLS: other user's week is empty", (await b.call("/plan")).body.days.every((d) => !d.outfit));
  const trip = await a.call("/pack", { method: "POST", json: { occasions: ["casual", "casual", "office"] } });
  check("trip packing gives a capsule", trip.status === 200 && trip.body.items.length > 0 && trip.body.days.length === 3, JSON.stringify(trip.body).slice(0, 200));
  check("scan-link refuses non-shop links", (await a.call("/shopping/scan-link", { method: "POST", json: { url: "https://169.254.169.254/latest" } })).status === 400);
  check("shop scan validates input", (await a.call("/shopping/scan", { method: "POST", json: { category: "hat", colors: [] } })).status === 400);

  const removed = await a.call("/samples", { method: "DELETE" });
  check("remove sample wardrobe", removed.status === 200 && (await a.call("/items?limit=100")).body.items.length === before, JSON.stringify(removed.body));
} finally {
  const del = await a.call("/me", { method: "DELETE" });
  check("account deletion", del.status === 204, JSON.stringify(del.body));
  await b.call("/me", { method: "DELETE" });
  const left = await admin.storage.from("wardrobe").list(a.id);
  check("deleted user's files are gone", (left.data ?? []).length === 0);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll smoke checks passed");
process.exit(failures ? 1 : 0);
