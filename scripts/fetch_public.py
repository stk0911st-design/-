"""公開データ（国土交通省『不動産情報ライブラリ』の不動産取引価格情報）を取得して相場を集計する。

使い方:
    REINFOLIB_API_KEY=xxxx python3 scripts/fetch_public.py

・レインズとは別系統の、誰でも正規に使える公開データ。APIキーは国交省サイトで申請して取得する。
・APIキーが未設定のときは何もせずスキップする（毎日の処理は止めない）。
・取得した生データは data/public/ にキャッシュし、同じ四半期は再取得しない。
"""
from __future__ import annotations

import json
import os
import ssl
import statistics
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as c

API_URL = "https://www.reinfolib.mlit.go.jp/ex-api/external/XIT001"
CA_BUNDLE = Path("/root/.ccr/ca-bundle.crt")


def ssl_context() -> ssl.SSLContext:
    if CA_BUNDLE.exists():
        return ssl.create_default_context(cafile=str(CA_BUNDLE))
    return ssl.create_default_context()


def recent_quarters(n: int) -> list[tuple[int, int]]:
    """直近n四半期を新しい順に返す。公表が数ヶ月遅れるので1つ前の四半期から数える。"""
    today = date.today()
    year, quarter = today.year, (today.month - 1) // 3 + 1
    out = []
    for _ in range(n):
        quarter -= 1
        if quarter == 0:
            year, quarter = year - 1, 4
        out.append((year, quarter))
    return out


def fetch_quarter(year: int, quarter: int, area: str, city: str | None, api_key: str) -> list[dict]:
    params = {"year": str(year), "quarter": str(quarter), "area": area}
    if city:
        params["city"] = city
    req = urllib.request.Request(
        f"{API_URL}?{urllib.parse.urlencode(params)}",
        headers={"Ocp-Apim-Subscription-Key": api_key},
    )
    with urllib.request.urlopen(req, timeout=60, context=ssl_context()) as res:
        payload = json.loads(res.read().decode("utf-8"))
    return payload.get("data", [])


def summarize(records: list[dict]) -> dict:
    """市区町村ごとに件数・取引価格の中央値・㎡単価の中央値を出す。"""
    buckets: dict[str, list[tuple[float, float | None]]] = {}
    for r in records:
        price = c.parse_number(r.get("TradePrice"))
        if not price:
            continue
        area = c.parse_number(r.get("Area"))
        unit = price / area if area else None
        key = f"{r.get('Prefecture','')}{r.get('Municipality','')}"
        buckets.setdefault(key, []).append((price, unit))

    summary = {}
    for key, values in sorted(buckets.items()):
        prices = [p for p, _ in values]
        units = [u for _, u in values if u]
        summary[key] = {
            "count": len(prices),
            "median_price_yen": int(statistics.median(prices)),
            "median_unit_price_yen_per_sqm": int(statistics.median(units)) if units else None,
        }
    return summary


def main() -> int:
    cr = c.load_criteria()
    conf = cr.get("public_data") or {}
    if not conf.get("enabled", True):
        print("[public] public_data.enabled が false のためスキップします。")
        return 0

    api_key = os.environ.get("REINFOLIB_API_KEY", "").strip()
    if not api_key:
        print("[public] REINFOLIB_API_KEY が未設定のためスキップします。"
              "（国土交通省『不動産情報ライブラリ』でAPIキーを申請し、環境変数に設定してください）")
        return 0

    area = str(conf.get("prefecture_code") or "13")
    cities = conf.get("city_codes") or [None]
    records: list[dict] = []

    for year, quarter in recent_quarters(int(conf.get("quarters_back") or 4)):
        for city in cities:
            tag = f"{area}{'-' + city if city else ''}_{year}Q{quarter}"
            cache = c.PUBLIC_DIR / f"mlit_{tag}.json"
            if cache.exists():
                data = c.load_json(cache)
            else:
                try:
                    data = fetch_quarter(year, quarter, area, city, api_key)
                except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
                    print(f"[public] {tag} の取得に失敗: {e}")
                    continue
                c.save_json(cache, data)
                print(f"[public] {tag}: {len(data)}件を取得")
            records.extend(data)

    if not records:
        print("[public] 取得できたレコードがありませんでした。")
        return 0

    summary = {"generated_at": c.today_str(), "record_count": len(records),
               "by_municipality": summarize(records)}
    out = c.PUBLIC_DIR / "market_summary.json"
    c.save_json(out, summary)
    print(f"[public] {len(records)}件を集計 -> {out.relative_to(c.ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
