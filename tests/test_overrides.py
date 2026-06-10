import storage


def _seed(db):
    db.cursor().executemany(
        "INSERT INTO transactions (transaction_id, item_key, date, amount, merchant, name, "
        "category_primary, category_detailed) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
        [
            ("c1", "APPLECARD", "2026-04-27", 14.87, "Caseys #3051", "CASEYS #3051",
             "TRANSPORTATION", "APPLECARD_GAS"),
            ("c2", "APPLECARD", "2026-04-28", 9.61, "Caseys #3051", "CASEYS #3051",
             "TRANSPORTATION", "APPLECARD_GAS"),
            ("g1", "CHASE", "2026-05-01", 41.00, "Chevron", "CHEVRON 0123",
             "TRANSPORTATION", "TRANSPORTATION_GAS"),
        ],
    )


def test_merchant_override_rewrites_category_in_place(db):
    _seed(db)
    storage.add_override("merchant", "casey", set_primary="GENERAL_MERCHANDISE",
                         set_detailed="GENERAL_MERCHANDISE_CONVENIENCE_STORES",
                         note="Casey's is snacks, never fuel")
    n = storage.apply_overrides(db)
    assert n == 2  # both Casey's rows; Chevron untouched

    rows = {r[0]: (r[1], r[2]) for r in db.execute(
        "SELECT transaction_id, category_primary, category_detailed FROM transactions"
    ).fetchall()}
    assert rows["c1"] == ("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_CONVENIENCE_STORES")
    assert rows["c2"][1] == "GENERAL_MERCHANDISE_CONVENIENCE_STORES"
    assert rows["g1"] == ("TRANSPORTATION", "TRANSPORTATION_GAS")   # real fuel untouched


def test_apply_overrides_is_idempotent(db):
    _seed(db)
    storage.add_override("merchant", "casey", set_detailed="GENERAL_MERCHANDISE_CONVENIENCE_STORES")
    assert storage.apply_overrides(db) == 2
    assert storage.apply_overrides(db) == 2          # same rows, still correct, no error
    # fuel query now excludes Casey's
    fuel = db.execute(
        "SELECT count(*) FROM transactions WHERE category_detailed LIKE '%GAS%'"
    ).fetchone()[0]
    assert fuel == 1   # only the real Chevron


def test_transaction_override_targets_one_row(db):
    _seed(db)
    storage.add_override("transaction", "g1", set_primary="WEDDING", note="test")
    storage.apply_overrides(db)
    assert db.execute(
        "SELECT category_primary FROM transactions WHERE transaction_id='g1'"
    ).fetchone()[0] == "WEDDING"


def test_list_overrides_and_upsert(db):
    storage.add_override("merchant", "casey", set_detailed="X", note="first")
    storage.add_override("merchant", "casey", set_detailed="Y", note="updated")  # upsert
    ovr = storage.list_overrides()
    assert len(ovr) == 1
    assert ovr[0]["set_detailed"] == "Y" and ovr[0]["note"] == "updated"


def test_bad_match_type_rejected(db):
    import pytest
    with pytest.raises(ValueError, match="match_type"):
        storage.add_override("category", "food")
