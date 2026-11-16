"""宮崎県の店舗リスト（stores_miyazaki.json）を作る。

- 店舗の正規リストはこのファイルの STORES に手で持つ（推測で足さない）
- 各店舗の「取扱カード種」は、公式の取扱店リストの取得結果
  （data/raw/stores/official_card_lists_*.json）から自動で付ける
- 月1回の再確認では、raw を取り直してこのスクリプトを再実行する

使い方: python scripts/build_stores.py
"""
from __future__ import annotations

import glob
import hashlib
import json
import re
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 公式の確認元（verified_by に入るキー）
SOURCES = {
    "pokemon_map": "ポケモンカードゲーム公式 取扱店舗検索 https://map.pokemon-card.com/",
    "konami": "遊戯王OCG公式 取り扱い店舗リスト https://www.yugioh-card.com/japan/information/retailer/",
    "bandai_onepiece": "ONE PIECEカードゲーム 取扱店舗（BANDAI CARDS）https://sec.carddass.com/jp/entry-shoplists/onepiece-cardgame/search.php?product_id=5",
    "bandai_gundam": "ガンダムカードゲーム 取扱店舗（BANDAI CARDS）https://sec.carddass.com/jp/entry-shoplists/gundam-card-game/search.php?product_id=24",
    "bandai_dbfw": "ドラゴンボール フュージョンワールド 取扱店舗（BANDAI CARDS）https://sec.carddass.com/jp/entry-shoplists/dbscg-fusionworld/search.php?product_id=9",
    "aeon": "イオングループ店舗一覧 https://www.aeon.com/store/list/九州地方/宮崎県/",
    "bookoff": "ブックオフ公式 店舗一覧（宮崎県）https://www.bookoff.co.jp/shop/pref-list/45.html",
    "topps_pdf": "Topps Japan 取扱店リスト（2026.11.13 Japan Original Products Retail Stores、利用者が提示したPDF）data/raw/stores/topps_japan_retail_2026-11-13.json",
    "edion": "エディオン公式 店舗検索 https://search.edion.com/e_store/spot/list?search=address&address=45",
}
RAW_SRC = {"pokemon": "pokemon_map", "yugioh": "konami", "onepiece": "bandai_onepiece",
           "gundam": "bandai_gundam", "dbfw": "bandai_dbfw", "topps": "topps_pdf"}

