"""Newsroom: edition validation, storage round-trip, and the two MCP tools.

The news_editions table is a separate content stream (like
investment_transactions): apply_tags()/apply_overrides() never touch it, and
idempotency rides on the deterministic slug PK (date + slot).
"""

import copy

import pytest

import newsroom
import storage


def _valid_edition() -> dict:
    src = [{"url": "https://example.com/a", "title": "A report",
            "publisher": "Example Wire", "published": "2026-07-01"}]
    article = {
        "kicker": "Markets",
        "headline": "Stocks Climb as Chip Rally Broadens",
        "dek": "Memory makers led the advance.",
        "byline": "By the Newsroom Agent",
        "body": "Stocks rose on **Tuesday**.\n\nA second paragraph.",
        "tickers": ["NVDA"],
        "sources": src,
    }
    return {
        "schema_version": 1,
        "masthead": {
            "edition_label": "Evening Edition",
            "dateline": "Chicago, Tuesday, July 1, 2026",
            "slot": "evening",
            "edition_date": "2026-07-01",
        },
        "lead": dict(article),
        "sections": [
            {"id": "economy", "title": "The Economy", "articles": [dict(article)]},
            {"id": "events", "title": "Upcoming Events", "events": [{
                "when": "2026-07-03", "title": "June Jobs Report",
                "why_it_matters": "Sets the tone for the Fed's next move.",
                "affected": [{"ticker": "SPY", "note": "Broad-market proxy."}],
                "sources": src,
            }]},
            {"id": "chip_desk", "title": "The Chip Desk", "articles": [dict(article)]},
        ],
        "warnings": [],
    }


# ---------------------------------------------------------------- validation

def test_validate_accepts_valid_edition():
    normalized, warnings = newsroom.validate_edition(_valid_edition())
    assert normalized["slug"] == "2026-07-01-evening"
    assert normalized["edition_date"] == "2026-07-01"
    assert normalized["slot"] == "evening"
    assert normalized["title"] == "Evening Edition"
    assert warnings == []


def test_validate_rejects_bad_slot():
    ed = _valid_edition()
    ed["masthead"]["slot"] = "brunch"
    with pytest.raises(ValueError, match="slot"):
        newsroom.validate_edition(ed)


def test_validate_rejects_bad_date():
    ed = _valid_edition()
    ed["masthead"]["edition_date"] = "July 1st"
    with pytest.raises(ValueError, match="edition_date"):
        newsroom.validate_edition(ed)


def test_validate_rejects_missing_lead_headline():
    ed = _valid_edition()
    ed["lead"]["headline"] = "  "
    with pytest.raises(ValueError, match="headline"):
        newsroom.validate_edition(ed)


def test_validate_rejects_empty_sections():
    ed = _valid_edition()
    ed["sections"] = []
    with pytest.raises(ValueError, match="section"):
        newsroom.validate_edition(ed)


def test_validate_warns_on_unsourced_article():
    ed = _valid_edition()
    ed["sections"][0]["articles"][0]["sources"] = []
    _, warnings = newsroom.validate_edition(ed)
    assert any("economy" in w and "source" in w for w in warnings)


def test_validate_warns_on_empty_section():
    ed = _valid_edition()
    ed["sections"].append({"id": "markets", "title": "Markets", "articles": []})
    _, warnings = newsroom.validate_edition(ed)
    assert any("markets" in w for w in warnings)


def test_validate_defaults_title_from_slot():
    ed = _valid_edition()
    ed["masthead"]["slot"] = "midday"
    del ed["masthead"]["edition_label"]
    normalized, _ = newsroom.validate_edition(ed)
    assert normalized["title"] == "Midday Edition"
    assert normalized["slug"] == "2026-07-01-midday"


# ------------------------------------------------------------------- storage

def _count(conn) -> int:
    return conn.execute("SELECT count(*) FROM news_editions").fetchone()[0]


def test_record_news_edition_inserts(db):
    ed = _valid_edition()
    out = storage.record_news_edition(
        db, slug="2026-07-01-evening", edition_date="2026-07-01",
        slot="evening", title="Evening Edition", content=ed)
    assert out["slug"] == "2026-07-01-evening"
    assert out["published_at"]
    assert _count(db) == 1


def test_record_news_edition_upserts_in_place(db):
    ed = _valid_edition()
    first = storage.record_news_edition(
        db, slug="2026-07-01-evening", edition_date="2026-07-01",
        slot="evening", title="Evening Edition", content=ed)
    revised = copy.deepcopy(ed)
    revised["lead"]["headline"] = "Revised: Chips Extend Gains After Hours"
    second = storage.record_news_edition(
        db, slug="2026-07-01-evening", edition_date="2026-07-01",
        slot="evening", title="Evening Edition", content=revised)
    assert _count(db) == 1
    # Re-publishing refreshes content but keeps the original publication time.
    assert second["published_at"] == first["published_at"]
    row = db.execute(
        "SELECT content->'lead'->>'headline' FROM news_editions").fetchone()
    assert row[0].startswith("Revised:")


def test_get_latest_news_edition_row(db):
    old, new = _valid_edition(), _valid_edition()
    new["masthead"]["slot"] = "midday"
    storage.record_news_edition(db, slug="2026-07-01-morning",
                                edition_date="2026-07-01", slot="morning",
                                title="Morning Edition", content=old)
    storage.record_news_edition(db, slug="2026-07-01-midday",
                                edition_date="2026-07-01", slot="midday",
                                title="Midday Edition", content=new)
    db.execute("UPDATE news_editions SET published_at = published_at"
               " - interval '1 hour' WHERE slug = '2026-07-01-morning'")
    row = storage.get_latest_news_edition_row()
    assert row["slug"] == "2026-07-01-midday"
    assert row["content"]["masthead"]["slot"] == "midday"


def test_get_latest_news_edition_row_empty(db):
    assert storage.get_latest_news_edition_row() is None


# --------------------------------------------------------------------- tools

def test_publish_tool_roundtrip(db):
    import server
    out = server._publish_news_edition_impl(_valid_edition())
    assert out["edition"]["slug"] == "2026-07-01-evening"
    assert out["warnings"] == []
    latest = server._get_latest_news_edition_impl()
    assert latest["edition"]["slug"] == "2026-07-01-evening"
    assert latest["edition"]["content"]["lead"]["headline"]
    assert latest["warnings"] == []


def test_publish_tool_surfaces_soft_warnings(db):
    import server
    ed = _valid_edition()
    ed["lead"]["sources"] = []
    out = server._publish_news_edition_impl(ed)
    assert out["edition"]["slug"] == "2026-07-01-evening"
    assert any("source" in w for w in out["warnings"])


def test_publish_tool_rejects_invalid_without_raising(db):
    import server
    ed = _valid_edition()
    ed["masthead"]["slot"] = "brunch"
    out = server._publish_news_edition_impl(ed)
    assert out["edition"] is None
    assert out["error"]["code"] == "INVALID_EDITION"


def test_get_latest_tool_empty(db):
    import server
    out = server._get_latest_news_edition_impl()
    assert out == {"edition": None, "warnings": []}
