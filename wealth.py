"""Wealth & debt analysis over the Postgres history store — zero Plaid calls.

Agent-facing deep-insight layer: everything here answers from local snapshots
and transaction history so agents can call these tools liberally. Four views:

- get_debt_analysis: what each debt costs to carry (APR, utilization, monthly
  interest) and concrete payoff scenarios at different payment levels.
- get_portfolio_analysis: positions at the latest holdings snapshot with
  allocation, cash-like vs invested split, concentration, and null-safe
  unrealized gains (institutions often omit cost basis; we never invent it).
- get_income_analysis: inflows classified into typed buckets. Plaid's INCOME
  category is unreliable (refunds and vault transfers land there), so buckets
  are explicit and only clearly-income buckets count toward income. Ambiguous
  money (p2p, self-transfers) is reported, never silently added.
- get_net_worth_trajectory: where net worth is heading — snapshot-based when
  enough history exists, cashflow-based otherwise — with milestone ETAs.
"""
from __future__ import annotations

import calendar
from datetime import date, timedelta

import storage

# ---- CONFIG -----------------------------------------------------------------
# T-bill / ultra-short-treasury ETFs and cash positions: parked money, not an
# investment bet. Used for the cash-like vs invested split.
CASH_EQUIVALENT_SYMBOLS = {"BIL", "SGOV", "SHV", "BILS", "USFR", "TFLO", "CUR:USD"}
DEFAULT_PAYOFF_PAYMENTS = (250.0, 500.0, 1000.0)
PAYOFF_MAX_MONTHS = 600
AVG_DAYS_PER_MONTH = 30.4
MIN_SNAPSHOT_SPAN_DAYS = 21   # below this, snapshot growth is noise — use cashflow
# ------------------------------------------------------------------------------

# Buckets whose dollars count as income. Everything else (p2p, self transfers,
# card payments, refunds) is visibility, not income.
INCOME_BUCKETS = frozenset({"payroll", "interest", "tax_refund", "other_income"})

_INTEREST_PAT = ("interest earned", "interest paid", "interest payment")
_PAYROLL_PAT = ("payroll", "direct dep", "salary", "gusto", "adp ", "rippling")
_TAX_PAT = ("tax board", "franchise tax", "state of", "irs ", "us treasury",
            "dept of revenue")
_P2P_PAT = ("zelle", "venmo", "cash app", "paypal", "apple cash")
_CARD_PAYMENT_PAT = ("payment thank", "autopay", "card payment",
                     "ach deposit internet transfer")
_SELF_TRANSFER_PAT = ("vault", "from savings", "internet transfer",
                      "transfer from", "transfer to")
_REFUND_PAT = ("(return)", "refund", "statement credit", "payyourselfback",
               "daily cash", "cash back", "reversal")


def classify_inflow(category_primary, name, merchant) -> str:
    """Classify one inflow (amount < 0) into a typed bucket.

    Pattern checks run before category fallbacks because Plaid's categories
    are the thing being corrected (e.g. vault transfers filed as INCOME).
    Order matters: card payments before self-transfers, since a card payment
    arrives as an 'internet transfer' on the card side.
    """
    hay = f"{name or ''} {merchant or ''}".lower()
    cat = (category_primary or "").upper()

    if any(p in hay for p in _INTEREST_PAT):
        return "interest"
    if any(p in hay for p in _PAYROLL_PAT):
        return "payroll"
    if any(p in hay for p in _TAX_PAT):
        return "tax_refund"
    if any(p in hay for p in _P2P_PAT):
        return "p2p"
    if any(p in hay for p in _CARD_PAYMENT_PAT) or cat in ("PAYMENT", "LOAN_DISBURSEMENTS", "LOAN_PAYMENTS"):
        return "card_payment"
    if any(p in hay for p in _SELF_TRANSFER_PAT) or cat == "TRANSFER_IN":
        return "self_transfer"
    if any(p in hay for p in _REFUND_PAT) or cat == "CREDIT":
        return "refund"
    if cat == "INCOME":
        return "other_income"
    return "other"


