"""2つのスナップショットを比べて、売出の新規・値動き・掲載終了と、新規成約を洗い出す。

使い方:
    python3 scripts/diff_snapshots.py [--今回 <日付>] [--前回 <日付>] [--json]

--今回/--前回 を省略すると、いちばん新しい2件を自動で比べる。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as c

# 差分として見る項目
変更監視項目 = ("間取り", "土地面積㎡", "建物面積㎡", "取引態様", "備考")


def 表示名(item: dict) -> str:
    価格 = c.金額表示(item["価格万円"]) if item.get("価格万円") else str(item.get("価格") or "")
    bits = [str(item.get("物件種目") or ""), str(item.get("所在地") or item.get("駅") or ""), 価格]
    return " / ".join(b for b in bits if b) or "(詳細不明)"


def 該当リスト(item: dict, watchlists: list[dict], dataset: str) -> list[str]:
    return [w["id"] for w in watchlists
            if dataset in w["対象データ"] and c.matches(item, w)]


def エントリ(キー: str, item: dict, watchlists: list[dict], dataset: str, **extra) -> dict:
    return {"キー": キー, "表示": 表示名(item), "物件": item,
            "該当リスト": 該当リスト(item, watchlists, dataset), **extra}


def 物件辞書(snapshot: dict, dataset: str) -> dict:
    return ((snapshot.get("データ") or {}).get(dataset) or {}).get("物件") or {}


def 差分を出す(前回: dict, 今回: dict, config: dict) -> dict:
    watchlists = c.resolve_watchlists(config)
    しきい値 = (config.get("レポート") or {}).get("価格変動しきい値パーセント", 0.0)

    result = {"前回日付": 前回.get("日付"), "今回日付": 今回.get("日付")}

    # ---- 売出: 新規 / 価格変更 / その他変更 / 掲載終了
    旧, 新 = 物件辞書(前回, "売出"), 物件辞書(今回, "売出")
    新規, 掲載終了, 価格変更, その他変更 = [], [], [], []

    for キー, item in 新.items():
        if キー not in 旧:
            新規.append(エントリ(キー, item, watchlists, "売出"))
            continue

        前 = 旧[キー]
        旧価格, 新価格 = 前.get("価格万円"), item.get("価格万円")
        if 旧価格 and 新価格 and 旧価格 != 新価格:
            変動率 = (新価格 - 旧価格) / 旧価格 * 100
            if abs(変動率) >= しきい値:
                価格変更.append(エントリ(キー, item, watchlists, "売出",
                                    前回価格万円=旧価格, 今回価格万円=新価格,
                                    変動率=round(変動率, 2)))

        変更 = {f: {"前": 前.get(f), "後": item.get(f)}
                for f in 変更監視項目 if 前.get(f) != item.get(f)}
        if 変更:
            その他変更.append(エントリ(キー, item, watchlists, "売出", 変更内容=変更))

    for キー, item in 旧.items():
        if キー not in 新:
            掲載終了.append(エントリ(キー, item, watchlists, "売出"))

    result["売出"] = {"前回件数": len(旧), "今回件数": len(新), "新規": 新規,
                      "価格変更": 価格変更, "その他変更": その他変更, "掲載終了": 掲載終了}

    # ---- 成約: 新しく成約として登場したもの
    旧成約, 新成約 = 物件辞書(前回, "成約"), 物件辞書(今回, "成約")
    新規成約 = [エントリ(キー, item, watchlists, "成約")
                for キー, item in 新成約.items() if キー not in 旧成約]
    result["成約"] = {"前回件数": len(旧成約), "今回件数": len(新成約), "新規成約": 新規成約}

    return result


def 解決(指定: str | None, 既定: Path | None) -> Path | None:
    if 指定:
        p = Path(指定)
        return p if p.exists() else c.SNAPSHOT_DIR / f"{指定}.json"
    return 既定


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--今回", dest="今回")
    parser.add_argument("--前回", dest="前回")
    parser.add_argument("--json", action="store_true", help="結果をJSONで標準出力に出す")
    args = parser.parse_args()

    直近 = c.latest_snapshots(2)
    今回パス = 解決(args.今回, 直近[0] if 直近 else None)
    前回パス = 解決(args.前回, 直近[1] if len(直近) > 1 else None)

    if not 今回パス or not 今回パス.exists():
        print("[差分] 比較できるスナップショットがありません。先に normalize_reins.py を実行してください。")
        return 2
    今回 = c.load_json(今回パス)

    if not 前回パス or not 前回パス.exists():
        print(f"[差分] 前回分がないため、{今回パス.name} を初回スナップショットとして扱います（差分なし）。")
        前回 = {"日付": None, "データ": {}}
    else:
        前回 = c.load_json(前回パス)

    r = 差分を出す(前回, 今回, c.load_config())
    if args.json:
        print(json.dumps(r, ensure_ascii=False, indent=2))
    else:
        s, k = r["売出"], r["成約"]
        print(f"[差分] {r['前回日付'] or '(初回)'} -> {r['今回日付']}")
        print(f"  売出: {s['前回件数']}件 -> {s['今回件数']}件 ／ 新規 {len(s['新規'])} ／ "
              f"価格変更 {len(s['価格変更'])} ／ 掲載終了 {len(s['掲載終了'])} ／ "
              f"その他変更 {len(s['その他変更'])}")
        print(f"  成約: {k['前回件数']}件 -> {k['今回件数']}件 ／ 新規成約 {len(k['新規成約'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
