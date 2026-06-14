"""Local-only Plaid Link helper.

Run one-time per bank to obtain a long-lived access token. Never deploy.

Usage:
    cp .env.example .env            # fill PLAID_CLIENT_ID / PLAID_SECRET
    source .venv/bin/activate
    uvicorn link_helper:app --port 8765

Then open http://localhost:8765 in your browser, click "Link a bank",
complete the Plaid Link flow, and paste the printed env var line into
your local .env and your deployment's env settings.

For re-auth (ITEM_LOGIN_REQUIRED):
    curl -X POST localhost:8765/create-link-token \\
      -H "content-type: application/json" \\
      -d '{"update_access_token": "access-prod-EXISTING"}'
    # then open the returned link_token in the browser widget
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

# Defense-in-depth: refuse to run on Horizon (deployment env).
if os.environ.get("HORIZON"):
    sys.exit("link_helper.py must not run on Horizon. Run locally only.")

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from plaid.model.country_code import CountryCode
from plaid.model.institutions_get_by_id_request import InstitutionsGetByIdRequest
from plaid.model.item_get_request import ItemGetRequest
from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest
from plaid.model.link_token_create_request import LinkTokenCreateRequest
from plaid.model.link_token_create_request_update import LinkTokenCreateRequestUpdate
from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
from plaid.model.link_token_transactions import LinkTokenTransactions
from plaid.model.products import Products

from plaid_client import all_items, build_api

app = FastAPI(title="Personal Finance MCP — Dashboard")
api = build_api()


# --- Dashboard support: status read-out + manual sync -----------------------
# All local-only; this file already refuses to run on Horizon.

def _last_sync_path() -> str:
    import secure_tokens
    d = secure_tokens.secrets_dir()
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "last_sync.json")


def _read_last_sync() -> dict | None:
    try:
        with open(_last_sync_path()) as f:
            return json.load(f)
    except Exception:
        return None


def _write_last_sync(data: dict) -> None:
    try:
        with open(_last_sync_path(), "w") as f:
            json.dump(data, f)
    except Exception:
        pass


@app.get("/api/status")
def api_status() -> dict:
    """Linked banks + link health + accounts + last-sync, for the dashboard.

    Link status comes from all_items() (cached per-Item item_get); accounts and
    per-Item last_synced_at come from the history store (zero Plaid calls).
    """
    import storage
    try:
        items = all_items(api)
    except Exception:
        items = []
    accounts_by_item: dict[str, list] = {}
    sync_by_item: dict[str, str | None] = {}
    manual_activity: dict[str, str | None] = {}
    delivery: dict = {}
    db_ok = True
    try:
        conn = storage.open_readonly()
        try:
            for r in conn.execute(
                "SELECT item_key, name, mask, type, subtype, institution FROM accounts "
                "ORDER BY item_key, name"
            ).fetchall():
                accounts_by_item.setdefault(r[0], []).append(
                    {"name": r[1], "mask": r[2], "type": r[3], "subtype": r[4],
                     "institution": r[5]}
                )
            for r in conn.execute(
                "SELECT item_key, last_synced_at FROM sync_state"
            ).fetchall():
                sync_by_item[r[0]] = str(r[1]) if r[1] else None
            for r in conn.execute(
                "SELECT item_key, max(updated_at) FROM transactions GROUP BY item_key"
            ).fetchall():
                manual_activity[r[0]] = str(r[1]) if r[1] else None
            # Delivery pulse (tag-based): this month vs last month, to watch it fall.
            dr = conn.execute(
                """
                SELECT
                  round(coalesce(sum(amount) FILTER (WHERE mon = date_trunc('month', CURRENT_DATE)),0)::numeric,2),
                  count(*) FILTER (WHERE mon = date_trunc('month', CURRENT_DATE)),
                  round(coalesce(sum(amount) FILTER (WHERE mon = date_trunc('month', CURRENT_DATE) - interval '1 month'),0)::numeric,2)
                FROM (
                  SELECT t.amount, date_trunc('month', t.date) AS mon
                  FROM transactions t
                  JOIN transaction_tags g ON t.transaction_id = g.transaction_id AND g.tag = 'delivery'
                  WHERE t.amount > 0
                ) s
                """
            ).fetchone()
            if dr:
                delivery = {"this_month": float(dr[0]), "orders": dr[1],
                            "last_month": float(dr[2])}
        finally:
            conn.close()
    except Exception:
        db_ok = False
    plaid_keys = {env_key for env_key, _t, _h in items}
    institutions = [
        {
            "env_key": env_key,
            "institution": health.institution_name or env_key,
            "status": health.status,
            "reason": health.reason,
            "accounts": accounts_by_item.get(env_key, []),
            "last_synced_at": sync_by_item.get(env_key),
        }
        for env_key, _token, health in items
    ]
    # Manually-imported sources (e.g. Apple Card CSV) have accounts but no
    # Plaid Item — surface them so the dashboard shows everything that's linked.
    for item_key, accts in accounts_by_item.items():
        if item_key in plaid_keys:
            continue
        institutions.append({
            "env_key": item_key,
            "institution": accts[0].get("institution") or item_key,
            "status": "csv_import",
            "reason": None,
            "accounts": accts,
            "last_synced_at": manual_activity.get(item_key),
        })
    game = None
    try:
        import gamify
        game = gamify.load_game()
    except Exception:
        game = None
    return {"institutions": institutions, "db_ok": db_ok,
            "delivery": delivery, "game": game, "last_sync": _read_last_sync()}


@app.post("/import-apple-card")
async def import_apple_card(request: Request) -> dict:
    """Import an uploaded Apple Card CSV (raw request body) idempotently."""
    import apple_card
    import storage
    raw = await request.body()
    text = raw.decode("utf-8-sig", errors="replace")
    try:
        rows = apple_card.parse_csv(text)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    if not rows:
        return {"ok": False, "error": "no valid transactions found in file"}
    conn = storage.open_db()
    try:
        result = storage.import_transactions(
            conn, rows, apple_card.ITEM_KEY, apple_card.ACCOUNT_ID, apple_card.INSTITUTION
        )
    finally:
        conn.close()
    return {"ok": True, **result}


@app.post("/sync")
def do_sync() -> dict:
    """Run a manual sync for every linked Item and remember the outcome."""
    import sync as sync_mod
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    try:
        result = sync_mod.run_sync(api)
        warnings = result.get("warnings") or []
        summary = {
            "at": now,
            "ok": not warnings,
            "total_transactions_stored": result.get("total_transactions_stored"),
            "items": [
                {
                    "institution": i.get("institution"),
                    "transactions": i.get("transactions"),
                    "snapshots": i.get("snapshots"),
                }
                for i in result.get("items") or []
            ],
            "warnings": warnings,
        }
    except Exception as e:
        summary = {"at": now, "ok": False, "error": f"{type(e).__name__}: {e}", "warnings": []}
    _write_last_sync(summary)
    return summary


class CreateReq(BaseModel):
    update_access_token: str | None = None
    # Update mode only: add the investments product to an already-linked Item
    # (e.g. an investment item linked before investments-transactions consent was
    # captured -- the Fidelity/Schwab case). Plaid grants it via re-consent.
    add_investments: bool = False


@app.post("/create-link-token")
def create_link_token(req: CreateReq) -> dict:
    if req.update_access_token:
        update_kwargs = dict(
            user=LinkTokenCreateRequestUser(client_user_id="personal-user"),
            client_name="Personal Finance MCP",
            country_codes=[CountryCode("US")],
            language="en",
            access_token=req.update_access_token,
            update=LinkTokenCreateRequestUpdate(account_selection_enabled=False),
        )
        if req.add_investments:
            # Adds the investments product to the existing Item via consent.
            update_kwargs["additional_consented_products"] = [Products("investments")]
        body = LinkTokenCreateRequest(**update_kwargs)
    else:
        # required_if_supported: brokerages capture the investments consent at link
        # time (so investments-transactions never needs a later re-link), while
        # banks that don't support it still link cleanly.
        body = LinkTokenCreateRequest(
            user=LinkTokenCreateRequestUser(client_user_id="personal-user"),
            client_name="Personal Finance MCP",
            products=[Products("transactions")],
            required_if_supported_products=[Products("investments")],
            optional_products=[Products("liabilities")],
            country_codes=[CountryCode("US")],
            language="en",
            # Request Plaid's maximum 24 months of history (default is 90 days).
            # This is fixed at Item creation and can never be raised afterwards, so
            # existing Items keep their 90-day seed -- only Items linked from now on,
            # or re-linked as a fresh Item, get the deep backfill.
            transactions=LinkTokenTransactions(days_requested=730),
        )
    return api.link_token_create(body).to_dict()


class ExchangeReq(BaseModel):
    public_token: str


@app.post("/exchange")
def exchange(req: ExchangeReq) -> dict:
    resp = api.item_public_token_exchange(
        ItemPublicTokenExchangeRequest(public_token=req.public_token)
    ).to_dict()
    access_token = resp["access_token"]
    item_id = resp["item_id"]

    item = api.item_get(ItemGetRequest(access_token=access_token)).to_dict().get("item", {}) or {}
    ins_id = item.get("institution_id")
    ins_name = "UNKNOWN"
    if ins_id:
        try:
            ins_name = api.institutions_get_by_id(
                InstitutionsGetByIdRequest(
                    institution_id=ins_id,
                    country_codes=[CountryCode("US")],
                )
            ).to_dict()["institution"]["name"]
        except Exception:
            ins_name = "UNKNOWN"

    env_suffix = "".join(ch for ch in ins_name.upper() if ch.isalnum())
    env_key = f"PLAID_TOKEN_{env_suffix}" if env_suffix else "PLAID_TOKEN_UNKNOWN"

    # Store encrypted at rest; the raw token is never printed or logged.
    import secure_tokens
    secure_tokens.set_token(env_key, access_token)

    print("=" * 60, flush=True)
    print(f"Institution: {ins_name}", flush=True)
    print(f"Item ID:     {item_id}", flush=True)
    print(f"Token encrypted and stored in plaid_tokens as {env_key}", flush=True)
    print("=" * 60, flush=True)

    return {"institution": ins_name, "item_id": item_id, "env_key": env_key, "stored": "encrypted"}


class ResetReq(BaseModel):
    env_key: str


@app.post("/reset-item")
def reset_item_endpoint(req: ResetReq) -> dict:
    """Retire a Plaid Item and wipe its local state, ready for a fresh re-link."""
    from dataclasses import asdict
    import reset_item
    try:
        result = reset_item.reset_item(req.env_key, confirm=True, api=api)
        return {"ok": True, **asdict(result)}
    except Exception as e:
        return {"ok": False, "error": str(e), "env_key": req.env_key}


INDEX_HTML = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Personal Finance MCP — Dashboard</title>
<style>
  :root { --bg:#0f1115; --card:#181b21; --line:#262b33; --txt:#e6e9ef; --mut:#9aa3b2;
          --green:#2ecc71; --red:#ff5b5b; --amber:#f5a623; --accent:#4c8bf5; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--txt);
         font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:820px; margin:2.5rem auto; padding:0 1rem; }
  h1 { font-size:1.25rem; margin:0 0 .2rem; }
  .sub { color:var(--mut); margin:0 0 1.5rem; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px;
          padding:1rem 1.25rem; margin-bottom:1rem; }
  .row { display:flex; align-items:center; justify-content:space-between; gap:1rem; }
  .strip { display:flex; gap:1.75rem; flex-wrap:wrap; color:var(--mut); font-size:.85rem; }
  .strip b { color:var(--txt); }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:.55rem .25rem; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--mut); font-weight:600; font-size:.74rem; text-transform:uppercase; letter-spacing:.04em; }
  tr:last-child td { border-bottom:0; }
  .badge { display:inline-block; padding:.15rem .55rem; border-radius:999px; font-size:.76rem; font-weight:600; }
  .b-green { background:rgba(46,204,113,.15); color:var(--green); }
  .b-red { background:rgba(255,91,91,.15); color:var(--red); }
  .b-amber { background:rgba(245,166,35,.15); color:var(--amber); }
  .b-grey { background:rgba(154,163,178,.15); color:var(--mut); }
  .acct { color:var(--mut); font-size:.85rem; }
  button { font:inherit; font-weight:600; border:0; border-radius:8px; padding:.55rem 1rem; cursor:pointer; }
  .primary { background:var(--accent); color:#fff; } .ghost { background:transparent; color:var(--txt); border:1px solid var(--line); }
  button:disabled { opacity:.5; cursor:default; }
  .muted { color:var(--mut); } .ok { color:var(--green); } .err { color:var(--red); }
  pre { white-space:pre-wrap; color:var(--mut); font-size:.8rem; margin:.6rem 0 0; }
  .gbar { height:9px; background:var(--line); border-radius:99px; overflow:hidden; margin:.5rem 0; }
  .gbar-fill { height:100%; transition:width .4s; }
  .gbar-ok { background:var(--green); } .gbar-warn { background:var(--amber); } .gbar-over { background:var(--red); }
  .gstat { font-size:1.6rem; font-weight:700; }
  .gamecard { background:linear-gradient(180deg,#1b1f27,#171a20); border-color:#2e3440; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Personal Finance MCP</h1>
  <p class="sub">Linked accounts &amp; sync status</p>

  <div class="card"><div class="strip" id="strip"><span class="muted">Loading…</span></div></div>

  <div class="card gamecard" id="gamecard" style="display:none">
    <div class="row" style="margin-bottom:.4rem">
      <strong>🎮 The Optimizer</strong>
      <span class="muted" id="g_lifetime"></span>
    </div>
    <div class="row" style="align-items:flex-end">
      <span class="gstat" id="g_points"></span>
      <span class="acct" id="g_week"></span>
    </div>
    <div class="gbar"><div class="gbar-fill" id="g_fill"></div></div>
    <div id="g_wedding" style="margin-top:.3rem"></div>
    <div class="acct" id="g_best" style="margin-top:.5rem"></div>
  </div>

  <div class="card">
    <div class="row" style="margin-bottom:.75rem">
      <strong>Linked banks</strong>
      <span><button class="ghost" id="refresh">Refresh</button>
            <button class="primary" id="sync">Sync now</button></span>
    </div>
    <table id="banks"><tbody><tr><td class="muted">Loading…</td></tr></tbody></table>
    <pre id="syncout"></pre>
  </div>

  <div class="card row">
    <span class="muted">Connect another bank account</span>
    <button class="primary" id="link">Link a bank</button>
  </div>
  <pre id="linkout"></pre>

  <div class="card">
    <div class="row" style="margin-bottom:.6rem">
      <div><strong>Import Apple Card</strong>
        <div class="acct">Upload an Apple Card CSV export. Re-uploading overlapping statements only adds dates you don't already have.</div>
      </div>
      <span>
        <input type="file" id="acfile" accept=".csv,text/csv" style="display:none">
        <button class="ghost" id="acpick">Choose CSV…</button>
        <button class="primary" id="acupload" disabled>Upload</button>
      </span>
    </div>
    <div class="acct" id="acname">No file chosen</div>
    <pre id="acout"></pre>
  </div>
</div>

<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script>
// Link-status -> [label, css class]. Tweak labels/colors here.
const STATUS = {
  healthy:["Connected","b-green"], re_auth_required:["Re-auth needed","b-red"],
  pending_expiration:["Expiring soon","b-amber"], item_locked:["Locked","b-amber"],
  no_accounts:["No accounts","b-grey"], unknown_error:["Error","b-red"],
  csv_import:["CSV import","b-grey"],
};
const fmt = s => { if(!s) return "—"; const d=new Date(s); return isNaN(d)?s:d.toLocaleString(); };

async function load(){
  let d; try { d = await (await fetch('/api/status')).json(); }
  catch(e){ document.getElementById('strip').innerHTML='<span class="err">dashboard API unreachable</span>'; return; }
  const ls = d.last_sync;
  const lastOk = d.institutions.map(i=>i.last_synced_at).filter(Boolean).sort().pop();
  let res = '<b class="muted">never</b>';
  if (ls) res = ls.ok ? `<b class="ok">OK</b> · ${fmt(ls.at)}` : `<b class="err">error</b> · ${fmt(ls.at)}`;
  let deliv = '';
  if (d.delivery && Object.keys(d.delivery).length){
    const t = d.delivery.this_month, l = d.delivery.last_month;
    const arrow = t < l ? '<span class="ok">▼</span>' : (t > l ? '<span class="err">▲</span>' : '·');
    deliv = `<span>🛵 Delivery this month: <b>$${t.toFixed(2)}</b> (${d.delivery.orders}) ${arrow} <span class="muted">last mo $${l.toFixed(2)}</span></span>`;
  }
  document.getElementById('strip').innerHTML =
    `<span>Banks linked: <b>${d.institutions.length}</b></span>`+
    `<span>History DB: <b class="${d.db_ok?'ok':'err'}">${d.db_ok?'connected':'unreachable'}</b></span>`+
    `<span>Last successful sync: <b>${fmt(lastOk)}</b></span>`+
    `<span>Last sync result: ${res}</span>`+
    deliv;

  const tb = document.querySelector('#banks tbody');
  if (!d.institutions.length){
    tb.innerHTML = '<tr><td class="muted">No banks linked yet — click “Link a bank”.</td></tr>';
  } else {
    tb.innerHTML = '<tr><th>Bank</th><th>Link status</th><th>Accounts</th><th>Last synced</th></tr>' +
      d.institutions.map(i=>{
        const [label,cls] = STATUS[i.status] || [i.status||'unknown','b-grey'];
        const accts = i.accounts.length
          ? i.accounts.map(a=>`${a.name||a.subtype||'account'}${a.mask?' ••'+a.mask:''}`).join('<br>')
          : '<span class="muted">— run sync —</span>';
        return `<tr><td><strong>${i.institution}</strong></td>`+
               `<td><span class="badge ${cls}">${label}</span>`+(i.reason?`<div class="acct">${i.reason}</div>`:'')+`</td>`+
               `<td class="acct">${accts}</td><td class="acct">${fmt(i.last_synced_at)}</td></tr>`;
      }).join('');
  }
  const out = document.getElementById('syncout');
  if (ls && ls.warnings && ls.warnings.length) out.textContent = 'Last sync warnings:\\n'+JSON.stringify(ls.warnings,null,2);
  else if (ls && ls.error) out.textContent = 'Last sync error: '+ls.error;
  else out.textContent = '';

  renderGame(d.game);
}

function renderGame(g){
  const card = document.getElementById('gamecard');
  if (!g || !g.current_month){ card.style.display='none'; return; }
  card.style.display='';
  const cm = g.current_month;
  const over = cm.total > cm.target;
  const daysLeft = Math.max(0, cm.days_in_month - cm.elapsed_days);
  const pct = Math.min(100, Math.round(100 * cm.total / cm.target));
  const cats = Object.entries(cm.by_category || {}).slice(0,4)
    .map(([k,v]) => `${k} $${Math.round(v).toLocaleString()}`).join(' · ');
  document.getElementById('g_lifetime').innerHTML =
    `TARGET <b>$${cm.target.toLocaleString()}</b>/mo · won <b>${g.months_won}/${g.months_played}</b> months`;
  document.getElementById('g_points').innerHTML =
    (over ? `<span class="err">$${cm.total.toLocaleString()}</span>` : `$${cm.total.toLocaleString()}`) +
    ` <span class="acct">of $${cm.target.toLocaleString()} this month</span>` +
    (cm.new_record ? ' <span class="badge b-green">RECORD PACE</span>' : '');
  document.getElementById('g_week').innerHTML =
    `&nbsp;&nbsp;day ${cm.elapsed_days}/${cm.days_in_month} · ` +
    (over ? `<span class="err">over by $${(-cm.remaining).toLocaleString()}</span>`
          : `<span class="ok">$${cm.remaining.toLocaleString()} left</span>, ${daysLeft} days`);
  const fill = document.getElementById('g_fill');
  fill.style.width = pct + '%';
  fill.className = 'gbar-fill ' + (over ? 'gbar-over' : (pct > 80 ? 'gbar-warn' : 'gbar-ok'));
  document.getElementById('g_wedding').innerHTML =
    (cm.saved > 0
       ? `💍 On track to send <b class="ok">$${cm.saved.toLocaleString()}</b> to the wedding`
       : `📊 Allowance to date: $${cm.allowance_to_date.toLocaleString()} · you're at $${cm.total.toLocaleString()}`) +
    ` · <span class="muted">$${g.wedding_saved_total.toLocaleString()} banked</span>`;
  const pb = g.personal_best;
  document.getElementById('g_best').innerHTML =
    (cats ? `<span class="muted">where it's going:</span> ${cats}<br>` : '') +
    (pb ? `🏆 Best month: $${pb.total.toLocaleString()} (${pb.month}) — beat it for +100`
        : '🎯 June is your baseline. First clean shot at $2,600 is July 1.');
}

document.getElementById('refresh').onclick = load;
document.getElementById('sync').onclick = async (e)=>{
  const b=e.target, orig=b.textContent; b.disabled=true; b.textContent='Syncing…';
  document.getElementById('syncout').textContent='Running sync…';
  try {
    const d = await (await fetch('/sync',{method:'POST'})).json();
    const line = d.ok ? `✓ Sync OK — ${d.total_transactions_stored} transactions stored` : '⚠ Sync completed with issues';
    document.getElementById('syncout').textContent = line+'\\n'+JSON.stringify(d,null,2);
  } catch(err){ document.getElementById('syncout').textContent='Sync failed: '+err; }
  finally { b.disabled=false; b.textContent=orig; load(); }
};

document.getElementById('link').onclick = async () => {
  const data = await (await fetch('/create-link-token',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json();
  if (!data.link_token){ document.getElementById('linkout').textContent='Error: '+JSON.stringify(data); return; }
  Plaid.create({
    token: data.link_token,
    onSuccess: async (public_token) => {
      const ex = await fetch('/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({public_token})});
      document.getElementById('linkout').textContent='Linked! '+await ex.text(); load();
    },
    onExit: (err)=>{ if(err) document.getElementById('linkout').textContent='Exit: '+JSON.stringify(err); },
  }).open();
};

// --- Apple Card CSV import ---
const acfile = document.getElementById('acfile');
document.getElementById('acpick').onclick = () => acfile.click();
acfile.onchange = () => {
  const f = acfile.files[0];
  document.getElementById('acname').textContent = f ? f.name : 'No file chosen';
  document.getElementById('acupload').disabled = !f;
};
document.getElementById('acupload').onclick = async (e) => {
  const f = acfile.files[0]; if (!f) return;
  const b = e.target, orig = b.textContent; b.disabled = true; b.textContent = 'Uploading…';
  document.getElementById('acout').textContent = 'Importing…';
  try {
    const d = await (await fetch('/import-apple-card', {method:'POST', body: f})).json();
    if (!d.ok){ document.getElementById('acout').textContent = '✗ ' + (d.error||'import failed'); }
    else {
      document.getElementById('acout').textContent =
        `✓ Imported ${d.imported} new transaction(s).\\n`+
        `  skipped (date already stored): ${d.skipped_existing_date}\\n`+
        `  skipped (duplicate id): ${d.skipped_duplicate_id}\\n`+
        `  file covered ${d.file_date_range ? d.file_date_range[0]+' → '+d.file_date_range[1] : '—'}\\n`+
        `  Apple Card total now: ${d.total_for_item}`;
    }
  } catch(err){ document.getElementById('acout').textContent = 'Upload failed: ' + err; }
  finally { b.disabled=false; b.textContent=orig; load(); }
};

load();
</script>
</body>
</html>
"""


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return INDEX_HTML