# ---------------------------------------------------------------------------
# Debt
# ---------------------------------------------------------------------------

def payoff_schedule(balance: float, rate_pct: float, monthly_payment: float) -> dict:
    """Amortize a balance at a fixed monthly payment. Returns months to zero
    and total interest paid, or months=None when the payment never wins."""
    r = rate_pct / 100.0 / 12.0
    if monthly_payment <= balance * r:
        return {
            "monthly_payment": monthly_payment,
            "months": None,
            "total_interest": None,
            "verdict": f"${monthly_payment:,.0f}/mo does not cover the "
                       f"~${balance * r:,.0f}/mo interest — never pays off",
        }
    bal, total_interest, months = balance, 0.0, 0
    while bal > 0 and months < PAYOFF_MAX_MONTHS:
        interest = bal * r
        total_interest += interest
        bal = bal + interest - monthly_payment
        months += 1
    return {
        "monthly_payment": monthly_payment,
        "months": months,
        "total_interest": round(total_interest, 2),
        "verdict": f"debt-free in {months} months, "
                   f"~${total_interest:,.0f} total interest",
    }


def get_debt_analysis(monthly_payment: float | None = None,
                      db_url: str | None = None) -> dict:
    """Every carried debt with its true carrying cost and payoff scenarios."""
    conn = storage.open_readonly(db_url)
    try:
        liab = conn.execute(
            """
            SELECT DISTINCT ON (account_id, liability_type)
                   account_id, liability_type, outstanding_balance,
                   apr_percentage, interest_rate_percentage,
                   minimum_payment_amount, next_payment_due_date, is_overdue,
                   snapshot_date
            FROM liabilities_snapshots
            ORDER BY account_id, liability_type, snapshot_date DESC
            """
        ).fetchall()
        balances = {
            r[0]: {"current": r[1], "credit_limit": r[2]}
            for r in conn.execute(
                """
                SELECT DISTINCT ON (account_id) account_id, current, credit_limit
                FROM balance_snapshots
                ORDER BY account_id, snapshot_date DESC
                """
            ).fetchall()
        }
        accounts = {
            r[0]: {"institution": r[1], "name": r[2]}
            for r in conn.execute(
                "SELECT account_id, institution, name FROM accounts"
            ).fetchall()
        }
    finally:
        conn.close()

    debts, zero_balance = [], 0
    as_of = None
    for (acct, ltype, balance, apr, rate, minpay, due, overdue, snap) in liab:
        as_of = max(as_of, snap) if as_of else snap
        if not balance or balance <= 0:
            zero_balance += 1
            continue
        effective_rate = apr if apr is not None else rate
        bal_row = balances.get(acct, {})
        limit = bal_row.get("credit_limit")
        monthly_interest = (
            round(balance * effective_rate / 100.0 / 12.0, 2)
            if effective_rate is not None else None
        )
        scenarios = None
        if effective_rate is not None:
            payments = {p for p in (minpay, monthly_payment, *DEFAULT_PAYOFF_PAYMENTS)
                        if p and p > 0}
            scenarios = [payoff_schedule(balance, effective_rate, p)
                         for p in sorted(payments)]
        debts.append({
            "account_id": acct,
            "institution": accounts.get(acct, {}).get("institution"),
            "name": accounts.get(acct, {}).get("name"),
            "liability_type": ltype,
            "balance": round(balance, 2),
            "apr_percentage": effective_rate,
            "minimum_payment": minpay,
            "next_payment_due_date": str(due) if due else None,
            "is_overdue": overdue,
            "credit_limit": limit,
            "utilization_pct": round(balance / limit * 100, 2) if limit else None,
            "monthly_interest_if_carried": monthly_interest,
            "payoff_scenarios": scenarios,
        })

    total_debt = round(sum(d["balance"] for d in debts), 2)
    rated = [d for d in debts if d["apr_percentage"] is not None]
    weighted_apr = (
        round(sum(d["balance"] * d["apr_percentage"] for d in rated)
              / sum(d["balance"] for d in rated), 2)
        if rated else None
    )
    return {
        "as_of": str(as_of) if as_of else None,
        "debts": debts,
        "zero_balance_debts": zero_balance,
        "total_debt": total_debt,
        "weighted_apr_percentage": weighted_apr,
        "total_monthly_interest_if_carried": round(
            sum(d["monthly_interest_if_carried"] or 0 for d in debts), 2),
        "total_minimum_payments": round(
            sum(d["minimum_payment"] or 0 for d in debts), 2),
        "source": "history_db",
    }


