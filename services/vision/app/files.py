"""Files in the private "wardrobe" bucket."""

from __future__ import annotations

from typing import Any, Protocol

from app.store import BUCKET

# Same as the web app's photos: a week in caches; paths are per item, so a re-process overwrites.
CACHE_CONTROL = "604800"


class FileStore(Protocol):
    def download(self, path: str) -> bytes: ...

    def upload(self, path: str, body: bytes, content_type: str) -> None: ...

    def remove(self, paths: list[str]) -> None: ...


class SupabaseFiles:
    def __init__(self, db: Any):
        self.db = db

    def _bucket(self) -> Any:
        return self.db.storage.from_(BUCKET)

    def download(self, path: str) -> bytes:
        try:
            return self._bucket().download(path)
        except Exception as err:
            raise RuntimeError(f"download {path}: {err}") from None

    def upload(self, path: str, body: bytes, content_type: str) -> None:
        try:
            self._bucket().upload(path, body, {"content-type": content_type, "upsert": "true", "cache-control": CACHE_CONTROL})
        except Exception as err:
            raise RuntimeError(f"upload {path}: {err}") from None

    def remove(self, paths: list[str]) -> None:
        if paths:
            self._bucket().remove(paths)
