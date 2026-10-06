# Warewise

A personal AI stylist: photograph your clothes once, and Warewise tags them and suggests outfits from what you already own, for the occasion and the weather.

This is the MVP described in the architecture doc ("Warewise — System Architecture"). It runs entirely on free tiers: **$0 a month, no card needed**.

## What works

| Area | Features |
| --- | --- |
| Sign-in | Google (Supabase Auth); email magic link for local testing |
| Wardrobe | Upload from phone or desktop, optional in-browser background removal, AI tagging (category, colours, pattern, season, fabric, formality, fit, brand), search and filters, corrections, laundry/lent status, duplicate warnings |
| Stylist | Chat with occasion, date and city; live weather (Open-Meteo); hard rules, then AI picks with a wardrobe-search tool; rule-based fallback when AI is unavailable; like, dislike, save |
| Outfits | Saved and hand-built outfits, favourites, "I wore this" |
| Insights | Utilization, most and never worn, cost per wear |
| Shop | Wardrobe gaps ranked by outfits unlocked, with Myntra and AJIO search links |
| Avatar | Up to 5 photos of yourself; body points found and background removed **on your device** (MediaPipe), then stored privately |
| Try-on | **On my photo:** garments warped onto your body piece by piece (torso, sleeves, each trouser leg, one shoe per foot) with 3D-style shading. **Live mirror:** Lenskart-style camera mode; the outfit follows you in real time (pose tracking and background removal on the device, about 20–30 ms a frame). **Realistic AI try-on:** IDM-VTON on a free Hugging Face GPU, behind a separate consent |
| Sample wardrobe | One tap loads 12 illustrated items and 3 outfits to explore every feature; one tap removes them |
| Profile | Style and body profile (self-reported), training and AI try-on consents, account deletion |
| Admin | AI calls, error rate, latency, correction and fallback rates, queue depth |

## Stack

- **Next.js 16** (App Router, TypeScript) on **Vercel**: UI, REST API (`/api/v1`), stylist, job handlers.
- **Supabase**: Postgres with row-level security, pgmq job queue, pg_cron + pg_net scheduler, Storage, Auth, Realtime.
- **AI router** (`src/modules/ai`): every AI call goes through config-defined jobs. See below.
- **sharp** for image processing; **@imgly/background-removal** in the browser.

```
src/
  app/                 pages and API routes (thin: parse, call a module, respond)
  modules/
    platform/          auth wrapper, problem responses, logging, idempotency, metrics
    ai/                AI router: config, model chain, prompts, mock model
    wardrobe/          items, taxonomy, schemas
    media/             signed upload URLs
    jobs/              image pipeline, tagger, queue runner, perceptual hash
    stylist/           rules engine, weather, AI loop, SSE events
    avatar/            avatar photos (max 5), pose quality
    tryon/             garment placement from body landmarks, AI try-on jobs
    samples/           illustrated sample wardrobe
    outfits/ insights/ shopping/ identity/
config/                ai.config.json (free models), ai.config.mock.json (offline)
prompts/               tagger/v1.md, stylist/v1.md
supabase/              migrations, seed, local config
scripts/smoke.mjs      end-to-end API test
```

## Run it locally

Needs Node 20.9+ and Docker.

```bash
npm install
npx supabase start          # local Postgres, Auth, Storage, Mailpit; applies migrations
cp .env.example .env.local  # then paste the keys printed by: npx supabase status
npm run dev                 # http://localhost:3000
```

- `AI_CONFIG_FILE` picks the AI setup:
  - `config/ai.config.local.json` (recommended locally): real free models where you have keys, offline fallback for tagging and the stylist, and real AI try-on (IDM-VTON works anonymously on a smaller quota; `HF_TOKEN` raises it).
  - `config/ai.config.mock.json`: fully offline; used by `npm run smoke` and CI.
  - `config/ai.config.json`: production; real models only.
