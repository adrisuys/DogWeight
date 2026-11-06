"""SQLite storage.

The spreadsheet this replaces had four columns — date, poids, type de
croquette, quantité — with the croquette written out by hand on every row.
Here the croquette is a row of its own that a weighing points at, so renaming
a food, correcting its brand or adding a photo of the bag happens once and
every past weighing follows. That is the whole reason for the split.

Three other things the spreadsheet couldn't hold:

* **The target weight**, in `profile` — a goal belongs to the dog, not to a
  weighing, and the dashboard measures every entry against it.
* **Who the dog is** — breed, age, whether they're neutered, how much they
  move. None of it changes a number on screen; all of it changes what the
  advice is worth, so it lives next to the target it informs.
* **The advice**, in `advice`, one set per weighing. Saving a weighing
  schedules it; it is never asked for. Generating it takes seconds, so the
  save returns first and the row fills in behind it.

One weighing per day, enforced by the UNIQUE on `weights.date`: weighing twice
in an afternoon is a correction, not two facts, and the writer in weights.py
treats it as one.
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from typing import Iterator

from .config import DATA_DIR, DB_PATH

SCHEMA = """
-- One row, id 1. A table rather than key/value pairs because every field is
-- read together, on every dashboard load, and typed columns beat parsing.
CREATE TABLE IF NOT EXISTS profile (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    name           TEXT    NOT NULL DEFAULT '',
    breed          TEXT    NOT NULL DEFAULT '',
    birth_date     TEXT    NOT NULL DEFAULT '',   -- ISO date; '' when unknown
    sex            TEXT    NOT NULL DEFAULT '',   -- 'M' | 'F' | ''
    neutered       INTEGER NOT NULL DEFAULT 0,
    activity       TEXT    NOT NULL DEFAULT '',   -- see config.ACTIVITY_LEVELS
    exercise       TEXT    NOT NULL DEFAULT '',   -- "3,2 km par jour + 2 sorties"
    microchip      TEXT    NOT NULL DEFAULT '',   -- 15 digits, ISO 11784
    target_weight  REAL,                          -- kg; NULL until it is set
    notes          TEXT    NOT NULL DEFAULT '',   -- allergies, vet's advice
    updated_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS kibbles (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    brand          TEXT    NOT NULL,              -- "Royal Canin"
    variety        TEXT    NOT NULL DEFAULT '',   -- "Medium Adult"
    kcal_per_100g  REAL,                          -- off the bag; NULL if unread
    notes          TEXT    NOT NULL DEFAULT '',
    -- Archived rather than deleted: a food you stopped buying still explains
    -- what the weight did last spring, so it leaves the picker and stays in
    -- the history.
    archived       INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL
);

-- The same bag entered twice is a typo, not two foods.
CREATE UNIQUE INDEX IF NOT EXISTS idx_kibbles_name ON kibbles(brand, variety);

CREATE TABLE IF NOT EXISTS kibble_photos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kibble_id  INTEGER NOT NULL REFERENCES kibbles(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,
    path       TEXT    NOT NULL                   -- '/images/<hash>.jpg'
);

CREATE INDEX IF NOT EXISTS idx_photos_kibble ON kibble_photos(kibble_id, position);

CREATE TABLE IF NOT EXISTS weights (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT    NOT NULL UNIQUE,           -- ISO date, one per day
    weight     REAL    NOT NULL,                  -- kg
    -- ON DELETE SET NULL, not CASCADE: deleting a food must never delete the
    -- weighings that happened while the dog was eating it.
    kibble_id  INTEGER REFERENCES kibbles(id) ON DELETE SET NULL,
    grams      REAL,                              -- per day; NULL if unrecorded
    notes      TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_weights_date ON weights(date);

-- Hints, one set per weighing. They are written *by* a weighing, not asked
-- for: saving an entry schedules the generation, and the dashboard shows the
-- latest set when it lands. `status` is what the front end polls on, because
-- the model takes seconds and the save must not wait for it.
--
-- `context_hash` digests exactly the facts that went into the prompt. Editing
-- a weighing changes it, which is the signal to regenerate; reloading the page
-- doesn't, which is why a reload is free.
CREATE TABLE IF NOT EXISTS advice (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    weight_id     INTEGER NOT NULL UNIQUE REFERENCES weights(id) ON DELETE CASCADE,
    status        TEXT    NOT NULL,               -- 'pending' | 'ready' | 'error'
    context_hash  TEXT    NOT NULL DEFAULT '',
    model         TEXT    NOT NULL DEFAULT '',
    payload       TEXT    NOT NULL DEFAULT '',    -- the JSON the model returned
    error         TEXT    NOT NULL DEFAULT '',
    created_at    TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL
);

-- One row per phone that asked to be reminded. Keyed by endpoint, so
-- re-subscribing after a reinstall corrects the row instead of earning you a
-- second notification per reminder.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint    TEXT PRIMARY KEY,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    last_sent   TEXT,
    last_error  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    # Without this the ON DELETE clauses above are silently ignored.
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def cursor() -> Iterator[sqlite3.Connection]:
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


# Columns added after a database was already in use. CREATE TABLE IF NOT
# EXISTS never touches a table that exists, so a database made before them
# gets them here, once, with the same defaults a fresh one would have.
_ADDED_COLUMNS: list[tuple[str, str, str]] = [
    ("profile", "microchip", "TEXT NOT NULL DEFAULT ''"),
]


def init_db() -> None:
    with cursor() as conn:
        conn.executescript(SCHEMA)
        for table, column, decl in _ADDED_COLUMNS:
            have = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
            if column not in have:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
        # The profile row must exist before anything reads it, and it is the
        # one row in the database nobody ever creates on purpose.
        conn.execute(
            "INSERT INTO profile (id, updated_at) VALUES (1, datetime('now')) "
            "ON CONFLICT(id) DO NOTHING"
        )


def get_meta(conn: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
