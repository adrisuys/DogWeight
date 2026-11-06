"""Weighings, and what they add up to.

The four spreadsheet columns live here — date, poids, croquette, grammes —
plus everything that was previously done by eye: the trend, the distance left
to the target weight, and whether the dog is losing it at a safe rate.

Two rules shape the writes:

* **One weighing per day.** Stepping on the scale twice before breakfast is a
  correction, not two measurements, so `add` updates the day's row instead of
  creating a second one.
* **A number you didn't write down is not zero.** `grams` is nullable and
  stays NULL when the field is left blank; the charts skip the day rather than
  drawing a bar at the baseline, which would read as "fed nothing".
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from . import db, kibbles
from .config import (
    MAX_SAFE_LOSS_RATIO_PER_WEEK,
    TREND_WINDOW_DAYS,
    WEIGHT_NOISE_KG,
)
from .errors import BadRequest, NotFound


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------

def _number(value, label: str, low: float, high: float) -> float:
    """Parse a number, accepting the comma a French keyboard types."""
    if isinstance(value, str):
        value = value.replace(",", ".").strip()
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise BadRequest(f"{label} doit être un nombre.")
    if not low <= number <= high:
        raise BadRequest(f"{label} doit être compris entre {low:g} et {high:g}.")
    return number


def _clean(payload: dict) -> dict:
    raw_date = (payload.get("date") or "").strip()
    if not raw_date:
        raise BadRequest("La date de pesée est obligatoire.")
    try:
        when = date.fromisoformat(raw_date)
    except ValueError:
        raise BadRequest("La date doit être au format AAAA-MM-JJ.")
    if when > date.today():
        raise BadRequest("Cette pesée est dans le futur.")

    weight = round(_number(payload.get("weight"), "Le poids", 0.5, 120), 2)

    grams = payload.get("grams")
    if grams in ("", None):
        grams = None
    else:
        grams = round(_number(grams, "La quantité", 0, 3000), 1)

    kibble_id = payload.get("kibble_id")
    if kibble_id in ("", None):
        kibble_id = None
    else:
        try:
            kibble_id = int(kibble_id)
        except (TypeError, ValueError):
            raise BadRequest("Croquette inconnue.")

    return {
        "date": when.isoformat(),
        "weight": weight,
        "grams": grams,
        "kibble_id": kibble_id,
        "notes": (payload.get("notes") or "").strip(),
    }


# --------------------------------------------------------------------------
# Reads
# --------------------------------------------------------------------------

_SELECT = """
    SELECT w.*, k.brand, k.variety, k.kcal_per_100g
      FROM weights w
      LEFT JOIN kibbles k ON k.id = w.kibble_id
