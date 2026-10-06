from app.failure import MAX_EVENT_ATTEMPTS, chain_failure, event_retry_delay_s, retry_hint


def test_retry_hint():
    assert retry_hint("You have exceeded your GPU quota (60s requested vs. 0s left). Try again in 18:52:11") == "in about 19 hours"
    assert retry_hint("Try again in 0:04:10") == "in about 5 minutes"
    assert retry_hint("boom") is None


def test_chain_failure():
    msg, retry = chain_failure(["hf-hunyuan3d-2mv: You have exceeded your GPU quota. Try again in 1:00:00", "hf-trellis-multi: daily quota used"])
    assert "GPU quota is used up; it resets in about 1 hour" in msg and retry
    assert chain_failure(["hf-trellis: The free 3D service took too long"])[0].startswith("No 3D service could take the scan")
    assert chain_failure([])[1] is False


def test_event_backoff():
    assert [event_retry_delay_s(n) / 60 for n in range(1, 6)] == [1, 4, 16, 60, 60]
    assert event_retry_delay_s(MAX_EVENT_ATTEMPTS) is None
