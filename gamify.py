"""The Optimizer game: hold the whole month under one hard number.

The user's rule: an expense is an expense. Rent, a trip to CA, dining, taxes —
all count equally. No one-off-vs-recurring distinction, no excuses. Win the
month by finishing under TARGET; every dollar under is a dollar to the wedding.
Aggressive by design.

Counts every real third-party outflow. Excludes only money that isn't actually
an expense: transfers between your own accounts, credit-card bill payments (the
purchases were already counted when made), and contributions to your own
savings/investments. Refunds are NOT netted — gross spend, no explanations.

State is recomputed from transactions every call, so the score can't drift.
Tune via the CONFIG block.
"""
from __future__ import annotations

import calendar
from datetime import date

# ---- CONFIG (tune freely) --------------------------------------------------
MONTHLY_TARGET = 2600.0    # the whole month, everything in
NO_SPEND_DAY_PTS = 25      # reward for a $0 day (category-neutral discipline)
RECORD_BONUS = 100         # for beating your best month
GAME_START = date(2026, 6, 1)
# ----------------------------------------------------------------------------

# Not expenses: account-to-account moves, card payments, savings/investing.
_NONSPEND_CATS = {"LOAN_PAYMENTS", "TRANSFER_IN", "TRANSFER_OUT",
                  "LOAN_DISBURSEMENTS", "INCOME", "PAYMENT", "CREDIT", "DEBIT"}
_NONSPEND_NAME = ("payment thank", "ach ", "ach deposit", "internet transfer",
                  "payyourselfback", "statement credit", "daily cash",
                  "autopay", "vault", "recurring payment")


def is_expense(category_primary, name, merchant, amount) -> bool:
    """True if this is a real expense (any third-party outflow), per the user's
    'an expense is an expense' rule. Only transfers/card-payments/savings are
    excluded — never a real purchase, no matter the category."""
    if amount is None or amount <= 0:
        return False
    if (category_primary or "").upper() in _NONSPEND_CATS:
        return False
    hay = f"{name or ''} {merchant or ''}".lower()
    return not any(k in hay for k in _NONSPEND_NAME)


def categorize(category_primary, merchant, name) -> str:
    """Coarse label for the month's breakdown (display only — never affects
    whether something counts; every expense counts equally)."""
    m = f"{merchant or ''} {name or ''}".lower()
    cp = (category_primary or "").upper()
    if "applejack" in m:
        return "Rent"
    if cp == "FOOD_AND_DRINK":
        return "Food & Dining"
    if cp == "TRAVEL":
        return "Travel"
    if cp == "TRANSPORTATION":
        return "Transportation"
    if cp == "GENERAL_MERCHANDISE":
        return "Shopping"
    if cp == "GENERAL_SERVICES":
        return "Services"
    if cp == "GOVERNMENT_AND_NON_PROFIT":
        return "Taxes & Gov"
    if cp == "ENTERTAINMENT":
        return "Entertainment"
    if cp in ("PERSONAL_CARE", "MEDICAL"):
        return "Health"
    if cp == "RENT_AND_UTILITIES":
        return "Utilities"
    return "Other"


def month_start(d: date) -> date:
    return d.replace(day=1)


def _days_in_month(d: date) -> int:
    return calendar.monthrange(d.year, d.month)[1]


def score_month(rows: list[dict], ms: date, today: date | None = None) -> dict:
    """Score one month against MONTHLY_TARGET. rows are that month's
    transactions; today bounds the month-to-date pace for the live month."""
    today = today or date.today()
    target = MONTHLY_TARGET
    dim = _days_in_month(ms)
    last = ms.replace(day=dim)
    elapsed = min(dim, max(1, (min(today, last) - ms).days + 1))

    total = 0.0
    spend_days: set = set()
    by_cat: dict[str, float] = {}
    for r in rows:
        if not is_expense(r.get("category_primary"), r.get("name"),
                          r.get("merchant"), r.get("amount")):
            continue
        amt = float(r["amount"])
        total += amt
        spend_days.add(r.get("date"))
        cat = categorize(r.get("category_primary"), r.get("merchant"), r.get("name"))
        by_cat[cat] = by_cat.get(cat, 0.0) + amt

    no_spend_days = elapsed - len(spend_days)
    allowance_to_date = round(target * elapsed / dim, 2)
    projected = round(total / elapsed * dim, 2)
    points = round(target - total) + NO_SPEND_DAY_PTS * no_spend_days
    return {
        "month": ms.isoformat()[:7],
        "target": target,
        "total": round(total, 2),
        "remaining": round(target - total, 2),
        "by_category": dict(sorted(by_cat.items(), key=lambda kv: -kv[1])),
        "days_in_month": dim,
        "elapsed_days": elapsed,
        "complete": today > last,
        "no_spend_days": no_spend_days,
        "daily_allowance": round(target / dim, 2),
        "allowance_to_date": allowance_to_date,
        "on_pace": total <= allowance_to_date,
        "projected": projected,
        "points": points,
        "saved": round(max(0.0, target - total), 2),
        "won": total <= target,
    }


def compute_game(rows: list[dict], today: date | None = None) -> dict:
    today = today or date.today()
    buckets: dict[date, list] = {}
    for r in rows:
        d = r.get("date")
        if d is None:
            continue
        buckets.setdefault(month_start(d), []).append(r)

    scored = []
    for ms, rs in sorted(buckets.items()):
        m = score_month(rs, ms, today)
        m["in_game"] = ms >= GAME_START   # pre-GAME_START months have partial data
        scored.append(m)

    cur_ms = month_start(today)
    current = next(
        (m for m in scored if m["month"] == cur_ms.isoformat()[:7]),
        {**score_month([], cur_ms, today), "in_game": cur_ms >= GAME_START},
    )
    # Records/lifetime/wedding count only completed in-game months (full data).
    completed = [m for m in scored if m["in_game"] and m["complete"]]
    best = max(completed, key=lambda m: m["points"], default=None)
    if best is not None and current["points"] > best["points"]:
        current = {**current, "points": current["points"] + RECORD_BONUS, "new_record": True}
    else:
        current = {**current, "new_record": False}

    return {
        "current_month": current,
        "personal_best": best,
        "lifetime_points": sum(m["points"] for m in completed),
        "months_played": len(completed),
        "months_won": sum(1 for m in completed if m["won"]),
        "wedding_saved_total": round(sum(m["saved"] for m in completed), 2),
        "recent_months": scored[-6:],
    }


def load_game(db_url: str | None = None, today: date | None = None) -> dict:
    """Pull every transaction and compute the game state (zero Plaid calls)."""
    import storage
    conn = storage.open_readonly(db_url)
    try:
        rows = conn.execute(
            "SELECT date, amount, category_primary, merchant, name FROM transactions"
        ).fetchall()
    finally:
        conn.close()
    dicts = [
        {"date": r[0], "amount": r[1], "category_primary": r[2],
         "merchant": r[3], "name": r[4]}
        for r in rows
    ]
    return compute_game(dicts, today)
