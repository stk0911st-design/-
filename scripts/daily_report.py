"""日次レポート（Markdown）を作る。normalize -> diff -> public の結果をまとめる。

使い方:
    python3 scripts/daily_report.py [--date YYYY-MM-DD]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as c
import diff_snapshots as d


FIELD_LABELS = {
    "price_man": "価格",
    "layout": "間取り",
    "land_sqm": "土地面積",
    "building_sqm": "建物面積",
    "transaction_type": "取引態様",
    "remarks": "備考",
}


def money(man: float | None) -> str:
    return f"{man:,.0f}万円" if man else "―"


def detail_line(item: dict) -> str:
    bits = []
    if item.get("layout"):
        bits.append(str(item["layout"]))
    if item.get("land_sqm"):
        bits.append(f"土地{item['land_sqm']:g}㎡")
    if item.get("building_sqm"):
        bits.append(f"建物{item['building_sqm']:g}㎡")
    if item.get("built_year"):
        bits.append(f"{item['built_year']}年築")
    if item.get("station"):
        walk = f"徒歩{item['walk_min']:g}分" if item.get("walk_min") else ""
        bits.append(f"{item.get('line') or ''}{item['station']}駅{walk}".strip())
    return " ／ ".join(bits)


def section(title: str, rows: list[str], empty: str) -> list[str]:
    out = [f"## {title}", ""]
    out.extend(rows if rows else [empty])
    out.append("")
    return out


def build(result: dict, cr: dict, market: dict | None, report_date: str) -> str:
    limit = (cr.get("report") or {}).get("highlight_limit", 30)
    matched_new = [x for x in result["added"] if x["matched"]]
    drops = sorted((x for x in result["price_changes"] if x["pct"] < 0), key=lambda x: x["pct"])
    ups = [x for x in result["price_changes"] if x["pct"] > 0]

    lines = [
        f"# 不動産デイリーレポート {report_date}",
        "",
        f"- 比較対象: {result['old_date'] or '(初回)'}（{result['old_count']}件） → "
        f"{result['new_date']}（{result['new_count']}件）",
        f"- 新規 **{len(result['added'])}件**（うち条件一致 **{len(matched_new)}件**） ／ "
        f"値下げ **{len(drops)}件** ／ 値上げ {len(ups)}件 ／ "
        f"掲載終了 {len(result['removed'])}件 ／ その他変更 {len(result['other_changes'])}件",
        "",
    ]

    rows = []
    for x in matched_new[:limit]:
        rows.append(f"- **{x['label']}**")
        detail = detail_line(x["item"])
        if detail:
            rows.append(f"  - {detail}")
    if len(matched_new) > limit:
        rows.append(f"- …ほか {len(matched_new) - limit}件")
    lines += section("🎯 条件に合う新規物件", rows,
                     "- 該当なし（条件未設定の場合は config/search_criteria.json を埋めてください）")

    rows = [f"- **{x['label']}** … {money(x['old_price_man'])} → {money(x['new_price_man'])}"
            f"（{x['pct']:+.1f}%）{' ⭐条件一致' if x['matched'] else ''}" for x in drops[:limit]]
    lines += section("📉 値下げ", rows, "- なし")

    rows = [f"- {x['label']}{' ⭐条件一致' if x['matched'] else ''}"
            for x in result["removed"][:limit]]
    lines += section("🏁 掲載終了（成約・取下げの可能性）", rows, "- なし")

    rows = []
    for x in result["other_changes"][:limit]:
        changed = "、".join(f"{FIELD_LABELS.get(k, k)}: {v['old'] or '―'} → {v['new'] or '―'}"
                            for k, v in x["changes"].items())
        rows.append(f"- {x['label']} … {changed}")
    lines += section("✏️ その他の変更", rows, "- なし")

    if market and market.get("by_municipality"):
        rows = ["| 市区町村 | 件数 | 取引価格の中央値 | ㎡単価の中央値 |",
                "| --- | ---: | ---: | ---: |"]
        for name, s in list(market["by_municipality"].items())[:20]:
            unit = f"{s['median_unit_price_yen_per_sqm']:,}円" if s["median_unit_price_yen_per_sqm"] else "―"
            rows.append(f"| {name} | {s['count']} | {s['median_price_yen']:,}円 | {unit} |")
        rows.append("")
        rows.append(f"出典: 国土交通省「不動産情報ライブラリ」不動産取引価格情報"
                    f"（{market.get('record_count')}件を集計 / 取得日 {market.get('generated_at')}）")
        lines += section("📊 参考相場（公開データ）", rows, "")

    lines += [
        "## 今日のアクション候補",
        "",
        "- [ ] 条件一致の新規物件を確認する",
        "- [ ] 値下げ物件の売主状況を確認する",
        "- [ ] 掲載終了物件が成約かどうか裏を取る",
        "",
        "---",
        "",
        "※ 物件の詳細情報はレインズ会員規約の範囲内で取り扱ってください（会員外への提供・公開は不可）。",
    ]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default=c.today_str())
    args = parser.parse_args()

    recent = c.latest_snapshots(2)
    if not recent:
        print("[report] スナップショットがありません。先に normalize_reins.py を実行してください。")
        return 2
    new = c.load_json(recent[0])
    old = c.load_json(recent[1]) if len(recent) > 1 else {"date": None, "items": {}}

    cr = c.load_criteria()
    result = d.compute(old, new, cr)

    market_path = c.PUBLIC_DIR / "market_summary.json"
    market = c.load_json(market_path) if market_path.exists() else None

    out = c.REPORT_DIR / f"{args.date}.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(build(result, cr, market, args.date), encoding="utf-8")
    print(f"[report] -> {out.relative_to(c.ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