# 正規の店舗リスト。aliases は公式リスト上の表記ゆれ（NFKC・空白除去後に部分一致で照合）
# official_page は確認できた公式ページ（チェーンの店舗ページ、なければ公式取扱店検索の店舗ページ）
STORES = [
    # ---- 宮崎市 ----
    dict(id="aeon-miyazaki", chain="イオン", name="イオン宮崎店", city="宮崎市", address="宮崎市新別府町江口862-1（イオンモール宮崎）",
         official_page="https://tenpo.aeon-kyushu.info/aeon/detail/miyazaki/", aliases=["イオン宮崎店"], extra_verified=["aeon"]),
    dict(id="aeon-minamimiyazaki", chain="イオン", name="イオン南宮崎店", city="宮崎市", address="宮崎市大淀4-7-30（宮交シティ）",
         official_page="https://tenpo.aeon-kyushu.info/aeon/detail/minamimiyazaki/", aliases=["イオン南宮崎店"], extra_verified=["aeon"]),
    dict(id="furuichi-aeonmall-miyazaki", chain="ふるいち", name="ふるいち イオンモール宮崎店", city="宮崎市", address="宮崎市新別府町江口862-1 イオンモール宮崎2F",
         official_page="https://map.pokemon-card.com/map/20780", aliases=["ふるいちイオンモール宮崎"]),
    dict(id="toysrus-miyako-city", chain="トイザらス", name="トイザらス・ベビーザらス 宮交シティ店", city="宮崎市", address="宮崎市大淀4-6-28 宮交シティ2F",
         official_page="https://www.toysrus.co.jp/ja-jp/stores/", aliases=["宮交シティ店"],
         note="2025年11月に旧・宮崎店（エディオン宮崎本店2F）から移転。ポケカ・バンダイの取扱店リストはまだ旧店舗の表記"),
    dict(id="tsutaya-miyako-city", chain="TSUTAYA", name="TSUTAYA BOOKSTORE 宮交シティ", city="宮崎市", address="宮崎市大淀4-7-30 イオン南宮崎店2F",
         official_page="https://store-tsutaya.tsite.jp/store/detail?storeId=8314", aliases=["TSUTAYABOOKSTORE宮交シティ"]),
    dict(id="tsutaya-takachiho", chain="TSUTAYA", name="蔦屋書店 宮崎高千穂通り", city="宮崎市", address="宮崎市橘通東4-8-1",
         official_page="https://store-tsutaya.tsite.jp/store/detail?storeId=8316", aliases=["宮崎高千穂通り"]),
    dict(id="tsutaya-otsukadai", chain="TSUTAYA", name="TSUTAYA AVクラブ 大塚台店", city="宮崎市", address="宮崎市大塚町池の内1127-7",
         official_page="https://store-tsutaya.tsite.jp/store/detail?storeId=8302", aliases=["AVクラブ大塚台"]),
    dict(id="geo-phoenix-garden", chain="ゲオ", name="ゲオ 宮崎フェニックスガーデン店", city="宮崎市", address="宮崎市柳丸町168-1",
         official_page="https://geo-online.co.jp/store/02646/", aliases=["ゲオ宮崎フェニックス"]),
    dict(id="geo-heiwadai", chain="ゲオ", name="ゲオ 宮崎平和台店", city="宮崎市", address="宮崎市矢の先町124-2",
         official_page="https://geo-online.co.jp/store/02316/", aliases=["ゲオ宮崎平和台"]),
    dict(id="geo-sadowara", chain="ゲオ", name="ゲオ 佐土原店", city="宮崎市", address="宮崎市佐土原町下田島9632",
         official_page="https://geo-online.co.jp/store/02230/", aliases=["ゲオ佐土原"]),
    dict(id="geo-otsuka", chain="ゲオ", name="ゲオ 宮崎大塚店", city="宮崎市", address="宮崎市大塚町城の下2776",
         official_page=None, aliases=["ゲオ宮崎大塚"]),
    dict(id="geo-tsunehisa", chain="ゲオ", name="ゲオ 宮崎恒久店", city="宮崎市", address="宮崎市恒久字今井手874-4",
         official_page=None, aliases=["ゲオ宮崎恒久"]),
    dict(id="geo-bears-kiyotake", chain="ゲオ", name="ゲオ ベアーズモール清武店", city="宮崎市", address="宮崎市清武町正手2-37-8",
         official_page="https://geo-online.co.jp/store/40308/", aliases=["ゲオベアーズモール清武"]),
    dict(id="bookoff-ekihigashi", chain="ブックオフ", name="BOOKOFF 宮崎駅東口店", city="宮崎市", address="宮崎市宮崎駅東1-2-6",
         official_page="https://www.bookoff.co.jp/shop/shop10239.html", aliases=["ブックオフ宮崎駅東口"], extra_verified=["bookoff"]),
    dict(id="bookoff-komatsudai", chain="ブックオフ", name="BOOKOFF タイヨー小松台店", city="宮崎市", address="宮崎市小松台南町13-1 2F",
         official_page="https://www.bookoff.co.jp/shop/shop10367.html", aliases=["タイヨー小松台"], extra_verified=["bookoff"]),
    dict(id="bookoff-kiyotake", chain="ブックオフ", name="BOOKOFF 宮崎清武店", city="宮崎市", address="宮崎市清武町新町2-2-1",
         official_page="https://www.bookoff.co.jp/shop/shop10626.html", aliases=["ブックオフ宮崎清武"], extra_verified=["bookoff"]),
    dict(id="bookoff-yanosaki", chain="ブックオフ", name="BOOKOFF 宮崎矢の先店", city="宮崎市", address="宮崎市矢の先町12-1",
         official_page="https://www.bookoff.co.jp/shop/shop10157.html", aliases=["ブックオフ宮崎矢の先"], extra_verified=["bookoff"]),
    dict(id="edion-miyazaki-honten", chain="エディオン", name="エディオン 宮崎本店", city="宮崎市", address="宮崎市中村西3-94-1",
         official_page="https://search.edion.com/e_store/spot/detail?code=0000000906", aliases=[], extra_verified=["edion"]),
    dict(id="edion-miyazaki-kouzen", chain="エディオン", name="エディオン 宮崎港前店", city="宮崎市", address="宮崎市芳士1016-1 浜田ビル102号",
         official_page="https://search.edion.com/e_store/spot/detail?code=0000003412", aliases=[], extra_verified=["edion"],
         note="小型店。トレカの取扱は公式取扱店リストに載っていない"),
    dict(id="yamada-hanagashima", chain="ヤマダデンキ", name="家電住まいる館YAMADA 宮崎花ヶ島店", city="宮崎市", address="宮崎市花ヶ島町瀬々町2600",
         official_page="https://map.pokemon-card.com/map/100379", aliases=["宮崎花ヶ島店"]),
    dict(id="yamada-shinmiyazaki", chain="ヤマダデンキ", name="テックランド 新宮崎本店 家電館", city="宮崎市", address="宮崎市新別府町土田167",
         official_page="https://map.pokemon-card.com/map/100148", aliases=["新宮崎本店"]),
    dict(id="donki-miyazaki", chain="ドン・キホーテ", name="ドン・キホーテ 宮崎店", city="宮崎市", address="宮崎市神宮東1-1-5",
         official_page=None, aliases=["ドン・キホーテ宮崎店"]),
    dict(id="donki-tachibana", chain="ドン・キホーテ", name="MEGAドン・キホーテ 宮崎橘通店", city="宮崎市", address="宮崎市橘通西3-10-32",
         official_page=None, aliases=["MEGAドン・キホーテ宮崎橘通"]),
    dict(id="mangasouko-sumiyoshi", chain="マンガ倉庫", name="マンガ倉庫 住吉店", city="宮崎市", address="宮崎市大字島之内7315-4",
         official_page=None, aliases=["マンガ倉庫住吉"]),
    dict(id="mangasouko-kano", chain="マンガ倉庫", name="マンガ倉庫 加納店", city="宮崎市", address="宮崎市清武町加納乙240-1",
         official_page=None, aliases=["マンガ倉庫加納"]),
    dict(id="animate-miyazaki", chain="アニメイト", name="アニメイト宮崎", city="宮崎市", address="宮崎市橘通東3-1-11 アゲインビル2F",
         official_page=None, aliases=["アニメイト宮崎"]),
    dict(id="miyazakiya-recycle", chain="（個店）", name="リサイクルショップ宮崎屋", city="宮崎市", address="宮崎市島之内7159-1",
         official_page="https://map.pokemon-card.com/map/20044", aliases=["リサイクルショップ宮崎屋"]),
    # 宮崎市のカードショップ
    dict(id="cs-home-miyazaki", chain="カードショップ＠ほ～む。", name="カードショップ＠ほ～む。宮崎店", city="宮崎市", address="宮崎市柳丸町153-1 パティオ柳丸C棟2-2",
         official_page="https://map.pokemon-card.com/map/11379", aliases=["ほ~む。宮崎店", "ほーむ。宮崎店"], kind="card_shop"),
    dict(id="cs-tresta-ekimae", chain="トレ☆スタ", name="トレカ専門店 スーパートレ☆スタ 宮崎駅前店", city="宮崎市", address="宮崎市広島2-5-27 第2小田ビル205",
         official_page="https://map.pokemon-card.com/map/19020", aliases=["トレスタ宮崎駅前", "トレ☆スタ宮崎駅前"], kind="card_shop"),
    dict(id="cs-tresta-tsunehisa", chain="トレ☆スタ", name="トレカ専門店 スーパートレ☆スタ 恒久店", city="宮崎市", address="宮崎市恒久908（ビックリサイクル内）",
         official_page="https://map.pokemon-card.com/map/12987", aliases=["トレ☆スタ恒久", "トレカ専門店トレ☆スタ"], kind="card_shop"),
    dict(id="cs-stadium-otsuka", chain="トレ☆スタ", name="スーパートレーディングカードスタジアム 宮崎大塚店", city="宮崎市", address="宮崎市大塚町権現昔762 匠家ビル1F",
         official_page="https://map.pokemon-card.com/map/19794", aliases=["スタジアム宮崎大塚"], kind="card_shop"),
    dict(id="cs-lariat", chain="（個店）", name="CARDSHOPラリアット！", city="宮崎市", address="宮崎市橘通西3-10-32 宮崎ナナイロ西館3F",
         official_page="https://map.pokemon-card.com/map/12181", aliases=["ラリアット"], kind="card_shop",
         note="MEGAドン・キホーテ宮崎橘通店と同じ建物。同住所の「トレカショップNISHIKI」との関係は未確認"),
    dict(id="cs-nishiki-tachibana", chain="NISHIKI", name="トレカショップNISHIKI（メガドンキ西館3F）", city="宮崎市", address="宮崎市橘通西3-10-32 メガドンキ西館3F",
         official_page=None, aliases=["トレカショップNISHIKI"], kind="card_shop"),
    dict(id="cs-bigred", chain="（個店）", name="カードショップ BIG RED", city="宮崎市", address="宮崎市清武町加納甲2669-2",
         official_page="https://map.pokemon-card.com/map/19693", aliases=["BIGRED"], kind="card_shop"),
    dict(id="cs-pandp", chain="（個店）", name="カードショップP&P", city="宮崎市", address="宮崎市元宮町9-27 プレステージ4 102",
         official_page="https://map.pokemon-card.com/map/22689", aliases=["カードショップP&P"], kind="card_shop"),
    dict(id="cs-torecareto", chain="（個店）", name="カードショップ トレカレト", city="宮崎市", address="宮崎市大塚町馬場崎3578-1",
         official_page="https://map.pokemon-card.com/map/22078", aliases=["トレカレト"], kind="card_shop"),
    # ---- 都城市 ----
    dict(id="aeon-miyakonojo", chain="イオン", name="イオン都城店", city="都城市", address="都城市早鈴町1990",
         official_page="https://tenpo.aeon-kyushu.info/aeon/detail/miyakonojo/", aliases=["イオン都城店"], extra_verified=["aeon"]),
    dict(id="aeon-miyakonojo-ekimae", chain="イオン", name="イオン都城駅前店", city="都城市", address="都城市栄町4672-5（イオンモール都城駅前）",
         official_page="https://tenpo.aeon-kyushu.info/aeon/detail/miyakonojoekimae/", aliases=["イオン都城駅前店"], extra_verified=["aeon"]),
    dict(id="cardbox-miyakonojo", chain="田中書店（CARDBOX）", name="CARDBOX 田中書店 イオンモール都城駅前店", city="都城市", address="都城市栄町4672-5 イオンモール都城駅前",
         official_page="https://map.pokemon-card.com/map/12766", aliases=["田中書店イオンモール都城駅前"], kind="card_shop"),
    dict(id="geo-miyakonojo-kamihigashi", chain="ゲオ", name="ゲオ 都城上東店", city="都城市", address="都城市上東町18街区14号",
         official_page=None, aliases=["ゲオ都城上東"]),
    dict(id="geo-miyakonojo-koorimoto", chain="ゲオ", name="ゲオ 都城郡元店", city="都城市", address="都城市郡元町2981-1",
         official_page=None, aliases=["ゲオ都城郡元"]),
    dict(id="bookoff-miyakonojo", chain="ブックオフ", name="BOOKOFF 都城駅前店", city="都城市", address="都城市栄町16-17",
         official_page="https://www.bookoff.co.jp/shop/shop10353.html", aliases=["BOOKOFF都城駅前", "ブックオフ都城駅前"], extra_verified=["bookoff"]),
    dict(id="edion-miyakonojo", chain="エディオン", name="エディオン 都城店", city="都城市", address="都城市上東町3447-1",
         official_page="https://search.edion.com/e_store/spot/detail?code=0000001103", aliases=[], extra_verified=["edion"]),
    dict(id="edion-miyakonojo-yoshio", chain="エディオン", name="エディオン 都城吉尾店", city="都城市", address="都城市吉尾町6099",
         official_page="https://search.edion.com/e_store/spot/detail?code=0000001319", aliases=["エディオン都城吉尾"], extra_verified=["edion"],
         note="バンダイの取扱店リストでは住所が「吉尾町61」表記"),
    dict(id="yamada-miyakonojo", chain="ヤマダデンキ", name="テックランド 都城店", city="都城市", address="都城市吉尾町1-1",
         official_page="https://map.pokemon-card.com/map/100153", aliases=["テックランド都城", "テックランド新都城"]),
    dict(id="donki-miyakonojo", chain="ドン・キホーテ", name="MEGAドン・キホーテ 都城店", city="都城市", address="都城市上川東4-5948-1",
         official_page=None, aliases=["MEGAドン・キホーテ都城"]),
    dict(id="mangasouko-miyakonojo", chain="マンガ倉庫", name="マンガ倉庫 都城店", city="都城市", address="都城市吉尾町840",
         official_page="https://map.pokemon-card.com/map/15215", aliases=["マンガ倉庫都城"]),
    # ---- 延岡市 ----
    dict(id="aeon-nobeoka", chain="イオン", name="イオン延岡店", city="延岡市", address="延岡市旭町2-2-1",
         official_page="https://tenpo.aeon-kyushu.info/aeon/detail/nobeoka/", aliases=["イオン延岡店"], extra_verified=["aeon"]),
    dict(id="aeon-tatara", chain="イオン", name="イオン多々良店", city="延岡市", address="延岡市岡富町154",
         official_page="https://tenpo.aeon-kyushu.info/aeon/detail/tatara/", aliases=["イオン多々良店"], extra_verified=["aeon"]),
    dict(id="geo-nobeoka", chain="ゲオ", name="ゲオ 延岡店", city="延岡市", address="延岡市出北3-19-17",
         official_page="https://geo-online.co.jp/store/02391/", aliases=["ゲオ延岡"]),
    dict(id="bookoff-nobeoka", chain="ブックオフ", name="BOOKOFF 延岡平原店", city="延岡市", address="延岡市平原町5-1492-13",
         official_page="https://www.bookoff.co.jp/shop/shop10796.html", aliases=["延岡平原店"], extra_verified=["bookoff"]),
    dict(id="tsutaya-okatomi", chain="TSUTAYA", name="TSUTAYA AVクラブ 岡富店", city="延岡市", address="延岡市中川原町2-4920",
         official_page=None, aliases=["AVクラブ岡富"]),
    dict(id="donki-nobeoka", chain="ドン・キホーテ", name="MEGAドン・キホーテ 延岡店", city="延岡市", address="延岡市塩浜町1-1532-1",
         official_page=None, aliases=["MEGAドン・キホーテ延岡"]),
    # ---- 日向市 ----
    dict(id="aeon-hyuga", chain="イオン", name="イオン日向店", city="日向市", address="日向市大字日知屋字古田町61-1",
         official_page="https://tenpo.aeon-kyushu.info/aeon/detail/hyuga/", aliases=["イオン日向店"], extra_verified=["aeon"]),
    dict(id="geo-hyuga", chain="ゲオ", name="ゲオ 日向店", city="日向市", address="日向市大字日知屋16320-1",
         official_page="https://geo-online.co.jp/store/02783/", aliases=["ゲオ日向"]),
    dict(id="yamada-hyuga", chain="ヤマダデンキ", name="テックランド 日向店", city="日向市", address="日向市大字財光寺186-6",
         official_page="https://map.pokemon-card.com/map/100175", aliases=["テックランド日向"]),
    dict(id="nishiki-hyuga", chain="NISHIKI", name="メディアクラブNISHIKI 日向店", city="日向市", address="日向市上町13-2",
         official_page="https://map.pokemon-card.com/map/14149", aliases=["メディアクラブNISHIKI"]),
    dict(id="mrmax-hyuga", chain="ミスターマックス", name="ミスターマックス 日向店", city="日向市", address="日向市大字日知屋14798-1",
         official_page=None, aliases=["ミスターマックス日向", "MrMax日向"]),
    # ---- その他の市町 ----
    dict(id="geo-takanabe", chain="ゲオ", name="ゲオ 高鍋店", city="高鍋町", address="児湯郡高鍋町蚊口浦5517-2",
         official_page="https://geo-online.co.jp/store/02941/", aliases=["ゲオ高鍋"]),
    dict(id="edion-takanabe", chain="エディオン", name="エディオン 高鍋店", city="高鍋町", address="児湯郡高鍋町蚊口浦5328",
         official_page="https://search.edion.com/e_store/spot/detail?code=0000000942", aliases=[], extra_verified=["edion"]),
    dict(id="geo-saito", chain="ゲオ", name="ゲオ 西都店", city="西都市", address="西都市小野崎2-52",
         official_page="https://geo-online.co.jp/store/02973/", aliases=["ゲオ西都"]),
    dict(id="geo-kobayashi", chain="ゲオ", name="ゲオ 小林店", city="小林市", address="小林市堤3005-7（ベスト電器小林店内）",
         official_page=None, aliases=["ゲオ小林"]),
    dict(id="daiwa-kobayashi", chain="だいわ", name="だいわプラッセ 小林店", city="小林市", address="小林市細野字池之原1976-1",
         official_page=None, aliases=["だいわプラッセ小林"]),
    dict(id="geo-nichinan", chain="ゲオ", name="ゲオ 日南店", city="日南市", address="日南市大字星倉4430",
         official_page=None, aliases=["ゲオ日南"]),
    dict(id="toretore-nichinan", chain="トレトレ倉庫", name="トレトレ倉庫 日南店", city="日南市", address="日南市吾田西1-8-8",
         official_page=None, aliases=["トレトレ倉庫日南"]),
    dict(id="tanaka-kunitomi", chain="田中書店", name="田中書店 国富店", city="国富町", address="東諸県郡国富町本庄1964",
         official_page=None, aliases=["田中書店国富"]),
]

