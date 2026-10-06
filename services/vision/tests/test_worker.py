from datetime import UTC, datetime

from warewise_contracts import ItemProcessed, ProcessItemRequest

from app.image import BadImageError
from app.jobs import event_json
from app.worker import Worker
from tests.conftest import ITEM, JOB, USER
from tests.memory_store import MemoryJobStore

REQ = ProcessItemRequest(job_id=JOB, user_id=USER, item_id=ITEM, image_path=f"{USER}/originals/a.jpg")
OK = ItemProcessed(job_id=JOB, user_id=USER, item_id=ITEM, ok=True)


class Files:
    def __init__(self):
        self.removed = []

    def download(self, path): raise AssertionError

    def upload(self, *a): raise AssertionError

    def remove(self, paths): self.removed.append(paths)


class Clock:
    def __init__(self):
        self.t = datetime(2026, 10, 4, 10, tzinfo=UTC).timestamp()

    def __call__(self):
        return self.t


def setup(run, send=None):
    clock = Clock()
    store = MemoryJobStore(clock)
    sent = []
    files = Files()
    worker = Worker(store, files, run, send or sent.append, now=clock)
    return store, worker, sent, files, clock


def test_runs_job_and_delivers_event():
    store, worker, sent, _, _ = setup(lambda job: OK)
    store.create(REQ)
    worker.tick()
    assert store.rows[JOB].status == "done" and store.rows[JOB].attempts == 1
    worker.tick()
    assert sent == [event_json(OK)]
    assert store.rows[JOB].event_sent_at is not None


def test_retries_three_times_then_fails():
    def boom(job):
        raise RuntimeError("network down")

    store, worker, _, _, clock = setup(boom)
    store.create(REQ)
    for _ in range(3):
        worker.tick()
        clock.t += 600
    row = store.rows[JOB]
    assert (row.status, row.attempts, row.last_error) == ("failed", 3, "network down")


def test_rejected_photo_fails_at_once():
    def bad(job):
        raise BadImageError("Use a JPEG, PNG or WebP photo")

    store, worker, *_ = setup(bad)
    store.create(REQ)
    worker.tick()
    assert store.rows[JOB].result["error"]["message"] == "Use a JPEG, PNG or WebP photo"
    assert store.rows[JOB].result["error"]["userFacing"] is True


def test_resumes_running_jobs():
    store, worker, *_ = setup(lambda job: OK)
    store.create(REQ)
    store.claim_next()  # the old process took it, then died
    worker.start()
    worker.stop()
    assert store.rows[JOB].status != "running"


def test_event_delivery_backoff():
    calls = []

    def down(event):
        calls.append(event)
        raise RuntimeError("web down")

    store, worker, _, _, clock = setup(lambda job: OK, down)
    store.create(REQ)
    worker.tick()
    worker.tick()
    assert store.rows[JOB].event_attempts == 1 and store.rows[JOB].event_sent_at is None
    worker.tick()  # not due yet
    assert len(calls) == 1
    clock.t += 60
    worker.tick()
    assert len(calls) == 2


def test_removes_files_when_user_deleted_mid_run():
    holder = {}

    def run(job):
        holder["store"].delete_user(USER)
        return OK

    store, worker, _, files, _ = setup(run)
    holder["store"] = store
    store.create(REQ)
    worker.tick()
    assert files.removed == [[f"{USER}/clean/{ITEM}.webp", f"{USER}/thumb/{ITEM}.webp", f"{USER}/cutout/{ITEM}.webp"]]
