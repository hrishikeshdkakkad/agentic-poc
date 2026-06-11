# The Optimizer Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `get_optimizer_plan` — the Optimizer's prescriptive twin: a pure planner module that turns the month's transactions into envelope budgets and hard directives, surfaced as an MCP tool, a dashboard `/plan` page, and (post-deploy) a weekly scheduled brief.

**Architecture:** `planner.py` mirrors `gamify.py`: a CONFIG block and pure functions over transaction rows, recomputed every call, no new tables, no writes. It imports `gamify.is_expense` so planner and scoreboard always agree on what counts. `server.py` registers the tool with the standard `_impl` + `mcp.tool()` pattern; the dashboard allowlist (`dashboard/src/lib/tools.ts`) and `verify_remote.py` census must be updated in the same change or CI fails.

**Tech Stack:** Python 3.11 (stdlib only — no new deps), pytest, FastMCP (existing), Next.js app router + SWR + Tailwind (existing dashboard conventions).

**Spec:** `docs/superpowers/specs/2026-06-11-optimizer-plan-design.md` — read it first; it defines envelope values, classification precedence, mode triggers, and the directive order.

**Commands cheat-sheet (from repo root):**
- Python tests: `.venv/bin/python -m pytest tests/test_planner.py -q` (pure tests, no DB needed)
- Full suite: `.venv/bin/python -m pytest -q`
- Dashboard tests: `cd dashboard && npm test`

---

## File structure

| File | Responsibility |
|---|---|
| `planner.py` (create) | CONFIG, `classify()`, `project_subscriptions()`, `survival_weekly_groceries()` (user-authored), `plan_month()`, `build_directives()`, `load_plan()` |
| `tests/test_planner.py` (create) | Pure-function tests mirroring `tests/test_gamify.py` style |
| `server.py` (modify, after `get_optimizer_score` block ~line 865) | `_get_optimizer_plan_impl` + registration |
| `dashboard/src/lib/tools.ts` (modify) | Add `"get_optimizer_plan"` to `ALLOWED_TOOLS` |
| `verify_remote.py` (modify) | Tool count 28→29 (lines 7, 164-165) + `TOOL_CHECKS` entry |
| `README.md` (modify, ~line 64) | One table row for the new tool |
| `dashboard/src/app/plan/page.tsx` (create) | `/plan` page: mode banner, envelope cards, directives, allowances |
| `dashboard/src/app/layout.tsx` (modify) | NAV entry `["/plan", "Plan"]` |

---

### Task 1: planner.py — CONFIG + classify()

**Files:**
- Create: `planner.py`
- Create: `tests/test_planner.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_planner.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_planner.py -q`
Expected: FAIL / ERROR with `ModuleNotFoundError: No module named 'planner'`

- [ ] **Step 3: Write the implementation**

Create `planner.py`:

```python
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
_SUBS = ("claude.ai", "openai", "chatgpt", "vercel", "google one", "google",
         "apple services", "apple.com/bill", "uber one", "walmart+",
         "wmt plus", "screenstudio", "nvidia", "playstation network")
_WALMART = ("walmart", "wal-mart")
_WALMART_NOT = ("amk walmart", "dgtc cafe", "dgtc coffe", "dgtc mm",
                "eighth pla", "fh cfa", "hq sparky")  # campus cafeteria, not groceries
_INDIAN = ("namaste", "indiamart", "india mart", "little india", "patel",
           "india bazaar", "desi")

SUBS_WINDOW_DAYS = 60           # trailing window for the kill-list projection
SURVIVAL_WEEKLY_WALMART = 50.0  # damage-control grocery floor (default policy)
SURVIVAL_WEEKLY_INDIAN = 30.0
# ----------------------------------------------------------------------------

ENV_LABEL = {"walmart": "Walmart", "indian": "Indian store",
             "subscriptions": "Subscriptions", "other": "Everything else"}


def classify(name, merchant) -> str:
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_planner.py -q`
Expected: `6 passed` (note: `calendar`, `math`, `date`, `timedelta` imports are used by later tasks; if lint complains, leave them — they arrive in Task 2/4 code.)

- [ ] **Step 5: Commit**

```bash
git add planner.py tests/test_planner.py
git commit -m "feat(planner): envelope CONFIG + transaction classification"
```

---

