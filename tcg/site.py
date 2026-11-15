"""DB から自分用サイト（1枚のHTML）を生成する（設計書 [E] の最小版）。

出力は claude.ai の Artifact として公開する前提で、<!doctype>/<html>/<head>/<body> を書かない。
状態（受付中・まもなく締切・要確認など）はページを開いた時刻で計算し直すので、
ビルドの間隔があいても表示は正しく保たれる。
"""
from __future__ import annotations

import json
from pathlib import Path

from . import db

TEMPLATE = Path(__file__).with_name("site_template.html")


def collect_data() -> dict:
    con = db.connect()
    stores_doc = json.loads(db.STORES.read_text(encoding="utf-8"))
    stores = {s["id"]: s for s in stores_doc["stores"]}
    listings = []
    for r in con.execute("SELECT * FROM listings ORDER BY COALESCE(end_at, '9999') ASC").fetchall():
        d = dict(r)
        d.pop("found_via", None)  # 内部用。公開ページには出さない
        ids = json.loads(d["pickup_store_ids"]) if d.get("pickup_store_ids") else []
        d["pickup_store_ids"] = ids
        d["cities"] = sorted({stores[i]["city"] for i in ids if i in stores})
        d["history"] = [dict(h) for h in con.execute(
            "SELECT change, detail, at FROM changes WHERE listing_id=? ORDER BY id", (r["id"],)).fetchall()]
        listings.append(d)
    unverified = [dict(r) for r in con.execute(
        "SELECT id, card_type, summary, shop, hint_url, apply_url, reason, reported_at FROM unverified WHERE resolved=0 ORDER BY id DESC").fetchall()]
    today = db.now().date().isoformat()
    products = [dict(r) for r in con.execute(
        "SELECT card_type, product_name, product_code, list_price, price_unit, release_date, official_url, note FROM products "
        "WHERE release_date IS NULL OR release_date >= ? OR release_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' "
        "ORDER BY release_date", (today,)).fetchall()]
    runs = [dict(r) for r in con.execute("SELECT kind, card_type, started_at, stats FROM runs ORDER BY id DESC LIMIT 20").fetchall()]
    return {
        "built_at": db.iso(db.now()),
        "card_names": db.CARD_NAMES,
        "listings": listings,
        "unverified": unverified,
        "products": products,
        "stores": [
            {k: s[k] for k in ("id", "kind", "chain", "name", "city", "address", "official_page", "card_types", "note")}
            for s in stores_doc["stores"]
        ],
        "chains": stores_doc["chains"],
        "shops_online": (so := json.loads((db.ROOT / "shops_online.json").read_text(encoding="utf-8")))["shops"],
        "topps_links": so.get("topps_official_links", []),
        "topps_physical": so.get("topps_physical", []),
        "stores_updated_at": stores_doc["updated_at"],
        "runs": runs,
    }


def build(out: Path) -> Path:
    data = collect_data()
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    html = TEMPLATE.read_text(encoding="utf-8").replace("/*__DATA__*/null", payload)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    return out
