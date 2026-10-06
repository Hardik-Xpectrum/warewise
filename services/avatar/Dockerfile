# Avatar service. Build from the repo root (it needs packages/contracts-py):
#   docker build -f services/avatar/Dockerfile -t warewise-avatar .
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PORT=7860

# Hugging Face Docker Spaces run as uid 1000.
RUN useradd --create-home --uid 1000 app
WORKDIR /app

COPY services/avatar/requirements.lock services/avatar/requirements.lock
RUN pip install -r services/avatar/requirements.lock

# The contract, laid out as in the repo.
COPY packages/contracts-py packages/contracts-py
RUN pip install ./packages/contracts-py

COPY services/avatar/config services/avatar/config
COPY services/avatar/app services/avatar/app

USER app
WORKDIR /app/services/avatar
# gradio_client keeps downloads and its cache under HOME.
ENV HOME=/home/app GRADIO_TEMP_DIR=/tmp/gradio
EXPOSE 7860
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860} --no-access-log"]
