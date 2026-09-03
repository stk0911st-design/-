"""日次レポート（Markdown）を作る。監視リストごとに章立てする。

使い方:
    python3 scripts/daily_report.py [--日付 YYYY-MM-DD]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as c
import diff_snapshots as d


金額 = c.金額表示


def 明細(item: dict) -> str:
    bits = []
    if item.get("間取り"):
        bits.append(str(item["間取り"]))
    if item.get("土地面積㎡"):
        bits.append(f"土地{item['土地面積㎡']:g}㎡")
    if item.get("建物面積㎡"):
        bits.append(f"建物{item['建物面積㎡']:g}㎡")
    if item.get("築年"):
        bits.append(f"{item['築年']}年築")
    if item.get("駅"):
        徒歩 = f"徒歩{item['徒歩分']:g}分" if item.get("徒歩分") else ""
        bits.append(f"{item.get('沿線') or ''}{item['駅']}駅{徒歩}".strip())
    if item.get("成約年月日"):
        bits.append(f"成約 {item['成約年月日']}")
    elif item.get("登録年月日"):
        bits.append(f"登録 {item['登録年月日']}")
    if item.get("取扱会社"):
        bits.append(str(item["取扱会社"]))
    return " ／ ".join(bits)


def 物件行(entry: dict) -> list[str]:
    行 = [f"- **{entry['表示']}**"]
    詳細 = 明細(entry["物件"])
    if 詳細:
        行.append(f"  - {詳細}")
    return 行


def 節(見出し: str, 行: list[str], 空文言: str | None) -> list[str]:
    if not 行 and 空文言 is None:
        return []
    out = [f"### {見出し}", ""]
    out.extend(行 if 行 else [空文言 or ""])
    out.append("")
    return out


def 上限で切る(items: list, 上限: int) -> tuple[list, int]:
    return items[:上限], max(0, len(items) - 上限)


def リスト別に抽出(entries: list[dict], wl_id: str) -> list[dict]:
    return [e for e in entries if wl_id in e.get("該当リスト", [])]


def build(result: dict, config: dict, market: dict | None, 日付: str) -> str:
    watchlists = c.resolve_watchlists(config)
    設定 = config.get("レポート") or {}
    上限 = int(設定.get("掲載件数上限") or 30)
    売出, 成約 = result["売出"], result["成約"]

    lines = [
        f"# 不動産デイリーレポート {日付}",
        "",
        f"比較対象: {result['前回日付'] or '(初回)'} → {result['今回日付']}　"
        f"（売出 {売出['前回件数']}件 → {売出['今回件数']}件、"
        f"成約 {成約['前回件数']}件 → {成約['今回件数']}件）",
        "",
        "## サマリー",
        "",
        "| 監視リスト | 新規売出 | 値下げ | 値上げ | 掲載終了 | 新規成約 |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]

    集計 = {}
    for w in watchlists:
        i = w["id"]
        価格変更 = リスト別に抽出(売出["価格変更"], i)
        集計[i] = {
            "新規": リスト別に抽出(売出["新規"], i),
            "値下げ": sorted((x for x in 価格変更 if x["変動率"] < 0), key=lambda x: x["変動率"]),
            "値上げ": [x for x in 価格変更 if x["変動率"] > 0],
            "掲載終了": リスト別に抽出(売出["掲載終了"], i),
            "新規成約": リスト別に抽出(成約["新規成約"], i),
            "その他変更": リスト別に抽出(売出["その他変更"], i),
        }
        s = 集計[i]
        lines.append(
            f"| {w['名称']} | {len(s['新規'])} | {len(s['値下げ'])} | {len(s['値上げ'])} | "
            f"{len(s['掲載終了'])} | {len(s['新規成約'])} |"
        )
    lines.append("")

    for 番号, w in enumerate(watchlists, 1):
        s = 集計[w["id"]]
        件数 = sum(len(v) for v in s.values())
        lines += [f"## 【{番号}】{w['名称']}", "",
                  f"対象エリア: {w['エリア名']}　／　対象データ: {'・'.join(w['対象データ'])}", ""]
        if 件数 == 0:
            lines += ["今日の動きはありません。", ""]
            continue

        表示, 残り = 上限で切る(s["新規"], 上限)
        行 = [l for e in 表示 for l in 物件行(e)]
        if 残り:
            行.append(f"- …ほか {残り}件")
        lines += 節(f"🆕 新規売出（{len(s['新規'])}件）", 行, "- なし")

        表示, 残り = 上限で切る(s["値下げ"], 上限)
        行 = [f"- **{e['表示']}** … {金額(e['前回価格万円'])} → {金額(e['今回価格万円'])}"
              f"（{e['変動率']:+.1f}%）" for e in 表示]
        if 残り:
            行.append(f"- …ほか {残り}件")
        lines += 節(f"📉 値下げ（{len(s['値下げ'])}件）", 行, "- なし")

        if s["値上げ"]:
            行 = [f"- {e['表示']} … {金額(e['前回価格万円'])} → {金額(e['今回価格万円'])}"
                  f"（{e['変動率']:+.1f}%）" for e in s["値上げ"][:上限]]
            lines += 節(f"📈 値上げ（{len(s['値上げ'])}件）", 行, None)

        表示, 残り = 上限で切る(s["新規成約"], 上限)
        行 = [l for e in 表示 for l in 物件行(e)]
        if 残り:
            行.append(f"- …ほか {残り}件")
        lines += 節(f"✅ 新規成約（{len(s['新規成約'])}件）", 行, "- なし")

        表示, 残り = 上限で切る(s["掲載終了"], 上限)
        行 = [f"- {e['表示']}" for e in 表示]
        if 残り:
            行.append(f"- …ほか {残り}件")
        lines += 節(f"🏁 掲載終了（成約・取下げの可能性）（{len(s['掲載終了'])}件）", 行, "- なし")

        if s["その他変更"]:
            行 = []
            for e in s["その他変更"][:上限]:
                内容 = "、".join(f"{k}: {v['前'] or '―'} → {v['後'] or '―'}"
                                for k, v in e["変更内容"].items())
                行.append(f"- {e['表示']} … {内容}")
            lines += 節(f"✏️ その他の変更（{len(s['その他変更'])}件）", 行, None)

    if 設定.get("条件外の変動も載せる"):
        該当なし = [e for e in 売出["新規"] if not e["該当リスト"]]
        行 = [f"- {e['表示']}" for e in 該当なし[:上限]]
        if 行:
            lines += ["## 参考: どの監視リストにも当てはまらなかった新規売出", ""] + 行 + [""]

    if market and market.get("市区町村別"):
        lines += ["## 📊 参考相場（公開データ）", "",
                  "| 市区町村 | 件数 | 取引価格の中央値 | ㎡単価の中央値 |",
                  "| --- | ---: | ---: | ---: |"]
        for 名称, m in list(market["市区町村別"].items())[:20]:
            単価 = f"{m['㎡単価の中央値']:,}円" if m["㎡単価の中央値"] else "―"
            lines.append(f"| {名称} | {m['件数']} | {m['取引価格の中央値']:,}円 | {単価} |")
        lines += ["",
                  "出典: 国土交通省「不動産情報ライブラリ」不動産取引価格情報"
                  f"（{market.get('レコード数')}件を集計 / 取得日 {market.get('作成日')}）", ""]

    lines += [
        "## 今日のアクション候補",
        "",
        "- [ ] 新規売出で条件に合うものを確認する",
        "- [ ] 値下げ物件の売主状況を確認する",
        "- [ ] 掲載終了物件が成約かどうか裏を取る",
        "- [ ] 新規成約を相場データとして記録する",
        "",
        "---",
        "",
        "※ 物件情報はレインズ会員規約の範囲内で取り扱ってください（会員外への提供・公開は不可）。",
    ]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--日付", dest="日付", default=c.today_str())
    args = parser.parse_args()

    直近 = c.latest_snapshots(2)
    if not 直近:
        print("[レポート] スナップショットがありません。先に normalize_reins.py を実行してください。")
        return 2
    今回 = c.load_json(直近[0])
    前回 = c.load_json(直近[1]) if len(直近) > 1 else {"日付": None, "データ": {}}

    config = c.load_config()
    result = d.差分を出す(前回, 今回, config)

    相場パス = c.PUBLIC_DIR / "相場サマリー.json"
    market = c.load_json(相場パス) if 相場パス.exists() else None

    out = c.REPORT_DIR / f"{args.日付}.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(build(result, config, market, args.日付), encoding="utf-8")
    print(f"[レポート] -> {out.relative_to(c.ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
