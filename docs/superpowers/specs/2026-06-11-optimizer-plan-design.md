# The Optimizer Planner — `get_optimizer_plan`

**Date:** 2026-06-11 · **Status:** Approved by user · **Builds on:** `gamify.py` (the Optimizer scoreboard)

## Problem

The Optimizer game scores the month (`get_optimizer_score`: where do I stand?) but issues no
decisions (what do I do next?). The user's targets: total spend ≤ **$2,600/month**, rent fixed at
**$1,850**, leaving **$750** for Walmart groceries, Indian-store groceries, and everything else.
Reality at design time: non-rent baseline runs $1,000–1,300/mo (Feb–Apr, excl. travel/taxes),
subscriptions alone ~$300/mo (Claude.ai $200), and June 2026 is already lost ($4,436 by day 11).
The planner closes the gap between scoreboard and behavior with concrete, hard orders.

## Decisions made (user-approved)

1. **Deliverables:** MCP tool + Next.js dashboard `/plan` page + weekly scheduled brief (all three).
2. **Envelopes:** four, subscriptions explicit — Walmart $230 / Indian $180 / Subscriptions $150 /
   Everything-else $190 (= $750; + rent reserve $1,850 = $2,600).
3. **Style:** hard directives — STOP orders, named subscription kill-list, damage-control mode.
4. **Architecture:** pure planner module mirroring `gamify.py`; read-time classification from
   CONFIG pattern sets; no new tables; state recomputed from transactions every call.

## Architecture

```
transactions (Postgres history store)
        │  same SELECT as gamify.load_game:
        │  date, amount, category_primary, merchant, name
        ▼
planner.py            (pure; imports gamify.is_expense — planner & scoreboard MUST agree)
  CONFIG: RENT_RESERVE, ENVELOPES, pattern sets, survival policy
  plan_month(rows, ms, today) → plan dict        (pure, unit-tested)
  load_plan(db_url, today)    → tool payload     (DB pull + warnings contract)
        ▼
├─ server.py: get_optimizer_plan (no params; _impl + mcp.tool, same as get_optimizer_score)
├─ dashboard /plan page (allowlisted in dashboard/src/lib/tools.ts — contract test enforces)
└─ weekly scheduled brief (calls the deployed tool via claude.ai connector)
```

No carryover between months, no stored plan, no writes anywhere. Plans the **current month only**.

## CONFIG

```python
RENT_RESERVE = 1850.0
ENVELOPES = {"walmart": 230.0, "indian": 180.0, "subscriptions": 150.0, "other": 190.0}
# Invariant (asserted in tests): RENT_RESERVE + sum(ENVELOPES) == gamify.MONTHLY_TARGET
```

All knobs (budgets, pattern sets, survival policy parameters) live in this block, like `gamify.py`.

## Classification

First-match-wins over lowercased `"{name} {merchant}"`, evaluated at read time:

| Order | Envelope | Patterns (initial) | Notes |
|---|---|---|---|
| 1 | rent | `applejack` | matches `gamify.categorize` |
| 2 | subscriptions | `claude.ai`, `openai`, `chatgpt`, `vercel`, `google one`, `google *`, `apple services`, `uber one`, `walmart+`, `wmt plus`, `screenstudio`, `nvidia`, `playstation network`, `apple.com/bill` | checked **before** walmart so `Walmart+ Member` lands here |
| 3 | walmart | `walmart`, `wal-mart` — minus cafeteria exclusions `amk walmart`, `dgtc cafe`, `dgtc coffe`, `dgtc mm`, `eighth pla`, `fh cfa`, `hq sparky` | campus-cafeteria lunches are not groceries → fall through to other |
| 4 | indian | `namaste`, `indiamart`, `india mart`, `little india`, `patel brother`, `india bazaar`, `desi ` | grocery stores only; restaurants (Kirpa, Paradise Biryani) match nothing → other |
| 5 | other | everything remaining | dining, delivery, Lyft, gas, travel, CVS — an expense is an expense |

Only rows passing `gamify.is_expense()` count (refunds not netted; transfers, card payments,
savings excluded). Pending handling matches the scoreboard exactly (same SELECT, no pending
filter) — the two surfaces must never show different totals.

**Rent rule:** $1,850 is committed on day 1, posted or not. Posts lower → surplus is safety
buffer, never redistributed to envelopes. Posts higher → `act` directive flags it.

## Modes

Let `elapsed_days = today.day` (current month, today inclusive — matches `gamify.score_month`),
`elapsed_share = elapsed_days / days_in_month`, `days_left = days_in_month − today.day + 1`,
`weeks_left = ceil(days_left / 7)`.

- **DAMAGE_CONTROL** — `total_spent + (RENT_RESERVE if rent unposted else 0) ≥ 2600`.
  Goal flips to minimize overage and protect next month: all envelopes CLOSED except a
  survival-groceries floor (user-authored policy, below); "do not prebook next month" order.
