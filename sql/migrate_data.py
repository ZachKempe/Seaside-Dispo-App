"""One-time migration: copy buyers.db (SQLite) rows into Supabase Postgres via REST API."""
import json
import sqlite3
import urllib.request
from pathlib import Path

CONFIG = json.loads(Path("/Users/zachk/seaside_automation/config.json").read_text())
SB = CONFIG["supabase"]
BASE = SB["url"].rstrip("/") + "/rest/v1"
KEY = SB["service_role_key"]

HEADERS = {
    "apikey": KEY,
    "Authorization": f"Bearer {KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
}


def insert(table: str, rows: list):
    if not rows:
        return
    body = json.dumps(rows).encode()
    req = urllib.request.Request(f"{BASE}/{table}", data=body, method="POST", headers=HEADERS)
    try:
        urllib.request.urlopen(req, timeout=30)
        print(f"  + {table}: inserted {len(rows)} row(s)")
    except urllib.error.HTTPError as e:
        print(f"  ! {table} error: {e.read().decode()[:300]}")


def main():
    conn = sqlite3.connect("/Users/zachk/seaside_automation/buyers.db")
    conn.row_factory = sqlite3.Row

    # ── buyers ──────────────────────────────────────────────────────────────
    rows = []
    for r in conn.execute("select * from buyers"):
        rows.append({
            "id": r["id"], "name": r["name"], "email": r["email"], "phone": r["phone"],
            "strategy": r["strategy"], "states": r["states"], "max_price": r["max_price"],
            "max_piti": r["max_piti"], "min_beds": r["min_beds"], "tier": r["tier"],
            "list_source": r["list_source"], "active": bool(r["active"]),
            "sms_opt_in": bool(r["sms_opt_in"]), "notes": r["notes"],
            "date_added": r["date_added"],
        })
    insert("buyers", rows)

    # ── deal_blasts ─────────────────────────────────────────────────────────
    rows = [{
        "id": r["id"], "card_id": r["card_id"], "address": r["address"], "channel": r["channel"],
        "status": r["status"], "detail": r["detail"], "blasted_at": r["blasted_at"],
    } for r in conn.execute("select * from deal_blasts")]
    insert("deal_blasts", rows)

    # ── facebook_posts ──────────────────────────────────────────────────────
    rows = [{
        "id": r["id"], "card_id": r["card_id"], "card_name": r["card_name"],
        "group_name": r["group_name"], "posted_at": r["posted_at"],
    } for r in conn.execute("select * from facebook_posts")]
    insert("facebook_posts", rows)

    # ── buyer_activity ──────────────────────────────────────────────────────
    rows = [{
        "id": r["id"], "buyer_id": r["buyer_id"], "card_id": r["card_id"], "address": r["address"],
        "channel": r["channel"], "detail": r["detail"], "created_at": r["created_at"],
    } for r in conn.execute("select * from buyer_activity")]
    insert("buyer_activity", rows)

    # ── property_status ─────────────────────────────────────────────────────
    rows = [{
        "card_id": r["card_id"], "status": r["status"], "notes": r["notes"],
        "updated_at": r["updated_at"],
    } for r in conn.execute("select * from property_status")]
    insert("property_status", rows)

    # ── deal_terms ──────────────────────────────────────────────────────────
    rows = [{
        "card_id": r["card_id"], "entry_fee": r["entry_fee"], "price": r["price"],
        "mortgage": r["mortgage"], "rate": r["rate"], "piti": r["piti"], "beds": r["beds"],
        "baths": r["baths"], "sqft": r["sqft"], "year_built": r["year_built"],
        "updated_at": r["updated_at"],
    } for r in conn.execute("select * from deal_terms")]
    insert("deal_terms", rows)

    conn.close()
    print("Migration complete.")


if __name__ == "__main__":
    main()
