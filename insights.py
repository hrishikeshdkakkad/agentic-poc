"""Deep spending insights over the Postgres history store — zero Plaid calls.

Agent-facing tools that answer the questions raw transaction lists can't:

- get_recurring_analysis: subscriptions and bills derived locally from charge
  cadence (no Plaid recurring API), with per-stream price history so creeping
  subscriptions get caught. Plaid's own recurring endpoint can't see price
  changes; this one is built on the full local history.
- get_merchant_profile: the lifetime story of one merchant — total given,
  frequency, ticket size, trend — searching raw names too, so "doordash"
  finds charges Plaid filed under the restaurant's cleaned name.
- compare_periods: month-vs-month diff with the category and merchant drivers
  that explain the change, biggest movers first.
- get_financial_health: one-call orientation — net worth, runway, debt cost,
  savings rate, game pace — plus rule-based flags for what needs attention.
"""
from __future__ import annotations

import calendar
import re
import statistics
from datetime import date, timedelta

import storage
from wealth import _shift_months

# ---- CONFIG -----------------------------------------------------------------
MIN_OCCURRENCES = 3          # events needed before a merchant counts as recurring
MIN_MONTHS_SEEN = 2
PRICE_CHANGE_FLAG_PCT = 5.0  # |latest vs prior median| beyond this gets flagged
FIXED_AMOUNT_SPREAD = 0.15   # (max-min)/median below this = fixed-price stream
# (label, min interval days, max interval days, periods per year)
_CADENCES = (
    ("weekly", 5, 10, 52.0),
    ("biweekly", 11, 18, 26.0),
    ("monthly", 24, 38, 12.0),
    ("quarterly", 75, 105, 4.0),
    ("annual", 320, 410, 1.0),
)
# Health flag thresholds
UTILIZATION_WARN_PCT = 30.0
APR_WARN_PCT = 15.0
RUNWAY_WARN_MONTHS = 3.0
SAVINGS_RATE_LOW = 0.10
BASIS_COVERAGE_INFO_PCT = 80.0
HEALTH_INCOME_MONTHS = 3
# ------------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Recurring streams
# ---------------------------------------------------------------------------

def _match_cadence(median_interval: float) -> tuple[str, float] | None:
    for label, lo, hi, per_year in _CADENCES:
        if lo <= median_interval <= hi:
            return label, per_year
    return None


def get_recurring_analysis(months: int = 6, as_of: date | None = None,
                           db_url: str | None = None) -> dict:
    """Detect recurring expense streams from local charge cadence."""
    import gamify
    as_of = as_of or date.today()
    window_start = _shift_months(as_of, -(months - 1))

    conn = storage.open_readonly(db_url)
    try:
        rows = conn.execute(
            "SELECT date, amount, merchant, name, category_primary "
            "FROM transactions WHERE amount > 0 AND date >= %s AND date <= %s",
            (window_start, as_of),
        ).fetchall()
    finally:
        conn.close()

    groups: dict[str, dict] = {}
    for (dt, amount, merchant, name, cat) in rows:
        # only real expenses recur as bills; card payments etc. would pollute
        if not gamify.is_expense(cat, name, merchant, amount):
            continue
        display = (merchant or name or "?").strip()
        g = groups.setdefault(display.lower(), {
            "merchant": display, "category": cat, "events": {},
        })
        g["events"][dt] = g["events"].get(dt, 0.0) + amount  # same-day merge

    streams = []
    for g in groups.values():
        events = sorted(g["events"].items())
        if len(events) < MIN_OCCURRENCES:
            continue
        if len({d.isoformat()[:7] for d, _ in events}) < MIN_MONTHS_SEEN:
            continue
        intervals = [(events[i + 1][0] - events[i][0]).days
                     for i in range(len(events) - 1)]
        median_interval = statistics.median(intervals)
        cadence = _match_cadence(median_interval)
        if cadence is None:
            continue
        label, per_year = cadence

        amounts = [a for _, a in events]
        latest = amounts[-1]
        median_amount = statistics.median(amounts)
        prior_median = statistics.median(amounts[:-1])
        change_pct = round((latest / prior_median - 1) * 100, 2) if prior_median else None
        price_change = (
            {"pct": change_pct, "from": round(prior_median, 2), "to": round(latest, 2)}
            if change_pct is not None and abs(change_pct) >= PRICE_CHANGE_FLAG_PCT
            else None
        )
        spread_ok = median_amount > 0 and (max(amounts) - min(amounts)) / median_amount <= FIXED_AMOUNT_SPREAD
        annualized = round(latest * per_year, 2)
        streams.append({
            "merchant": g["merchant"],
            "category": g["category"],
            "cadence": label,
            "occurrences": len(events),
            "first_date": str(events[0][0]),
            "last_date": str(events[-1][0]),
            "next_expected_date": str(events[-1][0] + timedelta(days=round(median_interval))),
            "latest_amount": round(latest, 2),
            "median_amount": round(median_amount, 2),
            "is_fixed_amount": spread_ok,
            "price_change": price_change,
            "annualized_cost": annualized,
            "monthly_equivalent": round(annualized / 12, 2),
        })

    streams.sort(key=lambda s: -s["annualized_cost"])
    return {
        "window": {"start": str(window_start), "end": str(as_of)},
        "streams": streams,
        "stream_count": len(streams),
        "monthly_recurring_total": round(sum(s["monthly_equivalent"] for s in streams), 2),
        "annual_recurring_total": round(sum(s["annualized_cost"] for s in streams), 2),
        "price_increases": [s["merchant"] for s in streams
                            if s["price_change"] and s["price_change"]["pct"] > 0],
        "source": "history_db",
    }


