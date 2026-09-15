#!/usr/bin/env python3
"""大手仲介7社 売買仲介実績レポート（月2回配信）のメール本文を生成する。

  python3 tools/build_broker_report.py            # HTML と テキストを out/ に出力
  python3 tools/build_broker_report.py --print     # テキスト版を標準出力に

データは data/brokers.json。調査のたびに JSON を更新すれば本文が作り直される。
金額は各社・業界団体が公表している公開情報のみを扱う（自社の数字は一切載せない）。
"""
import argparse
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "brokers.json")
OUT = os.path.join(ROOT, "out")

CONF_MARK = {"high": "", "mid": "※", "low": "※※"}


def oku(mmen):
    """百万円 → 「○兆○,○○○億円」表記。"""
    if mmen is None:
        return "—"
    if isinstance(mmen, str):
        return mmen
    oku_total = mmen / 100.0
    if oku_total >= 10000:
        cho, rest = divmod(oku_total, 10000)
        return f"{int(cho)}兆{rest:,.0f}億円"
    return f"{oku_total:,.0f}億円"


def cases(v):
    return "—" if v is None else f"{v:,}件"


def stores(v):
    return "—" if v is None else f"{v}店"


def load():
    with open(DATA, encoding="utf-8") as f:
        return json.load(f)


