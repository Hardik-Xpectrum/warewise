"""The job lifecycle as pure functions over a row of vision.jobs: queued → running → done | failed,
with retries. The worker applies the patches these return; keeping the rules here keeps them tested."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel
from warewise_contracts import ItemError, ItemProcessed

JobStatus = Literal["queued", "running", "done", "failed"]


class JobRow(BaseModel):
    job_id: str
    user_id: str
    item_id: str
    image_path: str
    status: JobStatus
    attempts: int
    last_error: str | None = None
    run_after: str
    result: dict[str, Any] | None = None  # the ItemProcessed event (camelCase JSON), once finished
    event_attempts: int = 0
    event_after: str | None = None
    event_sent_at: str | None = None
    created_at: str
    updated_at: str


JobPatch = dict[str, Any]

MAX_ATTEMPTS = 3
# After a failed attempt n (1-based), wait this long (seconds) before attempt n + 1.
RETRY_DELAYS_S = [30, 120]
# Every model out of free quota: wait, without spending an attempt.
DEFERRAL_S = 120
# Event delivery to the web app: retry after 1, 4, 16, 60 minutes, then give up (the web app can
# still poll GET /v1/jobs/{jobId}).
EVENT_BACKOFF_S = [m * 60 for m in (1, 4, 16, 60)]

GENERIC_FAILURE = "We couldn't read this photo. Retry, or tag it by hand."


@dataclass
class Outcome:
    """How one run of a job ended.

    done: `event` is the result. rejected: the photo is unusable; `message` is shown to the user and
    never retried. error: something broke (network, Storage, model); retried. deferred: no model had
    free quota.
    """

    kind: Literal["done", "rejected", "error", "deferred"]
    event: ItemProcessed | None = None
    message: str = ""


def iso(t: float) -> str:
    return datetime.fromtimestamp(t, UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_time(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


OPTIONAL_EVENT_FIELDS = ("tags", "paths", "phash", "error")


def event_json(event: ItemProcessed) -> dict[str, Any]:
    """The event as JSON for the web app. The TypeScript contract declares tags, paths, phash and
    error as optional (absent), not nullable, so null values are left out rather than sent."""
    body = event.to_json()
    return {k: v for k, v in body.items() if not (k in OPTIONAL_EVENT_FIELDS and v is None)}


def failure_event(job: JobRow, message: str, user_facing: bool) -> ItemProcessed:
    # A rejected photo stays rejected; anything else may work if the user tries again.
    return ItemProcessed(
        job_id=job.job_id,
        user_id=job.user_id,
        item_id=job.item_id,
        ok=False,
        error=ItemError(message=message if user_facing else GENERIC_FAILURE, user_facing=user_facing, retryable=not user_facing),
    )


def transition(job: JobRow, outcome: Outcome, now: float) -> JobPatch:
    """The row update after a run (job.attempts already counts this run: the claim incremented it)."""

    def finish(result: ItemProcessed, status: str, last_error: str | None) -> JobPatch:
        return {
            "status": status,
            "result": event_json(result),
            "last_error": last_error,
            "event_attempts": 0,
            "event_after": iso(now),  # send right away
            "event_sent_at": None,
        }

    if outcome.kind == "done":
        assert outcome.event is not None
        return finish(outcome.event, "done", None)
    if outcome.kind == "rejected":
        return finish(failure_event(job, outcome.message, True), "failed", outcome.message)
    if outcome.kind == "deferred":
        return {"status": "queued", "attempts": max(0, job.attempts - 1), "run_after": iso(now + DEFERRAL_S)}
    if job.attempts >= MAX_ATTEMPTS:
        return finish(failure_event(job, outcome.message, False), "failed", outcome.message)
    delay = RETRY_DELAYS_S[min(job.attempts, len(RETRY_DELAYS_S)) - 1]
    return {"status": "queued", "last_error": outcome.message, "run_after": iso(now + delay)}


def exhausted(job: JobRow) -> bool:
    """A claimed job past its attempts can only get here by crashing the process mid-run (each
    start counts). Fail it instead of crashing again."""
    return job.attempts > MAX_ATTEMPTS


def resume_patch(now: float) -> JobPatch:
    """On restart: jobs left "running" by the previous process go back to the queue."""
    return {"status": "queued", "run_after": iso(now)}


def event_retry(event_attempts: int, now: float) -> JobPatch:
    """After a failed event delivery: the next try, or stop (event_after None) when out of tries."""
    delay = EVENT_BACKOFF_S[event_attempts] if event_attempts < len(EVENT_BACKOFF_S) else None
    return {"event_attempts": event_attempts + 1, "event_after": None if delay is None else iso(now + delay)}


def event_sent(now: float) -> JobPatch:
    return {"event_sent_at": iso(now), "event_after": None}


def public_status(job: JobRow) -> dict[str, Any]:
    """What GET /v1/jobs/{jobId} answers: the contract's VisionJobStatus (jobId, itemId, status,
    attempts, tags, paths, error) plus what the TypeScript service also returned (userId, result,
    eventDelivered, createdAt, updatedAt)."""
    result = job.result or {}
    error = (result.get("error") or {}).get("message") if job.status == "failed" else None
    return {
        "jobId": job.job_id,
        "itemId": job.item_id,
        "status": job.status,
        "attempts": job.attempts,
        "tags": result.get("tags"),
        "paths": result.get("paths"),
        "error": error,
        "userId": job.user_id,
        "result": job.result,
        "eventDelivered": job.event_sent_at is not None,
        "createdAt": job.created_at,
        "updatedAt": job.updated_at,
    }
