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
    squeeze = 0.75 ** max(0, int(overage // 500))  # guard: negative overage must not loosen the belt
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


def _next_month_first(ms: date) -> date:
    return (ms.replace(day=28) + timedelta(days=4)).replace(day=1)


def build_directives(*, mode: str, target: float, committed: float,
                     envelopes: list[dict], rent: dict, subs: dict,
                     week: dict, no_spend_days: int, ms: date) -> list[dict]:
    """Ordered, hard-language orders. Severity: stop > slow > act > info.

    The kill-list runs in every mode, including DAMAGE_CONTROL where it
    follows "Subscriptions: CLOSED" — not a contradiction: CLOSED stops this
    month's spending; cancellations shrink NEXT month's bill, which is the
    DC goal ("protect next month").
    """
    out: list[dict] = []
    by_key = {e["key"]: e for e in envelopes}
    nxt = _next_month_first(ms)
    nxt_label = f"{calendar.month_abbr[nxt.month]} 1"
    month_name = calendar.month_name[ms.month]
    nxt_name = calendar.month_name[nxt.month]

    def add(severity, envelope, order, reason, amount=None):
        out.append({"severity": severity, "envelope": envelope,
                    "order": order, "reason": reason, "amount": amount})

    if mode == "DAMAGE_CONTROL":
        overage = round(committed - target, 2)
        add("stop", None,
            f"DAMAGE CONTROL: {month_name} is lost — minimize the overage, protect {nxt_name}.",
            f"committed spend ${committed:,.0f} is ${overage:,.0f} over the ${target:,.0f} target")
        add("stop", None, f"Do not prebook anything for {nxt_name}.",
            f"{nxt_name} is the next winnable month; keep it clean")
        for key in ("subscriptions", "other"):
            add("stop", key, f"{ENV_LABEL[key]}: CLOSED until {nxt_label}.",
                "damage control — every avoidable dollar widens the loss")
        floor = survival_weekly_groceries(week["weeks_left"], overage)
        for key in ("walmart", "indian"):
            add("slow", key,
                f"Survival groceries only: {ENV_LABEL[key]} ≤ ${floor[key]:.0f}/week.",
                "eat from the pantry first", float(floor[key]))
    else:
        for e in envelopes:
            if e["state"] == "closed":
                add("stop", e["key"], f"{ENV_LABEL[e['key']]}: CLOSED until {nxt_label}.",
                    f"${e['spent']:.0f} spent of ${e['budget']:.0f} — envelope empty")
            elif e["state"] == "slow":
                add("slow", e["key"],
                    f"{ENV_LABEL[e['key']]}: SLOW — max ${e['weekly_allowance']}/week "
                    f"for the rest of {month_name}.",
                    f"${e['spent']:.0f} of ${e['budget']:.0f} gone with "
                    f"{week['days_left']} days left in {month_name}", float(e["weekly_allowance"]))

    sub_budget = ENVELOPES["subscriptions"]
    if subs["total"] > sub_budget:
        running = subs["total"]
        for merchant, monthly in subs["by_merchant"].items():  # largest first
            add("act", "subscriptions",
                f"Cancel/downgrade {merchant} (${monthly:.0f}/mo).",
                f"subscriptions projected ${subs['total']:.0f}/mo vs ${sub_budget:.0f} envelope",
                monthly)
            running -= monthly
            if running <= sub_budget:
                break
        if running > sub_budget:
            add("act", "subscriptions",
                f"Audit subscriptions — projected ${subs['total']:.0f}/mo vs ${sub_budget:.0f} envelope.",
                "no single cancellation closes the gap; review manually")

    if rent["status"] == "reserved":
        add("act", None,
            f"Rent not posted yet: ${rent['reserve']:,.0f} is reserved, not spendable.",
            "the reserve is committed on day 1", rent["reserve"])
    elif rent["posted"] > rent["reserve"]:
        add("act", None,
            f"Rent posted ${rent['posted']:,.2f} — ${rent['posted'] - rent['reserve']:,.2f} over reserve.",
            "overage comes out of the month's headroom; tighten the other envelopes")
    else:
        add("info", None,
            f"Rent posted ${rent['posted']:,.2f}: ${rent['reserve'] - rent['posted']:,.2f} "
            f"under reserve, banked as buffer.",
            "buffer is safety margin — never redistributed to envelopes")

    if mode != "DAMAGE_CONTROL":
        parts = []
        if by_key["walmart"]["state"] == "open":
            parts.append(f"Walmart ≤ ${by_key['walmart']['weekly_allowance']} (one trip)")
        if by_key["indian"]["state"] == "open":
            parts.append(f"Indian store ≤ ${by_key['indian']['weekly_allowance']}")
        if parts:
            add("info", None, f"This week: {', '.join(parts)}.",
                "weekly allowance = remaining ÷ weeks left — overspend and next week shrinks")
        if by_key["other"]["state"] == "open":
            add("info", "other",
                f"Everything else ≤ ${by_key['other']['weekly_allowance']} this week.",
                "dining, delivery, rides, one-offs — all of it")

    add("info", None, f"{no_spend_days} no-spend day(s) so far — each is +25 pts.",
        "no-spend days are the easiest points in the game")
    return out


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
    directives = build_directives(mode=mode, target=target, committed=committed,
                                  envelopes=envelopes, rent=rent, subs=subs,
                                  week=week, no_spend_days=no_spend_days, ms=ms)

    plan = {
        "month": ms.isoformat()[:7], "mode": mode, "target": target,
        "total_spent": round(total, 2), "headroom": round(target - total, 2),
        "rent": rent, "envelopes": envelopes, "week": week,
        "projected_subs_monthly": subs_total,
    }
    return {"plan": plan, "directives": directives}


def load_plan(db_url: str | None = None, today: date | None = None) -> dict:
    """Pull every transaction and plan the current month (zero Plaid calls).

    Honors the repo's warnings contract: a broken DB becomes a warning entry,
    never an exception.
    """
    today = today or date.today()
    try:
        import storage
        conn = storage.open_readonly(db_url)
        try:
            rows = conn.execute(
                "SELECT date, amount, category_primary, merchant, name FROM transactions"
            ).fetchall()
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001 — one broken store must not break the answer
        return {"plan": None, "directives": [],
                "warnings": [f"history DB unreachable: {exc}"], "source": "history_db"}
    dicts = [
        {"date": r[0], "amount": r[1], "category_primary": r[2],
         "merchant": r[3], "name": r[4]}
        for r in rows
    ]
    out = plan_month(dicts, gamify.month_start(today), today)
    return {**out, "warnings": [], "source": "history_db"}
