"""What POST /v1/renders does with a request. Pure and unit-tested.

A row is a dict with the tryon.renders columns (job_id, user_id, cache_key, status, render_path,
texture {version, front, back}, note, error, quota, cacheable, cached_from, created_at, ...)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class Decision:
    # existing: the same jobId was sent before, answer with its state
    # conflict: the jobId is taken by a different request
    # cached: the same render exists, reuse it (no GPU time)
    kind: Literal["existing", "conflict", "cached", "new"]
    row: dict | None = None


def decide_render(user_id: str, cache_key: str, avatar_version: int | None, same_job: dict | None, hits: list[dict]) -> Decision:
    """`same_job` is the row with the request's jobId, if any; `hits` are this user's finished
    renders with the same cache key. Only complete renders are reused (a partly dressed outfit or
    the offline fallback should get a real render next time), and only when the texture asked for
    is there too (the key includes the avatar version, so it normally is)."""
    if same_job:
        if same_job["user_id"] == user_id and same_job["cache_key"] == cache_key:
            return Decision("existing", same_job)
        return Decision("conflict")
    usable = [
        r
        for r in hits
        if r["user_id"] == user_id
        and r["cache_key"] == cache_key
        and r["status"] == "done"
        and r.get("cacheable")
        and r.get("render_path")
        and (avatar_version is None or (r.get("texture") or {}).get("version") == avatar_version)
    ]
    usable.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return Decision("cached", usable[0]) if usable else Decision("new")
