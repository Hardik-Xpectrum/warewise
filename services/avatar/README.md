# Warewise avatar service (Python)

Builds each user's 3D avatar once, stores it per user and **versions** it, so the app always has
a ready model to show; only the clothes change on top. Every successful scan makes a new version.
Python 3.12 / FastAPI port of the first TypeScript version (archived in `~/Warewise-archive/services-ts/avatar`) (same endpoints, tables and SQL functions), plus:
the stored GLB is **normalised** with trimesh (scaled to the user's height, feet on y = 0, centred,
transforms baked in), and each version records **`textured`** (read from the stored GLB's images)
and **`measurementSources`** (`measured` | `size` | `average` per value).

| Scan (`kind`) | Input (cut-outs in Storage, from the phone) | Engine chain (`config/ai.config.json`) |
|---|---|---|
| `photo` | `views.front` | TRELLIS → Stable Fast 3D → fal.ai / Tripo / Meshy (only when their keys are set) |
| `body360` | `views.front`, `back`, `left`, `right` | Hunyuan3D-2mv → TRELLIS multi-image |
| `face` | `faceMesh` (GLB from MediaPipe on the phone), optional `faceTexture` | none: checked, texture embedded, attached to a new version |

A version is the whole avatar: a new body keeps the last face mesh; a face scan keeps the last body
mesh, its `textured` flag and its measurements. Owns schema `avatar` and Storage paths
`<userId>/avatar3d/`. Rules: [docs/microservices.md](../../docs/microservices.md); contract:
`packages/contracts-py/warewise_contracts`.

## Endpoints

All but `/health` need `Authorization: Service <token>` (audience `avatar`); errors are RFC 7807
`Problem`s (`application/problem+json`). Real examples in [`samples/`](samples).

| Method | Path | Caller | Answer |
|---|---|---|---|
| `POST` | `/v1/avatars/build` | web | `202 JobAccepted`. Idempotent by `jobId`; the same `jobId` for another user or kind is `409`. Every file (views, `faceMesh`, `faceTexture`) must be under `<userId>/`. |
| `GET` | `/v1/avatars/{userId}` | web, tryon | `AvatarCurrent`: newest version, 1-hour signed URLs, `building` (a newer build is queued or running); `404` before the first version |
| `GET` | `/v1/avatars/{userId}/versions` | web, tryon | `AvatarVersion[]`, newest first |
| `DELETE` | `/v1/avatars/{userId}` | web | `204`: all versions, jobs and files under `<userId>/avatar3d/` |
| `GET` | `/health` | anyone | `{ "ok": true, "service": "avatar", "version": "0.2.0" }` |

Events go to `POST {WEB_URL}/api/internal/events` (token audience `web`): `avatar.ready { jobId, userId, version }`
or `avatar.failed { jobId, userId, message, retryable }`, queued on the job row in the same write
that finishes the job, retried after 1, 4, 16, 60 minutes, then hourly, up to 10 tries.

## How a build runs

`app/worker.py` runs in a thread inside the server and takes one job at a time from `avatar.jobs`
(`avatar.claim_job`, `FOR UPDATE SKIP LOCKED`, 330 s lease, so a restart resumes unfinished work):

1. Download and prepare the cut-outs (RGBA PNG, ≤ 1024 px, EXIF dropped).
2. Submit to the first engine in the chain that is configured, under its daily cap
   (`avatar.take_engine_quota`), and that accepts the scan; save its task on the job (`provider_ref`).
3. Poll within a 200 s budget; if the model isn't ready the job goes back to the queue and resumes
   later without asking the engine again. Free Spaces answer in one call, so they finish in step 2.
4. Download the GLB (≤ 50 MB, glTF 2 magic and JSON chunk checked), load it with trimesh (must hold
   triangles), normalise it, store it at `<userId>/avatar3d/<jobId>/body.glb`, estimate measurements,
   and call `avatar.complete_job`, which allocates the next version under a per-user advisory lock,
   marks the job done and queues `avatar.ready` in one transaction (race-free; idempotent by job).

Bad input (a view that isn't an image, a face scan that isn't a GLB) fails at once with
`retryable: false`. If every engine refuses, the job fails with a friendly message (quota errors say
when the free GPU quota resets). Unexpected errors retry up to 3 times with backoff.

### Engines (`app/engines.py`, via `gradio_client`)

- **Hunyuan3D-2mv** (`tencent/Hunyuan3D-2mv`): `/generation_all` (shape + texture) with turbo
  settings (5 steps, octree 256, fixed seed, background removal off). When texturing fails with
  `PyMeshLabException` (still the case on 2026-10-04, after ~14 s) it falls back to
  `/shape_generation` in the same attempt and stores an untextured mesh (`textured: false`). Set
  `"textured": false` in the config to skip the textured attempt. Licence: Tencent Hunyuan 3D
  community licence (not EU/UK/South Korea; check before a commercial launch).
- **TRELLIS** (`trellis-community/TRELLIS`): `/start_session`, `/preprocess_image`,
  `/generate_and_extract_glb`; multi-image flips the session state with `/lambda_1` first and uses
  `multidiffusion`.
- **Stable Fast 3D**, **fal.ai**, **Tripo**, **Meshy**: as in the TypeScript service.
- **mock-3d**: a 0.5 × 1.7 × 0.3 m box (byte-identical to the TS mock), for development and tests.

Results are requested with `download_files=False`, so the job stores the Space's file URL and a
resumed job downloads instead of generating again. The HF token is only sent to Hugging Face hosts.

### Measurements (`app/measure.py`)

`heightCm`, `shoulderCm`, `chestCm`, `waistCm`, `hipCm`, `inseamCm`, `armCm`, `torsoCm`, plus
`chestDepthCm`/`waistDepthCm` when a 360° scan measured them, and `shoeUk` when given.

- **Scale:** cm per pixel = profile height (170 cm when unknown) / silhouette pixel height, per view.
- **Rows:** shoulder, chest, waist, hip at 0.80, 0.72, 0.62, 0.53 of stature (mean adult proportions).
- **Width and depth:** the front view's opaque run through the torso's centre column gives the
  width; the side view (left, else right) gives the depth; median over a ±1.5 % band.
- **Girth:** the torso section is modelled as an ellipse with that width and depth; its perimeter
  (Ramanujan: π[3(a+b) − √((3a+b)(a+3b))], a and b the half-axes) × 1.13 (chest) or × 1.05 (waist,
  hip), factors calibrated on mean adult breadths, depths and girths.
- **Fallbacks:** without a side view, chest and waist come from the sizes entered, then proportions;
  a silhouette value outside 0.65–1.5× that estimate is ignored (e.g. arms merged with the torso).
- **Sources:** `measured` (from the silhouettes), `size` (entered by the user: height, top size,
  waist, shoe), `average` (proportions of the height).

## Run locally

```sh
cd services/avatar
/opt/homebrew/bin/python3.12 -m venv .venv
.venv/bin/pip install -e ../../packages/contracts-py -r requirements.lock
cp .env.example .env       # fill SUPABASE_SECRET_KEY, SERVICE_SECRET, HF_TOKEN; export it
.venv/bin/uvicorn app.main:app --port 7860   # worker included
.venv/bin/python -m pytest                    # unit + route tests (in-memory store, mock engine)
.venv/bin/ruff check app tests
```

Migrations: `supabase/migrations/20261004000011_avatar_service.sql` and
`20261004000014_avatar_service_py.sql` (complete_job also takes `p_measurement_sources` and
`p_textured`, with defaults, so the TS service still works). The `avatar` schema must be exposed
to the API (`supabase/config.toml` `[api] schemas`).

## Environment

| Var | |
|---|---|
| `PORT` | default 7860 |
| `SERVICE_SECRET` | shared, ≥ 32 chars |
| `WEB_URL` | where events go |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | service key: never sent to a browser |
| `HF_TOKEN` | ZeroGPU quota for the Spaces (anonymous use works with less) |
| `LOG_LEVEL` | debug, info (default), warn, error; one JSON object per line |
| `FAL_KEY`, `TRIPO_API_KEY`, `MESHY_API_KEY` | optional paid photo engines |
| `AVATAR_ENGINES` | optional comma list that replaces every chain (e.g. `mock-3d`) |
| `AI_CONFIG_FILE`, `STORAGE_BUCKET`, `WORKER_INTERVAL_MS` | optional overrides |

## Deploy

```sh
docker build -f services/avatar/Dockerfile -t warewise-avatar .   # from the repo root
docker run -p 7860:7860 --env-file services/avatar/.env warewise-avatar
```

python:3.12-slim, uid 1000, port 7860: also runs as a Hugging Face Docker Space (CPU is enough;
the 3D work happens on the engines' GPUs). Hosts that sleep are fine: jobs resume on start.