# 公式リストに載っているが、登録しないもの（理由つき）
EXCLUDED_ALIASES = {
    "トイザらス宮崎店": "2025年11月9日に閉店（宮交シティ店へ移転）。公式取扱店リストの更新待ち",
    "トイザらス・ベビーザらス宮崎": "同上",
    "ゲオ大河原店": "遊戯王リストの誤掲載（宮城県柴田郡の店舗）",
}

# 候補チェーンの県内店舗の確認状況（設計書 3.「実店舗」）
CHAINS = [
    dict(chain="イオン", miyazaki="あり", checked_via="aeon", note="総合スーパー7店。キッズリパブリックは県内なし"),
    dict(chain="エディオン", miyazaki="あり", checked_via="edion", note="宮崎高岡店はページが404（閉店の可能性）のため除外"),
    dict(chain="ゲオ", miyazaki="あり", checked_via="konami,bandai_gundam", note="ゲオ公式サイトはこの環境から自動取得不可（アクセス拒否）。遊戯王・ガンダムの公式取扱店リストで確認"),
    dict(chain="ヤマダデンキ", miyazaki="あり", checked_via="pokemon_map,bandai_gundam", note="ヤマダ公式サイトは自動取得不可。トレカ取扱のある4店のみ登録。ほかの県内店舗は未登録"),
    dict(chain="TSUTAYA", miyazaki="あり", checked_via="pokemon_map,konami", note="TSUTAYA店舗検索は自動取得不可のため、トレカ取扱リストで確認した4店のみ"),
    dict(chain="ブックオフ", miyazaki="あり", checked_via="bookoff", note="6店"),
    dict(chain="トイザらス", miyazaki="あり", checked_via="konami", note="宮交シティ店。イオンモール宮崎のキダルト専門店（2025年12月開店の発表あり）は店舗検索で未確認"),
    dict(chain="ドン・キホーテ", miyazaki="あり", checked_via="bandai_onepiece,bandai_dbfw", note=""),
    dict(chain="ふるいち", miyazaki="あり", checked_via="pokemon_map,konami", note="イオンモール宮崎店"),
    dict(chain="マンガ倉庫", miyazaki="あり", checked_via="konami,pokemon_map", note="住吉・加納・都城"),
    dict(chain="しまむら", miyazaki="未確認", checked_via="", note="公式サイトが自動取得不可。アプリ抽選（通販枠）として扱う"),
    dict(chain="ビックカメラ", miyazaki="なし（取扱リスト上）", checked_via="pokemon_map,konami,bandai", note="通販（ビックカメラ.com）のみ対象"),
    dict(chain="コジマ", miyazaki="なし（取扱リスト上）", checked_via="pokemon_map,konami,bandai", note="通販のみ対象"),
    dict(chain="ジョーシン", miyazaki="なし（取扱リスト上）", checked_via="pokemon_map,konami,bandai", note="通販のみ対象"),
    dict(chain="ハードオフ・ホビーオフ", miyazaki="未確認", checked_via="", note="公式店舗検索がJavaScript動的表示のため未確認"),
    dict(chain="お宝創庫", miyazaki="なし（取扱リスト上）", checked_via="pokemon_map,konami,bandai", note=""),
    dict(chain="カードボックス", miyazaki="あり", checked_via="pokemon_map,bandai_dbfw", note="田中書店のCARDBOX（イオンモール都城駅前）"),
    dict(chain="シーガル", miyazaki="なし（取扱リスト上）", checked_via="pokemon_map,konami,bandai", note=""),
    dict(chain="コンビニ各社", miyazaki="あり（チェーン単位で扱う）", checked_via="topps_pdf", note="セブン・ローソンの抽選は通販枠で扱う。ファミリーマートはToppsの取扱店リスト（PDF）にある県内31店を店舗単位で登録"),
]


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s)
    s = s.replace("～", "~").replace("〜", "~").replace("ー", "-").replace("−", "-")
    return re.sub(r"[\s・【】]", "", s)


