import storage
import tagging


def test_doordash_hidden_under_restaurant_name():
    # Plaid cleans merchant to "Subway" but the raw name reveals delivery.
    assert tagging.compute_tags("DD *DOORDASH SUBWAY", "Subway") == ["delivery"]
    assert tagging.compute_tags("DD *DOORDASH TARGET", "Target") == ["delivery"]
    assert tagging.compute_tags("DD *DOORDASHDOUBLEDASH303 2ND ST", "Dd *doordashdoubledash") == ["delivery"]


def test_uber_eats_variants():
    assert tagging.compute_tags("UBER *EATS 1455 MARKET ST", "Uber   *eats") == ["delivery"]
    assert tagging.compute_tags("Uber Eats", "Uber Eats") == ["delivery"]


def test_non_delivery_not_tagged():
    assert tagging.compute_tags("UBER ONE MEMBERSHIP", "Uber   *one Membership") == []
    assert tagging.compute_tags("LYFT *1 RIDE 12-30", "Lyft") == []         # rideshare, not delivery
    assert tagging.compute_tags("CHEVRON 0123456", "Chevron") == []
    assert tagging.compute_tags("SUBWAY 303 2ND ST", "Subway") == []        # in-store, no delivery marker


def test_handles_none_fields():
    assert tagging.compute_tags(None, None) == []


def test_apply_tags_backfills_and_is_idempotent(db):
    db.cursor().executemany(
        "INSERT INTO transactions (transaction_id, item_key, date, amount, merchant, name) "
        "VALUES (%s,%s,%s,%s,%s,%s)",
        [
            ("t1", "CHASE", "2026-05-03", 15.12, "Subway", "DD *DOORDASH SUBWAY"),
            ("t2", "CHASE", "2026-05-04", 11.00, "Chevron", "CHEVRON 0123"),
            ("t3", "APPLECARD", "2026-02-08", 33.22, "Uber   *eats", "UBER *EATS 1455 MARKET ST"),
        ],
    )
    r1 = storage.apply_tags(db)
    assert r1["matched"]["delivery"] == 2          # t1 + t3, not t2
    assert r1["newly_tagged"] == 2

    # re-running tags nothing new
    r2 = storage.apply_tags(db)
    assert r2["newly_tagged"] == 0

    tagged = {row[0] for row in db.execute(
        "SELECT transaction_id FROM transaction_tags WHERE tag='delivery'"
    ).fetchall()}
    assert tagged == {"t1", "t3"}


def test_apply_tags_scoped_to_item(db):
    db.cursor().executemany(
        "INSERT INTO transactions (transaction_id, item_key, date, amount, merchant, name) "
        "VALUES (%s,%s,%s,%s,%s,%s)",
        [
            ("a1", "CHASE", "2026-05-03", 15.0, "Subway", "DD *DOORDASH SUBWAY"),
            ("a2", "APPLECARD", "2026-02-08", 33.0, "Uber *eats", "UBER *EATS MARKET ST"),
        ],
    )
    r = storage.apply_tags(db, item_key="APPLECARD")
    assert r["newly_tagged"] == 1   # only the APPLECARD row scanned
    tagged = {row[0] for row in db.execute(
        "SELECT transaction_id FROM transaction_tags WHERE tag='delivery'"
    ).fetchall()}
    assert tagged == {"a2"}
