import apple_card
import storage

CSV = """Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By
06/04/2026,06/05/2026,"RENT 15 N CHURCH AVE","Applejack Rent","Other","Purchase","1812.80","Me"
06/01/2026,06/02/2026,"APPLE.COM/BILL","Apple Services","Other","Purchase","9.99","Me"
05/31/2026,05/31/2026,"ACH PAYMENT FROM 7568","Ach Payment","Payment","Payment","-2298.33","Me"
05/15/2026,05/15/2026,"COFFEE SHOP","Coffee","Restaurants","Purchase","5.00","Me"
05/15/2026,05/15/2026,"COFFEE SHOP","Coffee","Restaurants","Purchase","5.00","Me"
"""


def test_parse_basic_fields_and_sign():
    rows = apple_card.parse_csv(CSV)
    assert len(rows) == 5
    rent = rows[0]
    assert rent["date"].isoformat() == "2026-06-04"
    assert rent["amount"] == 1812.80          # purchase stays positive (spend)
    assert rent["category_primary"] == "OTHER"
    pay = next(r for r in rows if r["amount"] < 0)
    assert pay["amount"] == -2298.33          # payment stays negative (inflow)
    assert pay["category_primary"] == "PAYMENT"


def test_category_mapping():
    rows = apple_card.parse_csv(CSV)
    coffee = [r for r in rows if r["merchant"] == "Coffee"]
    assert all(r["category_primary"] == "FOOD_AND_DRINK" for r in coffee)
    assert all(r["category_detailed"] == "APPLECARD_RESTAURANTS" for r in coffee)


def test_identical_same_day_rows_get_distinct_ids():
    rows = apple_card.parse_csv(CSV)
    coffee_ids = {r["transaction_id"] for r in rows if r["merchant"] == "Coffee"}
    assert len(coffee_ids) == 2  # occurrence index disambiguates true duplicates


def test_ids_are_deterministic_across_reparse():
    a = apple_card.parse_csv(CSV)
    b = apple_card.parse_csv(CSV)
    assert [r["transaction_id"] for r in a] == [r["transaction_id"] for r in b]


def test_rejects_non_apple_csv():
    import pytest
    with pytest.raises(ValueError, match="not an Apple Card CSV"):
        apple_card.parse_csv("foo,bar\n1,2\n")


def test_import_is_idempotent_and_date_aware(db):
    rows = apple_card.parse_csv(CSV)
    r1 = storage.import_transactions(
        db, rows, apple_card.ITEM_KEY, apple_card.ACCOUNT_ID, apple_card.INSTITUTION
    )
    assert r1["imported"] == 5
    assert r1["total_for_item"] == 5

    # re-upload the exact same file -> nothing new (every date already covered)
    r2 = storage.import_transactions(
        db, rows, apple_card.ITEM_KEY, apple_card.ACCOUNT_ID, apple_card.INSTITUTION
    )
    assert r2["imported"] == 0
    assert r2["skipped_existing_date"] == 5
    assert r2["total_for_item"] == 5


def test_overlapping_statement_only_imports_new_dates(db):
    first = apple_card.parse_csv(CSV)  # dates 05/15..06/04
    storage.import_transactions(
        db, first, apple_card.ITEM_KEY, apple_card.ACCOUNT_ID, apple_card.INSTITUTION
    )
    overlap = """Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By
06/10/2026,06/11/2026,"NEW THING","New","Other","Purchase","42.00","Me"
06/04/2026,06/05/2026,"RENT 15 N CHURCH AVE","Applejack Rent","Other","Purchase","1812.80","Me"
"""
    r = storage.import_transactions(
        db, apple_card.parse_csv(overlap), apple_card.ITEM_KEY,
        apple_card.ACCOUNT_ID, apple_card.INSTITUTION,
    )
    assert r["imported"] == 1                 # only the new 06/10 date
    assert r["skipped_existing_date"] == 1    # 06/04 already covered
    assert r["total_for_item"] == 6
