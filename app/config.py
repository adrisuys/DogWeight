"""Paths, limits, and the small vocabulary the app shares with itself.

Everything is local: a SQLite file, photos on disk, a static PWA. The only
thing that reaches outside this directory is the advice call, and that goes
through the `claude` binary already installed on this Mac — see advice.py.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
STATIC_DIR = ROOT / "static"
DB_PATH = Path(os.environ.get("DOG_DB", DATA_DIR / "dog.db"))
IMAGES_DIR = Path(os.environ.get("DOG_IMAGES", DATA_DIR / "images"))

WEB_PORT = int(os.environ.get("DOG_PORT", "8740"))

# Photos of a croquette bag, taken on a phone or dragged in from a desktop.
# The browser downscales before sending, so the cap is generous for a real
# photo and still small enough that a video picked by accident can't quietly
# fill the disk.
MAX_IMAGE_BYTES = 6 * 1024 * 1024
MAX_PHOTOS_PER_KIBBLE = 6

# The types we accept, and the extension each is served back as. Sniffed from
# the bytes, never taken from the filename or the request header. SVG is absent
# on purpose: it can carry script, and these are served from our own origin.
IMAGE_TYPES: dict[str, str] = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}

IMAGE_URL_PREFIX = "/images/"

# --------------------------------------------------------------------------
# Advice
# --------------------------------------------------------------------------
# The advice endpoint shells out to Claude Code rather than the Anthropic API:
# it is already installed and already signed in, so there is no key to store
# here and no per-call bill beyond the subscription. CLAUDE_BIN is resolved at
# import time so a missing binary is a clear message rather than an ENOENT
# halfway through a request.
CLAUDE_BIN = os.environ.get("DOG_CLAUDE_BIN") or shutil.which("claude") or "claude"
CLAUDE_MODEL = os.environ.get("DOG_CLAUDE_MODEL", "opus")
# A cold run is ~3s; a thoughtful one with a long history can be much longer.
# The ceiling is here so a wedged subprocess can't hold a worker thread open
# for the rest of the afternoon.
ADVICE_TIMEOUT_S = int(os.environ.get("DOG_ADVICE_TIMEOUT", "180"))

# How much history the advice prompt carries. Long enough to see a trend and a
# couple of food changes, short enough that the prompt stays small.
ADVICE_HISTORY = 40

# --------------------------------------------------------------------------
# Vocabulary
# --------------------------------------------------------------------------
# The whole interface is in French, so these are the strings the UI shows.
# They live here rather than in the front end because advice.py puts them in
# the prompt too, and the two must agree.

ACTIVITY_LEVELS: list[str] = ["calme", "modéré", "actif", "sportif"]

SEXES: dict[str, str] = {"M": "mâle", "F": "femelle"}

# The window the weight trend is measured over. Eight weeks is long enough to
# see through the half-kilo of noise a home scale and a full stomach add, and
# short enough that a diet started last month still shows up.
TREND_WINDOW_DAYS = 56

# A dog losing more than this is losing it too fast, and the dashboard says so.
# Veterinary guidance is 1–2% of body weight per week; we warn above the top of
# that range rather than at the middle of it.
MAX_SAFE_LOSS_RATIO_PER_WEEK = 0.02

# Below this, a difference between two weighings is the scale, not the dog.
WEIGHT_NOISE_KG = 0.1
