"""The dog: who they are, and what they should weigh.

One row. Everything here exists because it changes what a number on the
dashboard *means* — 18 kg is a different fact for a two-year-old working
shepherd than for a neutered senior — and because advice.py puts all of it in
the prompt. Nothing here is decoration.
"""

from __future__ import annotations

from datetime import date, datetime

from . import db
from .config import ACTIVITY_LEVELS, SEXES
from .errors import BadRequest

FIELDS = ("name", "breed", "birth_date", "sex", "neutered", "activity",
          "exercise", "target_weight", "microchip", "notes")


def _age(birth_date: str) -> dict | None:
    """Years and months at today's date, or None if the birthday is unknown.

    Computed on read rather than stored, for the obvious reason.
    """
    if not birth_date:
        return None
    try:
        born = date.fromisoformat(birth_date)
    except ValueError:
        return None
    today = date.today()
    months = (today.year - born.year) * 12 + today.month - born.month
    if today.day < born.day:
        months -= 1
    months = max(months, 0)
    return {"years": months // 12, "months": months % 12, "total_months": months}


def _row_to_profile(row) -> dict:
    profile = {key: row[key] for key in FIELDS}
    profile["neutered"] = bool(profile["neutered"])
    profile["sex_label"] = SEXES.get(profile["sex"], "")
    profile["age"] = _age(profile["birth_date"])
    profile["updated_at"] = row["updated_at"]
    return profile


def get() -> dict:
    with db.cursor() as conn:
        row = conn.execute("SELECT * FROM profile WHERE id = 1").fetchone()
    return _row_to_profile(row)


def _clean(payload: dict) -> dict:
    name = (payload.get("name") or "").strip()
    breed = (payload.get("breed") or "").strip()
    notes = (payload.get("notes") or "").strip()
    exercise = (payload.get("exercise") or "").strip()

    birth_date = (payload.get("birth_date") or "").strip()
    if birth_date:
        try:
            parsed = date.fromisoformat(birth_date)
        except ValueError:
            raise BadRequest("La date de naissance doit être au format AAAA-MM-JJ.")
        if parsed > date.today():
            raise BadRequest("La date de naissance est dans le futur.")
        birth_date = parsed.isoformat()

    sex = (payload.get("sex") or "").strip().upper()
    if sex and sex not in SEXES:
        raise BadRequest("Le sexe doit être M ou F.")

    # The chip number is identity rather than measurement: it is kept exactly
    # as read off the vet's scanner, minus the spaces people add in fours.
    # Not validated beyond length — a transponder standard is not worth
    # refusing a number the scanner actually printed.
    microchip = "".join((payload.get("microchip") or "").split())
    if microchip and not (8 <= len(microchip) <= 20):
        raise BadRequest("Le numéro de puce doit faire entre 8 et 20 caractères.")

    activity = (payload.get("activity") or "").strip()
    if activity and activity not in ACTIVITY_LEVELS:
        raise BadRequest(
            "Niveau d'activité inconnu : " + ", ".join(ACTIVITY_LEVELS) + "."
        )

    target = payload.get("target_weight")
    if target in ("", None):
        target = None
    else:
        target = _weight(target, "Le poids de forme")

    return {
        "name": name,
        "breed": breed,
        "birth_date": birth_date,
        "sex": sex,
        "neutered": 1 if payload.get("neutered") else 0,
        "activity": activity,
        "exercise": exercise,
        "target_weight": target,
        "microchip": microchip,
        "notes": notes,
    }


def _weight(value, label: str) -> float:
    """Parse a weight in kg, accepting the comma a French keyboard types."""
    if isinstance(value, str):
        value = value.replace(",", ".").strip()
    try:
        weight = float(value)
    except (TypeError, ValueError):
        raise BadRequest(f"{label} doit être un nombre.")
    # A dog under 500 g or over 120 kg is a typo — a misplaced decimal point
    # on the way in is much likelier than a chihuahua puppy or a mastiff.
    if not 0.5 <= weight <= 120:
        raise BadRequest(f"{label} doit être compris entre 0,5 et 120 kg.")
    return round(weight, 2)


def update(payload: dict) -> dict:
    clean = _clean(payload)
    clean["updated_at"] = datetime.now().isoformat(timespec="seconds")
    assignments = ", ".join(f"{key} = :{key}" for key in clean)
    with db.cursor() as conn:
        conn.execute(f"UPDATE profile SET {assignments} WHERE id = 1", clean)
    return get()


def set_target(value) -> dict:
    """The poids de forme on its own — the dashboard edits it in place."""
    target = None if value in ("", None) else _weight(value, "Le poids de forme")
    with db.cursor() as conn:
        conn.execute(
            "UPDATE profile SET target_weight = ?, updated_at = ? WHERE id = 1",
            (target, datetime.now().isoformat(timespec="seconds")),
        )
    return get()
