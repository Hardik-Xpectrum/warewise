# Build from the repo root: docker build -f services/tryon/Dockerfile -t warewise-tryon .
# Runs as a Hugging Face Docker Space too (port 7860, non-root user 1000).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PORT=7860
RUN useradd --create-home --uid 1000 app
WORKDIR /app

# The shared contract, installed from source.
COPY packages/contracts-py packages/contracts-py
COPY services/tryon/requirements.lock services/tryon/requirements.lock
RUN pip install -r services/tryon/requirements.lock && pip install ./packages/contracts-py

COPY services/tryon/pyproject.toml services/tryon/
COPY services/tryon/app services/tryon/app
COPY services/tryon/config services/tryon/config

RUN chown -R app:app /app
USER app
WORKDIR /app/services/tryon
EXPOSE 7860
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --no-access-log"]
