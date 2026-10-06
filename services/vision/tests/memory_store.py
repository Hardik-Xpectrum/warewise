"""vision.jobs in memory, for tests: same semantics as the Supabase store and claim_next_job()."""

from __future__ import annotations

import time
from collections.abc import Callable

from warewise_contracts import ProcessItemRequest

from app.jobs import JobPatch, JobRow, iso, parse_time


class MemoryJobStore:
    def __init__(self, now: Callable[[], float] = time.time):
        self.rows: dict[str, JobRow] = {}
        self.now = now

    def create(self, req: ProcessItemRequest) -> tuple[JobRow, bool]:
        if req.job_id in self.rows:
            return self.rows[req.job_id].model_copy(), False
        t = iso(self.now())
        job = JobRow(job_id=req.job_id, user_id=req.user_id, item_id=req.item_id, image_path=req.image_path,
                     status="queued", attempts=0, run_after=t, created_at=t, updated_at=t)
        self.rows[job.job_id] = job
        return job.model_copy(), True

    def get(self, job_id: str) -> JobRow | None:
        row = self.rows.get(job_id)
        return row.model_copy() if row else None

    def claim_next(self) -> JobRow | None:
        due = sorted((r for r in self.rows.values() if r.status == "queued" and parse_time(r.run_after) <= self.now()),
                     key=lambda r: parse_time(r.run_after))
        if not due:
            return None
        due[0].status = "running"
        due[0].attempts += 1
        return due[0].model_copy()

    def update(self, job_id: str, patch: JobPatch) -> bool:
        row = self.rows.get(job_id)
        if row is None:
            return False
        self.rows[job_id] = row.model_copy(update={**patch, "updated_at": iso(self.now())})
        return True

    def list_running(self) -> list[JobRow]:
        return [r.model_copy() for r in self.rows.values() if r.status == "running"]

    def due_events(self, limit: int) -> list[JobRow]:
        return [r.model_copy() for r in self.rows.values()
                if r.status in ("done", "failed") and not r.event_sent_at and r.event_after
                and parse_time(r.event_after) <= self.now()][:limit]

    def delete_user(self, user_id: str) -> int:
        ids = [k for k, r in self.rows.items() if r.user_id == user_id]
        for k in ids:
            del self.rows[k]
        return len(ids)