# ---------------------------------------------------------------------------
# Merchant profile
# ---------------------------------------------------------------------------

def get_merchant_profile(merchant: str, as_of: date | None = None,
                         db_url: str | None = None) -> dict:
    """Lifetime profile of one merchant. Searches the raw transaction name as
    well as the cleaned merchant, so marketplace prefixes are found."""
    as_of = as_of or date.today()
    q = f"%{merchant}%"
    conn = storage.open_readonly(db_url)
    try:
        rows = conn.execute(
            """
            SELECT t.transaction_id, t.date, t.amount, t.merchant, t.name,
                   t.category_primary
            FROM transactions t
            WHERE t.merchant ILIKE %s OR t.name ILIKE %s
            ORDER BY t.date
            """,
            (q, q),
        ).fetchall()
        ids = [r[0] for r in rows]
        tags = []
        if ids:
            tags = [r[0] for r in conn.execute(
                "SELECT DISTINCT tag FROM transaction_tags WHERE transaction_id = ANY(%s)",
                (ids,),
            ).fetchall()]
    finally:
        conn.close()

    spends = [r for r in rows if r[2] > 0]
    refunds = [r for r in rows if r[2] < 0]
    total_spent = round(sum(r[2] for r in spends), 2)

    monthly: dict[str, dict] = {}
    for r in spends:
        mk = r[1].isoformat()[:7]
        m = monthly.setdefault(mk, {"month": mk, "total": 0.0, "count": 0})
        m["total"] = round(m["total"] + r[2], 2)
        m["count"] += 1

    current_mk = as_of.isoformat()[:7]
    completed = [m for mk, m in sorted(monthly.items()) if mk != current_mk]
    trend = None
    if len(completed) >= 2:
        last, prior = completed[-1], completed[:-1]
        prior_avg = sum(m["total"] for m in prior) / len(prior)
        if prior_avg > 0:
            pct = round((last["total"] / prior_avg - 1) * 100, 1)
            trend = {"last_completed_month": last["month"], "vs_prior_avg_pct": pct,
                     "direction": "up" if pct > 10 else "down" if pct < -10 else "flat"}

    return {
        "query": merchant,
        "matched_merchants": sorted({r[3] for r in rows if r[3]}),
        "transaction_count": len(spends),
        "refund_count": len(refunds),
        "total_spent": total_spent,
        "total_refunded": round(-sum(r[2] for r in refunds), 2),
        "avg_ticket": round(total_spent / len(spends), 2) if spends else None,
        "max_ticket": round(max((r[2] for r in spends), default=0.0), 2) or None,
        "first_seen": str(rows[0][1]) if rows else None,
        "last_seen": str(rows[-1][1]) if rows else None,
        "categories": sorted({r[5] for r in rows if r[5]}),
        "tags": sorted(tags),
        "monthly": sorted(monthly.values(), key=lambda m: m["month"])[-12:],
        "trend": trend,
        "recent": [{"date": str(r[1]), "amount": r[2], "merchant": r[3], "name": r[4]}
                   for r in rows[-5:]][::-1],
        "source": "history_db",
    }


