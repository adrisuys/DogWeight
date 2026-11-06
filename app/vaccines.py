"""The vaccination booklet, and what it adds up to today.

The paper booklet answers "what was injected, when, by whom". The question
you actually have — at the kennel, at a border, booking the next appointment —
is a different one: *is she covered right now, and until when?* That answer is
per disease, not per injection, because the products overlap: a Canigen
DHPPi/L and a Eurican L4 both cover leptospirosis, and it is whichever runs
out last that counts.

So the rows are stored as the booklet has them, one per sticker, and `status`
folds them into one line per disease.

The dates are the ones the vet wrote. Nothing here decides how long a vaccine
lasts — that is the vet's call, and a guessed expiry is worse than a blank.
"""

from __future__ import annotations

import sqlite3
from datetime import date, datetime

from . import db
from .config import DISEASES, KNOWN_VACCINES, VACCINE_SOON_DAYS
from .errors import BadRequest, NotFound


# --------------------------------------------------------------------------
# Reading
# --------------------------------------------------------------------------

def _codes(raw: str) -> list[str]:
    return [code for code in (raw or "").split(",") if code]


def _row_to_vaccination(row) -> dict:
    codes = _codes(row["diseases"])
    return {
        "id": row["id"],
        "date": row["date"],
        "vaccine": row["vaccine"],
        "diseases": codes,
        "disease_labels": [DISEASES.get(code, code) for code in codes],
        "batch": row["batch"],
        "valid_from": row["valid_from"],
        "valid_until": row["valid_until"],
        "vet": row["vet"],
        "notes": row["notes"],
    }


def list_vaccinations() -> list[dict]:
    """Newest first — the booklet is read from its last filled line."""
    with db.cursor() as conn:
        rows = conn.execute(
            "SELECT * FROM vaccinations ORDER BY date DESC, vaccine"
        ).fetchall()
    return [_row_to_vaccination(row) for row in rows]


def get_vaccination(vaccination_id: int) -> dict:
    with db.cursor() as conn:
        row = conn.execute(
            "SELECT * FROM vaccinations WHERE id = ?", (vaccination_id,)
        ).fetchone()
    if row is None:
        raise NotFound(f"Vaccin {vaccination_id} introuvable.")
    return _row_to_vaccination(row)


def status(vaccinations: list[dict], today: date | None = None) -> list[dict]:
    """One line per disease ever vaccinated against, in config order.

    `state` is one of:

    * ``ok``       — covered, and not running out within VACCINE_SOON_DAYS;
    * ``soon``     — covered, but the booster is due within that window;
    * ``expired``  — the last validity date written down has passed;
    * ``pending``  — injected, but not valid yet (rabies' 21 days);
    * ``unknown``  — injected, but no validity date was ever written down.

    Diseases never vaccinated against are left out rather than shown as
    "expired": that would be a claim the booklet doesn't make.
    """
    today = today or date.today()
    best: dict[str, dict] = {}
    for vaccination in vaccinations:
        for code in vaccination["diseases"]:
            current = best.get(code)
            if current is None or _later(vaccination, current):
                best[code] = vaccination

    lines = []
    for code, label in DISEASES.items():
        source = best.get(code)
        if source is None:
            continue
        until = source["valid_until"]
        if not until:
            state, days_left = "unknown", None
        else:
            days_left = (date.fromisoformat(until) - today).days
            if days_left < 0:
                state = "expired"
            elif source["valid_from"] and date.fromisoformat(source["valid_from"]) > today:
                state = "pending"
            elif days_left <= VACCINE_SOON_DAYS:
                state = "soon"
            else:
                state = "ok"
        lines.append({
            "code": code,
            "label": label,
            "state": state,
            "valid_until": until,
            "valid_from": source["valid_from"],
            "days_left": days_left,
            "last_date": source["date"],
            "vaccine": source["vaccine"],
        })
    return lines


def _later(candidate: dict, current: dict) -> bool:
    """Whether `candidate` is the better witness for a disease than `current`.

    The furthest validity date wins — that is what "covered until" means.
    A row with no date only wins against another row with no date, and then
    the more recent injection does.
    """
    a, b = candidate["valid_until"], current["valid_until"]
    if a and b:
        return (a, candidate["date"]) > (b, current["date"])
    if a or b:
        return bool(a)
    return candidate["date"] > current["date"]


def overview() -> dict:
    """Everything the Vaccins card needs, in one call."""
    vaccinations = list_vaccinations()
    return {
        "vaccinations": vaccinations,
        "status": status(vaccinations),
        "diseases": DISEASES,
        "known": KNOWN_VACCINES,
        "soon_days": VACCINE_SOON_DAYS,
    }


