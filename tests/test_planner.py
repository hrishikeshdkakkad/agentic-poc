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
