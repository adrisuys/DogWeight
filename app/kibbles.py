"""Croquette types: the brand, the variety, and photos of the bag.

A food is a row rather than a string repeated down a column, which is what
makes it correctable — fix the spelling of a brand once and every weighing
that used it reads right, including the ones from two years ago.

Photos earn their place for a practical reason: the bag is where the feeding
chart and the kcal/100 g are printed, and you are usually standing in a shop
when you need them.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime

from . import db, images
from .config import MAX_PHOTOS_PER_KIBBLE
from .errors import BadRequest, NotFound


def label(brand: str, variety: str) -> str:
    """How a food is named everywhere — list, picker, chart annotation."""
    return f"{brand} — {variety}" if variety else brand


def _row_to_kibble(row) -> dict:
    return {
        "id": row["id"],
        "brand": row["brand"],
        "variety": row["variety"],
        "label": label(row["brand"], row["variety"]),
        "kcal_per_100g": row["kcal_per_100g"],
        "notes": row["notes"],
        "archived": bool(row["archived"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _photos_for(conn: sqlite3.Connection, kibble_ids: list[int]) -> dict[int, list[str]]:
    if not kibble_ids:
        return {}
    marks = ",".join("?" * len(kibble_ids))
    rows = conn.execute(
        f"SELECT kibble_id, path FROM kibble_photos WHERE kibble_id IN ({marks}) "
        f"ORDER BY kibble_id, position",
        kibble_ids,
    ).fetchall()
    out: dict[int, list[str]] = {}
    for row in rows:
        out.setdefault(row["kibble_id"], []).append(row["path"])
    return out


def list_kibbles(include_archived: bool = True) -> list[dict]:
    """Every food, with its photos and how much it has been used.

    `uses` and `last_used` come along because they are the only honest way to
    order the list: the bag you are feeding now belongs at the top, and the
    one from 2023 does not.
    """
    where = "" if include_archived else "WHERE k.archived = 0"
    with db.cursor() as conn:
        rows = conn.execute(f"""
            SELECT k.*,
                   COUNT(w.id)  AS uses,
                   MAX(w.date)  AS last_used
              FROM kibbles k
              LEFT JOIN weights w ON w.kibble_id = k.id
              {where}
             GROUP BY k.id
        """).fetchall()
        photos = _photos_for(conn, [row["id"] for row in rows])

    kibbles = []
    for row in rows:
        kibble = _row_to_kibble(row)
        kibble["uses"] = row["uses"]
        kibble["last_used"] = row["last_used"]
        kibble["photos"] = photos.get(row["id"], [])
        kibbles.append(kibble)

    # Three stable passes, least significant first: alphabetical as the
    # baseline, then most-recently-fed on top of it, then the partition that
    # puts the bag you are feeding now above the ones you aren't.
    kibbles.sort(key=lambda k: k["label"].casefold())
    kibbles.sort(key=lambda k: k["last_used"] or "", reverse=True)
    kibbles.sort(key=lambda k: (k["archived"], k["last_used"] is None))
    return kibbles


def get_kibble(kibble_id: int) -> dict:
    with db.cursor() as conn:
        row = conn.execute("SELECT * FROM kibbles WHERE id = ?", (kibble_id,)).fetchone()
        if row is None:
            raise NotFound(f"Croquette {kibble_id} introuvable.")
        kibble = _row_to_kibble(row)
        kibble["photos"] = _photos_for(conn, [kibble_id]).get(kibble_id, [])
        usage = conn.execute(
            "SELECT COUNT(*) AS uses, MAX(date) AS last_used, MIN(date) AS first_used "
            "FROM weights WHERE kibble_id = ?",
            (kibble_id,),
        ).fetchone()
    kibble["uses"] = usage["uses"]
    kibble["last_used"] = usage["last_used"]
    kibble["first_used"] = usage["first_used"]
    return kibble


def _clean(payload: dict) -> dict:
    brand = (payload.get("brand") or "").strip()
    if not brand:
        raise BadRequest("La marque est obligatoire.")

    kcal = payload.get("kcal_per_100g")
    if kcal in ("", None):
        kcal = None
    else:
        if isinstance(kcal, str):
            kcal = kcal.replace(",", ".").strip()
        try:
            kcal = float(kcal)
        except (TypeError, ValueError):
            raise BadRequest("Les kcal/100 g doivent être un nombre.")
        # Dry dog food sits around 300–450 kcal/100 g. Outside this range the
        # user has almost certainly typed the kcal per kilo, or per portion.
        if not 50 <= kcal <= 900:
            raise BadRequest("Les kcal/100 g doivent être comprises entre 50 et 900.")
        kcal = round(kcal, 1)

    return {
        "brand": brand,
        "variety": (payload.get("variety") or "").strip(),
        "kcal_per_100g": kcal,
        "notes": (payload.get("notes") or "").strip(),
        "archived": 1 if payload.get("archived") else 0,
    }


def _clean_photos(payload: dict) -> list[str]:
    photos = payload.get("photos") or []
    if not isinstance(photos, list):
        raise BadRequest("`photos` doit être une liste de chemins.")
    paths: list[str] = []
    for value in photos:
        path = (value or "").strip()
        if not path:
            continue
        # Only paths we wrote ourselves. An arbitrary URL here would turn the
        # card into a request to somebody else's server every time it renders.
        if images.local_name(path) is None:
            raise BadRequest(f"Photo inconnue : {path}")
        if path not in paths:
            paths.append(path)
    if len(paths) > MAX_PHOTOS_PER_KIBBLE:
        raise BadRequest(f"{MAX_PHOTOS_PER_KIBBLE} photos au maximum par croquette.")
    return paths


def _write_photos(conn: sqlite3.Connection, kibble_id: int, paths: list[str]) -> None:
    conn.execute("DELETE FROM kibble_photos WHERE kibble_id = ?", (kibble_id,))
    conn.executemany(
        "INSERT INTO kibble_photos (kibble_id, position, path) VALUES (?, ?, ?)",
        [(kibble_id, index, path) for index, path in enumerate(paths)],
    )


def create_kibble(payload: dict) -> dict:
    clean = _clean(payload)
    photos = _clean_photos(payload)
    now = datetime.now().isoformat(timespec="seconds")
    with db.cursor() as conn:
        try:
            kibble_id = conn.execute(
                "INSERT INTO kibbles (brand, variety, kcal_per_100g, notes, archived, "
                "created_at, updated_at) VALUES (:brand, :variety, :kcal_per_100g, "
                ":notes, :archived, :now, :now)",
                {**clean, "now": now},
            ).lastrowid
        except sqlite3.IntegrityError:
            raise BadRequest(
                f"« {label(clean['brand'], clean['variety'])} » existe déjà."
            )
        _write_photos(conn, kibble_id, photos)
    return get_kibble(kibble_id)


def update_kibble(kibble_id: int, payload: dict) -> dict:
    clean = _clean(payload)
    photos = _clean_photos(payload)
    with db.cursor() as conn:
        if conn.execute("SELECT 1 FROM kibbles WHERE id = ?", (kibble_id,)).fetchone() is None:
            raise NotFound(f"Croquette {kibble_id} introuvable.")
        try:
            conn.execute(
                "UPDATE kibbles SET brand = :brand, variety = :variety, "
                "kcal_per_100g = :kcal_per_100g, notes = :notes, archived = :archived, "
                "updated_at = :now WHERE id = :id",
                {**clean, "id": kibble_id,
                 "now": datetime.now().isoformat(timespec="seconds")},
            )
        except sqlite3.IntegrityError:
            raise BadRequest(
                f"« {label(clean['brand'], clean['variety'])} » existe déjà."
            )
        _write_photos(conn, kibble_id, photos)
    return get_kibble(kibble_id)


def delete_kibble(kibble_id: int) -> None:
    """Remove a food outright.

    Refused while weighings still point at it — that is what archiving is for,
    and silently blanking the food on a year of history is not a thing a
    delete button should be allowed to do.
    """
    with db.cursor() as conn:
        row = conn.execute("SELECT 1 FROM kibbles WHERE id = ?", (kibble_id,)).fetchone()
        if row is None:
            raise NotFound(f"Croquette {kibble_id} introuvable.")
        uses = conn.execute(
            "SELECT COUNT(*) AS n FROM weights WHERE kibble_id = ?", (kibble_id,)
        ).fetchone()["n"]
        if uses:
            raise BadRequest(
                f"{uses} pesée(s) utilisent cette croquette. Archivez-la plutôt "
                f"que de la supprimer."
            )
        conn.execute("DELETE FROM kibbles WHERE id = ?", (kibble_id,))
