-- トレカ販売・抽選情報 DB（設計書 v2「4. データの形」）
-- 日時はすべて日本時間の ISO 8601 文字列（例 2026-11-14T19:00:00+09:00）

CREATE TABLE IF NOT EXISTS products (
    id            TEXT PRIMARY KEY,          -- card_type + ':' + product_code（なければ商品名の正規化）
    card_type     TEXT NOT NULL,
    product_name  TEXT NOT NULL,
    product_code  TEXT,
    list_price    INTEGER,                   -- メーカー希望小売価格（税込）。不明は NULL
    price_unit    TEXT,                      -- 'box' / 'pack' / 'set' など、list_price の単位
    release_date  TEXT,
    official_url  TEXT,                      -- 公式の商品ページ
    note          TEXT,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS listings (
    id              TEXT PRIMARY KEY,        -- 商品＋店舗＋種別＋開始日から作るキー
    card_type       TEXT NOT NULL CHECK (card_type IN ('onepiece','pokemon','yugioh','gundam','dbfw','naruto','topps')),
    product_name    TEXT NOT NULL,
    product_code    TEXT,
    product_id      TEXT REFERENCES products(id),
    sale_type       TEXT NOT NULL CHECK (sale_type IN ('lottery','first_come','restock','store')),
    shop            TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('upcoming','open','closed','in_stock','sold_out','unknown')),
    start_at        TEXT,
    end_at          TEXT,
    result_at       TEXT,
    price           INTEGER,
    is_list_price   INTEGER,                 -- 1=定価 0=定価超え NULL=不明
    conditions      TEXT,                    -- 応募条件（省略しない）
    pickup          TEXT NOT NULL CHECK (pickup IN ('online','store')),
    pickup_area     TEXT,                    -- 店頭受取のとき「都道府県 店舗名」
    pickup_store_ids TEXT,                   -- 店頭受取のとき stores_miyazaki.json の id（JSON配列）
    apply_url       TEXT,                    -- 応募・購入ページ（source_url と別のとき）
    source_url      TEXT NOT NULL,           -- 一次情報の URL（必須）
    found_via       TEXT,                    -- 発見のきっかけ（内部用・公開しない）
    verified        INTEGER NOT NULL DEFAULT 0,
    verify_status   TEXT,                    -- ok / mismatch / unreachable / blocked（機械チェックの結果）
    verify_note     TEXT,
    note            TEXT,
    needs_check     INTEGER NOT NULL DEFAULT 0,  -- 最終確認が古い → 要確認
    first_seen_at   TEXT NOT NULL,
    last_checked_at TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listings_card ON listings(card_type, status);
CREATE INDEX IF NOT EXISTS idx_listings_end ON listings(end_at);

-- 一次情報で裏が取れなかったもの（登録しない・別枠で報告）
CREATE TABLE IF NOT EXISTS unverified (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    card_type     TEXT NOT NULL,
    summary       TEXT NOT NULL,
    shop          TEXT,
    found_via     TEXT,
    hint_url      TEXT,                      -- 確認先（店の公式ページなど）
    apply_url     TEXT,                      -- 応募フォーム（Googleフォームなど。わかる場合）
    reason        TEXT,
    reported_at   TEXT NOT NULL,
    resolved      INTEGER NOT NULL DEFAULT 0
);

-- 収集・検証の実行記録（件数の急減を検知する）
CREATE TABLE IF NOT EXISTS runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kind          TEXT NOT NULL,             -- collect / maintain / verify
    card_type     TEXT,
    started_at    TEXT NOT NULL,
    stats         TEXT NOT NULL              -- JSON
);

-- 変更履歴（新規・変更・終了の報告と、商品ページの再販履歴に使う）
CREATE TABLE IF NOT EXISTS changes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id    TEXT NOT NULL,
    change        TEXT NOT NULL,             -- new / changed / closed / needs_check
    detail        TEXT,
    at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_listing ON changes(listing_id);