def main() -> None:
    raws = []
    for f in sorted(glob.glob(str(ROOT / "data/raw/stores/official_card_lists_*.json"))):
        raws += json.load(open(f, encoding="utf-8"))
    fetched = max(Path(f).stem.rsplit("_", 1)[1] for f in glob.glob(str(ROOT / "data/raw/stores/official_card_lists_*.json")))

    # Toppsの取扱店リスト（PDF）。ファミリーマート・ヒマラヤは店舗単位で登録し、ほかは既存の店に取扱を足す
    tp = json.load(open(ROOT / "data/raw/stores/topps_japan_retail_2026-11-13.json", encoding="utf-8"))
    tp_names = tp["products"]
    stores = list(STORES)
    known = {norm(a) for s in STORES for a in s["aliases"] + [s["name"]]}
    for e in tp["stores"]:
        raws.append({"game": "topps", "name": e["name"], "address": e["address"], "src": "topps_pdf", "products": e["products"]})
        if e["chain"] in ("ファミリーマート", "ヒマラヤ"):
            m = re.search(r"宮崎県(?:.+?郡)?(.+?[市町村])", e["address"])
            prefix = "familymart-" if e["chain"] == "ファミリーマート" else "himaraya-"
            sid = prefix + e["zip"].replace("-", "") + "-" + hashlib.md5(e["name"].encode()).hexdigest()[:4]
            stores.append(dict(id=sid,
                               chain=e["chain"], name=e["name"], city=m.group(1) if m else "", address=e["address"].replace("宮崎県", "", 1),
                               official_page=None, aliases=[e["name"]], note=""))

    out, unmatched = [], []
    used = set()
    tp_products = {}
    for s in stores:
        cards, verified = set(), set(s.get("extra_verified", []))
        keys = [norm(a) for a in s["aliases"] + [s["name"]]]
        for i, r in enumerate(raws):
            n = norm(r["name"])
            if any(k and k in n for k in keys) or norm(s["name"]) == n:
                cards.add(r["game"])
                verified.add(RAW_SRC[r["game"]])
                used.add(i)
                if r["game"] == "topps":
                    tp_products[s["id"]] = r.get("products", [])
        out.append({
            "id": s["id"],
            "kind": s.get("kind", "chain_store"),
            "chain": s["chain"],
            "name": s["name"],
            "city": s["city"],
            "address": "宮崎県" + s["address"],
            "official_page": s["official_page"],
            "sns": {"x": None, "instagram": None, "line": None},
            "card_types": sorted(cards),
            "lottery_history": [],
            "verified_by": sorted(verified),
            "verified_at": fetched,
            "note": "; ".join(x for x in [s.get("note", ""), ("Topps取扱（2026.11.13のリスト）：" + "・".join(tp_names[p].split("（")[0] for p in tp_products[s["id"]]) + "。店舗の事情で品切れ・取扱なしの場合あり") if s["id"] in tp_products else ""] if x),
        })
    for i, r in enumerate(raws):
        if i in used:
            continue
        if any(norm(k) in norm(r["name"]) for k in EXCLUDED_ALIASES):
            continue
        unmatched.append(r)

    doc = {
        "updated_at": fetched,
        "recheck": "月1回。data/raw/stores を取り直して scripts/build_stores.py を再実行する",
        "sources": SOURCES,
        "excluded": EXCLUDED_ALIASES,
        "chains": CHAINS,
        "stores": out,
    }
    (ROOT / "stores_miyazaki.json").write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"stores: {len(out)}  (card shops: {sum(1 for o in out if o['kind']=='card_shop')})")
    no_card = [o["name"] for o in out if not o["card_types"]]
    print("取扱カード種が公式リストで確認できない店:", no_card)
    if unmatched:
        print("どの店舗にも対応しない公式リスト行:")
        for r in unmatched:
            print("  ", r["game"], r["name"], r["address"])


if __name__ == "__main__":
    main()
