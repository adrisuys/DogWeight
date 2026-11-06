"""Croquette-bag photographs on disk.

Lifted wholesale from the recipes app next door, because the rules that made
it right there are not about recipes:

* **We name the file, never the client.** The name is a hash of the bytes plus
  an extension chosen from what those bytes actually are, so a filename from a
  phone can't decide where the file lands or what it is served as.

* **The type is sniffed, not declared.** A `Content-Type` header is a claim by
  the sender. SVG is refused outright — it can carry script and we serve these
  back from our own origin.

* **Names are content-addressed, so files are immutable.** The same photo
  uploaded twice is one file, and `/images/<name>` can be cached forever.

* **Nothing here is authoritative.** `kibble_photos` records what is in use; a
  file no row points at is garbage, and `cli sweep` is what collects it. This
  module never deletes on its own — two foods can share a photo of the same
  shelf, and removing one is not a decision to throw the photograph away.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from . import db
from .config import IMAGE_TYPES, IMAGE_URL_PREFIX, IMAGES_DIR, MAX_IMAGE_BYTES
from .errors import BadRequest, NotFound

# A name we generated: 16 hex characters and a known extension, nothing else.
# Traversal, absolute paths and dotfiles all fail this before touching disk.
NAME_RE = re.compile(r"^[0-9a-f]{16}(\.jpg|\.png|\.webp)$")

_EXTENSIONS = {ext: media for media, ext in IMAGE_TYPES.items()}


def _sniff(blob: bytes) -> str | None:
    """The media type according to the bytes themselves, or None if it isn't
    one we take. Short signatures are enough: we only need to tell three
    formats apart and reject everything else."""
    if blob[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if blob[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return "image/webp"
    return None


def save(blob: bytes) -> str:
    """Write a photo and return the path to store in `kibble_photos.path`."""
    if not blob:
        raise BadRequest("L'envoi était vide.")
    if len(blob) > MAX_IMAGE_BYTES:
        raise BadRequest(
            f"Cette image fait {len(blob) // 1024 // 1024} Mo ; la limite est "
            f"{MAX_IMAGE_BYTES // 1024 // 1024} Mo."
        )

    media_type = _sniff(blob)
    if media_type is None:
        raise BadRequest("Ce fichier n'est pas un JPEG, un PNG ni un WebP.")

    name = hashlib.sha256(blob).hexdigest()[:16] + IMAGE_TYPES[media_type]
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    target = IMAGES_DIR / name
    # Content-addressed, so an identical upload is already the right file and
    # rewriting it would only risk truncating one that is being served.
    if not target.exists():
        target.write_bytes(blob)
    return IMAGE_URL_PREFIX + name


def media_type_for(name: str) -> str:
    return _EXTENSIONS[Path(name).suffix]


def path_for(name: str) -> Path:
    """The file behind `/images/<name>`, or NotFound.

    Validated against NAME_RE rather than sanitised: we only ever generate 16
    hex characters and a known extension, so anything else is not a name we
    wrote and there is nothing to repair.
    """
    if not NAME_RE.match(name):
        raise NotFound(f"Image inconnue : {name}")
    path = IMAGES_DIR / name
    if not path.is_file():
        raise NotFound(f"Image inconnue : {name}")
    return path


def local_name(value: str | None) -> str | None:
    """The filename inside a stored `/images/…` value, or None if it is an
    external URL, empty, or not a name we would have written."""
    if not value or not value.startswith(IMAGE_URL_PREFIX):
        return None
    name = value[len(IMAGE_URL_PREFIX):]
    return name if NAME_RE.match(name) else None


def referenced() -> set[str]:
    """Every local image name some croquette points at."""
    with db.cursor() as conn:
        rows = conn.execute("SELECT path FROM kibble_photos").fetchall()
    names = (local_name(row["path"]) for row in rows)
    return {name for name in names if name}


def stored() -> list[Path]:
    if not IMAGES_DIR.is_dir():
        return []
    return sorted(p for p in IMAGES_DIR.iterdir() if p.is_file() and NAME_RE.match(p.name))


def orphans() -> list[Path]:
    """Files on disk nothing uses — an upload someone then cancelled, or a
    photo replaced by a better one."""
    used = referenced()
    return [path for path in stored() if path.name not in used]
