"""The two errors the API turns into status codes.

They live in their own module so every other module can raise them without
importing a sibling that imports it back.
"""

from __future__ import annotations


class NotFound(LookupError):
    """No such row. Becomes a 404."""


class BadRequest(ValueError):
    """The caller sent something we can't store. Becomes a 400."""
