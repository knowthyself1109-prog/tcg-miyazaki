"""コマンド:
  python -m tcg ingest inbox/<file>.json   収集結果を検証して登録（[B]→[D]）
  python -m tcg maintain                   締切・要確認などの時間ルールを適用
  python -m tcg verify [--card pokemon] [--all]   source_url を開いて照合
  python -m tcg report [--card pokemon]    件数・急減・未確認の報告
  python -m tcg build                      サイトを生成（dist/index.html）
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from . import db, verify

ROOT = db.ROOT


def cmd_ingest(args) -> int:
    path = Path(args.file)
    doc = json.loads(path.read_text(encoding="utf-8"))
    at = db.parse_dt(doc.get("run_at")) or db.now()
    card = doc.get("card_type")
    stores = db.load_stores()
    con = db.connect()
    stats = {"new": 0, "changed": 0, "same": 0, "rejected": 0, "unverified": 0, "products": 0}
    rejected = []
    for p in doc.get("products", []):
        pid = p.get("id") or f"{p['card_type']}:{db.norm_key(p.get('product_code') or p['product_name'])}"
        con.execute(
            """INSERT INTO products (id, card_type, product_name, product_code, list_price, price_unit, release_date, official_url, note, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET product_name=excluded.product_name, product_code=excluded.product_code,
                 list_price=COALESCE(excluded.list_price, products.list_price), price_unit=COALESCE(excluded.price_unit, products.price_unit),
                 release_date=COALESCE(excluded.release_date, products.release_date), official_url=COALESCE(excluded.official_url, products.official_url),
                 note=COALESCE(excluded.note, products.note), updated_at=excluded.updated_at""",
            (pid, p["card_type"], p["product_name"], p.get("product_code"), p.get("list_price"), p.get("price_unit"),
             p.get("release_date"), p.get("official_url"), p.get("note"), db.iso(at)))
        stats["products"] += 1
    for item in doc.get("listings", []):
        item.setdefault("card_type", card)
        try:
            it = db.validate(item, stores)
        except db.Rejected as e:
            stats["rejected"] += 1
            rejected.append(f"{item.get('shop')} / {item.get('product_name')}: {e}")
            continue
        result, _ = db.upsert_listing(con, it, at)
        stats[result] += 1
    for u in doc.get("unverified", []):
        con.execute("INSERT INTO unverified (card_type, summary, shop, found_via, hint_url, apply_url, reason, reported_at) VALUES (?,?,?,?,?,?,?,?)",
                    (u.get("card_type", card), u["summary"], u.get("shop"), u.get("found_via"), u.get("hint_url"), u.get("apply_url"), u.get("reason"), db.iso(at)))
        stats["unverified"] += 1
    for rid in doc.get("resolve_unverified", []):   # 裏が取れた・対象外になった未確認を閉じる
        con.execute("UPDATE unverified SET resolved=1 WHERE id=?", (rid,))
        stats["resolved"] = stats.get("resolved", 0) + 1
    # 今回の収集で報告されなかった「受付中・受付予定」は、終了したとは限らないので触らない（要確認は時間ルールで付く）
    active = con.execute("SELECT COUNT(*) FROM listings WHERE card_type=? AND status IN ('upcoming','open','in_stock')", (card,)).fetchone()[0]
    stats["active_after"] = active
    db.record_run(con, "collect", card, at, stats)
    con.commit()
    print(json.dumps(stats, ensure_ascii=False))
    for r in rejected:
        print("  除外:", r)
    if args.move:
        dest = ROOT / "inbox" / "processed"
        dest.mkdir(exist_ok=True)
        shutil.move(str(path), dest / path.name)
    return 0


def cmd_maintain(args) -> int:
    con = db.connect()
    at = db.now()
    stats = db.apply_time_rules(con, at)
    db.record_run(con, "maintain", None, at, stats)
    con.commit()
    print(json.dumps(stats, ensure_ascii=False))
    return 0


def cmd_verify(args) -> int:
    con = db.connect()
    at = db.now()
    q = "SELECT * FROM listings WHERE status NOT IN ('closed')"
    params: list = []
    if args.card:
        q += " AND card_type=?"
        params.append(args.card)
    if not args.all:
        q += " AND (verify_status IS NULL OR verify_status != 'ok')"
    rows = con.execute(q, params).fetchall()
    counts: dict[str, int] = {}
    for r in rows:
        st, note = verify.check(r)
        counts[st] = counts.get(st, 0) + 1
        con.execute("UPDATE listings SET verify_status=?, verify_note=? WHERE id=?", (st, note, r["id"]))
        if st != "ok":
            print(f"  [{st}] {r['shop']} / {r['product_name']}: {note}")
        con.commit()
    db.record_run(con, "verify", args.card, at, counts)
    con.commit()
    total = sum(counts.values())
    ok = counts.get("ok", 0)
    print(json.dumps({"checked": total, **counts, "ok_rate": round(ok / total, 2) if total else None}, ensure_ascii=False))
    return 0


def cmd_report(args) -> int:
    con = db.connect()
    cards = [args.card] if args.card else db.CARD_TYPES
    out = []
    for c in cards:
        cnt = con.execute("SELECT status, COUNT(*) n FROM listings WHERE card_type=? GROUP BY status", (c,)).fetchall()
        runs = con.execute("SELECT stats FROM runs WHERE kind='collect' AND card_type=? ORDER BY id DESC LIMIT 2", (c,)).fetchall()
        anomaly = False
        if len(runs) == 2:
            now_n = json.loads(runs[0]["stats"]).get("active_after", 0)
            prev_n = json.loads(runs[1]["stats"]).get("active_after", 0)
            anomaly = prev_n > 0 and now_n == 0
        out.append({"card_type": c, "by_status": {r["status"]: r["n"] for r in cnt}, "anomaly_zero": anomaly})
    unv = con.execute("SELECT card_type, summary, shop, reason FROM unverified WHERE resolved=0 ORDER BY id DESC LIMIT 30").fetchall()
    vr = con.execute("SELECT verify_status, COUNT(*) n FROM listings WHERE status!='closed' GROUP BY verify_status").fetchall()
    print(json.dumps({"cards": out, "verify": {str(r['verify_status']): r['n'] for r in vr},
                      "unverified_open": [dict(r) for r in unv]}, ensure_ascii=False, indent=1))
    return 0


def cmd_build(args) -> int:
    from . import site
    path = site.build(Path(args.out))
    print(path)
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="tcg")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("ingest"); p.add_argument("file"); p.add_argument("--move", action="store_true"); p.set_defaults(f=cmd_ingest)
    p = sub.add_parser("maintain"); p.set_defaults(f=cmd_maintain)
    p = sub.add_parser("verify"); p.add_argument("--card"); p.add_argument("--all", action="store_true"); p.set_defaults(f=cmd_verify)
    p = sub.add_parser("report"); p.add_argument("--card"); p.set_defaults(f=cmd_report)
    p = sub.add_parser("build"); p.add_argument("--out", default=str(ROOT / "dist" / "index.html")); p.set_defaults(f=cmd_build)
    args = ap.parse_args(argv)
    return args.f(args)


if __name__ == "__main__":
    sys.exit(main())
