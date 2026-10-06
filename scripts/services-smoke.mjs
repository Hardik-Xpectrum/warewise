// End-to-end test of the web app handing work to the three services and hearing back.
//   1. Start the services (no GPU time used): see docs/microservices.md "Run everything locally"
//   2. npm run dev with VISION_URL, AVATAR_URL, TRYON_URL and SERVICE_SECRET set
//   3. node scripts/services-smoke.mjs [garment photo folder]
// One throwaway user: uploads two real garment photos (tagged and cut out by the vision service),
// renders an outfit (try-on service, offline composite engine), builds a 3D model (avatar service,
// mock engine), checks the events endpoint's security, then deletes the account and checks that
// every service forgot the user and every file is gone.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

process.loadEnvFile(".env.local");
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const admin = createClient(url, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const schema = (name) => createClient(url, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false }, db: { schema: name } });

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, seconds = 120, every = 2000) {
  for (let i = 0; i < (seconds * 1000) / every; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  return null;
}

// Two garment photos: from the folder given, else plain synthetic ones (which the tagger may
// reject as "not clothing": real photos make a better test).
function garmentPhotos() {
  const dir = process.argv[2];
  if (!dir) return null;
  const files = readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
  return files.slice(0, 2).map((f) => readFileSync(path.join(dir, f)));
}

const email = `svc-smoke-${Date.now()}-${randomBytes(3).toString("hex")}@warewise.test`;
const password = randomBytes(18).toString("base64url"); // never printed or stored
const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (created.error) throw created.error;
const userId = created.data.user.id;
const client = createClient(url, anonKey, { auth: { persistSession: false } });
const { data: session, error: signInError } = await client.auth.signInWithPassword({ email, password });
if (signInError) throw signInError;
const call = async (p, init = {}) => {
  const res = await fetch(`${BASE}/api/v1${p}`, {
    ...init,
    headers: { authorization: `Bearer ${session.session.access_token}`, ...(init.json ? { "content-type": "application/json" } : {}), ...init.headers },
    body: init.json ? JSON.stringify(init.json) : init.body,
  });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, body };
};
const storage = () => createClient(url, anonKey, { auth: { persistSession: false } }).storage.from("wardrobe");

