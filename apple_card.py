"""Parse an Apple Card transaction CSV export into storage-ready rows.

Apple Card's CSV (Wallet → Card → Export Transactions) has columns:

    Transaction Date, Clearing Date, Description, Merchant, Category, Type,
    Amount (USD), Purchased By

Dates are MM/DD/YYYY. The Amount sign already matches Plaid's convention used
throughout this project: **positive = outflow (purchase/spend), negative =
inflow (payment to the card / credit)** — so amounts are stored as-is and the
existing analytics (which treat amount>0 as spending) just work.

Each row gets a deterministic ``transaction_id`` derived from the stable
fields (date, amount, description) plus an occurrence index that disambiguates
genuinely-identical same-day charges. Re-parsing the same export yields the
same ids, so imports are idempotent at the row level (see
storage.import_transactions for the date-coverage layer on top).
"""
from __future__ import annotations

import csv
import hashlib
import io
from datetime import date, datetime

ITEM_KEY = "APPLECARD"
ACCOUNT_ID = "applecard_manual"
INSTITUTION = "Apple Card"
CURRENCY = "USD"

# Apple's Category -> Plaid personal_finance_category primary, for consistency
# with Plaid-sourced rows in aggregate_spending / list_transactions. Categories
# without a clean mapping (Other, Payment, Credit, Debit) are kept verbatim
# (uppercased) rather than force-fit into a Plaid bucket — e.g. Apple files rent
# under "Other", so mislabeling it would corrupt spending totals.
_CATEGORY_MAP = {
    "Restaurants": "FOOD_AND_DRINK",
    "Grocery": "FOOD_AND_DRINK",
    "Gas": "TRANSPORTATION",
    "Transportation": "TRANSPORTATION",
}


def _parse_date(s: str) -> date | None:
    s = (s or "").strip()
    for fmt in ("%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _parse_amount(s: str) -> float:
    return float((s or "").replace(",", "").replace("$", "").strip())


def make_txn_id(d: date, amount: float, description: str, occurrence: int) -> str:
    key = f"{d.isoformat()}|{amount:.2f}|{description.strip()}|{occurrence}"
    return "ac_" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:24]


def parse_csv(text: str) -> list[dict]:
    """Parse Apple Card CSV text into normalized transaction rows.

    Returns rows shaped for storage.import_transactions. Rows with an
    unparseable date or amount are skipped. Raises ValueError if the header
    is not an Apple Card export.
    """
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or "Transaction Date" not in reader.fieldnames:
        raise ValueError(
            "not an Apple Card CSV (missing 'Transaction Date' header); "
            f"got headers: {reader.fieldnames}"
        )

    rows: list[dict] = []
    seen: dict[tuple, int] = {}
    for raw in reader:
        d = _parse_date(raw.get("Transaction Date", ""))
        if d is None:
            continue
        try:
            amount = _parse_amount(raw.get("Amount (USD)", ""))
        except (ValueError, TypeError):
            continue

        description = (raw.get("Description") or "").strip()
        merchant = (raw.get("Merchant") or "").strip() or description
        category = (raw.get("Category") or "").strip()
        category_primary = _CATEGORY_MAP.get(category, (category or "OTHER").upper())

        occ_key = (d.isoformat(), round(amount, 2), description)
        occurrence = seen.get(occ_key, 0)
        seen[occ_key] = occurrence + 1

        rows.append({
            "transaction_id": make_txn_id(d, amount, description, occurrence),
            "account_id": ACCOUNT_ID,
            "item_key": ITEM_KEY,
            "date": d,
            "authorized_date": _parse_date(raw.get("Clearing Date", "")),
            "amount": amount,
            "currency": CURRENCY,
            "merchant": merchant,
            "name": description,
            "category_primary": category_primary,
            "category_detailed": f"APPLECARD_{category.upper()}" if category else None,
            "pending": False,
        })
    return rows
