"""Data access: the tryon schema and this service's Storage prefix (<userId>/tryon/). The HTTP
layer and the worker use the Store protocol, so route tests run on an in-memory fake."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Protocol

from postgrest.exceptions import APIError
from storage3.exceptions import StorageApiError
from supabase import ClientOptions, create_client

from app.config import env


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


class Store(Protocol):
    def get(self, job_id: str) -> dict | None: ...
    def cache_hits(self, user_id: str, cache_key: str) -> list[dict]: ...
    def insert(self, row: dict) -> bool:
        """False when the job id already exists (a concurrent duplicate request)."""
        ...
    def update(self, job_id: str, patch: dict) -> bool:
        """False when the row no longer exists (the user was deleted meanwhile)."""
        ...
    def claim(self, lease_seconds: int) -> dict | None: ...
    def due_events(self, limit: int) -> list[dict]: ...
    def take_quota(self, model: str, per_minute: int | None, per_day: int | None) -> bool: ...
    def delete_user(self, user_id: str) -> tuple[int, int]:
        """(rows, files) deleted."""
        ...
    def download(self, path: str) -> bytes | None: ...
    def upload(self, path: str, data: bytes, content_type: str) -> None: ...
    def remove(self, paths: list[str]) -> None: ...


class SupabaseStore:
    def __init__(self) -> None:
        self.client = create_client(
            env.supabase_url(),
            env.supabase_key(),
            options=ClientOptions(schema="tryon", auto_refresh_token=False, persist_session=False),
        )
        self.bucket_name = env.bucket()

    @property
    def _renders(self) -> Any:
        return self.client.table("renders")

    @property
    def _bucket(self) -> Any:
        return self.client.storage.from_(self.bucket_name)

    def get(self, job_id: str) -> dict | None:
        data = self._renders.select("*").eq("job_id", job_id).limit(1).execute().data
        return data[0] if data else None

    def cache_hits(self, user_id: str, cache_key: str) -> list[dict]:
        q = self._renders.select("*").eq("user_id", user_id).eq("cache_key", cache_key).eq("status", "done").eq("cacheable", True)
        return q.order("created_at", desc=True).limit(5).execute().data

    def insert(self, row: dict) -> bool:
        try:
            self._renders.insert(row).execute()
            return True
        except APIError as err:
            if err.code == "23505":
                return False
            raise

    def update(self, job_id: str, patch: dict) -> bool:
        return len(self._renders.update(patch).eq("job_id", job_id).execute().data) > 0

    def claim(self, lease_seconds: int) -> dict | None:
        data = self.client.rpc("claim_render", {"p_lease_seconds": lease_seconds}).execute().data
        return data[0] if data else None

    def due_events(self, limit: int) -> list[dict]:
        q = self._renders.select("*").not_.is_("event", "null").is_("event_sent_at", "null").lte("event_after", now_iso())
        return q.order("event_after").limit(limit).execute().data

    def take_quota(self, model: str, per_minute: int | None, per_day: int | None) -> bool:
        res = self.client.rpc("take_model_quota", {"p_model": model, "p_per_minute": per_minute, "p_per_day": per_day}).execute()
        return res.data is True

    def delete_user(self, user_id: str) -> tuple[int, int]:
        prefix = f"{user_id}/tryon"
        files = 0
        # Storage lists one folder level at a time, 1000 per page; everything here is flat.
        for _ in range(100):
            listed = self._bucket.list(prefix, {"limit": 1000}) or []
            paths = [f"{prefix}/{f['name']}" for f in listed if f.get("id")]
            if not paths:
                break
            self._bucket.remove(paths)
            files += len(paths)
        rows = self._renders.delete().eq("user_id", user_id).execute().data
        return len(rows), files

    def download(self, path: str) -> bytes | None:
        """None when the file is gone; other Storage errors raise (the job is retried)."""
        try:
            return self._bucket.download(path)
        except StorageApiError as err:
            if str(err.status) in ("400", "404") or "not found" in str(err.message).lower():
                return None
            raise

    def upload(self, path: str, data: bytes, content_type: str) -> None:
        self._bucket.upload(path, data, {"content-type": content_type, "upsert": "true", "cache-control": "31536000"})

    def remove(self, paths: list[str]) -> None:
        if paths:
            self._bucket.remove(paths)
