"""2つのスナップショットを比べて、新規・価格変更・掲載終了・その他変更を洗い出す。

使い方:
    python3 scripts/diff_snapshots.py [--new <日付>] [--old <日付>] [--json]

--new/--old を省略すると、いちばん新しい2件を自動で比べる。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as c

# 差分として見る対象の項目（内部計算用の項目は除く）
WATCH_FIELDS = ("price_man", "layout", "land_sqm", "building_sqm", "transaction_type", "remarks")


def label(item: dict) -> str:
    bits = [
        str(item.get("property_type") or ""),
        str(item.get("address") or item.get("station") or ""),
        f"{item.get('price_man'):,.0f}万円" if item.get("price_man") else str(item.get("price") or ""),
    ]
    return " / ".join(b for b in bits if b) or "(詳細不明)"


def resolve(path_or_date: str | None, fallback: Path | None) -> Path | None:
    if path_or_date:
        p = Path(path_or_date)
        return p if p.exists() else c.SNAPSHOT_DIR / f"{path_or_date}.json"
    return fallback


def compute(old: dict, new: dict, cr: dict) -> dict:
    old_items, new_items = old.get("items", {}), new.get("items", {})
    threshold = (cr.get("report") or {}).get("price_drop_threshold_pct", 0.0)

    added, removed, price_changes, other_changes = [], [], [], []

    for key, item in new_items.items():
        if key not in old_items:
            added.append({"id": key, "label": label(item), "item": item,
                          "matched": c.matches_criteria(item, cr)})
            continue

        before = old_items[key]
        op, np_ = before.get("price_man"), item.get("price_man")
        if op and np_ and op != np_:
            pct = (np_ - op) / op * 100
            if abs(pct) >= threshold:
                price_changes.append({"id": key, "label": label(item), "item": item,
                                      "old_price_man": op, "new_price_man": np_,
                                      "pct": round(pct, 2),
                                      "matched": c.matches_criteria(item, cr)})

        changed = {
            f: {"old": before.get(f), "new": item.get(f)}
            for f in WATCH_FIELDS
            if f != "price_man" and before.get(f) != item.get(f)
        }
        if changed:
            other_changes.append({"id": key, "label": label(item), "changes": changed,
                                  "matched": c.matches_criteria(item, cr)})

    for key, item in old_items.items():
        if key not in new_items:
            removed.append({"id": key, "label": label(item), "item": item,
                            "matched": c.matches_criteria(item, cr)})

    return {
        "old_date": old.get("date"),
        "new_date": new.get("date"),
        "old_count": len(old_items),
        "new_count": len(new_items),
        "added": added,
        "removed": removed,
        "price_changes": price_changes,
        "other_changes": other_changes,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--new")
    parser.add_argument("--old")
    parser.add_argument("--json", action="store_true", help="結果をJSONで標準出力に出す")
    args = parser.parse_args()

    recent = c.latest_snapshots(2)
    new_path = resolve(args.new, recent[0] if recent else None)
    old_path = resolve(args.old, recent[1] if len(recent) > 1 else None)

    if not new_path or not new_path.exists():
        print("[diff] 比較できるスナップショットがありません。先に normalize_reins.py を実行してください。")
        return 2
    new = c.load_json(new_path)

    if not old_path or not old_path.exists():
        print(f"[diff] 前回分がないため、{new_path.name} を初回スナップショットとして扱います（差分なし）。")
        old = {"date": None, "items": {}}
    else:
        old = c.load_json(old_path)

    result = compute(old, new, c.load_criteria())
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"[diff] {result['old_date']} ({result['old_count']}件) -> "
              f"{result['new_date']} ({result['new_count']}件)")
        print(f"  新規 {len(result['added'])} / 価格変更 {len(result['price_changes'])} / "
              f"掲載終了 {len(result['removed'])} / その他変更 {len(result['other_changes'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
