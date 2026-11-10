"""Recurring treatments: the dewormer every three months, the flea tablet
every month.

Unlike a vaccine, nobody writes a validity date for these: the schedule *is*
the fact. "Le 10, tous les 3 mois" is stored as its first due date plus a
period, and every later date is derived from that anchor — computed from the
anchor each time rather than step by step, so a schedule on the 31st lands on
28 February and goes back to the 31st in March instead of drifting to the 28th
for ever.

The calendar is fixed, not reset by the dose. Giving the tablet two days late
does not move next month's date: the vet's advice is "le 26 du mois", and a
schedule that slid with every late dose would stop meaning that within a year.

So the question "what is due next?" is answered from the doses: a dose
counts for the scheduled date it is closest to — given on the 24th or the 29th,
it is the 26th's — and the next due date is the one after that. Deleting a
mistaken dose therefore undoes it with no state to repair.
"""

from __future__ import annotations

import calendar
import sqlite3
from datetime import date, datetime

from . import db
from .config import TREATMENT_SOON_DAYS
from .errors import BadRequest, NotFound


# --------------------------------------------------------------------------
# The schedule
# --------------------------------------------------------------------------

def _occurrence(anchor: date, every: int, k: int) -> date:
    """The k-th due date (k may be negative), with the anchor's day of the
    month clamped to the length of the month it lands in."""
    months = anchor.month - 1 + k * every
    year, month = anchor.year + months // 12, months % 12 + 1
    day = min(anchor.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def _covered_index(anchor: date, every: int, given: date) -> int:
    """Which due date a dose given on `given` counts for: the nearest one,
    the earlier on a tie (a dose exactly between two is a late one)."""
    months = (given.year - anchor.year) * 12 + given.month - anchor.month
    base = months // every
    candidates = range(base - 1, base + 3)
    return min(candidates,
               key=lambda k: (abs((_occurrence(anchor, every, k) - given).days), k))


def next_due(anchor: date, every: int, last_dose: date | None) -> date:
    """The first due date no dose has covered — never before the anchor,
    which is by definition the first time anything was due."""
    if last_dose is None:
        return anchor
    after = _occurrence(anchor, every, _covered_index(anchor, every, last_dose) + 1)
    return max(after, anchor)


# --------------------------------------------------------------------------
# Reading
# --------------------------------------------------------------------------

def _state(days_left: int) -> str:
    if days_left < 0:
        return "overdue"
    if days_left == 0:
        return "due"
    if days_left <= TREATMENT_SOON_DAYS:
        return "soon"
    return "ok"


def _build(row, doses: list[dict], today: date) -> dict:
    anchor = date.fromisoformat(row["first_due"])
    last = date.fromisoformat(doses[0]["date"]) if doses else None
    due = next_due(anchor, row["every_months"], last)
    days_left = (due - today).days
    return {
        "id": row["id"],
        "name": row["name"],
        "product": row["product"],
        "first_due": row["first_due"],
        "every_months": row["every_months"],
        "day_of_month": anchor.day,
        "notes": row["notes"],
        "next_due": due.isoformat(),
        "days_left": days_left,
        "state": _state(days_left),
        "last_dose": doses[0]["date"] if doses else None,
        "doses": doses,
    }


def list_treatments(today: date | None = None) -> list[dict]:
    """Soonest due first: the card is read from the top."""
    today = today or date.today()
    with db.cursor() as conn:
        rows = conn.execute("SELECT * FROM treatments ORDER BY name").fetchall()
        doses: dict[int, list[dict]] = {}
        for dose in conn.execute(
            "SELECT id, treatment_id, date FROM treatment_doses ORDER BY date DESC"
        ):
            doses.setdefault(dose["treatment_id"], []).append(
                {"id": dose["id"], "date": dose["date"]})
    out = [_build(row, doses.get(row["id"], []), today) for row in rows]
    out.sort(key=lambda t: (t["next_due"], t["name"]))
    return out


def get_treatment(treatment_id: int) -> dict:
    for treatment in list_treatments():
        if treatment["id"] == treatment_id:
            return treatment
    raise NotFound(f"Traitement {treatment_id} introuvable.")


def overview() -> dict:
    return {"treatments": list_treatments(), "soon_days": TREATMENT_SOON_DAYS}


# --------------------------------------------------------------------------
# Writing
# --------------------------------------------------------------------------

def _iso(value, label: str) -> date:
    raw = (value or "").strip() if isinstance(value, str) else value
    if not raw:
        raise BadRequest(f"{label} est obligatoire.")
    try:
        return date.fromisoformat(raw)
    except (TypeError, ValueError):
        raise BadRequest(f"{label} doit être au format AAAA-MM-JJ.")


def _clean(payload: dict) -> dict:
    name = " ".join((payload.get("name") or "").split())
    if not name:
        raise BadRequest("Le nom du traitement est obligatoire (vermifuge, antipuce…).")
    try:
        every = int(payload.get("every_months") or 0)
    except (TypeError, ValueError):
        raise BadRequest("La fréquence doit être un nombre de mois.")
    if not 1 <= every <= 24:
        raise BadRequest("La fréquence doit être comprise entre 1 et 24 mois.")
    return {
        "name": name,
        "product": " ".join((payload.get("product") or "").split()),
        "first_due": _iso(payload.get("first_due"), "La prochaine échéance").isoformat(),
        "every_months": every,
        "notes": (payload.get("notes") or "").strip(),
    }


def create_treatment(payload: dict) -> dict:
    clean = _clean(payload)
    now = datetime.now().isoformat(timespec="seconds")
    with db.cursor() as conn:
        try:
            new_id = conn.execute(
                "INSERT INTO treatments (name, product, first_due, every_months, notes, "
                "created_at, updated_at) VALUES (:name, :product, :first_due, "
                ":every_months, :notes, :now, :now)",
                {**clean, "now": now},
            ).lastrowid
        except sqlite3.IntegrityError:
            raise BadRequest(f"« {clean['name']} » existe déjà.")
    return get_treatment(new_id)


def update_treatment(treatment_id: int, payload: dict) -> dict:
    clean = _clean(payload)
    with db.cursor() as conn:
        try:
            changed = conn.execute(
                "UPDATE treatments SET name = :name, product = :product, "
                "first_due = :first_due, every_months = :every_months, notes = :notes, "
                "updated_at = :now WHERE id = :id",
                {**clean, "id": treatment_id,
                 "now": datetime.now().isoformat(timespec="seconds")},
            ).rowcount
        except sqlite3.IntegrityError:
            raise BadRequest(f"« {clean['name']} » existe déjà.")
    if not changed:
        raise NotFound(f"Traitement {treatment_id} introuvable.")
    return get_treatment(treatment_id)


def delete_treatment(treatment_id: int) -> None:
    with db.cursor() as conn:
        deleted = conn.execute(
            "DELETE FROM treatments WHERE id = ?", (treatment_id,)).rowcount
    if not deleted:
        raise NotFound(f"Traitement {treatment_id} introuvable.")


def give(treatment_id: int, when=None) -> dict:
    """Record a dose — today unless told otherwise — and return the treatment
    with its next due date already moved on."""
    given = _iso(when, "La date") if when else date.today()
    if given > date.today():
        raise BadRequest("Cette prise est dans le futur.")
    with db.cursor() as conn:
        if conn.execute("SELECT 1 FROM treatments WHERE id = ?",
                        (treatment_id,)).fetchone() is None:
            raise NotFound(f"Traitement {treatment_id} introuvable.")
        # Twice the same day is a double tap, not a double dose.
        conn.execute(
            "INSERT INTO treatment_doses (treatment_id, date, created_at) VALUES (?, ?, ?) "
            "ON CONFLICT(treatment_id, date) DO NOTHING",
            (treatment_id, given.isoformat(), datetime.now().isoformat(timespec="seconds")),
        )
    return get_treatment(treatment_id)


def delete_dose(dose_id: int) -> None:
    with db.cursor() as conn:
        deleted = conn.execute(
            "DELETE FROM treatment_doses WHERE id = ?", (dose_id,)).rowcount
    if not deleted:
        raise NotFound(f"Prise {dose_id} introuvable.")
