"""source_url を実際に開いて、登録内容と食い違いがないか機械的に確かめる（設計書 [D] 2）。

判定はゆるめにする：
- 開けない（403・接続拒否など）→ blocked / unreachable。登録は残し、サイトに「自動確認不可」と出す
- 商品名の主要な語（型番か、商品名の長い語）がページにない → mismatch
- 価格が登録されていて、その数字がページにない → mismatch（注記）
"""
from __future__ import annotations

import html
import re
import ssl
import time
import unicodedata
import urllib.error
import urllib.request
from urllib.parse import urlparse

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
CA = "/root/.ccr/ca-bundle.crt"
_last_hit: dict[str, float] = {}
MIN_INTERVAL = 3.0  # 同じサイトへの連続アクセス間隔（秒）


def fetch_text(url: str, timeout: int = 25) -> tuple[int, str]:
    host = urlparse(url).netloc
    wait = MIN_INTERVAL - (time.time() - _last_hit.get(host, 0))
    if wait > 0:
        time.sleep(wait)
    _last_hit[host] = time.time()
    try:
        ctx = ssl.create_default_context(cafile=CA)
    except (FileNotFoundError, ssl.SSLError):
        ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ja"})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            body = r.read()
            status = r.status
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:  # noqa: BLE001 接続できないものはまとめて扱う
        return 0, str(e)
    for enc in ("utf-8", "cp932", "euc-jp"):
        try:
            text = body.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        text = body.decode("utf-8", "replace")
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", text, flags=re.S | re.I)
    text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    return status, unicodedata.normalize("NFKC", re.sub(r"\s+", " ", text))


def key_terms(product_name: str, product_code: str | None) -> list[str]:
    if product_code:
        return [unicodedata.normalize("NFKC", product_code)]
    name = unicodedata.normalize("NFKC", product_name)
    name = re.sub(r"(ポケモンカードゲーム|ONE PIECEカードゲーム|遊戯王OCG|デュエルモンスターズ|"
                  r"拡張パック|強化拡張パック|ハイクラスパック|スペシャルセット|ブースターパック|BOX|ボックス|"
                  r"スカーレット&バイオレット|MEGA|メガ)", " ", name, flags=re.I)
    terms = [t for t in re.split(r"[\s「」『』【】()（）・/]+", name) if len(t) >= 3]
    return sorted(terms, key=len, reverse=True)[:2] or [product_name]


def check(row) -> tuple[str, str]:
    status, text = fetch_text(row["source_url"])
    if status in (401, 403, 429, 503):
        return "blocked", f"HTTP {status}（自動アクセス不可）"
    if status != 200:
        return "unreachable", f"HTTP {status} {text[:80]}".strip()
    terms = key_terms(row["product_name"], row["product_code"])
    missing = [t for t in terms if t.lower() not in text.lower()]
    notes = []
    if len(missing) == len(terms):
        notes.append("商品名がページに見つからない: " + "、".join(terms))
    if row["price"]:
        p = row["price"]
        if not re.search(rf"{p:,}|{p}(?!\d)", text):
            notes.append(f"価格 {p:,}円 がページに見つからない")
    return ("mismatch" if notes else "ok"), " / ".join(notes)