### Task 2: plan_month() — envelope accounting, week math, rent

**Files:**
- Modify: `planner.py` (append)
- Modify: `tests/test_planner.py` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_planner.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_planner.py -q`
Expected: FAIL with `AttributeError: module 'planner' has no attribute 'plan_month'`

- [ ] **Step 3: Write the implementation**

Append to `planner.py` (the directives/modes/subs pieces referenced here land in Tasks 3–5; for THIS task implement `plan_month` with `mode="NORMAL"` hardcoded, no directives, `projected_subs_monthly=0.0`, exactly as below — Tasks 3–5 then replace the marked lines):

```python
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
    day = min(today.day, dim) if in_month else dim
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

    rent = {"reserve": RENT_RESERVE,
            "posted": round(rent_posted, 2) if rent_posted > 0 else None,
            "status": "posted" if rent_posted > 0 else "reserved"}
    week = {"days_left": days_left, "weeks_left": weeks_left}
    no_spend_days = max(0, day - len(spend_days))

    mode = "NORMAL"            # Task 3 replaces this line with real mode logic
    subs_total = 0.0           # Task 4 replaces this line with project_subscriptions
    directives: list[dict] = []  # Task 5 replaces this line with build_directives

    plan = {
        "month": ms.isoformat()[:7], "mode": mode, "target": target,
        "total_spent": round(total, 2), "headroom": round(target - total, 2),
        "rent": rent, "envelopes": envelopes, "week": week,
        "projected_subs_monthly": subs_total,
    }
    return {"plan": plan, "directives": directives}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_planner.py -q`
Expected: `11 passed`

- [ ] **Step 5: Commit**

```bash
git add planner.py tests/test_planner.py
git commit -m "feat(planner): plan_month envelope accounting, week math, rent reserve"
```

---

### Task 3: Modes — NORMAL / TIGHT / DAMAGE_CONTROL

**Files:**
- Modify: `planner.py` (replace the `mode = "NORMAL"` placeholder)
- Modify: `tests/test_planner.py` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_planner.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_planner.py -q`
Expected: 3 of the 5 new tests FAIL (mode is hardcoded NORMAL); `test_mode_normal_...` and `test_empty_rows_...` pass by accident.

- [ ] **Step 3: Implement the mode logic**

In `planner.py`, replace the single line `mode = "NORMAL"            # Task 3 replaces this line with real mode logic` with:

```python
    committed = total + (RENT_RESERVE if rent_posted <= 0 else 0.0)
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
```