# ---------------------------------------------------------------------------
# Period comparison
# ---------------------------------------------------------------------------

_MONTH_RE = re.compile(r"^\d{4}-\d{2}$")
_SPEND_FILTER = (
    "amount > 0 AND pending = FALSE "
    "AND coalesce(category_primary, '') NOT IN ('TRANSFER_OUT', 'LOAN_PAYMENTS')"
)


def compare_periods(period_a: str, period_b: str, db_url: str | None = None) -> dict:
    """Diff two months of spending; biggest movers first."""
    for p in (period_a, period_b):
        if not _MONTH_RE.match(p):
            raise ValueError(f"period must look like YYYY-MM, got {p!r}")

    def _grouped(conn, col: str) -> dict[str, dict[str, float]]:
        out: dict[str, dict[str, float]] = {}
        rows = conn.execute(
            f"""
            SELECT to_char(date, 'YYYY-MM') AS month,
                   coalesce({col}, 'UNKNOWN') AS grp,
                   round(sum(amount)::numeric, 2)
            FROM transactions
            WHERE to_char(date, 'YYYY-MM') IN (%s, %s) AND {_SPEND_FILTER}
            GROUP BY 1, 2
            """,
            (period_a, period_b),
        ).fetchall()
        for month, grp, total in rows:
            out.setdefault(grp, {})[month] = float(total)
        return out

    conn = storage.open_readonly(db_url)
    try:
        by_cat = _grouped(conn, "category_primary")
        by_merch = _grouped(conn, "merchant")
    finally:
        conn.close()

    def _diff(grouped: dict, key_name: str, top: int | None = None) -> list[dict]:
        rows = []
        for grp, vals in grouped.items():
            a, b = vals.get(period_a, 0.0), vals.get(period_b, 0.0)
            rows.append({key_name: grp, "a": a, "b": b, "delta": round(b - a, 2)})
        rows.sort(key=lambda r: -abs(r["delta"]))
        return rows[:top] if top else rows

    cat_rows = _diff(by_cat, "category")
    total_a = round(sum(r["a"] for r in cat_rows), 2)
    total_b = round(sum(r["b"] for r in cat_rows), 2)
    return {
        "period_a": period_a,
        "period_b": period_b,
        "total_a": total_a,
        "total_b": total_b,
        "delta": round(total_b - total_a, 2),
        "delta_pct": round((total_b / total_a - 1) * 100, 2) if total_a else None,
        "by_category": cat_rows,
        "by_merchant": _diff(by_merch, "merchant", top=15),
        "source": "history_db",
    }


# ---------------------------------------------------------------------------
# Composite health
# ---------------------------------------------------------------------------

