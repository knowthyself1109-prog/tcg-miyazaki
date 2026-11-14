import json
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

from tcg import db

STORES = db.load_stores()
BASE = dict(card_type="pokemon", product_name="テストパック", sale_type="lottery", shop="テスト店",
            status="open", pickup="online", source_url="https://example.com/a")


class ValidateTest(unittest.TestCase):
    def test_ok(self):
        db.validate(dict(BASE), STORES)

    def test_requires_source_url(self):
        with self.assertRaises(db.Rejected):
            db.validate(dict(BASE, source_url=""), STORES)

    def test_rejects_over_list_price(self):
        with self.assertRaises(db.Rejected):
            db.validate(dict(BASE, is_list_price=False), STORES)

    def test_rejects_rush_duel(self):
        with self.assertRaises(db.Rejected):
            db.validate(dict(BASE, card_type="yugioh", product_name="遊戯王ラッシュデュエル 強化パック"), STORES)

    def test_store_pickup_needs_miyazaki_store(self):
        with self.assertRaises(db.Rejected):
            db.validate(dict(BASE, pickup="store", pickup_store_ids=["somewhere-else"]), STORES)
        it = db.validate(dict(BASE, pickup="store", pickup_store_ids=["tsutaya-otsukadai"]), STORES)
        self.assertIn("宮崎県", it["pickup_area"])


class TimeRulesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.con = db.connect(Path(self.tmp.name) / "t.sqlite")

    def tearDown(self):
        self.con.close()
        self.tmp.cleanup()

    def test_close_after_deadline_and_stale(self):
        t0 = db.now()
        _, a = db.upsert_listing(self.con, dict(BASE, end_at=db.iso(t0 + timedelta(hours=1))), t0)
        _, b = db.upsert_listing(self.con, dict(BASE, shop="別の店", end_at=db.iso(t0 + timedelta(days=5))), t0)
        stats = db.apply_time_rules(self.con, t0 + timedelta(hours=30))
        self.assertEqual(stats["closed"], 1)
        row_a = self.con.execute("SELECT status FROM listings WHERE id=?", (a,)).fetchone()
        row_b = self.con.execute("SELECT needs_check FROM listings WHERE id=?", (b,)).fetchone()
        self.assertEqual(row_a["status"], "closed")
        self.assertEqual(row_b["needs_check"], 1)

    def test_change_detection(self):
        t0 = db.now()
        r1, lid = db.upsert_listing(self.con, dict(BASE, end_at="2026-12-01"), t0)
        r2, _ = db.upsert_listing(self.con, dict(BASE, end_at="2026-12-01"), t0)
        r3, _ = db.upsert_listing(self.con, dict(BASE, end_at="2026-12-02"), t0)
        self.assertEqual((r1, r2, r3), ("new", "same", "changed"))
        detail = self.con.execute("SELECT detail FROM changes WHERE change='changed'").fetchone()["detail"]
        self.assertIn("end_at", json.loads(detail))

    def test_date_only_deadline_is_end_of_day(self):
        self.assertEqual(db.parse_end("2026-11-18").strftime("%H:%M"), "23:59")


if __name__ == "__main__":
    unittest.main()