# ---------------------------------------------------------------------------
# Portfolio
# ---------------------------------------------------------------------------

def get_portfolio_analysis(db_url: str | None = None) -> dict:
    """Positions at the latest holdings snapshot, aggregated by symbol."""
    conn = storage.open_readonly(db_url)
    try:
        rows = conn.execute(
            """
            SELECT symbol, security_name, security_type, account_id,
                   quantity, market_value, cost_basis, snapshot_date
            FROM holdings_snapshots
            WHERE snapshot_date = (SELECT max(snapshot_date) FROM holdings_snapshots)
            """
        ).fetchall()
    finally:
        conn.close()

    if not rows:
        return {"as_of": None, "total_value": 0.0, "positions": [],
                "cash_like_value": 0.0, "invested_value": 0.0,
                "allocation_by_type": {}, "concentration": None,
                "basis_coverage_pct": None, "total_unrealized_gain": None,
                "source": "history_db"}

    as_of = rows[0][7]
    by_symbol: dict[str, dict] = {}
    basis_known_value = 0.0
    for (symbol, name, sec_type, acct, qty, mv, basis, _sd) in rows:
        p = by_symbol.setdefault(symbol or "?", {
            "symbol": symbol, "name": name, "security_type": sec_type,
            "quantity": 0.0, "market_value": 0.0, "cost_basis": 0.0,
            "basis_known": True, "accounts": set(),
        })
        p["quantity"] += qty or 0.0
        p["market_value"] += mv or 0.0
        p["accounts"].add(acct)
        if basis is None:
            p["basis_known"] = False
        else:
            p["cost_basis"] += basis
            basis_known_value += mv or 0.0

    total = sum(p["market_value"] for p in by_symbol.values())
    positions = []
    cash_like = 0.0
    total_gain = 0.0
    any_gain = False
    for p in sorted(by_symbol.values(), key=lambda x: -x["market_value"]):
        mv = p["market_value"]
        known = p["basis_known"]
        gain = round(mv - p["cost_basis"], 2) if known else None
        if known:
            total_gain += gain
            any_gain = True
        is_cash_like = (p["security_type"] == "cash"
                        or (p["symbol"] or "") in CASH_EQUIVALENT_SYMBOLS)
        if is_cash_like:
            cash_like += mv
        positions.append({
            "symbol": p["symbol"],
            "name": p["name"],
            "security_type": p["security_type"],
            "quantity": round(p["quantity"], 6),
            "market_value": round(mv, 2),
            "weight_pct": round(mv / total * 100, 2) if total else None,
            "cost_basis": round(p["cost_basis"], 2) if known else None,
            "basis_known": known,
            "unrealized_gain": gain,
            "unrealized_pct": (round((mv / p["cost_basis"] - 1) * 100, 2)
                               if known and p["cost_basis"] else None),
            "cash_like": is_cash_like,
            "accounts": len(p["accounts"]),
        })

    by_type: dict[str, float] = {}
    for p in positions:
        t = p["security_type"] or "unknown"
        by_type[t] = round(by_type.get(t, 0.0) + p["market_value"], 2)

    top5 = sum(p["weight_pct"] or 0 for p in positions[:5])
    return {
        "as_of": str(as_of),
        "total_value": round(total, 2),
        "positions": positions,
        "cash_like_value": round(cash_like, 2),
        "invested_value": round(total - cash_like, 2),
        "allocation_by_type": by_type,
        "concentration": {
            "top_position": {"symbol": positions[0]["symbol"],
                             "weight_pct": positions[0]["weight_pct"]},
            "top5_weight_pct": round(top5, 2),
        },
        "basis_coverage_pct": round(basis_known_value / total * 100, 2) if total else None,
        "total_unrealized_gain": round(total_gain, 2) if any_gain else None,
        "source": "history_db",
    }


