from datetime import date

import gamify
import planner


# ---- classification ---------------------------------------------------------

def test_config_invariant_rent_plus_envelopes_equals_target():
    assert planner.RENT_RESERVE + sum(planner.ENVELOPES.values()) == gamify.MONTHLY_TARGET


def test_classify_rent():
    assert planner.classify("RENT 15 N CHURCH", "Ett*applejackllcrent") == "rent"


def test_classify_subscriptions_outrank_walmart():
    # Walmart+ membership is a subscription, not groceries
    assert planner.classify("WALMART+ MEMBER 04/26", "Walmart+ Member") == "subscriptions"
    assert planner.classify("WMT PLUS FEB 2026", "Wmt Plus Feb 2026") == "subscriptions"
    assert planner.classify("CLAUDE.AI SUBSCRIPTION", "Claude.ai") == "subscriptions"
    assert planner.classify("OPENAI *CHATGPT SUBSCR", "OpenAI") == "subscriptions"


def test_classify_walmart_stores_but_not_campus_cafeteria():
    assert planner.classify("WALMART GROCERY", "Walmart") == "walmart"
    assert planner.classify("WAL-MART #7368", "Wal-mart #7368") == "walmart"
    # DGTC campus cafeteria is lunch, not groceries — falls to other
    assert planner.classify("AMK WALMART DGTC CAFE", "Amk Walmart Dgtc Cafe") == "other"
    assert planner.classify("WALMART HQ SPARKY 1T1L", "Walmart Hq Sparky 1t1l") == "other"


def test_classify_indian_groceries_but_not_restaurants():
    assert planner.classify("NAMASTE INDIAN GROCERY", "Namaste Indian Grocery") == "indian"
    assert planner.classify("INDIAMART", "Indiamart") == "indian"
    # restaurants match no grocery pattern
    assert planner.classify("PARADISE BIRYANI", "Paradise Biryani") == "other"
    assert planner.classify("KIRPA INDIAN CUISINE", "Kirpa Indian Cuisine") == "other"


def test_classify_everything_else_is_other():
    assert planner.classify("CHIPOTLE", "Chipotle Mexican Grill") == "other"
    assert planner.classify("ALAMO RENT-A-CAR", "Alamo Rent-a-car") == "other"
    assert planner.classify(None, None) == "other"


def test_classify_pattern_false_positive_guards():
    # surname/brand/prefix traps must NOT be classified by accident
    assert planner.classify("DESIGUAL STORE", "Desigual") == "other"
    assert planner.classify("PATEL FAMILY DENTAL", "Patel Family Dental") == "other"
    assert planner.classify("GOOGLE FIBER", "Google Fiber") == "other"
    # the real things still match
    assert planner.classify("GOOGLE *YOUTUBEPREMIUM", "Google") == "subscriptions"
    assert planner.classify("PATEL BROTHERS", "Patel Brothers") == "indian"
    assert planner.classify("DESI BAZAAR", "Desi Bazaar") == "indian"


# ---- plan_month: envelope accounting ----------------------------------------

def _row(d, amt, cp="FOOD_AND_DRINK", merch="Cafe", name="CAFE"):
    return {"date": d, "amount": amt, "category_primary": cp, "merchant": merch, "name": name}


def _june_rows():
    """June 2026 fixture, viewed from Jun 11: rent posted + a bit of each envelope."""
    return [
        _row(date(2026, 6, 4), 1812.80, "OTHER", "Ett*applejackllcrent", "RENT"),
        _row(date(2026, 6, 5), 50.0, "GENERAL_MERCHANDISE", "Walmart", "WALMART GROCERY"),
        _row(date(2026, 6, 6), 40.0, "FOOD_AND_DRINK", "Namaste Indian Grocery", "NAMASTE"),
        _row(date(2026, 6, 7), 20.0, "GENERAL_SERVICES", "OpenAI", "OPENAI *CHATGPT"),
        _row(date(2026, 6, 8), 100.0, "FOOD_AND_DRINK", "Cafe", "CAFE"),
    ]


