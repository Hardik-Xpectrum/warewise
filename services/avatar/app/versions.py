"""What goes into a new avatar version.

A version is the whole avatar the app shows (body mesh, face mesh, measurements), so a scan that
only changes one part carries the others over from the previous version. Version numbers
themselves come from avatar.complete_job in the database, which allocates them under a per-user
advisory lock (race-free: two builds finishing at once get 1 and 2, never 1 and 1).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal

ScanKind = Literal["photo", "body360", "face"]


@dataclass
class Built:
    """What a build produced."""

    measurements: dict[str, float]
    sources: dict[str, str] = field(default_factory=dict)
    mesh_path: str | None = None
    face_mesh_path: str | None = None
    face_texture_path: str | None = None
    engine_key: str | None = None
    textured: bool = False


@dataclass
class VersionContents:
    mesh_path: str | None
    face_mesh_path: str | None
    face_texture_path: str | None
    measurements: dict[str, float]
    measurement_sources: dict[str, str]
    textured: bool
    engine: str


def engine_label(key: str) -> str:
    """Engine names as the contract shows them ("hunyuan3d-2mv", "trellis-multi", "trellis")."""
    return re.sub(r"^hf-", "", key)


def version_contents(kind: ScanKind, previous: dict[str, Any] | None, built: Built) -> VersionContents:
    """`previous` is the user's latest avatar.versions row (or None)."""
    if kind == "face":
        # The face is made on the phone (MediaPipe); the body, its texture flag and its
        # measurements stay as they were.
        keep = bool(previous and previous.get("measurements"))
        return VersionContents(
            mesh_path=(previous or {}).get("mesh_path"),
            face_mesh_path=built.face_mesh_path,
            face_texture_path=built.face_texture_path,
            measurements=previous["measurements"] if keep else built.measurements,  # type: ignore[index]
            measurement_sources=(previous.get("measurement_sources") or {}) if keep else built.sources,  # type: ignore[union-attr]
            textured=bool((previous or {}).get("textured")),
            engine="mediapipe-face",
        )
    return VersionContents(
        mesh_path=built.mesh_path,
        face_mesh_path=(previous or {}).get("face_mesh_path"),  # a new body keeps the last face scan
        face_texture_path=(previous or {}).get("face_texture_path"),
        measurements=built.measurements,
        measurement_sources=built.sources,
        textured=built.textured,
        engine=engine_label(built.engine_key or "unknown"),
    )
