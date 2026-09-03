"""レインズからエクスポートしたCSVを、日次スナップショット(JSON)に正規化する。

使い方:
    python3 scripts/normalize_reins.py [--日付 YYYY-MM-DD]

読み込み先:
    data/reins_export/売出/*.csv   … 販売中（売出）物件
    data/reins_export/成約/*.csv   … 成約物件
    data/reins_export/*.csv        … フォルダ分けしていない場合は「売出」として扱う

列名の揺れは config/field_mapping.json で吸収し、data/snapshots/<日付>.json に保存する。
元CSVは削除せずそのまま残す。
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


def 見出し行を探す(text: str, candidates: set[str]) -> int:
    """先頭に説明行が入っているCSVでも、見出し行の位置を探し当てる。"""
    for i, line in enumerate(text.splitlines()[:20]):
        cells = {cell.strip().strip('"') for cell in line.split(",")}
        if cells & candidates:
            return i
    return 0


def 逆引き表を作る(mapping: dict) -> dict[str, str]:
    rev = {}
    for 正規化名, 候補 in mapping.items():
        for name in 候補:
            rev[name.strip()] = 正規化名
    return rev


def 行を正規化(row: dict, rev: dict[str, str], dataset: str) -> dict:
    item: dict = {}
    raw: dict = {}
    for key, value in row.items():
        if key is None:
            continue
        key = key.strip()
        value = (value or "").strip()
        raw[key] = value
        正規化名 = rev.get(key)
        if 正規化名 and value and not item.get(正規化名):
            item[正規化名] = value

    # 成約データは「成約価格」を価格として扱う
    価格元 = item.get("成約価格") if dataset == "成約" and item.get("成約価格") else item.get("価格")
    item["価格万円"] = c.parse_price_man(価格元)
    item["徒歩分"] = c.parse_number(item.get("徒歩"))
    item["土地面積㎡"] = c.parse_number(item.get("土地面積"))
    item["建物面積㎡"] = c.parse_number(item.get("建物面積"))
    item["築年"] = c.parse_built_year(item.get("築年月"))
    item["_raw"] = raw
    return item


def 物件キー(item: dict) -> str:
    番号 = item.get("物件番号")
    if 番号:
        return str(番号)
    seed = "|".join(
        str(item.get(k) or "")
        for k in ("所在地", "物件種目", "土地面積", "建物面積", "間取り", "築年月")
    )
    return "hash:" + hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]


def CSVを読む(path: Path, rev: dict[str, str], candidates: set[str], dataset: str):
    text, encoding = c.read_text_any_encoding(path)
    skip = 見出し行を探す(text, candidates)
    body = "\n".join(text.splitlines()[skip:])
    reader = csv.DictReader(io.StringIO(body))
    return [行を正規化(row, rev, dataset) for row in reader], encoding


def 対象ファイル(dataset: str) -> list[Path]:
    files = sorted((c.EXPORT_DIR / dataset).glob("*.csv"))
    if dataset == "売出":
        files += sorted(c.EXPORT_DIR.glob("*.csv"))  # フォルダ分けしていない置き方も拾う
    return files


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--日付", dest="日付", default=c.today_str(), help="スナップショットの日付（既定: 今日）")
    args = parser.parse_args()

    rev = 逆引き表を作る(c.load_field_mapping())
    candidates = set(rev)

    データ = {}
    合計 = 0
    for dataset in c.DATASETS:
        files = 対象ファイル(dataset)
        物件: dict[str, dict] = {}
        取り込み元 = []
        for path in files:
            rows, encoding = CSVを読む(path, rev, candidates, dataset)
            for item in rows:
                if not any(item.get(k) for k in ("物件番号", "所在地", "価格", "成約価格")):
                    continue  # 空行・合計行などを捨てる
                item["_取り込み元"] = path.name
                物件[物件キー(item)] = item
            取り込み元.append({"ファイル": path.name, "文字コード": encoding, "行数": len(rows)})
            print(f"[正規化] {dataset}: {path.name} … {len(rows)}行 ({encoding})")
        データ[dataset] = {"件数": len(物件), "取り込み元": 取り込み元, "物件": 物件}
        合計 += len(物件)

    if 合計 == 0:
        print(f"[正規化] CSVが見つかりません。{c.EXPORT_DIR.relative_to(c.ROOT)}/売出/ "
              f"または /成約/ にレインズのエクスポートを置いてから実行してください。")
        return 2

    out = c.SNAPSHOT_DIR / f"{args.日付}.json"
    c.save_json(out, {"日付": args.日付, "データ": データ})
    内訳 = " / ".join(f"{k} {v['件数']}件" for k, v in データ.items())
    print(f"[正規化] {内訳} -> {out.relative_to(c.ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
