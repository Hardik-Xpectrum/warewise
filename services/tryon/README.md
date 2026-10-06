# Warewise try-on service (Python)

Dresses a user's avatar photo in an outfit with free AI try-on models, and caches the result:
the same person photo (or avatar version) plus the same garments in the same state is never
rendered twice, which saves the small free GPU allowance. When the request names an
`avatarVersion`, it also makes front and back textures for that 3D avatar version.

Python 3.12 / FastAPI port of the first TypeScript version (archived in `~/Warewise-archive/services-ts/tryon`) (same endpoints, tables, SQL functions and
events). Owns schema `tryon` (migration `supabase/migrations/20261004000012_tryon_service.sql`)
and Storage paths `<userId>/tryon/` in the `wardrobe` bucket. It only reads the photos named in a
request. See `docs/microservices.md` for the rules; the messages come from `warewise_contracts`
(`packages/contracts-py`).

## Layout

| File | |
|---|---|
| `app/main.py` | FastAPI routes, service-token middleware, Problem errors; starts the worker on startup |
| `app/worker.py` | background thread: one render at a time, event outbox delivery |
| `app/jobs.py` | one claimed render: download, dress, store, textures, event |
| `app/engine.py` | pass-based engine (fallbacks, partial results), model input prep, composite engine |
| `app/hf.py` | the Hugging Face Space calls (`gradio_client`) |
| `app/plan.py`, `cache.py`, `request.py`, `wear.py`, `placement.py` | pure rules (unit-tested) |
| `app/texture.py` | avatar textures (numpy + OpenCV) |
| `app/events.py`, `store.py`, `config.py`, `log.py`, `problem.py` | plumbing |

## How a render works

