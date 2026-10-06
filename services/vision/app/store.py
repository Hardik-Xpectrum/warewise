"""The vision.jobs table, behind a protocol so the HTTP layer and worker are testable without a database."""

from __future__ import annotations

from typing import Any, Protocol

from warewise_contracts import ProcessItemRequest

from app.jobs import JobPatch, JobRow, iso

BUCKET = "wardrobe"


class JobStore(Protocol):
    def create(self, req: ProcessItemRequest) -> tuple[JobRow, bool]:
        """Inserts a queued job unless job_id exists; returns the row either way, and whether it was new."""
        ...

    def get(self, job_id: str) -> JobRow | None: ...

    def claim_next(self) -> JobRow | None:
        """Atomically takes the next due queued job and marks it running (attempts + 1)."""
        ...

    def update(self, job_id: str, patch: JobPatch) -> bool:
        """False when the row no longer exists (the user's data was deleted mid-run)."""
        ...

    def list_running(self) -> list[JobRow]: ...

    def due_events(self, limit: int) -> list[JobRow]:
        """Finished jobs whose event is due for (re)delivery."""
        ...

    def delete_user(self, user_id: str) -> int: ...


def supabase_client(url: str, key: str) -> Any:
    from supabase import ClientOptions, create_client

    return create_client(url, key, options=ClientOptions(auto_refresh_token=False, persist_session=False))


class SupabaseJobStore:
    def __init__(self, db: Any, now: Any = None):
        import time

        self.db = db
        self.now = now or time.time

    def _jobs(self) -> Any:
        return self.db.schema("vision").table("jobs")

    def create(self, req: ProcessItemRequest) -> tuple[JobRow, bool]:
        row = {"job_id": req.job_id, "user_id": req.user_id, "item_id": req.item_id, "image_path": req.image_path}
        res = self._jobs().upsert(row, on_conflict="job_id", ignore_duplicates=True).execute()
        if res.data:
            return JobRow.model_validate(res.data[0]), True
        job = self.get(req.job_id)
        if job is None:
            raise RuntimeError("create job: row vanished")
        return job, False

    def get(self, job_id: str) -> JobRow | None:
        res = self._jobs().select("*").eq("job_id", job_id).limit(1).execute()
        return JobRow.model_validate(res.data[0]) if res.data else None

    def claim_next(self) -> JobRow | None:
        res = self.db.schema("vision").rpc("claim_next_job", {}).execute()
        return JobRow.model_validate(res.data[0]) if res.data else None

    def update(self, job_id: str, patch: JobPatch) -> bool:
        res = self._jobs().update(patch).eq("job_id", job_id).execute()
        return bool(res.data)

    def list_running(self) -> list[JobRow]:
        res = self._jobs().select("*").eq("status", "running").execute()
        return [JobRow.model_validate(r) for r in res.data or []]

    def due_events(self, limit: int) -> list[JobRow]:
        res = (
            self._jobs()
            .select("*")
            .in_("status", ["done", "failed"])
            .is_("event_sent_at", "null")
            .lte("event_after", iso(self.now()))
            .order("event_after")
            .limit(limit)
            .execute()
        )
        return [JobRow.model_validate(r) for r in res.data or []]

    def delete_user(self, user_id: str) -> int:
        res = self._jobs().delete().eq("user_id", user_id).execute()
        return len(res.data or [])