# --------------------------------------------------------------------------
# Writing
# --------------------------------------------------------------------------

def _iso(value, label: str, required: bool = False) -> str | None:
    raw = (value or "").strip() if isinstance(value, str) else value
    if not raw:
        if required:
            raise BadRequest(f"{label} est obligatoire.")
        return None
    try:
        return date.fromisoformat(raw).isoformat()
    except (TypeError, ValueError):
        raise BadRequest(f"{label} doit être au format AAAA-MM-JJ.")


def _clean(payload: dict) -> dict:
    vaccine = " ".join((payload.get("vaccine") or "").split())
    if not vaccine:
        raise BadRequest("Le nom du vaccin est obligatoire.")

    given = _iso(payload.get("date"), "La date de vaccination", required=True)
    if date.fromisoformat(given) > date.today():
        raise BadRequest("Cette vaccination est dans le futur.")

    valid_from = _iso(payload.get("valid_from"), "« Valable depuis »")
    valid_until = _iso(payload.get("valid_until"), "« Valable jusqu'au »")
    if valid_from and valid_from < given:
        raise BadRequest("« Valable depuis » précède la date de vaccination.")
    if valid_until and valid_until <= given:
        raise BadRequest("« Valable jusqu'au » doit suivre la date de vaccination.")

    raw = payload.get("diseases") or []
    if isinstance(raw, str):
        raw = raw.split(",")
    codes = []
    for value in raw:
        code = (value or "").strip()
        if not code:
            continue
        if code not in DISEASES:
            raise BadRequest(f"Maladie inconnue : {code}.")
        if code not in codes:
            codes.append(code)
    # Stored in config order, so "D,H,P,Pi" always reads the same way.
    codes.sort(key=list(DISEASES).index)

    return {
        "date": given,
        "vaccine": vaccine,
        "diseases": ",".join(codes),
        # Lot numbers are kept as printed, minus stray spaces.
        "batch": "".join((payload.get("batch") or "").split()),
        "valid_from": valid_from,
        "valid_until": valid_until,
        "vet": (payload.get("vet") or "").strip(),
        "notes": (payload.get("notes") or "").strip(),
    }


def _duplicate(clean: dict) -> BadRequest:
    return BadRequest(
        f"« {clean['vaccine']} » est déjà noté le {clean['date']}."
    )


def create_vaccination(payload: dict) -> dict:
    clean = _clean(payload)
    now = datetime.now().isoformat(timespec="seconds")
    with db.cursor() as conn:
        try:
            new_id = conn.execute(
                "INSERT INTO vaccinations (date, vaccine, diseases, batch, valid_from, "
                "valid_until, vet, notes, created_at, updated_at) VALUES (:date, "
                ":vaccine, :diseases, :batch, :valid_from, :valid_until, :vet, :notes, "
                ":now, :now)",
                {**clean, "now": now},
            ).lastrowid
        except sqlite3.IntegrityError:
            raise _duplicate(clean)
    return get_vaccination(new_id)


def update_vaccination(vaccination_id: int, payload: dict) -> dict:
    clean = _clean(payload)
    with db.cursor() as conn:
        if conn.execute(
            "SELECT 1 FROM vaccinations WHERE id = ?", (vaccination_id,)
        ).fetchone() is None:
            raise NotFound(f"Vaccin {vaccination_id} introuvable.")
        try:
            conn.execute(
                "UPDATE vaccinations SET date = :date, vaccine = :vaccine, "
                "diseases = :diseases, batch = :batch, valid_from = :valid_from, "
                "valid_until = :valid_until, vet = :vet, notes = :notes, "
                "updated_at = :now WHERE id = :id",
                {**clean, "id": vaccination_id,
                 "now": datetime.now().isoformat(timespec="seconds")},
            )
        except sqlite3.IntegrityError:
            raise _duplicate(clean)
    return get_vaccination(vaccination_id)


def delete_vaccination(vaccination_id: int) -> None:
    with db.cursor() as conn:
        deleted = conn.execute(
            "DELETE FROM vaccinations WHERE id = ?", (vaccination_id,)
        ).rowcount
    if not deleted:
        raise NotFound(f"Vaccin {vaccination_id} introuvable.")


def import_rows(rows: list[dict]) -> tuple[int, int]:
    """Add rows from a transcription of the booklet; skip the ones already in.

    Returns (added, skipped). Re-running the same file is therefore harmless,
    which is what makes it safe to append a new visit to it and run it again.
    """
    added = skipped = 0
    for row in rows:
        try:
            create_vaccination(row)
            added += 1
        except BadRequest as exc:
            if "déjà noté" not in str(exc):
                raise BadRequest(f"{row.get('date')} {row.get('vaccine')} : {exc}")
            skipped += 1
    return added, skipped

