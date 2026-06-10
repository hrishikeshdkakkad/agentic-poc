"""Deterministic, rule-based transaction tagging.

Plaid cleans the merchant to the underlying restaurant ("Subway") and keeps the
delivery marker only in the raw description ("DD *DOORDASH SUBWAY"), so delivery
spend is invisible to category- or merchant-based queries. These rules recover
it by scanning the raw name + merchant. Tags are stored in the transaction_tags
table (never overwriting Plaid's category data) and re-applied on every sync and
CSV import, so the set stays current and queryable via a JOIN.

Adding a tag is a one-line entry in _RULES — e.g. a future "wedding" tag keyed
on merchant patterns. compute_tags is a pure function, unit-tested directly.
"""
from __future__ import annotations

import re

# tag -> patterns matched (case-insensitive) against "<name> <merchant>".
_RULES: dict[str, list[re.Pattern]] = {
    "delivery": [re.compile(p) for p in (
        r"doordash",            # "DD *DOORDASH SUBWAY", "DD *DOORDASHDOUBLEDASH"
        r"\bdd \*",             # DoorDash prefix even if "doordash" is abbreviated
        r"uber\s*\*?\s*eats",   # "UBER *EATS", "Uber   *eats", "Uber Eats"
        r"ubereats",
        r"grubhub",
        r"postmates",
        r"gopuff",
    )],
}


def compute_tags(name: str | None, merchant: str | None) -> list[str]:
    """Return the list of tags that apply to one transaction (may be empty).

    Matches on the combined raw name + cleaned merchant so delivery orders that
    Plaid filed under the restaurant name are still caught. Deterministic and
    side-effect free.
    """
    haystack = f"{name or ''} {merchant or ''}".lower()
    return [tag for tag, patterns in _RULES.items()
            if any(p.search(haystack) for p in patterns)]


def known_tags() -> list[str]:
    return list(_RULES)