- **TIGHT** — not damage-control, but any envelope is `slow`/`closed` **or**
  `(total_spent − rent_posted) > (2600 − RENT_RESERVE) × elapsed_share`. Pace is judged on
  non-rent spend against the $750 — judging on the full total would flag TIGHT from the moment
  rent posts (day ~4) until ~day 22 every month, which is noise, not signal.
- **NORMAL** — everything else.

Envelope states: `closed` (remaining ≤ 0), `slow` (spent > budget × elapsed_share — tolerance
1.0, aggressive by design), else `open`. In DAMAGE_CONTROL every envelope state is forced to
`closed` regardless of pace — the dashboard must show a blown month as blown; the survival
grocery floor is expressed only as a directive, never as an open envelope.

## Directive engine

Ordered list of `{severity: stop|slow|act|info, envelope, order, reason, amount}` with hard
language. Generation order:

1. Mode banner (`stop` in damage-control, explaining the flipped goal).
2. Per envelope `closed` → `stop`: `"Indian store: CLOSED until Jul 1"`.
3. Per envelope `slow` → `slow`: this-week cap = `floor(remaining / weeks_left)`.
4. **Subscription kill-list** → `act`: project monthly subs cost = trailing-60-day
   subscriptions-classified spend ÷ 2, per merchant. If projected total > $150: order cuts
   largest-first until the remainder fits, one directive per cut
   (`"Cancel/downgrade Claude.ai ($200/mo): subs projected $300 vs $150 envelope"`).
5. Rent watch → `act`/`info`: unposted (reserved, not spendable) or posted-over-reserve.
6. Weekly shopping orders (NORMAL/TIGHT) → `info`:
   `"This week: Walmart ≤ $58 (one trip), Indian ≤ $45"` — allowance = `floor(remaining /
   weeks_left)`, recomputed every call, so last week's overspend automatically shrinks this
   week. Self-correcting; no carryover bookkeeping.
7. No-spend-day nudge → `info` (ties to the game's +25 pts/day).

### User-authored: survival policy

`survival_weekly_groceries(...)` — called only in DAMAGE_CONTROL; returns the weekly grocery
floor (Walmart/Indian) the user is willing to live on during a blown month. ~8 lines, written
by the user during implementation (values call, not engineering). Scaffolded with signature,
docstring, and contract test; default behavior until then: flat configured floor.

## Tool contract

```json
{"plan": {"month": "2026-06", "mode": "DAMAGE_CONTROL", "target": 2600,
          "total_spent": 4436.20, "headroom": -1836.20,
          "rent": {"reserve": 1850.0, "posted": 1812.80, "status": "posted"},
          "envelopes": [{"key": "walmart", "budget": 230.0, "spent": 0.0,
                          "remaining": 230.0, "weekly_allowance": 76,
                          "state": "closed"}],
          "week": {"days_left": 20, "weeks_left": 3},
          "projected_subs_monthly": 300.0},
 "directives": [{"severity": "stop", "envelope": null,
                  "order": "DAMAGE CONTROL: June is lost...", "reason": "...",
                  "amount": null}],
 "warnings": [], "source": "history_db"}
```

## Error handling

Repo warnings contract, honored strictly: DB unreachable →
`{"plan": null, "directives": [], "warnings": ["history DB unreachable: ..."]}` — never raise.
Empty transaction table → clean NORMAL plan, full envelopes, no directives beyond weekly orders.

## Dashboard page

`/plan` in the Next.js dashboard: mode banner, four envelope burn-down cards, ordered directive
list, this-week allowance table. Follows existing page/chart-wrapper patterns; tool call goes
through the existing allowlisted plumbing. Vitest coverage consistent with sibling pages.

## Weekly brief

Scheduled routine, Mondays 8:00 AM: call deployed `get_optimizer_plan` via the claude.ai
Personal Finance connector, deliver the directive list verbatim (the tool is the brain; the
brief is a messenger). Created after the tool ships to Lambda (push to main → CI deploy).

## Testing

`tests/test_planner.py`, pure-function style like `test_gamify.py`:

- Classification precedence: `Walmart+ Member` → subscriptions; `Amk Walmart Dgtc Cafe` →
  other; `Namaste Indian Grocery` → indian; restaurants → other; `applejack` → rent.
- Envelope math + CONFIG invariant ($1,850 + $750 = $2,600).
- Self-correcting weekly allowance (overspend week 1 → smaller week-2 cap).
- Mode transitions: June-2026-like fixture → DAMAGE_CONTROL; mid-pace fixture → TIGHT; fresh
  month → NORMAL.
- Kill-list: largest-first cuts until projected ≤ $150.
- Rent: buffer not redistributed; over-reserve flagged; unposted counted as committed.
- Empty rows → NORMAL, no crash; DB-down path → warnings, not raise (tool-level test).
- Existing contract test forces the dashboard allowlist entry; `verify_remote.py` tool census
  updated for the new tool.

## Out of scope

Month-to-month rollover/carryover, income-based pacing, budgets stored in the DB, multi-month
planning, any modification to `gamify.py` scoring, any write path. The planner reads the same
plane the scoreboard reads and emits words, not writes.
