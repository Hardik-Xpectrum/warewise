# Build from the repo root (the contract lives outside this folder):
#   docker build -f services/vision/Dockerfile -t warewise-vision .
# No models are baked in: CLIP, the clothes parser and u2net (~900 MB) download to MODEL_CACHE_DIR
# on first use. Mount a volume there to keep them across restarts.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    PORT=7860 MODEL_CACHE_DIR=/data/models HF_HOME=/data/models/hf

WORKDIR /app
# CPU-only PyTorch first (the default Linux wheel pulls in CUDA, several GB); the lock's torch pin
# is then already satisfied.
COPY services/vision/requirements.lock services/vision/requirements.lock
RUN TORCH=$(grep '^torch==' services/vision/requirements.lock) \
 && pip install --index-url https://download.pytorch.org/whl/cpu "$TORCH" \
 && grep -vE '^(pytest|ruff|pluggy|iniconfig)==' services/vision/requirements.lock > /tmp/req.txt \
 && pip install -r /tmp/req.txt
COPY packages/contracts-py packages/contracts-py
RUN pip install --no-deps -e packages/contracts-py

COPY services/vision/app services/vision/app
COPY services/vision/config services/vision/config
COPY services/vision/prompts services/vision/prompts

RUN useradd --create-home --uid 1000 app && mkdir -p /data/models && chown -R app:app /data
USER app
WORKDIR /app/services/vision
EXPOSE 7860
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860}"]