def get_financial_health(as_of: date | None = None,
                         db_url: str | None = None) -> dict:
    """One-call orientation across debt, cash, income, portfolio, and the game,
    with rule-based flags for anything that deserves attention."""
    import analytics
    import gamify
    import wealth
    as_of = as_of or date.today()

    debt = wealth.get_debt_analysis(db_url=db_url)
    portfolio = wealth.get_portfolio_analysis(db_url=db_url)
    income = wealth.get_income_analysis(months=HEALTH_INCOME_MONTHS,
                                        as_of=as_of, db_url=db_url)
    trajectory = wealth.get_net_worth_trajectory(as_of=as_of, db_url=db_url)
    game = gamify.load_game(db_url, today=as_of)
    history = analytics.net_worth_history(db_url)["history"]
    net_worth = history[-1]["net_worth"] if history else None

    conn = storage.open_readonly(db_url)
    try:
        cash = conn.execute(
            """
            SELECT coalesce(sum(current), 0) FROM (
                SELECT DISTINCT ON (account_id) current
                FROM balance_snapshots
                WHERE type = 'depository'
                ORDER BY account_id, snapshot_date DESC
            ) latest
            """
        ).fetchone()[0]
    finally:
        conn.close()

    liquid = round(float(cash) + portfolio["cash_like_value"], 2)
    avg_expenses = income["avg_monthly_expenses"]
    runway = round(liquid / avg_expenses, 1) if avg_expenses else None

    flags: list[dict] = []

    def _flag(name: str, severity: str, detail: str):
        flags.append({"flag": name, "severity": severity, "detail": detail})

    for d in debt["debts"]:
        if d["utilization_pct"] and d["utilization_pct"] > UTILIZATION_WARN_PCT:
            _flag("high_utilization", "warn",
                  f"{d['institution']} {d['liability_type']} at "
                  f"{d['utilization_pct']}% utilization (>{UTILIZATION_WARN_PCT:.0f}%)")
        if (d["apr_percentage"] or 0) >= APR_WARN_PCT and d["balance"] > 0:
            _flag("expensive_debt", "warn",
                  f"{d['institution']} balance ${d['balance']:,.2f} at "
                  f"{d['apr_percentage']}% APR costs "
                  f"~${d['monthly_interest_if_carried']:,.2f}/mo if carried")
    if runway is not None and runway < RUNWAY_WARN_MONTHS:
        _flag("thin_runway", "warn",
              f"liquid reserves cover {runway} months of expenses "
              f"(<{RUNWAY_WARN_MONTHS:.0f})")
    rate = income["savings_rate"]
    if rate is not None:
        if rate < 0:
            _flag("negative_savings", "warn",
                  f"spending exceeds income (savings rate {rate:.0%})")
        elif rate < SAVINGS_RATE_LOW:
            _flag("low_savings", "info", f"savings rate {rate:.0%} "
                  f"(<{SAVINGS_RATE_LOW:.0%})")
    bc = portfolio["basis_coverage_pct"]
    if bc is not None and bc < BASIS_COVERAGE_INFO_PCT:
        _flag("unknown_cost_basis", "info",
              f"cost basis known for only {bc}% of portfolio value — "
              "gain figures are partial")
    cur = game["current_month"]
    if cur.get("in_game") and not cur["on_pace"]:
        _flag("over_pace", "info",
              f"{cur['month']} spend ${cur['total']:,.2f} is over the "
              f"to-date allowance ${cur['allowance_to_date']:,.2f}")

    return {
        "as_of": str(as_of),
        "net_worth": net_worth,
        "liquid_reserves": liquid,
        "months_of_runway": runway,
        "debt": {
            "count": len(debt["debts"]),
            "total_debt": debt["total_debt"],
            "weighted_apr_percentage": debt["weighted_apr_percentage"],
            "monthly_interest_if_carried": debt["total_monthly_interest_if_carried"],
        },
        "portfolio": {
            "total_value": portfolio["total_value"],
            "cash_like_value": portfolio["cash_like_value"],
            "invested_value": portfolio["invested_value"],
            "basis_coverage_pct": portfolio["basis_coverage_pct"],
        },
        "income": {
            "estimated_monthly_income": income["estimated_monthly_income"],
            "avg_monthly_expenses": income["avg_monthly_expenses"],
            "savings_rate": income["savings_rate"],
        },
        "game": {
            "month": cur["month"],
            "total": cur["total"],
            "target": cur["target"],
            "remaining": cur["remaining"],
            "on_pace": cur["on_pace"],
        },
        "trajectory": {
            "estimated_monthly_change": trajectory["estimated_monthly_change"],
            "estimate_source": trajectory["estimate_source"],
            "milestone": trajectory["milestone"],
        },
        "flags": flags,
        "source": "history_db",
    }
