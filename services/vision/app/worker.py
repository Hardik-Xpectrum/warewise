"""The background job loop: one job at a time (free CPUs are small, and the vision models use all
of one). vision.jobs is the queue, so nothing is lost on a restart: running jobs are put back and
undelivered events are sent again."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any

from warewise_contracts import ItemProcessed

from app.events import SendEvent
from app.files import FileStore
from app.jobs import JobRow, Outcome, event_retry, event_sent, exhausted, resume_patch, transition
from app.log import error_fields, log
from app.pipeline import classify_error, output_paths
from app.store import JobStore


class Worker:
    def __init__(
        self,
        store: JobStore,
        files: FileStore,
        run: Callable[[JobRow], ItemProcessed],
        send_event: SendEvent,
        now: Callable[[], float] = time.time,
        poll_s: float = 2.0,
    ):
        self.store, self.files, self.run, self.send_event, self.now, self.poll_s = store, files, run, send_event, now, poll_s
        self._running = False
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        for job in self.store.list_running():
            self.store.update(job.job_id, resume_patch(self.now()))
            log("info", "job resumed after restart", jobId=job.job_id, userId=job.user_id)
        self._running = True
        self._thread = threading.Thread(target=self._loop, name="vision-worker", daemon=True)
        self._thread.start()

    def stop(self, timeout: float | None = None) -> None:
        """Finishes the job in hand, then stops (a hard kill is fine too: the job resumes on the next start)."""
        self._running = False
        self.kick()
        if self._thread:
            self._thread.join(timeout)

    def kick(self) -> None:
        """New work arrived: skip the rest of the idle wait."""
        self._wake.set()

    def _loop(self) -> None:
        while self._running:
            busy = False
            try:
                busy = self.tick()
            except Exception as err:  # e.g. the database is unreachable; try again shortly
                log("error", "worker tick failed", **error_fields(err))
            if not busy and self._running:
                self._wake.wait(self.poll_s)
            self._wake.clear()

    def tick(self) -> bool:
        """Delivers due events, then runs at most one job. True when it did something."""
        delivered = self.deliver_events()
        job = self.store.claim_next()
        if job is None:
            return delivered > 0
        self.run_job(job)
        return True

    def run_job(self, job: JobRow) -> None:
        fields: dict[str, Any] = {"jobId": job.job_id, "userId": job.user_id, "attempt": job.attempts}
        if exhausted(job):
            # An "error" past the last attempt fails the job (see transition).
            outcome = Outcome("error", message="the service stopped while processing this photo, several times")
        else:
            started = self.now()
            log("info", "job started", **fields)
            try:
                outcome = Outcome("done", event=self.run(job))
            except Exception as err:
                outcome = classify_error(err)
            level = "info" if outcome.kind == "done" else "error" if outcome.kind == "error" else "warn"
            extra = {"error": outcome.message} if outcome.kind in ("error", "rejected") else {}
            log(level, f"job {outcome.kind}", **fields, ms=round((self.now() - started) * 1000), **extra)
        still_there = self.store.update(job.job_id, transition(job, outcome, self.now()))
        if not still_there and outcome.kind == "done":
            # The user's data was deleted while this ran: don't leave the new files behind.
            p = output_paths(job.user_id, job.item_id)
            try:
                self.files.remove([p["clean"], p["thumb"], p["cutout"]])
            except Exception as err:
                log("warn", "orphan cleanup failed", **fields, **error_fields(err))
            log("info", "job dropped: user data deleted mid-run", **fields)

    def deliver_events(self) -> int:
        sent = 0
        for job in self.store.due_events(10):
            if not job.result:
                continue
            fields = {"jobId": job.job_id, "userId": job.user_id, "eventAttempt": job.event_attempts + 1}
            try:
                self.send_event(job.result)
                self.store.update(job.job_id, event_sent(self.now()))
                log("info", "event delivered", **fields)
                sent += 1
            except Exception as err:
                patch = event_retry(job.event_attempts, self.now())
                self.store.update(job.job_id, patch)
                if patch["event_after"]:
                    log("warn", "event delivery failed; will retry", **fields, error=str(err))
                else:
                    log("error", "event delivery gave up", **fields, error=str(err))
        return sent