(Note this block must sit AFTER the `envelopes` list and BEFORE the `rent = {...}` dict so `e["state"]` mutation lands in the payload. Move the `rent`/`week`/`no_spend_days` lines below it if needed — final ordering: envelopes → mode block → rent/week/no_spend_days → subs/directives placeholders → plan dict.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_planner.py -q`
Expected: `16 passed`

- [ ] **Step 5: Commit**

```bash
git add planner.py tests/test_planner.py
git commit -m "feat(planner): NORMAL/TIGHT/DAMAGE_CONTROL modes; non-rent pacing"
```

---

### Task 4: Subscription projection (kill-list input)

**Files:**
- Modify: `planner.py` (add `project_subscriptions`, replace the `subs_total = 0.0` placeholder)
- Modify: `tests/test_planner.py` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_planner.py`:

```python
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
    assert out["plan"]["projected_subs_monthly"] == 190.0   # 180 + OpenAI Jun-7 20/2=10
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_planner.py -q`
Expected: FAIL with `AttributeError: module 'planner' has no attribute 'project_subscriptions'`

- [ ] **Step 3: Write the implementation**

Add to `planner.py` (above `plan_month`):

```python
def project_subscriptions(rows: list[dict], today: date) -> dict:
    """Per-merchant monthly subscription estimate from the trailing window.

    Sum of subscriptions-classified spend over SUBS_WINDOW_DAYS, divided by
    the window length in months (60d → 2.0). Deterministic — no cadence
    heuristics; the kill-list needs names and sizes, not predictions.
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
```

In `plan_month`, replace `subs_total = 0.0           # Task 4 replaces this line with project_subscriptions` with:

```python
    subs = project_subscriptions(rows, today if in_month else ms.replace(day=dim))
    subs_total = subs["total"]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_planner.py -q`
Expected: `18 passed`

- [ ] **Step 5: Commit**

```bash
git add planner.py tests/test_planner.py
git commit -m "feat(planner): trailing-window subscription projection"
```

---

### Task 5: Survival policy scaffold — ⚠️ USER-AUTHORED CHECKPOINT

**Files:**
- Modify: `planner.py` (add function between CONFIG and `classify`)
- Modify: `tests/test_planner.py` (append)

This is the one function the USER writes (values call: how to eat during a blown month). Scaffold it with a working default, then **stop and ask the user to write the body** before continuing. If executing autonomously and the user is unavailable, keep the default and flag it in the final report.

- [ ] **Step 1: Write the failing contract test**

Append to `tests/test_planner.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_planner.py::test_survival_policy_contract -q`
Expected: FAIL with `AttributeError: module 'planner' has no attribute 'survival_weekly_groceries'`

- [ ] **Step 3: Scaffold with the default policy**

Add to `planner.py` after the CONFIG block:

```python
def survival_weekly_groceries(weeks_left: int, overage: float) -> dict[str, float]:
    """USER POLICY — the weekly grocery floor during DAMAGE_CONTROL.

    The month is already lost; every grocery dollar widens the loss, but you
    still have to eat. Decide how: flat floor? taper as overage grows?
    Walmart-only past some overage? Inputs: weeks_left in the month, overage
    in dollars (committed − target, > 0). Returns weekly caps:
    {"walmart": float, "indian": float}. Contract in
    tests/test_planner.py::test_survival_policy_contract.
    """
    return {"walmart": SURVIVAL_WEEKLY_WALMART, "indian": SURVIVAL_WEEKLY_INDIAN}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `.venv/bin/python -m pytest tests/test_planner.py -q`
Expected: `19 passed`

- [ ] **Step 5: Commit the scaffold**

```bash
git add planner.py tests/test_planner.py
git commit -m "feat(planner): survival policy scaffold (default flat floor)"
```

- [ ] **Step 6: ⚠️ CHECKPOINT — ask the user to write the policy body**

Present the function to the user: file `planner.py`, function `survival_weekly_groceries`. Explain the trade-off space (flat = predictable; tapering with overage = punishes blowouts; Walmart-only = cheapest basket). Ask them to replace the body (~5–8 lines). Re-run `.venv/bin/python -m pytest tests/test_planner.py -q` after their edit; if their policy violates the contract test, show them the failure and let them decide (adjust policy or adjust contract). Commit as `feat(planner): user survival policy`.

---

### Task 6: Directive engine

**Files:**
- Modify: `planner.py` (add `build_directives` + helper; replace the directives placeholder)
- Modify: `tests/test_planner.py` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_planner.py`:

```python
# ---- directives -----------------------------------------------------------------

def _orders(out):
    return [d["order"] for d in out["directives"]]


def test_damage_control_directives_banner_prebook_survival():
    rows = _june_rows() + [_row(date(2026, 6, 9), 2413.40, "TRAVEL", "Alamo Rent-a-car", "ALAMO")]
    out = planner.plan_month(rows, date(2026, 6, 1), date(2026, 6, 11))
    orders = _orders(out)
    assert any(o.startswith("DAMAGE CONTROL: June is lost") for o in orders)
    assert "Do not prebook anything for July." in orders
    assert any("Subscriptions: CLOSED until Jul 1." == o for o in orders)
    assert any("Everything else: CLOSED until Jul 1." == o for o in orders)
    assert any(o.startswith("Survival groceries only: Walmart") for o in orders)
    assert any(o.startswith("Survival groceries only: Indian store") for o in orders)
    # banner first, and it's a stop
    assert out["directives"][0]["severity"] == "stop"


def test_tight_directives_slow_order_with_weekly_cap():
    out = planner.plan_month(_june_rows(), date(2026, 6, 1), date(2026, 6, 11))
    slows = [d for d in out["directives"] if d["severity"] == "slow"]
    assert len(slows) == 1
    assert slows[0]["envelope"] == "other"
    assert "max $30/week" in slows[0]["order"]


def test_closed_envelope_gets_stop_order():
    rows = _june_rows() + [_row(date(2026, 6, 9), 200.0, "GENERAL_MERCHANDISE", "Walmart", "WALMART GROCERY")]
    out = planner.plan_month(rows, date(2026, 6, 1), date(2026, 6, 11))
    assert out["plan"]["mode"] == "TIGHT"
    assert "Walmart: CLOSED until Jul 1." in _orders(out)


def test_kill_list_cuts_largest_first_until_it_fits():
    rows = _june_rows() + _subs_rows()
    out = planner.plan_month(rows, date(2026, 6, 1), date(2026, 6, 11))
    cancels = [d for d in out["directives"] if d["order"].startswith("Cancel/downgrade")]
    # projected 190 vs 150: cutting Claude.ai (150/mo) alone gets to 40 ≤ 150 — one cut
    assert len(cancels) == 1
    assert "Claude.ai" in cancels[0]["order"]
    assert cancels[0]["severity"] == "act"


def test_rent_watch_directives():
    out = planner.plan_month(_june_rows(), date(2026, 6, 1), date(2026, 6, 11))
    assert any("banked as buffer" in d["order"] for d in out["directives"])
    rows = [_row(date(2026, 6, 2), 30.0)]
    out = planner.plan_month(rows, date(2026, 6, 1), date(2026, 6, 3))
    assert any(d["order"].startswith("Rent not posted yet") for d in out["directives"])


def test_weekly_shopping_orders_in_non_damage_modes():
    out = planner.plan_month(_june_rows(), date(2026, 6, 1), date(2026, 6, 11))
    orders = _orders(out)
    assert "This week: Walmart ≤ $60 (one trip), Indian store ≤ $46." in orders
    # 'other' is slow (not open), so it gets the SLOW order, not a weekly order
    assert not any(o.startswith("Everything else ≤ $") for o in orders)


def test_no_spend_day_nudge_present():
    out = planner.plan_month(_june_rows(), date(2026, 6, 1), date(2026, 6, 11))
    assert any("no-spend day" in d["order"] for d in out["directives"])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_planner.py -q`
Expected: the 7 new tests FAIL (directives list is empty)

- [ ] **Step 3: Write the implementation**

Add to `planner.py` (above `plan_month`):

```python
def _next_month_first(ms: date) -> date:
    return (ms.replace(day=28) + timedelta(days=4)).replace(day=1)


def build_directives(*, mode: str, target: float, committed: float,
                     envelopes: list[dict], rent: dict, subs: dict,
                     week: dict, no_spend_days: int, ms: date) -> list[dict]:
    """Ordered, hard-language orders. Severity: stop > slow > act > info."""
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
                "eat from the pantry first", floor[key])
    else:
        for e in envelopes:
            if e["state"] == "closed":
                add("stop", e["key"], f"{ENV_LABEL[e['key']]}: CLOSED until {nxt_label}.",
                    f"${e['spent']:.2f} spent of ${e['budget']:.0f} — envelope empty")
            elif e["state"] == "slow":
                add("slow", e["key"],
                    f"{ENV_LABEL[e['key']]}: SLOW — max ${e['weekly_allowance']}/week "
                    f"for the rest of {month_name}.",
                    f"${e['spent']:.2f} of ${e['budget']:.0f} gone with "
                    f"{week['days_left']} days left in {month_name}", e["weekly_allowance"])

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
```

In `plan_month`, replace `directives: list[dict] = []  # Task 5 replaces this line with build_directives` with (note: the placeholder comment says Task 5; this is that replacement, numbered Task 6 after the survival checkpoint was split out):

```python
    directives = build_directives(mode=mode, target=target, committed=committed,
                                  envelopes=envelopes, rent=rent, subs=subs,
                                  week=week, no_spend_days=no_spend_days, ms=ms)
```

(`committed` exists from the Task 3 block and `subs` from Task 4, so this call has everything it needs; the plan dict keeps using `subs_total` unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_planner.py -q`
Expected: `26 passed`

- [ ] **Step 5: Commit**

```bash
git add planner.py tests/test_planner.py
git commit -m "feat(planner): directive engine — stops, kill-list, rent watch, weekly orders"
```

---

### Task 7: load_plan() — DB pull + warnings contract

**Files:**
- Modify: `planner.py` (append)
- Modify: `tests/test_planner.py` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_planner.py`:

```python
# ---- load_plan: warnings, not exceptions ----------------------------------------

def test_load_plan_db_down_returns_warning_not_raise(monkeypatch):
    import storage

    def boom(url=None):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(storage, "open_readonly", boom)
    out = planner.load_plan()
    assert out["plan"] is None
    assert out["directives"] == []
    assert len(out["warnings"]) == 1
    assert "connection refused" in out["warnings"][0]
    assert out["source"] == "history_db"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_planner.py::test_load_plan_db_down_returns_warning_not_raise -q`
Expected: FAIL with `AttributeError: module 'planner' has no attribute 'load_plan'`

- [ ] **Step 3: Write the implementation**

Append to `planner.py`:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_planner.py -q`
Expected: `27 passed`

- [ ] **Step 5: Commit**

```bash
git add planner.py tests/test_planner.py
git commit -m "feat(planner): load_plan with warnings-not-exceptions DB path"
```

---

### Task 8: Wire the tool — server.py, dashboard allowlist, verify_remote, README

**Files:**
- Modify: `server.py` (insert after the `get_optimizer_score` registration, ~line 865)
- Modify: `dashboard/src/lib/tools.ts:11`
- Modify: `verify_remote.py:7`, `verify_remote.py:68-69` (insert), `verify_remote.py:164-165`
- Modify: `README.md:64` (insert row after)

- [ ] **Step 1: Register the tool in server.py**

Insert after the `get_optimizer_score = mcp.tool(...)` block:

```python
def _get_optimizer_plan_impl() -> dict:
    """Decide the month: envelope plan + hard orders from local history — zero Plaid calls.

    The scoreboard's prescriptive twin. Rent ($1,850) is committed on day 1;
    four envelopes split the remaining $750 — walmart groceries, indian-store
    groceries, subscriptions, everything else. Returns the month's plan (mode:
    NORMAL/TIGHT/DAMAGE_CONTROL, envelope burn-down with self-correcting
    weekly allowances, rent watch, projected subscription cost) plus ordered
    directives: STOP orders for empty envelopes, a largest-first subscription
    kill-list, survival grocery floors when the month is already lost.
    Recomputed from transactions every call. See planner.py.
    """
    import planner
    return planner.load_plan()


get_optimizer_plan = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Optimizer Plan"},
    name="get_optimizer_plan",
)(_get_optimizer_plan_impl)
```

- [ ] **Step 2: Run the contract test to see it force the dashboard entry**

Run: `.venv/bin/python -m pytest tests/test_dashboard_contract.py -q`
Expected: FAIL — `dashboard allowlist drift — missing from dashboard: ['get_optimizer_plan']`

- [ ] **Step 3: Add the tool to the dashboard allowlist**

In `dashboard/src/lib/tools.ts`, change line 11:

```ts
  "get_financial_health", "list_category_overrides", "get_optimizer_plan",
```

- [ ] **Step 4: Update verify_remote.py census**

Line 7: change `(expects all 28 tools)` → `(expects all 29 tools)`.

After the `get_optimizer_score` entry (lines 68-69) insert:

```python
    ("get_optimizer_plan", {},
     lambda p: "plan" in p and "directives" in p, "Optimizer planner"),
```

Lines 164-165: change both occurrences of `28` → `29`:

```python
        check("protocol: tools/list returns all 29 tools", len(tools) == 29,
              f"({len(tools)} tools)")
```

- [ ] **Step 5: Add the README row**

After the `get_optimizer_score` row (README.md line 64) insert:

```markdown
| `get_optimizer_plan`    | The Optimizer planner: envelope plan + hard directives — stop orders, subscription kill-list, damage control |
```

- [ ] **Step 6: Run the full Python suite**

Run: `.venv/bin/python -m pytest -q`
Expected: all pass (DB-backed tests skip if the `finance-test-pg` container isn't running — that's expected; planner tests are pure and must pass either way).

- [ ] **Step 7: Commit**

```bash
git add server.py dashboard/src/lib/tools.ts verify_remote.py README.md
git commit -m "feat(server): get_optimizer_plan tool — allowlist, remote census, README"
```

---

### Task 9: Dashboard /plan page + nav

**Files:**
- Create: `dashboard/src/app/plan/page.tsx`
- Modify: `dashboard/src/app/layout.tsx:14` (NAV entry)

- [ ] **Step 1: Add the NAV entry**

In `dashboard/src/app/layout.tsx`, insert into the `NAV` array after `["/spending", "Spending"],`:

```ts
  ["/plan", "Plan"],
```

- [ ] **Step 2: Create the page**

Create `dashboard/src/app/plan/page.tsx`:

```tsx
"use client";

import { useTool } from "@/lib/hooks";
import { usd } from "@/lib/format";
import { Card, ErrorBanner, Loading, Stat } from "@/components/ui";

type Envelope = {
  key: string; budget: number; spent: number; remaining: number;
  weekly_allowance: number; state: "open" | "slow" | "closed";
};
type Directive = {
  severity: "stop" | "slow" | "act" | "info"; envelope: string | null;
  order: string; reason: string; amount: number | null;
};
type PlanPayload = {
  plan: {
    month: string; mode: "NORMAL" | "TIGHT" | "DAMAGE_CONTROL"; target: number;
    total_spent: number; headroom: number;
    rent: { reserve: number; posted: number | null; status: "posted" | "reserved" };
    envelopes: Envelope[]; week: { days_left: number; weeks_left: number };
    projected_subs_monthly: number;
  } | null;
  directives: Directive[];
  warnings: string[];
};

const ENV_LABEL: Record<string, string> = {
  walmart: "Walmart", indian: "Indian store",
  subscriptions: "Subscriptions", other: "Everything else",
};
const MODE_STYLE: Record<string, string> = {
  NORMAL: "bg-green/15 text-green",
  TIGHT: "bg-accent/15 text-accent",
  DAMAGE_CONTROL: "bg-red/15 text-red",
};
const SEV_STYLE: Record<string, string> = {
  stop: "bg-red/15 text-red", slow: "bg-accent/15 text-accent",
  act: "bg-accent/15 text-accent", info: "bg-card text-mut",
};

function BurnBar({ spent, budget }: { spent: number; budget: number }) {
  const pct = budget > 0 ? (spent / budget) * 100 : 100;
  const color = pct >= 100 ? "bg-red" : pct > 60 ? "bg-accent" : "bg-green";
  return (
    <div className="mt-2 h-1.5 w-full rounded bg-line">
      <div className={`h-1.5 rounded ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

export default function PlanPage() {
  const res = useTool<PlanPayload>("get_optimizer_plan");
  const plan = res.data?.plan;
  const directives = res.data?.directives ?? [];
  const warnings = res.data?.warnings ?? [];

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-1 text-xl font-bold">Plan</h1>
      <p className="mb-6 text-sm text-mut">
        What to do with the month — envelopes, orders, and this week&apos;s allowances.
      </p>
      <ErrorBanner error={res.error} />
      {warnings.map((w, i) => (
        <div key={i} className="mb-4 rounded-md border border-line bg-card px-3 py-2 text-sm text-red">
          ⚠ {w}
        </div>
      ))}

      {!res.data && !res.error ? <Loading /> : null}

      {plan && (
        <>
          <div className="mb-4 flex items-center gap-3">
            <span className={`rounded-full px-3 py-1 text-sm font-bold ${MODE_STYLE[plan.mode]}`}>
              {plan.mode.replace("_", " ")}
            </span>
            <span className="text-sm text-mut">
              {plan.month} · {plan.week.days_left} days left · {plan.week.weeks_left} week(s)
            </span>
          </div>

          <div className="mb-4 grid gap-4 md:grid-cols-3">
            <Card><Stat label="Spent" value={usd(plan.total_spent)} sub={`target ${usd(plan.target)}`} /></Card>
            <Card><Stat label="Headroom" value={
              <span className={plan.headroom >= 0 ? "text-green" : "text-red"}>{usd(plan.headroom)}</span>
            } /></Card>
            <Card><Stat label="Rent" value={usd(plan.rent.posted ?? plan.rent.reserve)}
              sub={plan.rent.status === "posted" ? "posted" : "reserved — committed day 1"} /></Card>
          </div>

          <div className="mb-4 grid gap-4 md:grid-cols-4">
            {plan.envelopes.map((e) => (
              <Card key={e.key} title={ENV_LABEL[e.key] ?? e.key}>
                <div className="flex items-baseline justify-between">
                  <span className="text-lg font-semibold">{usd(e.remaining)}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    e.state === "open" ? "bg-green/15 text-green"
                    : e.state === "slow" ? "bg-accent/15 text-accent" : "bg-red/15 text-red"}`}>
                    {e.state.toUpperCase()}
                  </span>
                </div>
                <div className="text-xs text-mut">{usd(e.spent)} of {usd(e.budget)} spent</div>
                <BurnBar spent={e.spent} budget={e.budget} />
                <div className="mt-2 text-xs text-mut">≤ {usd(e.weekly_allowance)}/week</div>
              </Card>
            ))}
          </div>

          <Card title="Orders">
            <ol className="flex flex-col gap-2">
              {directives.map((d, i) => (
                <li key={i} className="flex items-start gap-3 border-t border-line pt-2 first:border-0 first:pt-0">
                  <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${SEV_STYLE[d.severity]}`}>
                    {d.severity}
                  </span>
                  <div>
                    <div className="text-sm font-medium">{d.order}</div>
                    <div className="text-xs text-mut">{d.reason}</div>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Run dashboard tests + typecheck via build of the test suite**

Run: `cd dashboard && npm test`
Expected: existing suite passes (no page-level test files exist in this dashboard — consistent with siblings; the Python contract test covers the allowlist).

- [ ] **Step 4: Visual smoke (only if both local servers are running)**

If `localhost:3000` is up: open `http://localhost:3000/plan` and confirm the mode banner reads DAMAGE CONTROL for June. If servers aren't running, skip — do not start them just for this.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/app/plan/page.tsx dashboard/src/app/layout.tsx
git commit -m "feat(dashboard): /plan page — mode banner, envelope burn-down, orders"
```

---

### Task 10: Full verification

- [ ] **Step 1: Full Python suite**

Run: `.venv/bin/python -m pytest -q`
Expected: pass (DB tests skip without the container — acceptable; if the `finance-test-pg` container is available, start it first: `docker start finance-test-pg`).

- [ ] **Step 2: Dashboard suite**

Run: `cd dashboard && npm test`
Expected: pass.

- [ ] **Step 3: Live tool sanity check (optional, needs local MCP server running)**

If `localhost:8000` is up, call the tool through any MCP client and confirm June yields `mode: DAMAGE_CONTROL` with a kill-list naming Claude.ai. Do not start servers just for this — the unit tests already pin the behavior.

- [ ] **Step 4: Commit anything outstanding**

```bash
git status --short   # expect clean; commit stragglers if any
```

---

### Task 11: Deploy + weekly brief (operator steps — needs user)

These are not code steps; they happen after the user merges.

- [ ] **Step 1: PR / merge.** Open a PR from `nextjs-dashboard` to the repo's main branch. Merging triggers CI: test → build → deploy to Lambda → smoke. (Env/config changes deploy locally only — this feature has none.)

- [ ] **Step 2: Verify the deployment.** `.venv/bin/python verify_remote.py` — expect `29 tools` and the `get_optimizer_plan` check green.

- [ ] **Step 3: Create the weekly brief.** Schedule a routine (e.g. via the `/schedule` skill or claude.ai scheduled tasks): every Monday 8:00 AM, call `get_optimizer_plan` on the Personal Finance connector and deliver the `directives` list verbatim, leading with the mode banner. The tool is the brain; the brief is a messenger — it must not re-derive or soften the orders.

---

## Self-review notes (already applied)

- Spec's TIGHT trigger was corrected to non-rent pacing (spec amended 2026-06-11) — Task 3 implements the corrected rule and `test_mode_normal_when_all_open_and_non_rent_pace_ok` pins it.
- `plan_month` placeholder comments in Task 2 name the tasks that replace them; Task 6's directive wiring notes the comment says "Task 5" (renumbered when the survival checkpoint became its own task).
- Type/name consistency: `survival_weekly_groceries(weeks_left, overage) -> dict[str, float]`, `project_subscriptions(rows, today) -> {"by_merchant", "total"}`, `build_directives(...)` keyword-only — used identically in Tasks 5, 4, and 6 respectively.
- Expected test counts: Task 1 → 6, Task 2 → 11, Task 3 → 16, Task 4 → 18, Task 5 → 19, Task 6 → 26, Task 7 → 27.
- Spec's "empty rows → clean NORMAL plan" requirement is covered by `test_empty_rows_is_a_clean_normal_plan` (Task 3).
