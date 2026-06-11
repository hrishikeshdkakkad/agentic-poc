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


def survival_weekly_groceries(weeks_left: int, overage: float) -> dict[str, float]:
    """USER POLICY: deeper hole, tighter belt — squeeze 25% per $500 of
    overage, but never starve below a hard floor ($30 Walmart / $15 Indian).

    Called only in DAMAGE_CONTROL. overage = committed − target (> 0).
    Contract in tests/test_planner.py::test_survival_policy_contract.
    """
    squeeze = 0.75 ** int(overage // 500)
    return {"walmart": max(30.0, SURVIVAL_WEEKLY_WALMART * squeeze),
            "indian": max(15.0, SURVIVAL_WEEKLY_INDIAN * squeeze)}


def project_subscriptions(rows: list[dict], today: date) -> dict:
    """Per-merchant monthly subscription estimate from the trailing window.

    Sum of subscriptions-classified spend over SUBS_WINDOW_DAYS, divided by
    the window length in months (60d → 2.0). Deterministic — no cadence
    heuristics; the kill-list needs names and sizes, not predictions.

    Caveats for consumers: a monthly charge seen only once in the window
    projects at HALF its true cost (estimate, not invoice); keys are raw
    merchant strings (falling back to name), so the same service may appear
    under two spellings across data sources.
    """
    start = today - timedelta(days=SUBS_WINDOW_DAYS - 1)
    months = SUBS_WINDOW_DAYS / 30.0
    raw: dict[str, float] = {}
    for r in rows:
        d = r.get("date")
        if d is None or d < start or d > today:
            continue
        if not gamify.is_expense(r.get("category_primary"), r.get("name"),
                                 r.get("merchant"), r.get("amount")):
            continue
        if classify(r.get("name"), r.get("merchant")) != "subscriptions":
            continue
        key = r.get("merchant") or r.get("name") or "unknown"
        raw[key] = raw.get(key, 0.0) + float(r["amount"])
    monthly = {m: round(v / months, 2) for m, v in raw.items()}
    return {"by_merchant": dict(sorted(monthly.items(), key=lambda kv: -kv[1])),
            "total": round(sum(monthly.values()), 2)}


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


def plan_month(rows: list[dict], ms: date, today: date | None = None) -> dict:
    """Plan one month against the envelopes.

    rows are ALL transactions (any month — the subscription projection needs
    trailing history); ms is the month to plan; today bounds month-to-date
    math for the live month. Returns {"plan": {...}, "directives": [...]}.
    """
    today = today or date.today()
    target = gamify.MONTHLY_TARGET
    dim = calendar.monthrange(ms.year, ms.month)[1]
    in_month = (today.year, today.month) == (ms.year, ms.month)
    day = min(today.day, dim) if in_month else dim  # other months: final-day snapshot
    elapsed_share = day / dim
    days_left = dim - day + 1
    weeks_left = max(1, math.ceil(days_left / 7))

    total = 0.0
    rent_posted = 0.0
    spent = {k: 0.0 for k in ENVELOPES}
    spend_days: set = set()
    for r in rows:
        d = r.get("date")
        if d is None or (d.year, d.month) != (ms.year, ms.month):
            continue
        if not gamify.is_expense(r.get("category_primary"), r.get("name"),
                                 r.get("merchant"), r.get("amount")):
            continue
        amt = float(r["amount"])
        total += amt
        spend_days.add(d)
        env = classify(r.get("name"), r.get("merchant"))
        if env == "rent":
            rent_posted += amt
        else:
            spent[env] += amt

    envelopes = []
    # States are imperatives mirroring directive severities: "slow" = slow down.
    for key, budget in ENVELOPES.items():
        used = round(spent[key], 2)
        remaining = round(budget - used, 2)
        state = ("closed" if remaining <= 0
                 else "slow" if used > budget * elapsed_share
                 else "open")
        envelopes.append({
            "key": key, "budget": budget, "spent": used, "remaining": remaining,
            "weekly_allowance": math.floor(max(0.0, remaining) / weeks_left),
            "state": state,
        })

    committed = total + (RENT_RESERVE if rent_posted <= 0 else 0.0)  # rent_posted ≥ 0 always (is_expense drops refunds)
    non_rent_total = total - rent_posted
    non_rent_budget = target - RENT_RESERVE
    if committed >= target:
        # Month is mathematically lost. Goal flips: minimize overage, protect
        # next month. A blown month must LOOK blown — close everything.
        mode = "DAMAGE_CONTROL"
        for e in envelopes:
            e["state"] = "closed"
            e["weekly_allowance"] = 0
    elif (any(e["state"] != "open" for e in envelopes)
          or non_rent_total > non_rent_budget * elapsed_share):
        mode = "TIGHT"
    else:
        mode = "NORMAL"

    rent = {"reserve": RENT_RESERVE,
            "posted": round(rent_posted, 2) if rent_posted > 0 else None,
            "status": "posted" if rent_posted > 0 else "reserved"}
    week = {"days_left": days_left, "weeks_left": weeks_left}
    no_spend_days = max(0, day - len(spend_days))  # consumed by build_directives (Task 6)

    # Past/future months anchor the window at month-end (final-day snapshot).
    subs = project_subscriptions(rows, today if in_month else ms.replace(day=dim))
    subs_total = subs["total"]
    directives: list[dict] = []  # Task 5 replaces this line with build_directives

    plan = {
        "month": ms.isoformat()[:7], "mode": mode, "target": target,
        "total_spent": round(total, 2), "headroom": round(target - total, 2),
        "rent": rent, "envelopes": envelopes, "week": week,
        "projected_subs_monthly": subs_total,
    }
    return {"plan": plan, "directives": directives}
