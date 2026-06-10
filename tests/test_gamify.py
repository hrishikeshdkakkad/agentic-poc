from datetime import date

import gamify


def test_an_expense_is_an_expense():
    # rent, travel, dining all count — no carve-outs
    assert gamify.is_expense("OTHER", "RENT", "Ett*applejackllcrent", 1800.0) is True
    assert gamify.is_expense("TRAVEL", "AGODA", "Agoda", 120.0) is True
    assert gamify.is_expense("FOOD_AND_DRINK", "CHIPOTLE", "Chipotle", 14.0) is True
    assert gamify.is_expense("GOVERNMENT_AND_NON_PROFIT", "IRS", "US Treasury", 960.0) is True


def test_transfers_and_payments_are_not_expenses():
    assert gamify.is_expense("PAYMENT", "ACH DEPOSIT INTERNET TRANSFER FROM 7568", "Ach", -2298.0) is False
    assert gamify.is_expense("LOAN_PAYMENTS", "Payment Thank You-Mobile", "Payment", -700.0) is False
    assert gamify.is_expense("TRANSFER_OUT", "Wedding Vault", "Vault", 700.0) is False
    assert gamify.is_expense("FOOD_AND_DRINK", "REFUND", "Cafe", -10.0) is False   # negative = not an outflow


def test_categorize_carves_rent_from_other():
    assert gamify.categorize("OTHER", "Ett*applejackllcrent", "RENT 15 N CHURCH") == "Rent"
    assert gamify.categorize("TRAVEL", "Agoda", "AGODA") == "Travel"
    assert gamify.categorize("FOOD_AND_DRINK", "Chipotle", "CHIPOTLE") == "Food & Dining"


def _row(d, amt, cp="FOOD_AND_DRINK", merch="Cafe", name="CAFE"):
    return {"date": d, "amount": amt, "category_primary": cp, "merchant": merch, "name": name}


def test_month_under_target_wins_and_funds_wedding():
    ms = date(2026, 7, 1)
    today = date(2026, 8, 1)  # July complete
    rows = [_row(date(2026, 7, 5), 1800.0, "OTHER", "Ett*applejackllcrent", "RENT"),
            _row(date(2026, 7, 10), 300.0)]   # total 2100 < 2600
    m = gamify.score_month(rows, ms, today)
    assert m["total"] == 2100.0
    assert m["won"] is True
    assert m["saved"] == 500.0
    assert m["remaining"] == 500.0


def test_month_over_target_goes_negative_and_saves_nothing():
    ms = date(2026, 5, 1)
    today = date(2026, 6, 1)  # May complete
    rows = [_row(date(2026, 5, 3), 4000.0, "TRAVEL", "Agoda", "AGODA")]
    m = gamify.score_month(rows, ms, today)
    assert m["won"] is False
    assert m["saved"] == 0.0
    assert m["remaining"] == 2600 - 4000           # -1400
    assert m["points"] < 0


def test_mtd_pace_for_live_month():
    ms = date(2026, 6, 1)
    today = date(2026, 6, 10)  # 10 days into a 30-day month
    rows = [_row(date(2026, 6, 2), 1813.0, "OTHER", "Ett*applejackllcrent", "RENT")]
    m = gamify.score_month(rows, ms, today)
    assert m["elapsed_days"] == 10
    assert m["daily_allowance"] == round(2600 / 30, 2)
    assert m["allowance_to_date"] == round(2600 * 10 / 30, 2)   # ~866
    assert m["on_pace"] is False                                # 1813 > 866
    assert m["projected"] == round(1813.0 / 10 * 30, 2)         # 5439 — blowing it


def test_compute_game_best_record_and_wedding_total():
    today = date(2026, 8, 5)  # current month Aug
    rows = (
        [_row(date(2026, 6, 15), 3000.0)] +    # June complete, over
        [_row(date(2026, 7, 15), 2000.0)] +    # July complete, under (the best)
        [_row(date(2026, 8, 1), 100.0)]        # Aug current, tiny
    )
    g = gamify.compute_game(rows, today)
    assert g["months_played"] == 2
    assert g["personal_best"]["month"] == "2026-07"
    assert g["months_won"] == 1                       # only July under 2600
    assert g["wedding_saved_total"] == 600.0          # July saved 600; June saved 0
