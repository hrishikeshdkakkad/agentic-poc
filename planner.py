"""The Optimizer planner: turn the month's transactions into orders.

The scoreboard (gamify.py) answers "where do I stand"; this module answers
"what do I do next". Rent is committed on day 1; four envelopes split the
remaining budget — walmart, indian, subscriptions, other. Classification is
read-time pattern matching from CONFIG, so editing a pattern re-classifies
all history on the next call. Recomputed from transactions every call: no
tables, no stored plan, no writes.
"""
from __future__ import annotations

import calendar
import math
from datetime import date, timedelta

import gamify

# ---- CONFIG (tune freely) --------------------------------------------------
RENT_RESERVE = 1850.0
ENVELOPES = {"walmart": 230.0, "indian": 180.0, "subscriptions": 150.0,
             "other": 190.0}
# Invariant: RENT_RESERVE + sum(ENVELOPES) == gamify.MONTHLY_TARGET (tested).

_RENT = ("applejack",)  # matches gamify.categorize
_SUBS = ("claude.ai", "openai", "chatgpt", "vercel", "google one", "google *",
         "apple services", "apple.com/bill", "uber one", "walmart+",
         "wmt plus", "screenstudio", "nvidia", "playstation network")
_WALMART = ("walmart", "wal-mart")
_WALMART_NOT = ("amk walmart", "dgtc cafe", "dgtc coffe", "dgtc mm",
                "eighth pla", "fh cfa", "hq sparky")  # campus cafeteria, not groceries
_INDIAN = ("namaste", "indiamart", "india mart", "little india", "patel brother",
           "india bazaar", "desi ")

SUBS_WINDOW_DAYS = 60           # trailing window for the kill-list projection
SURVIVAL_WEEKLY_WALMART = 50.0  # damage-control grocery floor (default policy)
SURVIVAL_WEEKLY_INDIAN = 30.0
# ----------------------------------------------------------------------------

ENV_LABEL = {"walmart": "Walmart", "indian": "Indian store",
             "subscriptions": "Subscriptions", "other": "Everything else"}


def classify(name: str | None, merchant: str | None) -> str:
    """Envelope for one transaction: rent|subscriptions|walmart|indian|other.

    First match wins. Subscriptions are checked before walmart so
    'Walmart+ Member' lands in subscriptions; the DGTC campus-cafeteria
    patterns are excluded from walmart (lunch is not groceries) and fall
    through to other.
    """
    hay = f"{name or ''} {merchant or ''}".lower()
    if any(p in hay for p in _RENT):
        return "rent"
    if any(p in hay for p in _SUBS):
        return "subscriptions"
    if any(p in hay for p in _WALMART) and not any(p in hay for p in _WALMART_NOT):
        return "walmart"
    if any(p in hay for p in _INDIAN):
        return "indian"
    return "other"
