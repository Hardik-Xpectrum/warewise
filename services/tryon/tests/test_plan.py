from datetime import UTC, datetime

from app.plan import TryOnPass, failure_message, plan_passes, retry_hint, until_pacific_midnight


def test_dresses_the_top_first_then_the_bottom():
    p = plan_passes([{"id": "b", "slot": "bottom"}, {"id": "t", "slot": "top"}, {"id": "s", "slot": "shoes"}])
    assert [(x.garment_id, x.region) for x in p] == [("t", "upper_body"), ("b", "lower_body")]


def test_prefers_the_visible_layer_over_the_top_under_it():
    assert plan_passes([{"id": "t", "slot": "top"}, {"id": "o", "slot": "outer"}])[0].garment_id == "o"


def test_uses_one_pass_for_a_dress():
    assert plan_passes([{"id": "d", "slot": "one_piece"}, {"id": "b", "slot": "bottom"}]) == [TryOnPass("d", "dresses", "dress_code", "dress")]


def test_handles_a_bottom_alone_and_nothing_wearable():
    assert [x.region for x in plan_passes([{"id": "b", "slot": "bottom"}])] == ["lower_body"]
    assert plan_passes([{"id": "s", "slot": "shoes"}]) == []


def test_retry_hint_turns_the_quota_wait_into_plain_words():
    assert retry_hint("Try again in 18:52:11. Authenticate") == "in about 19 hours"
    assert retry_hint("try again in 0:04:10") == "in about 5 minutes"
    assert retry_hint("try again in 1:00:00") == "in about 1 hour"
    assert retry_hint("try again in 0:00:30") == "in about 1 minute"
    assert retry_hint("try again in 2:30:00") == "in about 3 hours"  # half rounds up, like Math.round
    assert retry_hint("no hint") is None


def test_tells_people_when_the_free_gpu_time_resets():
    quota = "You have exceeded your free GPU quota (60s requested vs. 12s left). Try again in 5:31:02"
    assert failure_message([quota, quota]) == ("The free GPU time is used up; it resets in about 6 hours. The instant preview still works.", True)


def test_counts_our_own_daily_limit_as_quota_resetting_at_pacific_midnight():
    at_10pm_pacific = datetime(2026, 10, 4, 5, 0, tzinfo=UTC)  # 22:00 PDT
    assert until_pacific_midnight(at_10pm_pacific) == "in about 2 hours"
    assert failure_message(["free quota used"], at_10pm_pacific)[0] == "The free GPU time is used up; it resets in about 2 hours. The instant preview still works."


def test_explains_a_photo_without_a_body_and_other_failures():
    assert "couldn't find a body" in failure_message(['"IndexError"'])[0]
    msg, quota = failure_message(["quota exceeded", "socket hang up"])
    assert "unavailable" in msg and quota is False
    assert failure_message([])[1] is False
    assert failure_message(["quota exceeded"])[0].endswith("resets later today. The instant preview still works.")
