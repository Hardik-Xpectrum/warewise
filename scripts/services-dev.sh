#!/usr/bin/env bash
# Starts the three Python services locally against the local Supabase, for development:
#   scripts/services-dev.sh            real engines (Hugging Face GPU time for try-on and 3D)
#   scripts/services-dev.sh --free     no GPU time: try-on uses the offline composite, 3D the mock box
# Then run the web app with the services switched on:
#   VISION_URL=http://localhost:7861 AVATAR_URL=http://localhost:7862 TRYON_URL=http://localhost:7863 npm run dev
# Logs go to .services-logs/. Stop with: scripts/services-dev.sh --stop
set -euo pipefail
cd "$(dirname "$0")/.."
ports=(7861 7862 7863)
if [[ "${1:-}" == "--stop" ]]; then
  for p in "${ports[@]}"; do lsof -ti "tcp:$p" | xargs kill 2>/dev/null || true; done
  echo "services stopped"; exit 0
fi
set -a; source .env.local; set +a
: "${SERVICE_SECRET:?Set SERVICE_SECRET (32+ characters) in .env.local}"
export SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL" WEB_URL="${WEB_URL:-http://localhost:3000}" LOG_LEVEL="${LOG_LEVEL:-info}"
unset AI_CONFIG_FILE # the web app's setting; each service has its own config
mkdir -p .services-logs
start() { # name port [env...]
  local name=$1 port=$2; shift 2
  (cd "services/$name" && env "$@" nohup .venv/bin/uvicorn app.main:app --port "$port" < /dev/null > "../../.services-logs/$name.log" 2>&1 &)
}
if [[ "${1:-}" == "--free" ]]; then
  start vision 7861
  start avatar 7862 AVATAR_ENGINES=mock-3d
  start tryon 7863 AI_CONFIG_FILE=config/ai.config.offline.json
else
  start vision 7861; start avatar 7862; start tryon 7863
fi
for p in "${ports[@]}"; do
  for _ in $(seq 1 30); do curl -sf "localhost:$p/health" >/dev/null && break; sleep 1; done
  echo "$p: $(curl -s "localhost:$p/health" || echo 'not up: see .services-logs/')"
done