1. `POST /v1/renders` validates the request (contract `RenderRequest`; every path must be under
   the user's own folder; at least one top, layer, bottom or dress) and computes
   `render_cache_key(person, avatarVersion, garments, engine)`; `engine` is `ai` or `composite`
   from the config, so an offline composite is never served once the AI models are back. A
   finished, complete render with that key for this user answers at once
   (`cached: true, status: "done"`) and still sends `tryon.ready`. Otherwise the job is queued.
2. The worker plans passes (`app/plan.py`): a dress is one pass; else the visible upper garment
   (a layer beats the top under it), then the bottom on that result. Upper body goes to IDM-VTON
   first (`yisol/IDM-VTON`, `/tryon`), Leffa (`franciszzj/Leffa`, `/leffa_predict_vt`) as
   fallback; bottoms and dresses go to Leffa. The garment is sent as its cut-out on white with an
   8% margin, the person as 768 x 1024 contain on white. If a later pass can't run, the partly
   dressed result is kept with a note ("AI dressed the top: ... The bottom was skipped: the free
   GPU time ran out.").
3. Each model call first takes one from that model's own limits (`tryon.take_model_quota`,
   per minute and per Pacific-time day, from the config).
4. The render is stored as `<userId>/tryon/<jobId>.webp`; with `avatarVersion` also
   `<jobId>-v<version>-front.png` and `-back.png`. Then the event goes out.

Only complete renders are reused from cache. A partial render, or the composite fallback after
the AI failed, is shown but the next identical request tries the AI again. In offline mode
(`config/ai.config.offline.json`, composite only) the composite (garment cut-outs placed from the
request's `pose` landmarks, or a standing centred figure) is the intended result and is cached.

### Avatar textures (`app/texture.py`)

- **Front**: the render with its white background keyed out: OpenCV connected components
  (4-connected) over near-white pixels (min channel >= 247, nearly grey), keeping only the ones
  touching the border, so white clothes inside the figure stay. Light pixels next to the
  background get a soft alpha.
- **Back**: a plain stand-in: the keyed front averaged to a 12 x 16 grid (alpha-weighted;
  thin cells take the overall mean), scaled up cubic, Gaussian-blurred, mirrored and cut to the
  mirrored silhouette. No face, print or logo survives.

### Errors people see

- `The free GPU time is used up; it resets in about N hours. The instant preview still works.`
  (from Hugging Face's "Try again in H:MM:SS", or our own daily limit resetting at midnight
  Pacific). `tryon.failed` carries `quota: true`.
- `The AI couldn't find a body in this photo...` (the Space answers `IndexError`).
- `The avatar photo was deleted` / `Photos for this try-on are missing`.
- Storage or network errors retry the job (1, then 4 minutes; 3 attempts), then
  `AI try-on failed. Please try again later.`

## Endpoints

All except `/health` need `Authorization: Service <token>` from
`sign_service_token("web", "tryon", SERVICE_SECRET)` (401 bad/missing, 403 other issuer).
Errors are RFC 7807 `Problem` bodies (`application/problem+json`).

| Method | Path | Answer |
|---|---|---|
| GET | `/health` | `{ "ok": true, "service": "tryon", "version": "0.1.0" }` |
| POST | `/v1/renders` | `202 JobAccepted` (`cached: true, status: "done"` on a cache hit); 400 invalid; 409 jobId reused for a different request. Resending the same jobId returns its state. |
| GET | `/v1/renders/{jobId}` | `RenderStatus` (incl. `textureForAvatar.backTexturePath`), 404 if unknown |
| DELETE | `/v1/users/{userId}/renders` | 204; deletes every row and every file under `<userId>/tryon/` |

Events go to `POST {WEB_URL}/api/internal/events`: `tryon.ready` / `tryon.failed`, signed
`tryon -> web`, validated against the contract before sending. They are stored on the render row
(outbox) and retried after 1, 4, 16 and 60 minutes, then given up (logged).

`samples/` holds real requests and responses captured from the running service (tokens
redacted), including the three events as the listener received them. `samples/*.webp` (a real
render of the owner's test photo) is git-ignored.

## Jobs

`tryon.renders` is the queue. `tryon.claim_render(lease)` takes the oldest due row
(`for update skip locked`) and leases it; a worker that dies mid-render leaves the row `running`
and it is claimed again when the lease runs out (2 x the model timeout + 5 min). Before running,
the worker checks the cache again. If the user is deleted while a job runs, its files are removed
afterwards.

## Env

| Var | |
|---|---|
| `PORT` | default 7860 |
| `SERVICE_SECRET` | shared with the web app, 32+ chars |
| `WEB_URL` | where events go |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | service key (schema `tryon` must be in the API's exposed schemas) |
| `HF_TOKEN` | optional; your own ZeroGPU allowance instead of the anonymous one |
| `LOG_LEVEL` | debug, info (default), warn, error |
| `AI_CONFIG_FILE` | default `config/ai.config.json`; `config/ai.config.offline.json` = composite only |
| `STORAGE_BUCKET` | default `wardrobe` |
| `WORKER` | `off` to run the HTTP API without the worker (then `python -m app.worker` elsewhere) |
| `WORKER_IDLE_MS` | poll interval when idle, default 5000 |

## Run locally

```sh
cd services/tryon
/opt/homebrew/bin/python3.12 -m venv .venv
.venv/bin/pip install -r requirements.lock -e ../../packages/contracts-py
cp .env.example .env   # fill in
set -a; . ./.env; set +a
.venv/bin/uvicorn app.main:app --port 7860 --no-access-log
.venv/bin/python -m pytest && .venv/bin/ruff check app tests
```

## Deploy

```sh
docker build -f services/tryon/Dockerfile -t warewise-tryon .   # from the repo root
docker run -p 7860:7860 --env-file services/tryon/.env warewise-tryon
```

`Dockerfile.dockerignore` keeps root-context builds to the few paths the image needs. The image
listens on `$PORT` (7860) as a non-root user (uid 1000), so it also runs as a Hugging Face Docker
Space. The GPU work happens in the Spaces, so a small CPU host is enough.

## Differences from the TypeScript version

- `model_input` keeps the 8% garment margin. The TS version re-ran `resize(768, 1024, contain)`
  on the 645 x 860 inner image, which scaled it back up and lost the margin.
- A Storage download that fails for a reason other than "not found" raises (the job is retried)
  instead of being treated as a deleted photo.
- Python's Gradio client reports Space errors as `AppError`; when a Space hides its errors the
  `IndexError` (no body found) text may not reach us, and the generic "unavailable" message is
  shown instead.
