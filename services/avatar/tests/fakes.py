"""In-memory stand-in for the Supabase-backed store, including complete_job's version allocation."""

from __future__ import annotations

import threading
from datetime import UTC, datetime

from app.store import avatar_prefix
from app.versions import VersionContents


class FakeStore:
    def __init__(self) -> None:
        self.jobs: dict[str, dict] = {}
        self.versions_: list[dict] = []
        self.files: dict[str, bytes] = {}
        self.quota: dict[str, int] = {}
        self._lock = threading.Lock()

    def enqueue(self, req):
        self.jobs.setdefault(req.job_id, {"job_id": req.job_id, "user_id": req.user_id, "kind": req.kind, "request": req.to_json(), "status": "queued", "provider_ref": None, "attempts": 0, "event": None, "event_attempts": 0, "event_after": None, "event_sent_at": None})
        return self.jobs[req.job_id]

    def claim(self, lease_seconds):
        for j in self.jobs.values():
            if j["status"] == "queued":
                j["status"] = "running"
                return dict(j)
        return None

    def update_job(self, job_id, patch):
        if job_id in self.jobs:
            self.jobs[job_id].update(patch)

    def complete_job(self, job, v: VersionContents):
        # Same rules as the SQL: idempotent by job, next version per user under a lock.
        with self._lock:
            if job["job_id"] not in self.jobs:
                return None
            for r in self.versions_:
                if r["job_id"] == job["job_id"]:
                    return r["version"]
            n = max((r["version"] for r in self.versions_ if r["user_id"] == job["user_id"]), default=0) + 1
            self.versions_.append({
                "user_id": job["user_id"], "version": n, "kind": job["kind"], "mesh_path": v.mesh_path, "face_mesh_path": v.face_mesh_path,
                "measurements": v.measurements, "measurement_sources": v.measurement_sources, "textured": v.textured, "engine": v.engine,
                "job_id": job["job_id"], "created_at": datetime.now(UTC).isoformat(),
            })
            ev = {"type": "avatar.ready", "jobId": job["job_id"], "userId": job["user_id"], "version": n}
            self.jobs[job["job_id"]].update(status="done", version=n, provider_ref=None, event=ev, event_attempts=0, event_after="now")
            return n

    def take_quota(self, engine, per_day):
        self.quota[engine] = self.quota.get(engine, 0) + 1
        return not per_day or self.quota[engine] <= per_day

    def latest_version(self, user_id):
        rows = sorted((r for r in self.versions_ if r["user_id"] == user_id), key=lambda r: -r["version"])
        return rows[0] if rows else None

    def versions(self, user_id):
        return sorted((r for r in self.versions_ if r["user_id"] == user_id), key=lambda r: -r["version"])

    def building(self, user_id):
        return any(j["user_id"] == user_id and j["status"] in ("queued", "running") for j in self.jobs.values())

    def due_events(self, limit):
        return [dict(j) for j in self.jobs.values() if j.get("event") and not j.get("event_sent_at") and j.get("event_after")][:limit]

    def delete_user(self, user_id):
        self.jobs = {k: j for k, j in self.jobs.items() if j["user_id"] != user_id}
        self.versions_ = [r for r in self.versions_ if r["user_id"] != user_id]
        gone = [p for p in self.files if p.startswith(avatar_prefix(user_id) + "/")]
        for p in gone:
            del self.files[p]
        return len(gone)

    def download(self, path, max_bytes):
        if path not in self.files:
            raise FileNotFoundError(path)
        return self.files[path]

    def upload(self, path, data, content_type):
        self.files[path] = data

    def remove(self, paths):
        for p in paths:
            self.files.pop(p, None)

    def signed_urls(self, paths, seconds=3600):
        return {p: f"https://storage.test/sign/{p}?token=t" for p in paths}