def test_plan_month_envelope_accounting_and_week_math():
    out = planner.plan_month(_june_rows(), date(2026, 6, 1), date(2026, 6, 11))
    p = out["plan"]
    assert p["month"] == "2026-06"
    assert p["total_spent"] == 2022.80
    assert p["headroom"] == round(2600 - 2022.80, 2)
    assert p["week"] == {"days_left": 20, "weeks_left": 3}
    env = {e["key"]: e for e in p["envelopes"]}
    assert env["walmart"]["spent"] == 50.0
    assert env["walmart"]["remaining"] == 180.0
    assert env["walmart"]["weekly_allowance"] == 60          # floor(180/3)
    assert env["indian"]["weekly_allowance"] == 46           # floor(140/3)
    assert env["subscriptions"]["weekly_allowance"] == 43    # floor(130/3)
    assert env["other"]["weekly_allowance"] == 30            # floor(90/3)
    assert env["walmart"]["state"] == "open"                 # 50 < 230 × 11/30


def test_plan_month_rent_posted_under_reserve_is_buffer_not_redistributed():
    out = planner.plan_month(_june_rows(), date(2026, 6, 1), date(2026, 6, 11))
    p = out["plan"]
    assert p["rent"] == {"reserve": 1850.0, "posted": 1812.80, "status": "posted"}
    # buffer is NOT redistributed: envelope budgets stay exactly CONFIG values
    assert [e["budget"] for e in p["envelopes"]] == [230.0, 180.0, 150.0, 190.0]


def test_plan_month_rent_unposted_is_reserved():
    rows = [_row(date(2026, 6, 2), 30.0)]
    out = planner.plan_month(rows, date(2026, 6, 1), date(2026, 6, 3))
    assert out["plan"]["rent"] == {"reserve": 1850.0, "posted": None, "status": "reserved"}


def test_plan_month_ignores_other_months_and_non_expenses():
    rows = _june_rows() + [
        _row(date(2026, 5, 20), 999.0),                                  # other month
        _row(date(2026, 6, 9), 700.0, "TRANSFER_OUT", "Vault", "Wedding Vault"),  # not an expense
    ]
    out = planner.plan_month(rows, date(2026, 6, 1), date(2026, 6, 11))
    assert out["plan"]["total_spent"] == 2022.80


def test_weekly_allowance_self_corrects_after_overspend():
    rows = _june_rows()
    rows[1] = _row(date(2026, 6, 5), 100.0, "GENERAL_MERCHANDISE", "Walmart", "WALMART GROCERY")
    out = planner.plan_month(rows, date(2026, 6, 1), date(2026, 6, 11))
    env = {e["key"]: e for e in out["plan"]["envelopes"]}
    assert env["walmart"]["weekly_allowance"] == 43          # floor(130/3) — shrank from 60


def test_last_day_of_month_weekly_allowance_is_full_remaining():
    out = planner.plan_month(_june_rows(), date(2026, 6, 1), date(2026, 6, 30))
    p = out["plan"]
    assert p["week"] == {"days_left": 1, "weeks_left": 1}
    env = {e["key"]: e for e in p["envelopes"]}
    assert env["walmart"]["weekly_allowance"] == 180


# ---- modes -------------------------------------------------------------------

def test_mode_tight_when_an_envelope_is_over_pace():
    # _june_rows: 'other' has 100 of 190 spent by day 11 (share 69.67) → slow → TIGHT
    out = planner.plan_month(_june_rows(), date(2026, 6, 1), date(2026, 6, 11))
    assert out["plan"]["mode"] == "TIGHT"
    env = {e["key"]: e for e in out["plan"]["envelopes"]}
    assert env["other"]["state"] == "slow"


def test_mode_normal_when_all_open_and_non_rent_pace_ok():
    rows = [r for r in _june_rows() if r["amount"] != 100.0]   # drop the cafe spend
    out = planner.plan_month(rows, date(2026, 6, 1), date(2026, 6, 11))
    assert out["plan"]["mode"] == "NORMAL"
    # rent posting day 4 must NOT flag TIGHT — pace is judged on non-rent spend
    assert all(e["state"] == "open" for e in out["plan"]["envelopes"])


def test_mode_damage_control_when_month_is_lost_forces_everything_closed():
    rows = _june_rows() + [_row(date(2026, 6, 9), 2413.40, "TRAVEL", "Alamo Rent-a-car", "ALAMO")]
    out = planner.plan_month(rows, date(2026, 6, 1), date(2026, 6, 11))
    p = out["plan"]
    assert p["total_spent"] == 4436.20
    assert p["mode"] == "DAMAGE_CONTROL"
    assert all(e["state"] == "closed" for e in p["envelopes"])
    assert all(e["weekly_allowance"] == 0 for e in p["envelopes"])


