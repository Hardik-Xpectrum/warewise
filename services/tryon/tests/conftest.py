"""Shared fixtures: the test request body and an in-memory Store."""

from __future__ import annotations

import copy
from datetime import UTC, datetime

USER = "11111111-1111-4111-8111-111111111111"
JOB = "22222222-2222-4222-8222-222222222222"


def render_body(**over: object) -> dict:
    body = {
        "jobId": JOB,
        "userId": USER,
        "personImagePath": f"{USER}/avatar/front.webp",
        "avatarVersion": None,
        "garments": [
            {"itemId": "33333333-3333-4333-8333-333333333333", "slot": "top", "description": "white cotton shirt",
             "imagePath": f"{USER}/clean/a.webp", "cutoutPath": f"{USER}/cutout/a.webp", "updatedAt": "2026-10-01T00:00:00Z"},
            {"itemId": "44444444-4444-4444-8444-444444444444", "slot": "bottom", "description": "blue denim jeans",
             "imagePath": f"{USER}/clean/b.webp", "cutoutPath": None, "updatedAt": "2026-10-01T00:00:00Z"},
        ],
    }
    body.update(over)
    return body


DEFAULTS = {
    "cacheable": False, "cached_from": None, "texture": None, "note": None, "error": None, "render_path": None, "quota": False,
    "attempts": 0, "run_after": "", "event": None, "event_attempts": 0, "event_after": None, "event_sent_at": None, "finished_at": None,
}


class FakeStore:
    def __init__(self, files: dict[str, bytes] | None = None) -> None:
        self.rows: dict[str, dict] = {}
        self.files: dict[str, bytes] = dict(files or {})
        self.deleted: list[str] = []
        self.quota = True

    def get(self, job_id: str) -> dict | None:
        return self.rows.get(job_id)

    def cache_hits(self, user_id: str, cache_key: str) -> list[dict]:
        return [r for r in self.rows.values() if r["user_id"] == user_id and r["cache_key"] == cache_key and r["status"] == "done" and r["cacheable"]]

    def insert(self, row: dict) -> bool:
        if row["job_id"] in self.rows:
            return False
        self.rows[row["job_id"]] = {"created_at": datetime.now(UTC).isoformat(), **DEFAULTS, **copy.deepcopy(row)}
        return True

    def update(self, job_id: str, patch: dict) -> bool:
        if job_id not in self.rows:
            return False
        self.rows[job_id].update(copy.deepcopy(patch))
        return True

    def claim(self, lease_seconds: int) -> dict | None:
        for r in self.rows.values():
            if r["status"] == "queued":
                r["status"] = "running"
                r["attempts"] += 1
                return dict(r)
        return None

    def due_events(self, limit: int) -> list[dict]:
        return [dict(r) for r in self.rows.values() if r["event"] and not r["event_sent_at"]][:limit]

    def take_quota(self, model: str, per_minute: int | None, per_day: int | None) -> bool:
        return self.quota

    def delete_user(self, user_id: str) -> tuple[int, int]:
        self.deleted.append(user_id)
        return 0, 0

    def download(self, path: str) -> bytes | None:
        return self.files.get(path)

    def upload(self, path: str, data: bytes, content_type: str) -> None:
        self.files[path] = data

    def remove(self, paths: list[str]) -> None:
        for p in paths:
            self.files.pop(p, None)
