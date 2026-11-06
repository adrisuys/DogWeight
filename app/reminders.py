"""Deciding whether it is time to get the scale out.

A three-week timer would be the obvious implementation and the wrong one: it
fires three weeks after it was *set*, not three weeks after the last weighing,
so weighing early silently shortens the next interval and weighing late never
catches up.

So there is no timer. A job runs every morning, asks how long it has been
since the last weighing, and sends only if that answer has crossed the
threshold. Weighing early pushes the next reminder out on its own, because the
question is always about the data rather than about the schedule.

Two guards:

* **It stays due until you weigh.** Once past the threshold the answer is yes
  every morning, so without a floor between sends it would be a daily alarm
  rather than a reminder. `REMIND_REPEAT_DAYS` is that floor.
* **No weighings, no reminder.** There is nothing to be late for yet, and the
  dashboard already says so in bigger letters.
"""

from __future__ import annotations

from datetime import date

from . import db, profile as profile_mod, push, weights
from .config import REMIND_EVERY_DAYS, REMIND_REPEAT_DAYS

LAST_REMINDER_KEY = "last_reminder"


def state() -> dict:
    """Everything the decision rests on, without making it.

    Split out so the CLI can explain itself and the API can show the next
    date, rather than both re-deriving it slightly differently.
    """
    entries = weights.list_entries(limit=1)
    status = push.status()
    today = date.today()

    out = {
        "every_days": REMIND_EVERY_DAYS,
        "last_weighing": entries[0]["date"] if entries else None,
        "days_since": None,
        "due": False,
        "due_date": None,
        "last_reminder": None,
        "days_since_reminder": None,
        # The front end needs both together: the count to say how many
        # devices are on, and the key to subscribe this one.
        "subscriptions": status["count"],
        "public_key": status["public_key"],
    }

    with db.cursor() as conn:
        out["last_reminder"] = db.get_meta(conn, LAST_REMINDER_KEY)

    if out["last_reminder"]:
        out["days_since_reminder"] = (today - date.fromisoformat(out["last_reminder"])).days

    if not entries:
        return out

    last = date.fromisoformat(entries[0]["date"])
    out["days_since"] = (today - last).days
    out["due_date"] = last.toordinal() and date.fromordinal(
        last.toordinal() + REMIND_EVERY_DAYS).isoformat()
    out["due"] = out["days_since"] >= REMIND_EVERY_DAYS
    return out


def _message(info: dict, name: str) -> tuple[str, str]:
    who = name or "Le chien"
    days = info["days_since"]
    weeks = round(days / 7)
    return (
        "Pesée à faire",
        f"{who} n'a pas été pesée depuis {days} jours "
        f"({weeks} semaines). Deux minutes et une balance.",
    )


def run(force: bool = False) -> dict:
    """Send the reminder if it is time. Returns what it decided and why."""
    info = state()
    dog = profile_mod.get()

    if not force:
        if not info["due"]:
            return {**info, "action": "not-due"}
        if info["days_since_reminder"] is not None \
                and info["days_since_reminder"] < REMIND_REPEAT_DAYS:
            return {**info, "action": "too-soon"}

    if not info["subscriptions"]:
        return {**info, "action": "no-subscribers"}

    title, body = _message(info, dog["name"]) if info["days_since"] is not None else (
        "Pesée à faire", f"{dog['name'] or 'Le chien'} n'a pas encore été pesée.")
    result = push.send(title, body, tag="weigh-in", url="/#/pesees")

    # Recorded only when something actually went out, so a morning where every
    # phone was unreachable doesn't quietly reset the clock.
    if result["sent"]:
        with db.cursor() as conn:
            db.set_meta(conn, LAST_REMINDER_KEY, date.today().isoformat())

    return {**info, "action": "sent", **result}