# ---------------------------------------------------------------------------
# Income
# ---------------------------------------------------------------------------

def _month_key(d: date) -> str:
    return d.isoformat()[:7]


def _shift_months(d: date, n: int) -> date:
    """First day of the month n months before/after d's month."""
    total = d.year * 12 + (d.month - 1) + n
    return date(total // 12, total % 12 + 1, 1)


def get_income_analysis(months: int = 6, as_of: date | None = None,
                        db_url: str | None = None) -> dict:
    """Inflows classified into typed buckets, with income vs expenses per month.

    Averages (income, expenses, savings rate) use completed months only — the
    in-progress month is shown in the series flagged partial.
    """
    import gamify
    as_of = as_of or date.today()
    window_start = _shift_months(as_of, -(months - 1))

    conn = storage.open_readonly(db_url)
    try:
        rows = conn.execute(
            "SELECT date, amount, category_primary, merchant, name "
            "FROM transactions WHERE date >= %s AND date <= %s",
            (window_start, as_of),
        ).fetchall()
    finally:
        conn.close()

    month_keys = [_month_key(_shift_months(as_of, -i)) for i in range(months - 1, -1, -1)]
    series = {mk: {"month": mk, "inflows_total": 0.0, "by_bucket": {},
                   "income": 0.0, "expenses": 0.0}
              for mk in month_keys}
    by_bucket: dict[str, float] = {}
    sources: dict[str, dict] = {}

    for (dt, amount, cat, merchant, name) in rows:
        mk = _month_key(dt)
        if mk not in series:
            continue
        m = series[mk]
        if amount < 0:
            inflow = -amount
            bucket = classify_inflow(cat, name, merchant)
            m["inflows_total"] += inflow
            m["by_bucket"][bucket] = m["by_bucket"].get(bucket, 0.0) + inflow
            by_bucket[bucket] = by_bucket.get(bucket, 0.0) + inflow
            if bucket in INCOME_BUCKETS:
                m["income"] += inflow
            src = merchant or name or "?"
            s = sources.setdefault(src, {"source": src, "bucket": bucket,
                                         "total": 0.0, "count": 0})
            s["total"] += inflow
            s["count"] += 1
        elif gamify.is_expense(cat, name, merchant, amount):
            m["expenses"] += amount

    current_mk = _month_key(as_of)
    out_months = []
    for mk in month_keys:
        m = series[mk]
        partial = (mk == current_mk
                   and as_of.day < calendar.monthrange(as_of.year, as_of.month)[1])
        out_months.append({
            "month": mk,
            "partial": partial,
            "inflows_total": round(m["inflows_total"], 2),
            "by_bucket": {k: round(v, 2) for k, v in sorted(m["by_bucket"].items())},
            "income": round(m["income"], 2),
            "expenses": round(m["expenses"], 2),
            "net": round(m["income"] - m["expenses"], 2),
        })

    completed = [m for m in out_months if not m["partial"]]
    n = len(completed)
    est_income = round(sum(m["income"] for m in completed) / n, 2) if n else 0.0
    avg_expenses = round(sum(m["expenses"] for m in completed) / n, 2) if n else 0.0
    savings_rate = round(1 - avg_expenses / est_income, 4) if est_income > 0 else None

    caveats = [
        "inflow classification is heuristic — buckets p2p, self_transfer, "
        "card_payment, and refund are excluded from income",
    ]
    if by_bucket.get("p2p"):
        caveats.append(
            f"p2p inflows of ${by_bucket['p2p']:,.2f} were excluded from income; "
            "if some are actually income, say so and they can be reclassified")

    top_sources = sorted(sources.values(), key=lambda s: -s["total"])[:10]
    for s in top_sources:
        s["total"] = round(s["total"], 2)
    return {
        "window": {"start": str(window_start), "end": str(as_of)},
        "months": out_months,
        "completed_months": n,
        "by_bucket": {k: round(v, 2) for k, v in sorted(by_bucket.items())},
        "income_buckets": sorted(INCOME_BUCKETS),
        "estimated_monthly_income": est_income,
        "avg_monthly_expenses": avg_expenses,
        "savings_rate": savings_rate,
        "top_sources": top_sources,
        "caveats": caveats,
        "source": "history_db",
    }


# ---------------------------------------------------------------------------
# Net-worth trajectory
# ---------------------------------------------------------------------------

def get_net_worth_trajectory(milestone: float = 100_000.0, months: int = 6,
                             as_of: date | None = None,
                             db_url: str | None = None) -> dict:
    """Where net worth is heading and when it reaches the milestone.

    Two independent estimates: snapshot growth (needs enough history span to
    not be noise) and average monthly net cashflow from transactions (works
    from day one; transfers between own accounts net out). The better one is
    chosen and both are reported.
    """
    import analytics
    as_of = as_of or date.today()
    history = analytics.net_worth_history(db_url)["history"]

    snapshot_est = None
    span_days = 0
    current = None
    if history:
        first, last = history[0], history[-1]
        current = last["net_worth"]
        span_days = (date.fromisoformat(last["date"])
                     - date.fromisoformat(first["date"])).days
        if span_days >= MIN_SNAPSHOT_SPAN_DAYS:
            snapshot_est = round(
                (last["net_worth"] - first["net_worth"]) / span_days
                * AVG_DAYS_PER_MONTH, 2)

    # Cashflow estimate over recent completed months: -sum(amount) per month
    # is net money in (inflows are negative in Plaid's convention).
    window_start = _shift_months(as_of, -months)
    current_month_start = _shift_months(as_of, 0)
    conn = storage.open_readonly(db_url)
    try:
        flow_rows = conn.execute(
            """
            SELECT to_char(date, 'YYYY-MM') AS month,
                   round(sum(-amount)::numeric, 2) AS net
            FROM transactions
            WHERE date >= %s AND date < %s
            GROUP BY 1 ORDER BY 1
            """,
            (window_start, current_month_start),
        ).fetchall()
    finally:
        conn.close()
    monthly_flows = [{"month": r[0], "net": float(r[1])} for r in flow_rows]
    cashflow_est = (round(sum(f["net"] for f in monthly_flows) / len(monthly_flows), 2)
                    if monthly_flows else None)

    est = snapshot_est if snapshot_est is not None else cashflow_est
    est_source = ("snapshots" if snapshot_est is not None
                  else "cashflow" if cashflow_est is not None else None)

    milestone_out = None
    if current is not None and milestone:
        reached = current >= milestone
        months_away = (round((milestone - current) / est, 2)
                       if not reached and est and est > 0 else None)
        eta = (str(as_of + timedelta(days=months_away * AVG_DAYS_PER_MONTH))
               if months_away is not None else None)
        milestone_out = {"target": milestone, "reached": reached,
                         "months_away": months_away, "eta": eta}

    return {
        "status": "ok" if history else "insufficient_history",
        "as_of": str(as_of),
        "current_net_worth": current,
        "history_days": span_days,
        "history_points": len(history),
        "estimates": {"snapshots": snapshot_est, "cashflow": cashflow_est},
        "estimate_source": est_source,
        "estimated_monthly_change": est,
        "monthly_net_flows": monthly_flows,
        "milestone": milestone_out,
        "note": ("snapshot history grows every sync; estimates sharpen after "
                 f"{MIN_SNAPSHOT_SPAN_DAYS}+ days of snapshots"
                 if span_days < MIN_SNAPSHOT_SPAN_DAYS else None),
        "source": "history_db",
    }
