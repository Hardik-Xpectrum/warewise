"""Asks the `tagger` job to describe one garment photo; validates, with one repair attempt."""

from __future__ import annotations

import base64
from typing import Any

from app.ai.chain import ChatRequest
from app.ai.router import ai_chat, job_prompt_version, load_prompt
from app.schemas import TAGGER_JSON_SCHEMA, TaggerOutput, parse_tagger_output
from app.tags import extract_json
from app.taxonomy import COLORS, FITS, PATTERNS, SEASONS


class TaggingRejected(Exception):
    """The photo was read fine but isn't something we can add; the message is shown to the user."""


NOT_CLOTHING_MESSAGE = "This photo doesn't look like clothing. Try another photo."
SEVERAL_ITEMS_MESSAGE = "Several items found. Photograph one item at a time."


def system_prompt() -> str:
    return (
        load_prompt("tagger", job_prompt_version("tagger"))
        .replace("{{COLORS}}", ", ".join(COLORS))
        .replace("{{PATTERNS}}", ", ".join(PATTERNS))
        .replace("{{SEASONS}}", ", ".join(SEASONS))
        .replace("{{FITS}}", ", ".join(FITS))
    )


def tag_image(image: bytes, *, user_id: str, job_id: str) -> tuple[TaggerOutput, str]:
    """The validated tags and the name of the model that produced them."""
    data_url = "data:image/webp;base64," + base64.b64encode(image).decode()
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system_prompt()},
        {"role": "user", "content": [
            {"type": "text", "text": "Tag this item. Reply with the JSON object only."},
            {"type": "image_url", "image_url": {"url": data_url}},
        ]},
    ]
    last_error = ""
    for attempt in range(2):
        extra = [] if attempt == 0 else [{"role": "user", "content": f"Your last reply was invalid ({last_error}). Reply again with valid JSON only."}]
        res = ai_chat(ChatRequest(
            job="tagger",
            messages=messages + extra,
            json={"name": "item_tags", "schema": TAGGER_JSON_SCHEMA},
            needs_images=True,
            user_id=user_id,
            request_id=job_id,
        ))
        try:
            tags = parse_tagger_output(extract_json(res.content))
        except ValueError as err:
            last_error = str(err)
            continue
        if not tags.is_clothing:
            raise TaggingRejected(NOT_CLOTHING_MESSAGE)
        if tags.item_count > 1:
            raise TaggingRejected(SEVERAL_ITEMS_MESSAGE)
        return tags, res.provider_model
    raise RuntimeError(f"Tagger returned invalid output twice: {last_error}")
