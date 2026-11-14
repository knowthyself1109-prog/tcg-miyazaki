# 宮崎トレカ抽選帳

トレカの販売・抽選情報の自分用サイト。設計は「トレカ販売・抽選情報サイト 設計・運用プロンプト v2」に従う。
v1 の公開サイトは `v1` 時点の main ブランチに残っている。

- サイト: claude.ai の非公開ページ（Artifact）。`python -m tcg build` で `dist/index.html` を作って公開する
- データ: `db/tcg.sqlite`（SQLite。スキーマは `db/schema.sql`）
- 宮崎県の店舗リスト: `stores_miyazaki.json`（`scripts/build_stores.py` で生成。月1回再確認）
- 抽選収集エージェントの指示: `agents/collector.md`
- 情報ソースの規約・robots.txt の確認: `sources.md`

## コマンド
```
python -m tcg ingest inbox/<file>.json --move   # 収集結果を検証して登録
python -m tcg maintain                          # 締切→終了、確認が古い→要確認
python -m tcg verify --card pokemon             # 一次情報のURLを開いて照合
python -m tcg report                            # 件数・急減・未確認
python -m tcg build                             # サイト生成
python -m unittest discover tests               # テスト
```