- To use real free models, set `AI_CONFIG_FILE=config/ai.config.json` and add at least `GEMINI_API_KEY` (free at [Google AI Studio](https://aistudio.google.com/apikey)). `GROQ_API_KEY` and `OPENROUTER_API_KEY` add backups.
- For realistic AI try-on, add a free Hugging Face token as `HF_TOKEN`. With the mock config, try-on uses a server-side composite instead, so the whole flow works offline.
- Sign in with the email link: emails land in Mailpit at http://127.0.0.1:54324.
- Local pg_cron reaches your dev server through `host.docker.internal:3000` (set in `supabase/seed.sql`).

## Google sign-in

Google sign-in needs your own OAuth client from Google Cloud (free). Until it is set up, the login page greys out the Google button and you can use the email link locally.

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), configure the OAuth consent screen (External, add yourself as a test user), then create an **OAuth client ID** of type **Web application**:
   - Authorised JavaScript origins: `http://localhost:3000`
   - Authorised redirect URIs: `http://127.0.0.1:54321/auth/v1/callback` (local) and later `https://<ref>.supabase.co/auth/v1/callback` (production)
2. Copy `supabase/.env.example` to `supabase/.env` and paste the client ID and secret there (the file is git-ignored).
3. In `supabase/config.toml`, set `enabled = true` under `[auth.external.google]`.
4. Restart Supabase so it picks up the change: `npx supabase stop && npx supabase start`.

Google redirects to Supabase, Supabase redirects to `/auth/callback`, and the app exchanges the code for a session cookie.

**Email links locally** never reach a real inbox: local Supabase catches them at http://127.0.0.1:54324 (the login page links there). Open the link in the same browser you requested it from. In production, Supabase's built-in email sender is only meant for testing (low limits); set up free custom SMTP (for example Resend's free tier) under Authentication → Emails before inviting others.

## Checks

```bash
npm run lint
npm run typecheck
npm test          # unit tests: rules engine, AI chain, hashing, gaps, schemas
npm run smoke     # with `npm run dev` running on config/ai.config.mock.json: 58 end-to-end API checks, including RLS
```

## Changing AI models (no code changes)

Code only asks for a job (`stylist`, `tagger`). `config/ai.config.json` maps each job to a chain of models, tried in order, skipping any without a key, the needed capability or free quota left. Any OpenAI-compatible endpoint works.

To move the stylist to a paid model, add an entry and put it first in the chain:

```json
"claude-haiku": {
  "baseURL": "https://api.anthropic.com/v1/",
  "apiKeyEnv": "ANTHROPIC_API_KEY",
  "model": "claude-haiku-4-5",
  "supports": { "images": true, "tools": true, "json": "none" }
}
```

(`"json": "none"` because not every OpenAI-compatible layer honours `response_format`; the prompt still asks for JSON and the router validates it. OpenRouter is another way to reach paid models with one key.)

Then `"stylist": { "chain": ["claude-haiku", "gemini-flash"] }`, set the key, redeploy. Free-tier limits in the file (`limits.perMinute`, `perDay`) are approximate; check each provider's page. Model names change: if a model is retired, update its `model` value.

Prompts are versioned files in `prompts/`; bump `promptVersion` in the config to switch.

### Free, keyless tagging and cut-outs (local development)

Without any AI key, the local config (`config/ai.config.local.json`) tags clothes on your own machine with the `local-vision` model: CLIP (zero-shot) names the garment and its pattern, and a clothes-parsing SegFormer model cuts the garment out of the photo, which also works on photos of someone wearing it. Colours are measured from the cut-out's pixels. Both models are MIT-licensed; about 260 MB is downloaded from Hugging Face on first use into `.cache/models` (or `MODEL_CACHE_DIR`), and photos never leave the machine. Each photo takes 1–3 seconds. Gemini, when `GEMINI_API_KEY` is set, is tried first and reads details better. The production config leaves `local-vision` out: the models are too big for a small serverless function.

### Realistic try-on

`tryon` dresses the photo one garment at a time. Tops and layers go to IDM-VTON first, because it asks the free GPU for about 60 s per run against Leffa's 120 s or more. Trousers, skirts and dresses go to Leffa. If a later garment can't run, the partly dressed result is kept with a note. Both run on free Hugging Face ZeroGPU Spaces with a small daily GPU allowance: set `HF_TOKEN` (a free read token) so you get your own instead of the shared anonymous one. The app never renders the same photo and outfit twice; it shows the saved result.

## Deploy for free

1. **Supabase**: create a free project in the Mumbai region. Link and push the schema:
   ```bash
   npx supabase link --project-ref <ref>
   npx supabase db push
   ```
   Then in the SQL editor, point the scheduler at your deployment (use a long random secret):
   ```sql
   insert into private.settings (key, value) values
     ('jobs_url', 'https://<your-app>.vercel.app/api/internal/jobs/run'),
     ('jobs_secret', '<random secret>')
   on conflict (key) do update set value = excluded.value;
   ```
2. **Google sign-in**: create an OAuth client in Google Cloud Console with redirect URI `https://<ref>.supabase.co/auth/v1/callback`; add the client id and secret under Supabase → Authentication → Providers → Google. Add `https://<your-app>.vercel.app/auth/callback` to Supabase's redirect URLs.
3. **Vercel** (Hobby): import the repo, set region `bom1`, and add the variables from `.env.example` with production values (`JOB_SECRET` = the secret above, `NEXT_PUBLIC_ENABLE_EMAIL_LOGIN=false`).
4. **Make yourself admin** (SQL editor): `update auth.users set raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}' where email = '<you>';` then sign out and in.
5. **Before real users**: set `NEXT_PUBLIC_CONTACT_EMAIL` (the grievance contact shown on /privacy and /terms), create a free Sentry project and set `SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN`, and point an uptime monitor at `/api/health` (it returns 503 when the database is unreachable).
6. **Automatic deploys** (optional): `.github/workflows/deploy.yml` pushes migrations and deploys to Vercel after CI passes on `main`. Add the secrets `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, the variables `SUPABASE_PROJECT_REF` and `PRODUCTION_URL`, then set `DEPLOY_ENABLED=true`.

CI also runs `npm audit` on production dependencies, checks that every table has row-level security (`supabase/tests/rls_enabled.sql`), and runs the end-to-end smoke test (67 checks) against a throwaway database.

## AI 3D avatar (optional, paid per model)

Try-on → 3D avatar → **AI 3D** turns the user's avatar photo, or their latest realistic try-on (so the model wears the outfit), into a textured GLB with a cloud image-to-3D API; the app needs no GPU. Set one or more keys; the `avatar3d` job in `config/ai.config.json` tries them in order:

| Key | Provider | Cost (checked Sept 2026) |
| --- | --- | --- |
| `FAL_KEY` | fal.ai, model `fal-ai/trellis` | about $0.02 per model, pay as you go |
| `TRIPO_API_KEY` | Tripo v3.1 | credits; failed tasks are not charged |
| `MESHY_API_KEY` | Meshy `meshy-6-lite` | 15 credits with texture; API needs a paid Meshy plan |

Users get 3 models a day (`DAILY_3D_MODELS`). Generation takes 1–3 minutes and runs as a background job that resumes if it outlasts one run. Models are stored as `<user>/models/<id>.glb` and deleted with the account. It uses the same consent as realistic AI try-on.

## Free-tier limits to know

- Supabase storage is 1 GB, about 90 users with 150 items each. Originals are deleted after processing to stretch it.
- A free Supabase project pauses after about a week without activity; restore it from the dashboard.
- Vercel Hobby is for non-commercial use.
- Gemini's free tier may use inputs to improve Google's products (stated in the in-app privacy note).
- The background-removal library is AGPL: fine for a personal project, review before commercial use.
- Realistic AI try-on uses Leffa (top then bottom, or a dress) with IDM-VTON as backup, both on Hugging Face's free ZeroGPU quota and for non-commercial use. Without `HF_TOKEN` you share the anonymous quota; a free token gives a few outfits a day. The job route asks for up to 300 s; check your Vercel plan's function limit. Switch the `tryon` job to a licensed paid API before charging for anything.

## Not in this MVP yet

Apple sign-in, Langfuse tracing, a prompt eval set, image embeddings (the `embedding` column is ready), a scheduled dataset export (the consent-filtered views `dataset_item_tags` and `dataset_outfit_outcomes` exist), payments and the Chrome extension.
