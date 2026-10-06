"""The background worker: one render at a time (free CPUs and GPU quotas are small), resumable
because the queue is the tryon.renders table. Runs in a thread inside the HTTP process by default,
or alone with `python -m app.worker` (then set WORKER=off on the HTTP process)."""

from __future__ import annotations

import math
import threading

from app.config import config_file, env, load_ai_config
from app.jobs import deliver_events, process_render
from app.log import error_message, log
from app.store import Store, SupabaseStore


def lease_seconds() -> int:
    """Two passes of up to timeoutMs each, plus downloads: a crashed run is retried after this."""
    return math.ceil(load_ai_config().jobs.tryon.timeout_ms * 2 / 1000) + 300


class Worker:
    def __init__(self, store: Store) -> None:
        self.store = store
        self._wake = threading.Event()
        self._stopping = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="tryon-worker", daemon=True)

    def start(self) -> Worker:
        self._thread.start()
        log("info", "worker started", config=config_file())
        return self

    def wake(self) -> None:
        self._wake.set()

    def stop(self) -> None:
        self._stopping.set()
        self._wake.set()

    def join(self, timeout: float | None = None) -> None:
        self._thread.join(timeout)

    def tick(self) -> bool:
        """Delivers due events and runs at most one render. True when it did any work."""
        from app import hf  # the Gradio client is only needed by the worker

        web_url, secret = env.web_url(), env.service_secret()
        worked = deliver_events(self.store, web_url, secret) > 0
        row = self.store.claim(lease_seconds())
        if row:
            worked = True
            log("info", "render started", jobId=row["job_id"], userId=row["user_id"], attempt=row.get("attempts"))
            process_render(row, self.store, load_ai_config(), hf.has_token, hf.run_pass)
            deliver_events(self.store, web_url, secret)  # tell the web app right away
        return worked

    def _loop(self) -> None:
        while not self._stopping.is_set():
            worked = False
            try:
                worked = self.tick()
            except Exception as err:  # noqa: BLE001 - keep the loop alive; the row is retried
                log("error", "worker tick failed", error=error_message(err))
            if not worked:
                self._wake.wait(env.idle_seconds())
                self._wake.clear()


if __name__ == "__main__":
    w = Worker(SupabaseStore()).start()
    try:
        w.join()
    except KeyboardInterrupt:
        w.stop()
