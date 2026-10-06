# Warewise vision service (Python)

Checks, cleans, tags and cuts out garment photos for the web app. Python 3.12 / FastAPI port of
the first TypeScript version (archived in `~/Warewise-archive/services-ts/vision`) (same endpoints, same `vision.jobs` table and `vision.claim_next_job()`, same
rules). Given an uploaded photo in Storage it:

1. validates it by contents (JPEG, PNG or WebP; at most 10 MB, 8000 px a side, 40 megapixels),
2. strips EXIF/GPS (and ICC/XMP) and writes a 1024 px WebP "clean" copy and a 320 px thumbnail,
3. computes a perceptual hash (dHash, 16 hex chars, same algorithm as the TypeScript service) so the
   web app can spot duplicates,
4. tags it (category, subcategory, colours, pattern, seasons, fabric, formality, fit, brand,
   confidence) through the model chain in `config/ai.config.json`,
5. cuts the garment out (transparent WebP) with the clothes parser; accessories with rembg; a plain
   background keyer as the last fallback,
6. writes `<userId>/clean|thumb|cutout/<itemId>.webp` to the `wardrobe` bucket, and
7. sends `item.processed` to the web app.

A photo that isn't clothing, or isn't an image, fails with a message meant for the user
("This photo doesn't look like clothing. Try another photo."). The uploaded original is left in
place: it belongs to the item, and the web app removes it.

Contract: `packages/contracts-py` (`warewise_contracts`). Rules: `docs/microservices.md`.

## Endpoints

All but `/health` need `Authorization: Service <token>` from `sign_service_token("web", "vision", SERVICE_SECRET)`;
only the web app may call (other issuers get 403). Errors are RFC 7807 problems (`application/problem+json`).

| Method | Path | Answer |
|---|---|---|
| `GET` | `/health` | `{ ok: true, service: "vision", version }` |
| `POST` | `/v1/items/process` | body `ProcessItemRequest` → `202 JobAccepted`. Idempotent by `jobId`; the same `jobId` for a different item is `409`. `imagePath` must be inside `<userId>/` and contain no `..` (else `400`). |
| `GET` | `/v1/jobs/{jobId}` | `VisionJobStatus` (`jobId, itemId, status, attempts, tags, paths, error`) plus `userId, result` (the `ItemProcessed` event once finished), `eventDelivered, createdAt, updatedAt` as the TypeScript service returned |
| `DELETE` | `/v1/users/{userId}` | `204`; removes the user's job rows (account deletion). Storage files are removed by the web app. |

Event: `POST {WEB_URL}/api/internal/events` with an `ItemProcessed` body and a token addressed to
`web`. Retried after 1, 4, 16 and 60 minutes until the web app answers 2xx. `tags`, `paths`, `phash`
and `error` are left out (not `null`) when absent, as the TypeScript contract declares them optional.

`samples/` holds real requests and responses captured from a running service (tokens replaced by
`<token>`).

## How jobs run

`vision.jobs` (migration `supabase/migrations/20261004000010_vision_service.sql`, no change needed) is
both the queue and the event outbox. A worker thread, started with the app, runs one job at a time.
A job is tried at most 3 times (30 s, then 2 min apart); a rejected photo fails at once; when every
model is out of free quota the job waits 2 min without spending an attempt. On start, jobs left
`running` by a previous process are queued again and undelivered events are sent. If the user's data
is deleted while their job runs, the files it just wrote are removed.

## Models

`config/ai.config.json` (or `AI_CONFIG_FILE`) lists the tagger's models in order:
Gemini Flash-Lite → Gemini Flash → OpenRouter free vision → **local-vision** → mock. Models without
an API key are skipped, so with no keys the on-device tagger does the work.

- local-vision: CLIP `openai/clip-vit-base-patch32` (PyTorch, Hugging Face `transformers`) picks the
  garment and pattern zero-shot (same label lists and pick rules as `localVision.ts`); colours are
  named in CIELAB from the cut-out's pixels (silver/gold never used for fabric).
- Cut-out: SegFormer clothes parser `mattmdjaga/segformer_b2_clothes` (same label rules, edge erosion,
  blur and fill gate as TypeScript). Accessories, which the parser barely covers, use rembg (u2net),
  held to the same gate. The plain-background keyer is the last fallback.
  rembg was tested on garments too and left out there: on shirts on hangers it kept the hanger.

All download on first use into `MODEL_CACHE_DIR` (CLIP ~600 MB, parser ~110 MB, u2net ~176 MB).
After that, a job takes about 1–3 s on an M-series CPU (the first ~10 s while models load).

## Environment

See `.env.example`. Required: `SERVICE_SECRET` (≥ 32 chars, shared), `WEB_URL`, `SUPABASE_URL`,
`SUPABASE_SECRET_KEY`. Optional: `PORT` (7860), `MODEL_CACHE_DIR`, `LOG_LEVEL`, `GEMINI_API_KEY`,
`OPENROUTER_API_KEY`, `AI_CONFIG_FILE`. Logs are one JSON object per line, with `jobId` and
`userId`, never photo data or secrets.

## Run locally

```sh
cd services/vision
python3.12 -m venv .venv
.venv/bin/pip install -e ../../packages/contracts-py
.venv/bin/pip install -r requirements.lock      # or: pip install -e ".[dev]"
cp .env.example .env                            # Supabase URL + secret key, a SERVICE_SECRET
.venv/bin/uvicorn app.main:app --port 7860 --env-file .env
.venv/bin/python -m pytest && .venv/bin/ruff check .
```

The `vision` schema must be exposed to the Supabase API (`[api] schemas` in `supabase/config.toml`).

## Deploy

```sh
docker build -f services/vision/Dockerfile -t warewise-vision .   # from the repo root
docker run -p 7860:7860 --env-file services/vision/.env -v vision-models:/data/models warewise-vision
```

The image uses CPU-only PyTorch. The models need well over 512 MB of RAM, so use a Hugging Face
Docker Space (CPU basic) or an Oracle Always Free VM, not a 512 MB free tier. Keep one replica: the
job loop is designed for one process.
