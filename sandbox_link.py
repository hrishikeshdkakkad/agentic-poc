"""Headless sandbox Item linking — no browser, sandbox only.

Uses /sandbox/public_token/create + /item/public_token/exchange to mint
Items against Plaid's test institutions, then stores the access token in
the encrypted store (secure_tokens.py). Refuses to run unless
PLAID_ENV=sandbox.

Usage:
    python sandbox_link.py                       # First Platypus Bank, all products
    python sandbox_link.py --institution ins_109509 --products transactions
    python sandbox_link.py --name MYBANK2        # store under PLAID_TOKEN_MYBANK2

The default links one institution with transactions + investments +
liabilities so a single Item exercises cash, spending, investment (incl.
401k), and debt data.
"""
from __future__ import annotations

import argparse
import os
import sys

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

DEFAULT_INSTITUTION = "ins_109508"  # First Platypus Bank
DEFAULT_PRODUCTS = ["transactions", "investments", "liabilities"]


def create_sandbox_item(
    institution_id: str = DEFAULT_INSTITUTION,
    products: list[str] | None = None,
    name: str | None = None,
) -> dict:
    from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest
    from plaid.model.products import Products
    from plaid.model.sandbox_public_token_create_request import SandboxPublicTokenCreateRequest

    import secure_tokens
    from plaid_client import build_api

    if os.environ.get("PLAID_ENV", "production").lower() != "sandbox":
        raise SystemExit("sandbox_link.py requires PLAID_ENV=sandbox")

    api = build_api()
    pt = api.sandbox_public_token_create(
        SandboxPublicTokenCreateRequest(
            institution_id=institution_id,
            initial_products=[Products(p) for p in (products or DEFAULT_PRODUCTS)],
        )
    ).to_dict()
    ex = api.item_public_token_exchange(
        ItemPublicTokenExchangeRequest(public_token=pt["public_token"])
    ).to_dict()

    env_key = (name or f"SANDBOX_{institution_id.replace('ins_', '')}").upper()
    secure_tokens.set_token(env_key, ex["access_token"])
    return {
        "institution_id": institution_id,
        "item_id": ex["item_id"],
        "env_key": f"PLAID_TOKEN_{env_key}",
        "stored": "encrypted",
    }


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--institution", default=DEFAULT_INSTITUTION)
    p.add_argument("--products", default=",".join(DEFAULT_PRODUCTS),
                   help="comma-separated initial products")
    p.add_argument("--name", default=None, help="token key suffix (default from institution id)")
    args = p.parse_args()
    out = create_sandbox_item(
        institution_id=args.institution,
        products=[s.strip() for s in args.products.split(",") if s.strip()],
        name=args.name,
    )
    print(f"Linked {out['institution_id']} (item {out['item_id']}) -> {out['env_key']} [encrypted]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