"""


def _row_to_entry(row) -> dict:
    entry = {
        "id": row["id"],
        "date": row["date"],
        "weight": row["weight"],
        "grams": row["grams"],
        "kibble_id": row["kibble_id"],
        "kibble_label": kibbles.label(row["brand"], row["variety"]) if row["brand"] else "",
        "notes": row["notes"],
    }
    # Energy per day, when both halves are known. It is the number that
    # actually drives weight, and neither column alone can say it.
    kcal = row["kcal_per_100g"]
    entry["kcal"] = round(entry["grams"] * kcal / 100) if entry["grams"] and kcal else None
    return entry


def list_entries(limit: int | None = None) -> list[dict]:
    """Every weighing, oldest first — the order the charts plot in."""
    sql = _SELECT + " ORDER BY w.date"
    with db.cursor() as conn:
        rows = conn.execute(sql).fetchall()
    entries = [_row_to_entry(row) for row in rows]
    return entries[-limit:] if limit else entries


def get_entry(entry_id: int) -> dict:
    with db.cursor() as conn:
        row = conn.execute(_SELECT + " WHERE w.id = ?", (entry_id,)).fetchone()
    if row is None:
        raise NotFound(f"Pesée {entry_id} introuvable.")
    return _row_to_entry(row)


# --------------------------------------------------------------------------
# Writes
# --------------------------------------------------------------------------

def add_entry(payload: dict) -> dict:
    """Record a weighing, or correct the one already on that date.

    The UPSERT is the one-per-day rule: the natural key is the date, so a
    second save for the same day lands on the same row. `created_at` is left
    alone on conflict so the row keeps the moment it first appeared.
    """
    clean = _clean(payload)
    _check_kibble(clean["kibble_id"])
    now = datetime.now().isoformat(timespec="seconds")
    with db.cursor() as conn:
        conn.execute(
            "INSERT INTO weights (date, weight, kibble_id, grams, notes, created_at, "
            "updated_at) VALUES (:date, :weight, :kibble_id, :grams, :notes, :now, :now) "
            "ON CONFLICT(date) DO UPDATE SET weight = excluded.weight, "
            "kibble_id = excluded.kibble_id, grams = excluded.grams, "
            "notes = excluded.notes, updated_at = excluded.updated_at",
            {**clean, "now": now},
        )
        entry_id = conn.execute(
            "SELECT id FROM weights WHERE date = ?", (clean["date"],)
        ).fetchone()["id"]
    return get_entry(entry_id)


def update_entry(entry_id: int, payload: dict) -> dict:
    clean = _clean(payload)
    _check_kibble(clean["kibble_id"])
    with db.cursor() as conn:
        if conn.execute("SELECT 1 FROM weights WHERE id = ?", (entry_id,)).fetchone() is None:
            raise NotFound(f"Pesée {entry_id} introuvable.")
        # Moving a weighing onto a date that already has one would collide
        # with the UNIQUE index. Say so, rather than letting SQLite do it.
        clash = conn.execute(
            "SELECT id FROM weights WHERE date = ? AND id <> ?", (clean["date"], entry_id)
        ).fetchone()
        if clash:
            raise BadRequest(f"Une pesée existe déjà au {clean['date']}.")
        conn.execute(
            "UPDATE weights SET date = :date, weight = :weight, kibble_id = :kibble_id, "
            "grams = :grams, notes = :notes, updated_at = :now WHERE id = :id",
            {**clean, "id": entry_id,
             "now": datetime.now().isoformat(timespec="seconds")},
        )
    return get_entry(entry_id)


def delete_entry(entry_id: int) -> None:
    with db.cursor() as conn:
        deleted = conn.execute("DELETE FROM weights WHERE id = ?", (entry_id,)).rowcount
    if not deleted:
        raise NotFound(f"Pesée {entry_id} introuvable.")


def _check_kibble(kibble_id: int | None) -> None:
    if kibble_id is None:
        return
    with db.cursor() as conn:
        if conn.execute("SELECT 1 FROM kibbles WHERE id = ?", (kibble_id,)).fetchone() is None:
            raise NotFound(f"Croquette {kibble_id} introuvable.")


# --------------------------------------------------------------------------
# Trend
# --------------------------------------------------------------------------

def _slope_kg_per_week(entries: list[dict]) -> float | None:
    """Least squares over (day, kg), in kg per week. None below two points.

    A plain first-to-last difference would be at the mercy of whether the dog
    had just eaten on either of those two days. The fit uses every weighing in
    the window, so one heavy morning moves the line a little instead of
    defining it.
    """
    if len(entries) < 2:
        return None
    origin = date.fromisoformat(entries[0]["date"]).toordinal()
    xs = [date.fromisoformat(e["date"]).toordinal() - origin for e in entries]
    ys = [e["weight"] for e in entries]
    n = len(xs)
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    variance = sum((x - mean_x) ** 2 for x in xs)
    if variance == 0:          # every weighing on the same day
        return None
    covariance = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    return covariance / variance * 7


def _window(entries: list[dict], days: int) -> list[dict]:
    if not entries:
        return []
    last = date.fromisoformat(entries[-1]["date"])
    cutoff = (last - timedelta(days=days)).isoformat()
    return [e for e in entries if e["date"] >= cutoff]


def stats(entries: list[dict] | None = None, target: float | None = None) -> dict:
    """Everything the dashboard shows above the charts.

    Takes the entries rather than reading them so the advice prompt and the
    API agree by construction instead of by coincidence.
    """
    if entries is None:
        entries = list_entries()

    out: dict = {
        "count": len(entries),
        "target": target,
        "latest": entries[-1] if entries else None,
        "first_date": entries[0]["date"] if entries else None,
        "min": min((e["weight"] for e in entries), default=None),
        "max": max((e["weight"] for e in entries), default=None),
        "trend_kg_per_week": None,
        "trend_window_days": TREND_WINDOW_DAYS,
        "trend_points": 0,
        "delta_to_target": None,
        "at_target": None,
        "eta_date": None,
        "losing_too_fast": False,
        "change_since_previous": None,
    }
    if not entries:
        return out

    latest = entries[-1]["weight"]

    if len(entries) >= 2:
        change = latest - entries[-2]["weight"]
        # Below the scale's own noise, "unchanged" is the honest reading.
        out["change_since_previous"] = round(change, 2) if abs(change) >= WEIGHT_NOISE_KG else 0.0

    window = _window(entries, TREND_WINDOW_DAYS)
    out["trend_points"] = len(window)
    slope = _slope_kg_per_week(window)
    if slope is not None:
        out["trend_kg_per_week"] = round(slope, 3)
        # Losing faster than ~2% of body weight a week is worth a word with a
        # vet, whichever direction the target lies in.
        out["losing_too_fast"] = -slope > latest * MAX_SAFE_LOSS_RATIO_PER_WEEK

    if target is not None:
        delta = latest - target
        out["delta_to_target"] = round(delta, 2)
        out["at_target"] = abs(delta) <= WEIGHT_NOISE_KG
        # Only project when the trend actually points at the target — a dog
        # drifting the wrong way has no arrival date, and inventing one by
        # extrapolating backwards would be worse than saying nothing.
        if slope and not out["at_target"] and (delta > 0) == (slope < 0):
            weeks = abs(delta / slope)
            if weeks <= 260:      # five years out is not a forecast
                last = date.fromisoformat(entries[-1]["date"])
                out["eta_date"] = (last + timedelta(weeks=weeks)).isoformat()

    return out


def kibble_periods(entries: list[dict]) -> list[dict]:
    """Runs of consecutive weighings on the same food.

    The grams chart marks the boundaries, and the advice prompt uses them to
    say things like "the climb started when you switched bags" — which is the
    question the spreadsheet could never answer, because it had no idea two
    adjacent rows were different foods.
    """
    periods: list[dict] = []
    for entry in entries:
        current = periods[-1] if periods else None
        if current and current["kibble_id"] == entry["kibble_id"]:
            current["to"] = entry["date"]
            current["weights"].append(entry["weight"])
        else:
            periods.append({
                "kibble_id": entry["kibble_id"],
                "label": entry["kibble_label"],
                "from": entry["date"],
                "to": entry["date"],
                "weights": [entry["weight"]],
            })
    for period in periods:
        period["change"] = round(period["weights"][-1] - period["weights"][0], 2)
        period["count"] = len(period["weights"])
        del period["weights"]
    return periods
