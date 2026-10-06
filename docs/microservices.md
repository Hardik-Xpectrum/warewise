# Warewise services

Warewise is a Next.js web app (pages + API gateway) plus three services that do the heavy, slow
work. Each service is its own deployable app with its own Docker image and its own data.

| Service | Folder | Owns | Does |
|---|---|---|---|
| web (gateway) | repo root | everything users touch: auth, wardrobe items, outfits, plans, stylist | the only thing browsers talk to; checks sign-in, calls services for the user |
| vision | `services/vision` | schema `vision`, Storage paths `<userId>/clean|thumb|cutout/` | checks and cleans garment photos, tags them, cuts them out, perceptual hash |
| avatar | `services/avatar` | schema `avatar`, Storage paths `<userId>/avatar3d/` | builds and versions each user's 3D avatar (photo, 360° body scan, face scan), measurements |
| tryon | `services/tryon` | schema `tryon`, Storage paths `<userId>/tryon/` | realistic outfit renders (IDM-VTON, Leffa), cached by avatar + garments; re-textures the 3D avatar |

The contract (every request, response and event) is defined twice, kept identical: TypeScript in
`packages/contracts/src/index.ts` (web app) and Python in `packages/contracts-py/warewise_contracts`
(services). Change the TypeScript one first, mirror it in Python, and keep the cross-language test
vectors in `packages/contracts-py/tests` passing. (The first TypeScript versions of the
services were archived outside the repo, in `~/Warewise-archive/services-ts/`.)

## Rules

1. **A service owns its schema.** Only `vision` reads or writes the `vision` schema, and so on.
   No service reads another's tables or `public.*` (except the web app, which owns `public`).
   Need data from another service? Ask it over HTTP, or carry it in the request.
2. **Talk by request and event, never by shared tables.**
   - Web → service: `POST` a job with a `jobId` the web app chose (idempotency key). The service
     answers `202` with `JobAccepted` right away and does the work in the background.
   - Service → web: when done, `POST {WEB_URL}/api/internal/events` with a `ServiceEvent`.
     Retry on failure with backoff (1, 4, 16, 60 min). Events are idempotent by `(type, jobId)`.
   - Status can also be polled: `GET /v1/jobs/:jobId` (vision), `/v1/renders/:jobId` (tryon).
3. **Service auth:** `Authorization: Service <token>` from `signServiceToken(iss, aud, SERVICE_SECRET)`.
   Every endpoint except `GET /health` verifies it with `verifyServiceToken`. Services trust the
   web app about which user is acting (`userId` in the body); they never see user logins.
4. **Files** live in the private Supabase Storage bucket `wardrobe` under `<userId>/...`. A service
   writes only under its own prefixes. Services use the Supabase service key; it never reaches a
   browser.
5. **Account deletion:** each service exposes a delete-everything-for-this-user endpoint and the web
   app calls all of them.
6. **Free tiers:** AI runs on free Hugging Face ZeroGPU Spaces with `HF_TOKEN`. Keep the GPU time
   per request low (IDM-VTON ~60 s, Leffa ~120 s); never run the same work twice (cache by key).

## Service template (all three follow it)

The services are **Python 3.12** (the web app stays Next.js/TypeScript: browsers run JavaScript).

- [FastAPI](https://fastapi.tiangolo.com) + uvicorn, Pydantic v2, the contract from
  `packages/contracts-py` (`warewise_contracts`, installed editable), httpx, supabase-py, Pillow /
  numpy, `gradio_client` for Hugging Face Spaces. Type hints everywhere; `ruff` for lint.
- `services/<name>/` is standalone:
  - `pyproject.toml` (name `warewise-<name>`, deps pinned with `>=` lower bounds), `requirements.lock`
    (`pip freeze` of the working venv), a local `.venv` (never committed)
  - `app/main.py` (FastAPI app: routes), `app/worker.py` (background job loop, started on app startup),
    `app/*.py` logic, `app/config.py` (env + `config/ai.config.json`), `tests/` (pytest; pure parts
    unit-tested, routes tested with FastAPI's TestClient)
  - `Dockerfile` (python:3.12-slim, non-root user, `EXPOSE 7860`, `PORT` env, default 7860 so it also
    runs as a Hugging Face Docker Space; build from the repo root: `docker build -f services/<name>/Dockerfile .`),
    `.dockerignore` / `Dockerfile.dockerignore`
  - `README.md` (what it does, endpoints, env, run locally, deploy) and `samples/` with real request
    and response JSON captured from a running service
  - `.env.example`
- Env every service reads: `PORT`, `SERVICE_SECRET` (≥ 32 chars, shared), `WEB_URL` (for events),
  `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `HF_TOKEN` (when it calls Hugging Face), `LOG_LEVEL`.
- `GET /health` → `{ "ok": true, "service": "<name>", "version": "x.y.z" }` (no auth).
- Errors are RFC 7807 `Problem` JSON (`application/problem+json`).
- Logs: one JSON object per line (`level`, `msg`, `time`, `jobId`, `userId`), no photo data, no secrets.
- Jobs: the service's own jobs table is the queue and the event outbox, so a restart resumes
  unfinished work and undelivered events. One job at a time per service (free CPUs are small).

## Database

Each service has one migration that creates its schema, tables, RLS (enabled, no policies: only
the service key can reach them) and grants to `service_role` only:

| Service | Migration |
|---|---|
| vision | `supabase/migrations/20261004000010_vision_service.sql` |
| avatar | `supabase/migrations/20261004000011_avatar_service.sql` |
| tryon | `supabase/migrations/20261004000012_tryon_service.sql` |

The schemas are exposed to the Supabase API in `supabase/config.toml` (`[api] schemas`).

## Hosting

Any Docker host works. Free options: Hugging Face Docker Spaces (CPU, 16 GB RAM, sleeps when idle),
Oracle Cloud Always Free VM (4 ARM cores, 24 GB RAM), Koyeb / Render free (512 MB: too small for
the vision models). The web app stays on Vercel, data on Supabase.

## Run everything locally

```bash
scripts/services-dev.sh --free      # the three services; --free: no Hugging Face GPU time
VISION_URL=http://localhost:7861 AVATAR_URL=http://localhost:7862 TRYON_URL=http://localhost:7863 npm run dev
node scripts/services-smoke.mjs <folder of garment photos>   # end-to-end check
scripts/services-dev.sh --stop
```

`SERVICE_SECRET` (in `.env.local`) is shared by the web app and the services. Without the three
URLs the web app works exactly as before, doing the work itself.

## Migration from the monolith

The web app still has the in-process versions (`src/modules/jobs`, `src/modules/ai/tryon.ts`,
`src/modules/ai/model3d.ts`). The services are built next to them; the web app switches over per
service behind an env flag (`VISION_URL`, `AVATAR_URL`, `TRYON_URL`: when set, use the service),
then the old code is removed.