def test_mode_damage_control_counts_unposted_rent_as_committed():
    # 800 spent, rent not posted yet: 800 + 1850 reserve = 2650 ≥ 2600 → already lost
    rows = [_row(date(2026, 6, 3), 800.0)]
    out = planner.plan_month(rows, date(2026, 6, 1), date(2026, 6, 5))
    assert out["plan"]["mode"] == "DAMAGE_CONTROL"


def test_empty_rows_is_a_clean_normal_plan():
    out = planner.plan_month([], date(2026, 6, 1), date(2026, 6, 1))
    p = out["plan"]
    assert p["mode"] == "NORMAL"
    assert p["total_spent"] == 0.0
    assert all(e["state"] == "open" and e["remaining"] == e["budget"] for e in p["envelopes"])
    assert p["rent"]["status"] == "reserved"


def test_mode_damage_control_at_exact_target():
    # 750 non-rent + 1850 unposted reserve = exactly 2600 → DC boundary is inclusive
    rows = [_row(date(2026, 6, 3), 750.0)]
    out = planner.plan_month(rows, date(2026, 6, 1), date(2026, 6, 5))
    assert out["plan"]["mode"] == "DAMAGE_CONTROL"


# ---- subscription projection ---------------------------------------------------

def _subs_rows():
    return [
        _row(date(2026, 5, 22), 200.0, "GENERAL_SERVICES", "Claude.ai", "CLAUDE.AI SUBSCRIPTION"),
        _row(date(2026, 4, 20), 100.0, "GENERAL_SERVICES", "Claude.ai", "CLAUDE.AI SUBSCRIPTION"),
        _row(date(2026, 5, 1), 20.0, "GENERAL_SERVICES", "Vercel Inc.", "VERCEL"),
        _row(date(2026, 6, 1), 20.0, "GENERAL_SERVICES", "Vercel Inc.", "VERCEL"),
        _row(date(2026, 5, 5), 20.0, "GENERAL_SERVICES", "OpenAI", "OPENAI *CHATGPT"),
        # outside the 60-day window ending Jun 11 (starts Apr 13) — must be excluded
        _row(date(2026, 4, 10), 102.73, "GENERAL_SERVICES", "Claude.ai", "CLAUDE.AI SUBSCRIPTION"),
        # in window but not a subscription — must be excluded
        _row(date(2026, 6, 5), 50.0, "GENERAL_MERCHANDISE", "Walmart", "WALMART GROCERY"),
    ]


def test_project_subscriptions_trailing_window_per_merchant():
    subs = planner.project_subscriptions(_subs_rows(), date(2026, 6, 11))
    # window = Apr 13..Jun 11 (60 days); monthly = sum / 2
    assert subs["by_merchant"] == {"Claude.ai": 150.0, "Vercel Inc.": 20.0, "OpenAI": 10.0}
    assert subs["total"] == 180.0
    # sorted largest-first (dict preserves insertion order)
    assert list(subs["by_merchant"]) == ["Claude.ai", "Vercel Inc.", "OpenAI"]


def test_plan_month_carries_projected_subs():
    rows = _june_rows() + _subs_rows()
    out = planner.plan_month(rows, date(2026, 6, 1), date(2026, 6, 11))
    # _subs_rows alone projects 180; the Jun-7 OpenAI charge in _june_rows
    # lifts OpenAI from 20/2=10 to 40/2=20, so the total becomes 190.
    assert out["plan"]["projected_subs_monthly"] == 190.0


# ---- survival policy (user-authored) -------------------------------------------

def test_survival_policy_contract():
    """Whatever policy the user writes must honor this contract."""
    for weeks_left in (1, 2, 3, 4, 5):
        for overage in (0.0, 50.0, 1836.20, 5000.45):
            floor = planner.survival_weekly_groceries(weeks_left, overage)
            assert set(floor) == {"walmart", "indian"}
            assert all(isinstance(v, float) and v >= 0.0 for v in floor.values())
            # survival ≠ normal life: combined floor stays under the normal weekly pace
            assert floor["walmart"] + floor["indian"] <= (
                planner.ENVELOPES["walmart"] + planner.ENVELOPES["indian"]) / 4 * 1.5
