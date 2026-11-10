"""The bell: everything that needs doing, right now.

Not a notification inbox. Nothing here is stored as "unread" or dismissed by
hand: every item is a question asked of the data — is a treatment due, is a
vaccine running out, is a weighing late — so an item disappears the moment the
thing it is about is done, because the answer changed. Ticking the dose,
entering the booster, weighing the dog: that is the "mark as done".

The one exception is buying the next box. The data can't know it was bought,
so that one is ticked by hand, and remembered per due date — the next cycle
asks again.

The push notifications ask the same questions every morning; this is the
version that stays on screen until it is answered.
"""

from __future__ import annotations

import json
from datetime import date

from . import db, profile as profile_mod, reminders, treatments, vaccines
from .config import TREATMENT_BUY_DAYS
from .errors import NotFound

BOUGHT_KEY = "treatment_bought"

# Overdue things first, then what is due today, then what is coming.
_RANK = {"bad": 0, "warn": 1, "info": 2}


def bought() -> dict[str, str]:
    """{treatment id: the due date the box was bought for}."""
    with db.cursor() as conn:
        return json.loads(db.get_meta(conn, BOUGHT_KEY) or "{}")


def mark_bought(treatment_id: int) -> dict:
    treatment = treatments.get_treatment(treatment_id)
    with db.cursor() as conn:
        marks = json.loads(db.get_meta(conn, BOUGHT_KEY) or "{}")
        marks[str(treatment_id)] = treatment["next_due"]
        db.set_meta(conn, BOUGHT_KEY, json.dumps(marks))
    return treatment


def unmark_bought(treatment_id: int) -> None:
    with db.cursor() as conn:
        marks = json.loads(db.get_meta(conn, BOUGHT_KEY) or "{}")
        if marks.pop(str(treatment_id), None) is None:
            raise NotFound(f"Aucun achat noté pour le traitement {treatment_id}.")
        db.set_meta(conn, BOUGHT_KEY, json.dumps(marks))


def build(today: date | None = None) -> list[dict]:
    today = today or date.today()
    items: list[dict] = []
    marks = bought()

    # --- traitements: give (due or late), else buy (within the week) -------
    for t in treatments.list_treatments(today):
        base = {"treatment_id": t["id"], "name": t["name"], "product": t["product"],
                "date": t["next_due"], "days_left": t["days_left"]}
        if t["days_left"] <= 0:
            items.append({**base, "key": f"give-{t['id']}", "kind": "give",
                          "level": "bad" if t["days_left"] < 0 else "warn"})
        elif t["days_left"] <= TREATMENT_BUY_DAYS and marks.get(str(t["id"])) != t["next_due"]:
            items.append({**base, "key": f"buy-{t['id']}", "kind": "buy", "level": "info"})

    # --- vaccins: one item per validity date, like the push ----------------
    groups: dict[str, list[dict]] = {}
    for line in vaccines.status(vaccines.list_vaccinations(), today):
        if line["state"] in ("soon", "expired") and line["valid_until"]:
            groups.setdefault(line["valid_until"], []).append(line)
    for until, lines in sorted(groups.items()):
        days = lines[0]["days_left"]
        items.append({"key": f"vaccine-{until}", "kind": "vaccine",
                      "level": "bad" if days < 0 else "warn",
                      "diseases": [line["label"] for line in lines],
                      "date": until, "days_left": days})

    # --- pesée ------------------------------------------------------------
    info = reminders.state()
    if info["due"]:
        late = info["days_since"] - info["every_days"]
        items.append({"key": "weigh", "kind": "weigh",
                      "level": "bad" if late >= 3 else "warn",
                      "date": info["due_date"], "days_left": -late,
                      "days_since": info["days_since"], "every_days": info["every_days"],
                      "name": profile_mod.get()["name"]})

    items.sort(key=lambda item: (_RANK[item["level"]], item["date"] or ""))
    return items
