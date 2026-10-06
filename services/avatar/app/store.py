"""The service's own data: schema "avatar" and Storage under "<userId>/avatar3d/".

Uses the Supabase service key, which never leaves this service. `Store` is the interface the
routes and the worker use, so tests can swap in an in-memory one.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Protocol

from supabase import Client, ClientOptions, create_client
from warewise_contracts import AvatarVersion, BuildAvatarRequest

from .versions import VersionContents

JobRow = dict[str, Any]
VersionRow = dict[str, Any]


def avatar_prefix(user_id: str) -> str:
    return f"{user_id}/avatar3d"


def mesh_path(user_id: str, job_id: str, file: str) -> str:
    return f"{avatar_prefix(user_id)}/{job_id}/{file}"


def iso(value: str | datetime) -> str:
    """Timestamps as JavaScript's toISOString prints them (UTC, milliseconds, Z)."""
    dt = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return dt.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def now_iso() -> str:
    return iso(datetime.now(UTC))


def to_version(r: VersionRow) -> AvatarVersion:
    return AvatarVersion(
        user_id=r["user_id"],
        version=r["version"],
        kind=r["kind"],
        mesh_path=r.get("mesh_path"),
        face_mesh_path=r.get("face_mesh_path"),
        face_texture_path=r.get("face_texture_path"),
        measurements=r.get("measurements") or {},
        measurement_sources=r.get("measurement_sources") or {},
        textured=bool(r.get("textured")),
        engine=r["engine"],
        created_at=iso(r["created_at"]),
    )


class Store(Protocol):
    def enqueue(self, req: BuildAvatarRequest) -> JobRow: ...
    def claim(self, lease_seconds: int) -> JobRow | None: ...
    def update_job(self, job_id: str, patch: dict[str, Any]) -> None: ...
    def complete_job(self, job: JobRow, v: VersionContents) -> int | None: ...
    def take_quota(self, engine: str, per_day: int | None) -> bool: ...
    def latest_version(self, user_id: str) -> VersionRow | None: ...
    def versions(self, user_id: str) -> list[VersionRow]: ...
    def building(self, user_id: str) -> bool: ...
    def due_events(self, limit: int) -> list[JobRow]: ...
    def delete_user(self, user_id: str) -> int: ...
    def download(self, path: str, max_bytes: int) -> bytes: ...
    def upload(self, path: str, data: bytes, content_type: str) -> None: ...
    def remove(self, paths: list[str]) -> None: ...
    def signed_urls(self, paths: list[str], seconds: int = 3600) -> dict[str, str]: ...


class SupabaseStore:
    def __init__(self, url: str, key: str, bucket: str) -> None:
        self.sb: Client = create_client(url, key, options=ClientOptions(schema="avatar", auto_refresh_token=False, persist_session=False))
        self.bucket = bucket

    def _files(self):  # noqa: ANN202
        return self.sb.storage.from_(self.bucket)

    # -- jobs ---------------------------------------------------------------------------------

    def enqueue(self, req: BuildAvatarRequest) -> JobRow:
        """Inserts the job unless its jobId exists already; returns the stored row either way."""
        row = {"job_id": req.job_id, "user_id": req.user_id, "kind": req.kind, "request": req.to_json()}
        self.sb.table("jobs").upsert(row, on_conflict="job_id", ignore_duplicates=True).execute()
        return self.sb.table("jobs").select("*").eq("job_id", req.job_id).single().execute().data

    def claim(self, lease_seconds: int) -> JobRow | None:
        rows = self.sb.rpc("claim_job", {"p_lease_seconds": lease_seconds}).execute().data or []
        return rows[0] if rows else None

    def update_job(self, job_id: str, patch: dict[str, Any]) -> None:
        self.sb.table("jobs").update({**patch, "updated_at": now_iso()}).eq("job_id", job_id).execute()

    def complete_job(self, job: JobRow, v: VersionContents) -> int | None:
        return self.sb.rpc(
            "complete_job",
            {
                "p_job_id": job["job_id"],
                "p_kind": job["kind"],
                "p_mesh_path": v.mesh_path,
                "p_face_mesh_path": v.face_mesh_path,
                "p_measurements": v.measurements,
                "p_engine": v.engine,
                "p_measurement_sources": v.measurement_sources,
                "p_textured": v.textured,
                "p_face_texture_path": v.face_texture_path,
            },
        ).execute().data

    def take_quota(self, engine: str, per_day: int | None) -> bool:
        if not per_day:
            return True
        return bool(self.sb.rpc("take_engine_quota", {"p_engine": engine, "p_per_day": per_day}).execute().data)

    def due_events(self, limit: int) -> list[JobRow]:
        return (
            self.sb.table("jobs").select("*").not_.is_("event", "null").is_("event_sent_at", "null")
            .lte("event_after", now_iso()).order("event_after").limit(limit).execute().data
        )

    # -- versions -----------------------------------------------------------------------------

    def latest_version(self, user_id: str) -> VersionRow | None:
        rows = self.sb.table("versions").select("*").eq("user_id", user_id).order("version", desc=True).limit(1).execute().data
        return rows[0] if rows else None

    def versions(self, user_id: str) -> list[VersionRow]:
        return self.sb.table("versions").select("*").eq("user_id", user_id).order("version", desc=True).execute().data

    def building(self, user_id: str) -> bool:
        rows = self.sb.table("jobs").select("job_id").eq("user_id", user_id).in_("status", ["queued", "running"]).limit(1).execute().data
        return bool(rows)

    def delete_user(self, user_id: str) -> int:
        """Account deletion: every version, job and file of the user."""
        self.sb.table("jobs").delete().eq("user_id", user_id).execute()
        self.sb.table("versions").delete().eq("user_id", user_id).execute()
        paths = self.list_files(avatar_prefix(user_id))
        for i in range(0, len(paths), 100):
            self._files().remove(paths[i : i + 100])
        return len(paths)

    # -- files --------------------------------------------------------------------------------

    def list_files(self, prefix: str) -> list[str]:
        """Every file under a prefix (Storage lists one folder level at a time)."""
        out: list[str] = []
        for e in self._files().list(prefix, {"limit": 1000}) or []:
            path = f"{prefix}/{e['name']}"
            if e.get("id"):  # files have an id; folders don't
                out.append(path)
            else:
                out.extend(self.list_files(path))
        return out

    def download(self, path: str, max_bytes: int) -> bytes:
        data = self._files().download(path)
        if not data:
            raise FileNotFoundError(f"{path} is missing")
        if len(data) > max_bytes:
            raise ValueError(f"{path} is too large")
        return data

    def upload(self, path: str, data: bytes, content_type: str) -> None:
        self._files().upload(path, data, {"content-type": content_type, "upsert": "true", "cache-control": "604800"})

    def remove(self, paths: list[str]) -> None:
        if paths:
            self._files().remove(paths)

    def signed_urls(self, paths: list[str], seconds: int = 3600) -> dict[str, str]:
        if not paths:
            return {}
        signed = self._files().create_signed_urls(paths, seconds) or []
        return {s["path"]: s["signedUrl"] for s in signed if s.get("path") and s.get("signedUrl")}