try {
  // --- The events endpoint only takes signed events from the services -----------------------
  const ev = (headers, body) => fetch(`${BASE}/api/internal/events`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  check("events: no token is refused", (await ev({}, {})).status === 401);
  check("events: a forged token is refused", (await ev({ authorization: "Service vision.web.4102444800.00" }, {})).status === 401);

  // --- Vision: upload two garments, the service tags and cuts them out -----------------------
  const photos = garmentPhotos() ?? [
    await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#1f3b73" } }).jpeg().toBuffer(),
    await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#c9b79c" } }).jpeg().toBuffer(),
  ];
  const itemIds = [];
  for (const [i, bytes] of photos.entries()) {
    const t = await call("/uploads", { method: "POST", json: { contentType: "image/jpeg" } });
    await storage().uploadToSignedUrl(t.body.path, t.body.token, bytes, { contentType: "image/jpeg" });
    const item = await call("/items", { method: "POST", json: { imagePath: t.body.path }, headers: { "idempotency-key": `svc-${userId}-${i}` } });
    check(`item ${i + 1} created`, item.status === 202, JSON.stringify(item.body));
    itemIds.push(item.body.id);
  }
  const items = await until(async () => {
    const { body } = await call("/items?limit=100");
    const mine = body.items.filter((it) => itemIds.includes(it.id));
    return mine.length === itemIds.length && mine.every((it) => it.status !== "processing") ? mine : null;
  }, 300, 3000);
  check("vision service processed both photos", Boolean(items), "timed out (first run downloads the models: give it a few minutes)");
  const { data: rows } = await admin.from("wardrobe_items").select("id,status,status_reason,category,subcategory,colors,cutout_path,vision_job_id,ai_tags").in("id", itemIds);
  for (const r of rows ?? []) console.log(`  · ${r.status} ${r.category ?? ""}/${r.subcategory ?? ""} ${(r.colors ?? []).join("/")} cutout=${Boolean(r.cutout_path)} ${r.status_reason ?? ""}`);
  check("each item has its vision job id", (rows ?? []).every((r) => r.vision_job_id));
  check("tags came from the service", (rows ?? []).some((r) => r.status === "ready" && r.ai_tags?.model));
  const { data: received } = await admin.from("service_events").select("type").eq("user_id", userId).eq("type", "item.processed");
  check("item.processed events received", (received ?? []).length === itemIds.length, JSON.stringify(received));
  const ready = (rows ?? []).filter((r) => r.status === "ready");

  // --- Try-on: render the two pieces on an avatar photo (offline composite in the service) ---
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }));
  for (const [i, x, y] of [[0, 0.5, 0.08], [11, 0.66, 0.2], [12, 0.34, 0.2], [23, 0.6, 0.5], [24, 0.4, 0.5], [25, 0.6, 0.7], [26, 0.4, 0.7], [27, 0.6, 0.92], [28, 0.4, 0.92]]) lm[i] = { x, y, z: 0, visibility: 0.97 };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1200"><g fill="#c8a58a"><circle cx="300" cy="100" r="70"/><rect x="190" y="200" width="220" height="420" rx="60"/><rect x="235" y="600" width="55" height="520" rx="25"/><rect x="310" y="600" width="55" height="520" rx="25"/></g></svg>`;
  const ta = await call("/uploads", { method: "POST", json: { contentType: "image/png", purpose: "avatar" } });
  await storage().uploadToSignedUrl(ta.body.path, ta.body.token, await sharp(Buffer.from(svg)).png().toBuffer(), { contentType: "image/png" });
  const avatar = await call("/avatar/photos", { method: "POST", json: { imagePath: ta.body.path, pose: { landmarks: lm } } });
  check("avatar photo added", avatar.status === 201 || avatar.status === 200, JSON.stringify(avatar.body));
  await call("/me/consents", { method: "PUT", json: { ai_training: false, analytics: false, avatar_ai: true } });
  if (ready.length) {
    const queued = await call("/tryon", { method: "POST", json: { avatarPhotoId: avatar.body.id, itemIds: ready.map((r) => r.id) } });
    check("try-on queued", queued.status === 202, JSON.stringify(queued.body));
    const result = await until(async () => {
      const r = (await call("/tryon")).body.results.find((x) => x.id === queued.body.id);
      return r && r.status !== "pending" ? r : null;
    }, 180);
    check("try-on service rendered it", result?.status === "ready" && Boolean(result.imageUrl), JSON.stringify(result));
    const { data: tr } = await admin.from("tryon_results").select("engine,result_path").eq("id", queued.body.id).single();
    check("render stored by the service", tr?.engine === "service:tryon" && tr.result_path?.startsWith(`${userId}/tryon/`), JSON.stringify(tr));
  } else {
    check("try-on (skipped: no garment was tagged ready)", false);
  }

  // --- Avatar: a 3D model from the avatar photo (mock engine in the service) -----------------
  const model = await call("/avatar/models", { method: "POST", json: { source: "avatar", sourceId: avatar.body.id } });
  check("3D model queued", model.status === 202, JSON.stringify(model.body));
  const m3d = await until(async () => {
    const m = (await call("/avatar/models")).body.models?.find((x) => x.id === model.body.id);
    return m && m.status !== "pending" ? m : null;
  }, 180);
  check("avatar service built it", m3d?.status === "ready" && Boolean(m3d.modelUrl ?? m3d.url), JSON.stringify(m3d));
  const glbUrl = m3d?.modelUrl ?? m3d?.url;
  if (glbUrl) {
    const glb = Buffer.from(await (await fetch(glbUrl)).arrayBuffer());
    check("the model downloads as a GLB", glb.subarray(0, 4).toString() === "glTF", `${glb.length} bytes`);
  }
  const { data: versions } = await schema("avatar").from("versions").select("version").eq("user_id", userId);
  check("avatar service keeps a version for the user", (versions ?? []).length >= 1);

  // --- A 360° body scan: four cut-out views → a body360 build in the avatar service ----------
  const views = {};
  for (const v of ["front", "left", "back", "right"]) {
    const t = await call("/uploads", { method: "POST", json: { contentType: "image/png", purpose: "scan" } });
    check(`scan upload URL (${v}) is in the scan folder`, t.status === 201 && t.body.path.startsWith(`${userId}/scan/`), JSON.stringify(t.body));
    await storage().uploadToSignedUrl(t.body.path, t.body.token, await sharp(Buffer.from(svg)).png().toBuffer(), { contentType: "image/png" });
    views[v] = t.body.path;
  }
  const scanModel = await call("/avatar/models", { method: "POST", json: { source: "scan", views } });
  check("scan build queued", scanModel.status === 202, JSON.stringify(scanModel.body));
  const scanned = await until(async () => {
    const m = (await call("/avatar/models")).body.models?.find((x) => x.id === scanModel.body.id);
    return m && m.status !== "pending" ? m : null;
  }, 180);
  check("avatar service built the scan", scanned?.status === "ready" && scanned.source_kind === "scan" && Boolean(scanned.url), JSON.stringify(scanned));
  const { data: kinds } = await schema("avatar").from("versions").select("kind").eq("user_id", userId);
  check("the scan became a body360 version", (kinds ?? []).some((k) => k.kind === "body360"), JSON.stringify(kinds));
  const foreign = await call("/avatar/models", { method: "POST", json: { source: "scan", views: { ...views, back: "00000000-0000-4000-8000-000000000000/scan/x.png" } } });
  check("a scan with someone else's view is refused", foreign.status === 400, JSON.stringify(foreign.body));
} finally {
  // --- Account deletion reaches every service and every file ---------------------------------
  const del = await call("/me", { method: "DELETE" });
  check("account deletion", del.status === 204, JSON.stringify(del.body));
  const [v, a, t] = await Promise.all([
    schema("vision").from("jobs").select("job_id").eq("user_id", userId),
    schema("avatar").from("versions").select("version").eq("user_id", userId),
    schema("tryon").from("renders").select("job_id").eq("user_id", userId),
  ]);
  check("vision forgot the user", (v.data ?? []).length === 0, JSON.stringify(v.error ?? v.data));
  check("avatar forgot the user", (a.data ?? []).length === 0, JSON.stringify(a.error ?? a.data));
  check("tryon forgot the user", (t.data ?? []).length === 0, JSON.stringify(t.error ?? t.data));
  const left = await admin.storage.from("wardrobe").list(userId);
  check("every file is gone (including nested folders)", (left.data ?? []).length === 0, JSON.stringify(left.data?.map((f) => f.name)));
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll service checks passed");
process.exit(failures ? 1 : 0);
