"""Newsroom edition validation — the contract between the scheduled research
agent and the dashboard's /news renderer.

Pure (no DB, no network, no Plaid) so the publish tool and the tests share one
implementation. The authoritative schema and editorial rules live in
docs/NEWSROOM.md; this module enforces the structural floor:

* Hard failures (malformed slot/date, missing lead headline, zero sections)
  raise ValueError — the edition is unrenderable and must not be stored.
* Recoverable gaps (an unsourced article, an empty section) come back as
  warnings so a partial edition still publishes. The newsroom failure policy
  is "publish what you could source, say what you couldn't".
"""
from __future__ import annotations

from datetime import date

SLOTS = ("morning", "midday", "evening")


def _blank(value) -> bool:
    return not isinstance(value, str) or not value.strip()


def _check_sources(item: dict, where: str, warnings: list[str]) -> None:
    sources = item.get("sources")
    if not isinstance(sources, list) or not sources:
        warnings.append(f"{where}: no sources cited")


def _check_article(article, where: str, warnings: list[str]) -> None:
    if not isinstance(article, dict) or _blank(article.get("headline")):
        warnings.append(f"{where}: article missing a headline")
        return
    _check_sources(article, where, warnings)


def validate_edition(edition) -> tuple[dict, list[str]]:
    """Validate an edition dict; return (normalized, warnings) or raise ValueError.

    ``normalized`` carries the storage row fields: the deterministic slug
    (``YYYY-MM-DD-<slot>``, which is what makes re-publishing idempotent),
    edition_date, slot, title, and the content dict itself.
    """
    if not isinstance(edition, dict):
        raise ValueError("edition must be an object")

    masthead = edition.get("masthead")
    if not isinstance(masthead, dict):
        raise ValueError("masthead is required")

    slot = masthead.get("slot")
    if slot not in SLOTS:
        raise ValueError(f"masthead.slot must be one of {', '.join(SLOTS)}")

    raw_date = masthead.get("edition_date")
    try:
        edition_date = date.fromisoformat(raw_date)
    except (TypeError, ValueError):
        raise ValueError("masthead.edition_date must be an ISO date (YYYY-MM-DD)")

    lead = edition.get("lead")
    if not isinstance(lead, dict) or _blank(lead.get("headline")):
        raise ValueError("lead.headline is required")

    sections = edition.get("sections")
    if not isinstance(sections, list) or not sections:
        raise ValueError("at least one section is required")

    warnings: list[str] = []
    _check_sources(lead, "lead", warnings)

    for i, section in enumerate(sections):
        if not isinstance(section, dict):
            warnings.append(f"section #{i}: not an object, will not render")
            continue
        sid = section.get("id") or f"#{i}"
        articles = section.get("articles") or []
        events = section.get("events") or []
        if not articles and not events:
            warnings.append(f"section '{sid}': empty (no articles or events)")
        for article in articles:
            _check_article(article, f"section '{sid}'", warnings)
        for event in events:
            if isinstance(event, dict):
                _check_sources(event, f"section '{sid}' event", warnings)

    title = masthead.get("edition_label")
    if _blank(title):
        title = f"{slot.capitalize()} Edition"

    normalized = {
        "slug": f"{edition_date.isoformat()}-{slot}",
        "edition_date": edition_date.isoformat(),
        "slot": slot,
        "title": title.strip(),
        "content": edition,
    }
    return normalized, warnings
