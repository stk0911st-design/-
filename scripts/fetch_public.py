"""公開データ（国土交通省『不動産情報ライブラリ』の不動産取引価格情報）を取得して相場を集計する。

使い方:
    REINFOLIB_API_KEY=xxxx python3 scripts/fetch_public.py

・レインズとは別系統の、誰でも正規に使える公開データ。APIキーは国交省サイトで申請して取得する。
・APIキーが未設定のときは何もせずスキップする（毎日の処理を止めない）。
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


def SSL設定() -> ssl.SSLContext:
    if CA_BUNDLE.exists():
        return ssl.create_default_context(cafile=str(CA_BUNDLE))
    return ssl.create_default_context()


def 直近の四半期(n: int) -> list[tuple[int, int]]:
    """直近n四半期を新しい順に返す。公表が数ヶ月遅れるので1つ前の四半期から数える。"""
    今日 = date.today()
    年, 四半期 = 今日.year, (今日.month - 1) // 3 + 1
    out = []
    for _ in range(n):
        四半期 -= 1
        if 四半期 == 0:
            年, 四半期 = 年 - 1, 4
        out.append((年, 四半期))
    return out


def 四半期を取得(年: int, 四半期: int, 都道府県: str, api_key: str) -> list[dict]:
    params = {"year": str(年), "quarter": str(四半期), "area": 都道府県}
    req = urllib.request.Request(
        f"{API_URL}?{urllib.parse.urlencode(params)}",
        headers={"Ocp-Apim-Subscription-Key": api_key},
    )
    with urllib.request.urlopen(req, timeout=60, context=SSL設定()) as res:
        payload = json.loads(res.read().decode("utf-8"))
    return payload.get("data", [])


def 集計(records: list[dict]) -> dict:
    """市区町村ごとに件数・取引価格の中央値・㎡単価の中央値を出す。"""
    buckets: dict[str, list[tuple[float, float | None]]] = {}
    for r in records:
        価格 = c.parse_number(r.get("TradePrice"))
        if not 価格:
            continue
        面積 = c.parse_number(r.get("Area"))
        単価 = 価格 / 面積 if 面積 else None
        キー = f"{r.get('Prefecture','')}{r.get('Municipality','')}"
        buckets.setdefault(キー, []).append((価格, 単価))

    out = {}
    for キー, values in sorted(buckets.items()):
        価格一覧 = [p for p, _ in values]
        単価一覧 = [u for _, u in values if u]
        out[キー] = {
            "件数": len(価格一覧),
            "取引価格の中央値": int(statistics.median(価格一覧)),
            "㎡単価の中央値": int(statistics.median(単価一覧)) if 単価一覧 else None,
        }
    return out


def main() -> int:
    設定 = c.load_config().get("公開データ") or {}
    if not 設定.get("有効", True):
        print("[公開データ] 設定が無効になっているためスキップします。")
        return 0

    api_key = os.environ.get("REINFOLIB_API_KEY", "").strip()
    if not api_key:
        print("[公開データ] REINFOLIB_API_KEY が未設定のためスキップします。"
              "（国土交通省『不動産情報ライブラリ』でAPIキーを申請し、環境変数に設定してください）")
        return 0

    コード = 設定.get("都道府県コード") or ["13"]
    if isinstance(コード, str):
        コード = [コード]

    records: list[dict] = []
    for 都道府県 in コード:
        for 年, 四半期 in 直近の四半期(int(設定.get("遡る四半期数") or 4)):
            タグ = f"{都道府県}_{年}Q{四半期}"
            cache = c.PUBLIC_DIR / f"mlit_{タグ}.json"
            if cache.exists():
                data = c.load_json(cache)
            else:
                try:
                    data = 四半期を取得(年, 四半期, 都道府県, api_key)
                except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
                    print(f"[公開データ] {タグ} の取得に失敗: {e}")
                    continue
                c.save_json(cache, data)
                print(f"[公開データ] {タグ}: {len(data)}件を取得")
            records.extend(data)

    if not records:
        print("[公開データ] 取得できたレコードがありませんでした。")
        return 0

    out = c.PUBLIC_DIR / "相場サマリー.json"
    c.save_json(out, {"作成日": c.today_str(), "レコード数": len(records),
                      "市区町村別": 集計(records)})
    print(f"[公開データ] {len(records)}件を集計 -> {out.relative_to(c.ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
