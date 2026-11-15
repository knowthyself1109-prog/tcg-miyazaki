"""DB の接続・登録・ルール適用（設計書 [D] の機械的な部分）。"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "db" / "tcg.sqlite"
SCHEMA = ROOT / "db" / "schema.sql"
STORES = ROOT / "stores_miyazaki.json"
JST = timezone(timedelta(hours=9))

CARD_TYPES = ("onepiece", "pokemon", "yugioh", "gundam", "dbfw", "naruto", "topps")
CARD_NAMES = {
    "pokemon": "ポケモンカード", "onepiece": "ワンピースカード", "yugioh": "遊戯王OCG",
    "gundam": "ガンダムカード", "dbfw": "ドラゴンボール フュージョンワールド",
    "naruto": "ナルトカード", "topps": "Topps 野球カード",
}
SALE_TYPES = ("lottery", "first_come", "restock", "store")
STATUSES = ("upcoming", "open", "closed", "in_stock", "sold_out", "unknown")

# 要確認に落とすまでの時間（設計書 4. ルール）
STALE_ONLINE_STOCK = timedelta(minutes=30)
STALE_LOTTERY = timedelta(hours=24)
STALE_MEMO = timedelta(days=3)


def now() -> datetime:
    return datetime.now(JST).replace(microsecond=0)


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def parse_dt(s: str | None) -> datetime | None:
    """'2026-11-20', '2026-11-20 23:59', ISO 8601 を受け付ける。タイムゾーンなしは日本時間。
    日付だけの締切はその日の 23:59 とみなす（parse_end を使う）。"""
    if not s:
        return None
    s = s.strip().replace("/", "-")
    try:
        dt = datetime.fromisoformat(s.replace(" ", "T"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=JST)
    return dt.astimezone(JST)


def parse_end(s: str | None) -> datetime | None:
    dt = parse_dt(s)
    if dt and s and re.fullmatch(r"\d{4}-\d{2}-\d{2}", s.strip().replace("/", "-")):
        dt = dt.replace(hour=23, minute=59)
    return dt


def connect(path: Path = DB_PATH) -> sqlite3.Connection:
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA.read_text(encoding="utf-8"))
    cols = {r[1] for r in con.execute("PRAGMA table_info(unverified)")}
    if "apply_url" not in cols:  # 既存DBへの列追加
        con.execute("ALTER TABLE unverified ADD COLUMN apply_url TEXT")
    return con


def norm_key(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "").lower()
    return re.sub(r"[\s\-_・/()（）「」『』【】\[\]!！?？:：,，.。]", "", s)


def listing_id(card_type: str, product: str, shop: str, sale_type: str, start_at: str | None) -> str:
    start = (parse_dt(start_at).date().isoformat() if parse_dt(start_at) else "nostart")
    raw = "|".join([card_type, norm_key(product), norm_key(shop), sale_type, start])
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def load_stores() -> dict:
    doc = json.loads(STORES.read_text(encoding="utf-8"))
    return {s["id"]: s for s in doc["stores"]}


class Rejected(Exception):
    pass


def validate(item: dict, stores: dict) -> dict:
    """登録ルール。破ったら Rejected（理由つき）。正規化した dict を返す。"""
    it = {k: (v.strip() if isinstance(v, str) else v) for k, v in item.items()}
    for k in ("card_type", "product_name", "sale_type", "shop", "status", "pickup"):
        if not it.get(k):
            raise Rejected(f"{k} がない")
    if it["card_type"] not in CARD_TYPES:
        raise Rejected(f"card_type が不正: {it['card_type']}")
    if it["sale_type"] not in SALE_TYPES:
        raise Rejected(f"sale_type が不正: {it['sale_type']}")
    if it["status"] not in STATUSES:
        raise Rejected(f"status が不正: {it['status']}")
    if it["pickup"] not in ("online", "store"):
        raise Rejected(f"pickup が不正: {it['pickup']}")
    url = it.get("source_url") or ""
    if not re.match(r"https?://", url):
        raise Rejected("source_url（一次情報のURL）がない")
    if it.get("is_list_price") is False or it.get("is_list_price") == 0:
        raise Rejected("定価を超える出品")
    if re.search(r"マーケットプレイス|転売|出品者", (it.get("conditions") or "") + (it.get("note") or "")):
        raise Rejected("マーケットプレイス・転売出品")
    if it["card_type"] == "yugioh" and re.search(r"ラッシュ|RUSH", it["product_name"], re.I):
        raise Rejected("ラッシュデュエルは対象外")
    if it["pickup"] == "store":
        ids = it.get("pickup_store_ids") or []
        if isinstance(ids, str):
            ids = json.loads(ids)
        ids = [i for i in ids if i in stores]
        if not ids:
            raise Rejected("店頭受取だが、受取店舗が宮崎県の店舗リストにない")
        it["pickup_store_ids"] = ids
        if not it.get("pickup_area"):
            it["pickup_area"] = "宮崎県 " + "、".join(stores[i]["name"] for i in ids)
    for k in ("start_at", "result_at"):
        if it.get(k) and not parse_dt(it[k]):
            raise Rejected(f"{k} の日付が読めない: {it[k]}")
    if it.get("end_at") and not parse_end(it["end_at"]):
        raise Rejected(f"end_at の日付が読めない: {it['end_at']}")
    if it.get("price") is not None:
        it["price"] = int(it["price"])
    return it


FIELDS = ("card_type", "product_name", "product_code", "product_id", "sale_type", "shop", "status",
          "start_at", "end_at", "result_at", "price", "is_list_price", "conditions", "pickup",
          "pickup_area", "pickup_store_ids", "apply_url", "source_url", "found_via", "verified", "note")
# 変更として報告する項目
WATCHED = ("status", "start_at", "end_at", "result_at", "price", "conditions", "pickup_area", "source_url")


def _norm_dt_field(k: str, v):
    if k in ("start_at", "result_at"):
        return iso(parse_dt(v)) if v else None
    if k == "end_at":
        return iso(parse_end(v)) if v else None
    return v


def upsert_listing(con: sqlite3.Connection, it: dict, at: datetime) -> tuple[str, str]:
    """登録して ('new'|'changed'|'same', id) を返す。"""
    lid = it.get("id") or listing_id(it["card_type"], it["product_name"], it["shop"], it["sale_type"], it.get("start_at"))
    row = {k: _norm_dt_field(k, it.get(k)) for k in FIELDS}
    if isinstance(row["pickup_store_ids"], list):
        row["pickup_store_ids"] = json.dumps(row["pickup_store_ids"], ensure_ascii=False)
    if row["is_list_price"] is not None:
        row["is_list_price"] = 1 if row["is_list_price"] else 0
    row["verified"] = 1 if it.get("verified", True) else 0
    old = con.execute("SELECT * FROM listings WHERE id=?", (lid,)).fetchone()
    ts = iso(at)
    if old is None:
        cols = ",".join(("id",) + FIELDS + ("needs_check", "first_seen_at", "last_checked_at", "updated_at"))
        vals = [lid] + [row[k] for k in FIELDS] + [0, ts, ts, ts]
        con.execute(f"INSERT INTO listings ({cols}) VALUES ({','.join('?' * len(vals))})", vals)
        con.execute("INSERT INTO changes (listing_id, change, detail, at) VALUES (?,?,?,?)", (lid, "new", None, ts))
        return "new", lid
    diffs = {k: [old[k], row[k]] for k in WATCHED if row[k] is not None and str(old[k]) != str(row[k])}
    sets = {k: row[k] for k in FIELDS if row[k] is not None}
    sets.update(needs_check=0, last_checked_at=ts)
    if diffs:
        sets["updated_at"] = ts
        con.execute("INSERT INTO changes (listing_id, change, detail, at) VALUES (?,?,?,?)",
                    (lid, "changed", json.dumps(diffs, ensure_ascii=False), ts))
    con.execute(f"UPDATE listings SET {','.join(k + '=?' for k in sets)} WHERE id=?", [*sets.values(), lid])
    return ("changed" if diffs else "same"), lid


def apply_time_rules(con: sqlite3.Connection, at: datetime) -> dict:
    """締切過ぎ→closed、開始時刻到来→open、確認が古い→要確認。"""
    stats = {"closed": 0, "opened": 0, "needs_check": 0}
    ts = iso(at)
    for r in con.execute("SELECT id, status, start_at, end_at, sale_type, pickup, last_checked_at, needs_check, note FROM listings").fetchall():
        end, start, checked = parse_dt(r["end_at"]), parse_dt(r["start_at"]), parse_dt(r["last_checked_at"])
        if r["status"] in ("upcoming", "open") and end and end < at:
            con.execute("UPDATE listings SET status='closed', updated_at=? WHERE id=?", (ts, r["id"]))
            con.execute("INSERT INTO changes (listing_id, change, detail, at) VALUES (?,?,?,?)", (r["id"], "closed", "締切を過ぎた", ts))
            stats["closed"] += 1
            continue
        if r["status"] == "upcoming" and start and start <= at and (not end or end >= at):
            con.execute("UPDATE listings SET status='open', updated_at=? WHERE id=?", (ts, r["id"]))
            stats["opened"] += 1
        if r["sale_type"] == "store" and (r["note"] or "").startswith("[自分のメモ]"):
            limit = STALE_MEMO
        elif r["status"] in ("in_stock",) and r["pickup"] == "online":
            limit = STALE_ONLINE_STOCK
        elif r["status"] in ("upcoming", "open", "in_stock"):
            limit = STALE_LOTTERY
        else:
            limit = None
        stale = 1 if (limit and checked and at - checked > limit) else 0
        if stale != r["needs_check"]:
            con.execute("UPDATE listings SET needs_check=? WHERE id=?", (stale, r["id"]))
            if stale:
                stats["needs_check"] += 1
    return stats


def record_run(con: sqlite3.Connection, kind: str, card_type: str | None, at: datetime, stats: dict) -> None:
    con.execute("INSERT INTO runs (kind, card_type, started_at, stats) VALUES (?,?,?,?)",
                (kind, card_type, iso(at), json.dumps(stats, ensure_ascii=False)))
