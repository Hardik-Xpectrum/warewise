"""The background worker: one job at a time (free CPUs are small), backed by avatar.jobs so a
restart resumes unfinished work and undelivered events. Started on app startup in a thread;
`python -m app.worker` runs it alone."""

from __future__ import annotations

import threading

from .config import Env, read_env
from .events import deliver_events
from .jobs import JobDeps, process_job
from .log import error_text, log, route_library_logs
from .store import Store, SupabaseStore

# A claimed job is invisible to other workers this long; a free Space call can take ~4 minutes.
LEASE_S = 330


def tick(store: Store, env: Env) -> tuple[bool, int]:
    """Runs at most one due job, then delivers due events. Returns (ran a job, events sent)."""
    job = store.claim(LEASE_S)
    if job:
        log("info", "job claimed", jobId=job["job_id"], userId=job["user_id"], kind=job["kind"], resumed=bool(job.get("provider_ref")))
        process_job(job, JobDeps(store=store))
    events = deliver_events(store, str(env.web_url), env.service_secret)
    return bool(job), events


class Worker:
    def __init__(self, store: Store, env: Env) -> None:
        self.store, self.env = store, env
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="avatar-worker", daemon=True)

    def start(self) -> Worker:
        self._thread.start()
        return self

    def stop(self, timeout: float = 5) -> None:
        # An interrupted job keeps its lease and provider_ref; the next start resumes it.
        self._stop.set()
        self._thread.join(timeout)

    def _loop(self) -> None:
        while not self._stop.is_set():
            busy = False
            try:
                busy, _ = tick(self.store, self.env)
            except Exception as err:  # noqa: BLE001
                log("error", "worker tick failed", error=error_text(err))
            # Straight on to the next job while there is work; otherwise wait.
            if not busy:
                self._stop.wait(self.env.worker_interval_s)


if __name__ == "__main__":
    route_library_logs()
    env = read_env()
    log("info", "avatar worker started")
    w = Worker(SupabaseStore(str(env.supabase_url), env.supabase_secret_key, env.storage_bucket), env)
    w._loop()
