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

import json
from datetime import date

from . import db, profile as profile_mod, push, vaccines, weights
from .config import (REMIND_EVERY_DAYS, REMIND_REPEAT_DAYS,
                     VACCINE_EXPIRED_REPEAT_DAYS, VACCINE_REMIND_STAGES)

LAST_REMINDER_KEY = "last_reminder"
VACCINE_REMINDERS_KEY = "vaccine_reminders"


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


# --------------------------------------------------------------------------
# Vaccins
# --------------------------------------------------------------------------
# Same principle as the weighing: no timer set when a vaccine is entered, just
# a question asked every morning — how far is each disease from the end of its
# cover? A crossed stage that hasn't been announced yet goes out, so a morning
# the Mac was asleep is caught up the next day rather than lost.
#
# What was announced is remembered per disease *and validity date*. Entering
# the booster changes the date, which is all it takes to start over.

_MONTHS = ("janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août",
           "sept.", "oct.", "nov.", "déc.")


def _fr(iso: str) -> str:
    day = date.fromisoformat(iso)
    return f"{day.day} {_MONTHS[day.month - 1]} {day.year}"


def _stage(days_left: int) -> int | None:
    """0 once lapsed, else the tightest stage reached, else None.

    Lower is more urgent, so "a new stage was reached" is `stage < sent`.
    """
    if days_left < 0:
        return 0
    reached = [stage for stage in VACCINE_REMIND_STAGES if days_left <= stage]
    return min(reached) if reached else None


def vaccine_state(today: date | None = None) -> list[dict]:
    """Diseases whose reminder is due this morning, and why. Doesn't send."""
    today = today or date.today()
    with db.cursor() as conn:
        sent = json.loads(db.get_meta(conn, VACCINE_REMINDERS_KEY) or "{}")

    due = []
    for line in vaccines.status(vaccines.list_vaccinations(), today):
        if not line["valid_until"] or line["state"] == "pending":
            continue
        stage = _stage(line["days_left"])
        if stage is None:
            continue
        previous = sent.get(line["code"])
        if previous and previous["until"] != line["valid_until"]:
            previous = None                    # a newer vaccine: start over
        if previous is None or stage < previous["stage"]:
            reason = "new-stage"
        elif stage == 0 and (today - date.fromisoformat(previous["sent"])).days \
                >= VACCINE_EXPIRED_REPEAT_DAYS:
            reason = "still-expired"
        else:
            continue
        due.append({**line, "stage": stage, "reason": reason})
    return due


def _vaccine_message(lines: list[dict], name: str) -> tuple[str, str]:
    """One notification for the whole morning, one line per validity date —
    Carré, hépatite and parvovirose lapse together and read as one fact."""
    groups: dict[str, list[dict]] = {}
    for line in lines:
        groups.setdefault(line["valid_until"], []).append(line)

    rows = []
    for until, group in sorted(groups.items()):
        labels = ", ".join(line["label"] for line in group)
        days = group[0]["days_left"]
        if days < 0:
            rows.append(f"{labels} : expiré depuis le {_fr(until)}.")
        elif days == 0:
            rows.append(f"{labels} : expire aujourd'hui.")
        else:
            rows.append(f"{labels} : jusqu'au {_fr(until)} (dans {days} j).")

    expired = any(line["days_left"] < 0 for line in lines)
    who = name or "le chien"
    title = f"Vaccin expiré — {who}" if expired else f"Vaccin à renouveler — {who}"
    return title, "\n".join(rows)


def run_vaccines(force: bool = False) -> dict:
    """Send the vaccine reminder if one is due. Returns what it decided."""
    if force:
        # Everything currently inside a stage, as if nothing had been sent.
        lines = [{**line, "stage": _stage(line["days_left"]), "reason": "forced"}
                 for line in vaccines.status(vaccines.list_vaccinations())
                 if line["valid_until"] and line["state"] != "pending"
                 and _stage(line["days_left"]) is not None]
    else:
        lines = vaccine_state()

    out = {"due": lines, "subscriptions": push.status()["count"]}
    if not lines:
        return {**out, "action": "not-due"}
    if not out["subscriptions"]:
        return {**out, "action": "no-subscribers"}

    title, body = _vaccine_message(lines, profile_mod.get()["name"])
    result = push.send(title, body, tag="vaccines", url="/#/profil")

    if result["sent"]:
        today = date.today().isoformat()
        with db.cursor() as conn:
            sent = json.loads(db.get_meta(conn, VACCINE_REMINDERS_KEY) or "{}")
            for line in lines:
                sent[line["code"]] = {"until": line["valid_until"],
                                      "stage": line["stage"], "sent": today}
            db.set_meta(conn, VACCINE_REMINDERS_KEY, json.dumps(sent))

    return {**out, "action": "sent", "title": title, "body": body, **result}