def build(d):
    names = {c["id"]: c["name"] for c in d["companies"]}
    shorts = {c["id"]: c["short"] for c in d["companies"]}
    H, T = [], []

    def h(s):
        H.append(s)

    def t(s):
        T.append(s)

    h('<div style="font-family:-apple-system,BlinkMacSystemFont,\'Hiragino Sans\',\'Yu Gothic\',sans-serif;'
      'font-size:14px;line-height:1.7;color:#1a1a1a;max-width:760px">')

    # --- 見出し -------------------------------------------------------
    h(f'<h2 style="margin:0 0 4px;font-size:18px">大手仲介7社 売買仲介実績レポート</h2>')
    h(f'<div style="color:#666;font-size:12px;margin-bottom:16px">作成日：{d["meta"]["updated"]}／月2回配信</div>')

    t("■ 大手仲介7社 売買仲介実績レポート")
    t(f"作成日：{d['meta']['updated']}／月2回配信")
    t("")

    # --- サマリー -----------------------------------------------------
    h('<div style="background:#f5f7fa;border-left:3px solid #2b6cb0;padding:12px 14px;margin-bottom:20px">')
    h('<b>3行サマリー</b><ul style="margin:6px 0 0;padding-left:18px">')
    t("【3行サマリー】")
    for s in d["industry"] + [d["market"]["comment"]]:
        h(f"<li>{s}</li>")
        t(f"・{s}")
    h("</ul></div>")
    t("")

    # --- 年度テーブル -------------------------------------------------
    def table(block, title):
        h(f'<h3 style="font-size:15px;margin:22px 0 8px;border-bottom:2px solid #2b6cb0;padding-bottom:4px">{title}</h3>')
        h(f'<div style="color:#666;font-size:12px;margin-bottom:6px">{block["label"]}</div>')
        h('<table border="1" bordercolor="#cbd5e0" cellpadding="7" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px">')
        h('<tr style="background:#eef2f7">'
          '<th align="left">会社</th>'
          '<th align="right">取扱件数</th>'
          '<th align="right">取扱高</th>'
          '<th align="right">手数料収入</th>'
          '<th align="right">店舗数</th></tr>')
        t(f"【{title}】{block['label']}")
        for r in block["rows"]:
            m = CONF_MARK.get(r.get("conf", ""), "")
            fee = r["fee"] if isinstance(r["fee"], str) else oku(r["fee"])
            yoy = f'<br><span style="color:#888;font-size:11px">{r["cases_yoy"]}</span>' if r.get("cases_yoy") else ""
            h('<tr>'
              f'<td>{names[r["id"]]}{m}</td>'
              f'<td align="right">{cases(r["cases"])}{yoy}</td>'
              f'<td align="right">{oku(r["volume"])}</td>'
              f'<td align="right">{fee}</td>'
              f'<td align="right">{stores(r["stores"])}</td></tr>')
            t(f"  {shorts[r['id']]}{m}: {cases(r['cases'])} / 取扱高 {oku(r['volume'])} / 手数料 {fee} / {stores(r['stores'])}")
        h("</table>")
        h('<ul style="font-size:12px;color:#555;margin:8px 0 0;padding-left:18px">')
        for r in block["rows"]:
            if r.get("note"):
                h(f'<li><b>{shorts[r["id"]]}</b>：{r["note"]}</li>')
                t(f"   - {shorts[r['id']]}：{r['note']}")
        h("</ul>")
        t("")

    table(d["fy2025"], "① 直近通期（2025年度）")
    table(d["fy2024"], "② 前年度（2024年度）との比較")

    # --- 5年推移 ------------------------------------------------------
    tr = d["trend_cases"]
    h('<h3 style="font-size:15px;margin:22px 0 8px;border-bottom:2px solid #2b6cb0;padding-bottom:4px">③ 5年推移（取扱件数）</h3>')
    h('<table border="1" bordercolor="#cbd5e0" cellpadding="7" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px">')
    h('<tr style="background:#eef2f7"><th align="left">会社</th>'
      + "".join(f'<th align="right">{y}</th>' for y in tr["years"]) + "</tr>")
    t("【③ 5年推移（取扱件数）】")
    t("  会社 / " + " / ".join(tr["years"]))
    for s in tr["series"]:
        h(f'<tr><td>{shorts[s["id"]]}</td>'
          + "".join(f'<td align="right">{cases(v)}</td>' for v in s["values"])
          + "</tr>")
        t(f"  {shorts[s['id']]}: " + " / ".join(cases(v) for v in s["values"]))
    h("</table>")
    h(f'<div style="font-size:12px;color:#555;margin-top:6px">{tr["note"]}</div>')
    t(f"  ※ {tr['note']}")
    t("")

    # --- 人員 ---------------------------------------------------------
    h('<h3 style="font-size:15px;margin:22px 0 8px;border-bottom:2px solid #2b6cb0;padding-bottom:4px">④ 人員</h3>')
    h('<ul style="margin:0;padding-left:18px">')
    t("【④ 人員】")
    for r in d["headcount"]:
        h(f'<li><b>{shorts[r["id"]]}</b>：{r["value"]}</li>')
        t(f"  {shorts[r['id']]}：{r['value']}")
    h("</ul>")
    t("")

    # --- トピック -----------------------------------------------------
    h('<h3 style="font-size:15px;margin:22px 0 8px;border-bottom:2px solid #2b6cb0;padding-bottom:4px">⑤ 各社トピック</h3>')
    t("【⑤ 各社トピック】")
    for tp in d["topics"]:
        h(f'<p style="margin:0 0 10px"><b>{names[tp["id"]]}</b><br>{tp["text"]}</p>')
        t(f"  ◆ {names[tp['id']]}")
        t(f"    {tp['text']}")
    t("")

    # --- 市況 ---------------------------------------------------------
    mk = d["market"]
    h(f'<h3 style="font-size:15px;margin:22px 0 8px;border-bottom:2px solid #2b6cb0;padding-bottom:4px">⑥ {mk["label"]}</h3>')
    h('<table border="1" bordercolor="#cbd5e0" cellpadding="7" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px">')
    h('<tr style="background:#eef2f7"><th align="left">時点</th>'
      '<th align="left">成約件数</th>'
      '<th align="left">成約平均価格</th></tr>')
    t(f"【⑥ {mk['label']}】")
    for r in mk["rows"]:
        h(f'<tr><td>{r["month"]}</td>'
          f'<td>{r["cases"]}</td>'
          f'<td>{r["price"]}</td></tr>')
        t(f"  {r['month']}：成約 {r['cases']}／価格 {r['price']}")
    h("</table>")
    h(f'<p style="margin:8px 0 0">{mk["comment"]}</p>')
    t(f"  {mk['comment']}")
    t("")

    # --- 注記・出典 ---------------------------------------------------
    h('<h3 style="font-size:15px;margin:22px 0 8px;border-bottom:2px solid #2b6cb0;padding-bottom:4px">注記・出典</h3>')
    h('<ul style="font-size:12px;color:#555;margin:0;padding-left:18px">')
    h(f'<li>{d["meta"]["note"]}</li>')
    h('<li>無印＝一次情報で裏取り済み／<b>※</b>＝業界紙・集計サイト経由（年度ラベルの取り違えに注意）／<b>※※</b>＝未確認・次回補完</li>')
    t("【注記・出典】")
    t(f"  {d['meta']['note']}")
    t("  無印=一次情報で裏取り済み／※=業界紙・集計サイト経由／※※=未確認・次回補完")
    for s in d["sources"]:
        h(f'<li><a href="{s["u"]}" style="color:#2b6cb0">{s["t"]}</a></li>')
        t(f"  - {s['t']}: {s['u']}")
    h("</ul></div>")

    return "\n".join(H), "\n".join(T)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--print", dest="show", action="store_true")
    a = ap.parse_args()
    d = load()
    html, text = build(d)
    os.makedirs(OUT, exist_ok=True)
    open(os.path.join(OUT, "broker-report.html"), "w", encoding="utf-8").write(html)
    open(os.path.join(OUT, "broker-report.txt"), "w", encoding="utf-8").write(text)
    if a.show:
        print(text)
    else:
        print(f"wrote {OUT}/broker-report.html, {OUT}/broker-report.txt")


if __name__ == "__main__":
    main()
