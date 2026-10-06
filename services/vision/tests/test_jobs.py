from datetime import UTC, datetime

from warewise_contracts import ItemProcessed, VisionJobStatus

from app.jobs import EVENT_BACKOFF_S, MAX_ATTEMPTS, JobRow, Outcome, event_json, event_retry, exhausted, iso, public_status, transition
from tests.conftest import ITEM, JOB, USER

NOW = datetime(2026, 10, 4, 10, tzinfo=UTC).timestamp()


def job(attempts: int) -> JobRow:
    return JobRow(job_id=JOB, user_id=USER, item_id=ITEM, image_path=f"{USER}/originals/x.jpg", status="running",
                  attempts=attempts, run_after="", created_at="", updated_at="")


def later(s: float) -> str:
    return iso(NOW + s)


def test_done_schedules_event_now():
    event = ItemProcessed(job_id=JOB, user_id=USER, item_id=ITEM, ok=True)
    patch = transition(job(1), Outcome("done", event=event), NOW)
    assert patch["status"] == "done" and patch["event_after"] == later(0) and patch["event_attempts"] == 0
    assert patch["result"] == {"type": "item.processed", "jobId": JOB, "userId": USER, "itemId": ITEM, "ok": True}


def test_rejected_fails_at_once():
    patch = transition(job(1), Outcome("rejected", message="Use a JPEG, PNG or WebP photo"), NOW)
    assert patch["status"] == "failed"
    err = ItemProcessed.model_validate(patch["result"]).error
    assert err.to_json() == {"message": "Use a JPEG, PNG or WebP photo", "userFacing": True, "retryable": False}


def test_errors_retry_then_fail_generically():
    assert transition(job(1), Outcome("error", message="timeout"), NOW) == {"status": "queued", "last_error": "timeout", "run_after": later(30)}
    assert transition(job(2), Outcome("error", message="timeout"), NOW)["run_after"] == later(120)
    last = transition(job(MAX_ATTEMPTS), Outcome("error", message="timeout"), NOW)
    assert last["status"] == "failed" and last["last_error"] == "timeout"
    assert last["result"]["error"]["userFacing"] is False and last["result"]["error"]["retryable"] is True
    assert "timeout" not in last["result"]["error"]["message"]  # internals stay in the logs


def test_deferral_gives_attempt_back():
    assert transition(job(2), Outcome("deferred"), NOW) == {"status": "queued", "attempts": 1, "run_after": later(120)}


def test_exhausted():
    assert not exhausted(job(MAX_ATTEMPTS))
    assert exhausted(job(MAX_ATTEMPTS + 1))


def test_event_backoff():
    assert [event_retry(n, NOW)["event_after"] for n in range(4)] == [later(s) for s in EVENT_BACKOFF_S]
    assert EVENT_BACKOFF_S == [60, 240, 960, 3600]
    assert event_retry(4, NOW) == {"event_attempts": 5, "event_after": None}


def test_event_json_leaves_out_nulls_for_typescript_optional_fields():
    body = event_json(ItemProcessed(job_id=JOB, user_id=USER, item_id=ITEM, ok=False))
    assert "tags" not in body and "error" not in body and "phash" not in body


def test_public_status_is_a_vision_job_status():
    row = job(1).model_copy(update={"status": "failed", "result": transition(job(1), Outcome("rejected", message="nope"), NOW)["result"]})
    body = public_status(row)
    VisionJobStatus.model_validate(body)
    assert body["error"] == "nope" and body["eventDelivered"] is False
