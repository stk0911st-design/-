"""レインズからエクスポートしたCSVを、日次スナップショット(JSON)に正規化する。

使い方:
    python3 scripts/normalize_reins.py [--date YYYY-MM-DD]

data/reins_export/ に置かれた *.csv を全部読み、列名の揺れを config/field_mapping.json で
吸収して data/snapshots/<日付>.json に保存する。元CSVはそのまま残す（削除しない）。
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as c


def find_header_row(text: str, candidates: set[str]) -> int:
    """先頭に説明行が入っているCSVでも、見出し行の位置を探し当てる。"""
    for i, line in enumerate(text.splitlines()[:20]):
        cells = {cell.strip().strip('"') for cell in line.split(",")}
        if cells & candidates:
            return i
    return 0


def build_reverse_map(mapping: dict) -> dict[str, str]:
    rev = {}
    for canonical, candidates in mapping.items():
        for name in candidates:
            rev[name.strip()] = canonical
    return rev


def normalize_row(row: dict, rev: dict[str, str]) -> dict:
    item: dict = {}
    raw: dict = {}
    for key, value in row.items():
        if key is None:
            continue
        key = key.strip()
        value = (value or "").strip()
        raw[key] = value
        canonical = rev.get(key)
        if canonical and value and not item.get(canonical):
            item[canonical] = value

    item["price_man"] = c.parse_price_man(item.get("price"))
    item["walk_min"] = c.parse_number(item.get("walk_minutes"))
    item["land_sqm"] = c.parse_number(item.get("land_area"))
    item["building_sqm"] = c.parse_number(item.get("building_area"))
    item["built_year"] = c.parse_built_year(item.get("built_date"))
    item["_raw"] = raw
    return item


def make_id(item: dict) -> str:
    pid = item.get("property_id")
    if pid:
        return str(pid)
    seed = "|".join(
        str(item.get(k) or "")
        for k in ("address", "property_type", "land_area", "building_area", "layout", "built_date")
    )
    return "hash:" + hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]


def load_csv(path: Path, rev: dict[str, str], candidates: set[str]) -> tuple[list[dict], str]:
    text, encoding = c.read_text_any_encoding(path)
    skip = find_header_row(text, candidates)
    body = "\n".join(text.splitlines()[skip:])
    reader = csv.DictReader(io.StringIO(body))
    return [normalize_row(row, rev) for row in reader], encoding


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default=c.today_str(), help="スナップショットの日付 (既定: 今日)")
    args = parser.parse_args()

    mapping = c.load_field_mapping()
    rev = build_reverse_map(mapping)
    candidates = set(rev)

    files = sorted(p for p in c.EXPORT_DIR.glob("*.csv"))
    if not files:
        print(f"[normalize] {c.EXPORT_DIR} にCSVがありません。レインズのエクスポートを置いてから実行してください。")
        return 2

    items: dict[str, dict] = {}
    sources = []
    for path in files:
        rows, encoding = load_csv(path, rev, candidates)
        for item in rows:
            if not any(item.get(k) for k in ("property_id", "address", "price")):
                continue  # 空行・合計行などを捨てる
            item["_source_file"] = path.name
            items[make_id(item)] = item
        sources.append({"file": path.name, "encoding": encoding, "rows": len(rows)})
        print(f"[normalize] {path.name}: {len(rows)}行 ({encoding})")

    snapshot = {"date": args.date, "sources": sources, "count": len(items), "items": items}
    out = c.SNAPSHOT_DIR / f"{args.date}.json"
    c.save_json(out, snapshot)
    print(f"[normalize] {len(items)}件 -> {out.relative_to(c.ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
