"""One garment photo, start to finish: clean it, tag it, cut it out, store the three WebPs."""

from __future__ import annotations

from warewise_contracts import ItemPaths, ItemProcessed

from app.ai.chain import AiUnavailableError
from app.files import FileStore
from app.image import BadImageError, make_cutout, process_image
from app.jobs import JobRow, Outcome
from app.tagger import TaggingRejected, tag_image
from app.tags import to_item_tags


def output_paths(user_id: str, item_id: str) -> dict[str, str]:
    """The files a job writes: only under this service's own prefixes."""
    return {
        "clean": f"{user_id}/clean/{item_id}.webp",
        "thumb": f"{user_id}/thumb/{item_id}.webp",
        "cutout": f"{user_id}/cutout/{item_id}.webp",
    }


def classify_error(err: BaseException) -> Outcome:
    """Sorts a raised error into what the job should do next."""
    if isinstance(err, (BadImageError, TaggingRejected)):
        return Outcome("rejected", message=str(err))
    if isinstance(err, AiUnavailableError) and err.reason == "quota":
        return Outcome("deferred")
    return Outcome("error", message=(str(err) or type(err).__name__)[:500])


def process_item(job: JobRow, files: FileStore) -> ItemProcessed:
    """The uploaded original is left alone: it belongs to the item, and the web app removes it."""
    processed = process_image(files.download(job.image_path))

    # Tag before storing anything, so a rejected photo leaves no files behind.
    tags, model = tag_image(processed.clean, user_id=job.user_id, job_id=job.job_id)

    paths = output_paths(job.user_id, job.item_id)
    files.upload(paths["clean"], processed.clean, "image/webp")
    files.upload(paths["thumb"], processed.thumb, "image/webp")
    # Transparent cut-out for the try-on preview; skipped when the garment can't be separated.
    cutout = make_cutout(processed.clean, tags.category)
    if cutout:
        files.upload(paths["cutout"], cutout, "image/webp")

    return ItemProcessed(
        job_id=job.job_id,
        user_id=job.user_id,
        item_id=job.item_id,
        ok=True,
        tags=to_item_tags(tags, model),
        paths=ItemPaths(clean=paths["clean"], thumb=paths["thumb"], cutout=paths["cutout"] if cutout else None),
        phash=processed.phash,
    )
