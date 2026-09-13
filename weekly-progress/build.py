#!/usr/bin/env python3
"""第5期 営業目標進捗（A3横）の週次生成スクリプト。

  python3 build.py                     # 小林さんあて（金額あり）
  python3 build.py --audience team      # 全員あて（金額をすべて非表示）

data/fy5.json を更新して実行すると out/ に PDF とメール本文 HTML が出ます。
単位はすべて「万円」で入力してください。
"""
import argparse, json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / "out"

C = dict(
    band="#4E7D28", green="#84BD41", greenTxt="#4E8B1F", greenDark="#3F6B1C",
    blue="#4FA8DB", blueTxt="#2E86B8", gray="#E3E8DD", ink="#2F3A25",
    sub="#7A8A6D", paper="#F4F7F0", card="#FFFFFF", line="#DFE7D6",
)
FONT = "'Noto Sans JP','IPAPGothic','IPAGothic',sans-serif"


# ---------- 数値の書式 ----------
def man(v):
    """万円単位の整数 -> 『1億9,482万円』形式"""
    v = int(round(v))
    if v == 0:
        return "0"
    oku, rest = divmod(v, 10000)
    if oku and rest:
        return f"{oku}億{rest:,}万円"
    if oku:
        return f"{oku}億円"
    return f"{rest:,}万円"


def pct(num, den):
    return 0 if not den else num / den * 100


def pctv(num, den, digits=0):
    return f"{pct(num, den):.{digits}f}%"


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


# ---------- グラフ ----------
def monthly_chart(d, show_money):
    """月別の粗利（棒グラフ）を SVG で描く"""
    rows = d["monthlyGross"]
    tgt = d["targets"]["monthlyGrossMan"]
    top = max([tgt] + [r["actual"] + r["forecast"] for r in rows])
    top = int(((top // 900) + 1) * 900)
    W, H = 1000.0, 300.0
    L, R, T, B = 62.0, 12.0, 30.0, 34.0
    pw, ph = W - L - R, H - T - B
    slot = pw / len(rows)
    bw = slot * 0.46

    def y(v):
        return T + ph - ph * (v / top)

    p = [f'<svg viewBox="0 0 {W:.0f} {H:.0f}" width="100%" role="img" aria-label="月別の粗利">']
    step = top // 4
    for i in range(5):
        v = step * i
        p.append(f'<line x1="{L}" y1="{y(v):.1f}" x2="{W-R}" y2="{y(v):.1f}" '
                 f'stroke="{C["line"]}" stroke-width="1" stroke-dasharray="3 3"/>')
        lab = f"{v:,}" if show_money else f"{pct(v, tgt):.0f}%"
        p.append(f'<text x="{L-8}" y="{y(v)+4:.1f}" text-anchor="end" font-size="12" '
                 f'fill="{C["sub"]}">{lab}</text>')
    for i, r in enumerate(rows):
        cx = L + slot * i + slot / 2
        x = cx - bw / 2
        p.append(f'<rect x="{x:.1f}" y="{y(tgt):.1f}" width="{bw:.1f}" '
                 f'height="{ph*(tgt/top):.1f}" fill="{C["gray"]}"/>')
        for v, col, tcol in ((r["actual"], C["green"], C["greenTxt"]),
                             (r["forecast"], C["blue"], C["blueTxt"])):
            if v <= 0:
                continue
            p.append(f'<rect x="{x:.1f}" y="{y(v):.1f}" width="{bw:.1f}" '
                     f'height="{ph*(v/top):.1f}" fill="{col}"/>')
            lab = f"{v:,}" if show_money else f"{pct(v, tgt):.0f}%"
            p.append(f'<text x="{cx:.1f}" y="{y(v)-7:.1f}" text-anchor="middle" '
                     f'font-size="14" font-weight="700" fill="{tcol}">{lab}</text>')
        p.append(f'<text x="{cx:.1f}" y="{H-12:.0f}" text-anchor="middle" font-size="14" '
                 f'font-weight="700" fill="{C["ink"]}">{r["label"]}</text>')
    p.append(f'<line x1="{L}" y1="{y(0):.1f}" x2="{W-R}" y2="{y(0):.1f}" '
             f'stroke="{C["sub"]}" stroke-width="1"/>')
    p.append("</svg>")
    return "".join(p)


def cumulative_chart(d, show_money):
    """粗利の累計（折れ線）を SVG で描く"""
    rows = d["monthlyGross"]
    goal = d["targets"]["grossMan"]
    fc_total = d["totals"]["grossForecastMan"]
    W, H = 620.0, 250.0
    L, R, T, B = 70.0, 120.0, 22.0, 34.0
    pw, ph = W - L - R, H - T - B
    n = len(rows)
    top = max(goal, fc_total)

    def X(i):
        return L + pw * (i / (n - 1))

    def Y(v):
        return T + ph - ph * (v / top)

    cum, run, last = [], 0, -1
    for i, r in enumerate(rows):
        run += r["actual"]
        cum.append(run)
        if r["actual"] > 0:
            last = i
    last = max(last, 0)

    p = [f'<svg viewBox="0 0 {W:.0f} {H:.0f}" width="100%" role="img" aria-label="粗利の累計">']
    for i in range(4):
        v = top * i / 3
        lab = man(v) if show_money else f"{pct(v, goal):.0f}%"
        p.append(f'<line x1="{L}" y1="{Y(v):.1f}" x2="{W-R}" y2="{Y(v):.1f}" '
                 f'stroke="{C["line"]}" stroke-dasharray="3 3"/>')
        p.append(f'<text x="{L-8}" y="{Y(v)+4:.1f}" text-anchor="end" font-size="11" '
                 f'fill="{C["sub"]}">{lab}</text>')
    p.append(f'<line x1="{X(0):.1f}" y1="{Y(0):.1f}" x2="{X(n-1):.1f}" y2="{Y(goal):.1f}" '
             f'stroke="{C["green"]}" stroke-width="2" stroke-dasharray="7 5" opacity=".65"/>')
    pts = " ".join(f"{X(i):.1f},{Y(cum[i]):.1f}" for i in range(last + 1))
    p.append(f'<polyline points="{pts}" fill="none" stroke="{C["green"]}" stroke-width="3"/>')
    for i in range(last + 1):
        p.append(f'<circle cx="{X(i):.1f}" cy="{Y(cum[i]):.1f}" r="3.4" fill="{C["green"]}"/>')
    fi = min(last + 2, n - 1)
    p.append(f'<line x1="{X(last):.1f}" y1="{Y(cum[last]):.1f}" x2="{X(fi):.1f}" '
             f'y2="{Y(fc_total):.1f}" stroke="{C["blue"]}" stroke-width="3"/>')
    p.append(f'<circle cx="{X(fi):.1f}" cy="{Y(fc_total):.1f}" r="4.6" fill="{C["blue"]}"/>')
    aL = man(d["totals"]["grossActualMan"]) if show_money else pctv(d["totals"]["grossActualMan"], goal)
    fL = man(fc_total) if show_money else pctv(fc_total, goal)
    p.append(f'<text x="{X(fi)+10:.1f}" y="{Y(fc_total)-2:.1f}" font-size="13" font-weight="700" '
             f'fill="{C["blueTxt"]}">予定 {fL}</text>')
    p.append(f'<text x="{X(fi)+10:.1f}" y="{Y(cum[last])+16:.1f}" font-size="13" font-weight="700" '
             f'fill="{C["greenTxt"]}">実績 {aL}</text>')
    for i in (0, 3, 6, 9, 11):
        p.append(f'<text x="{X(i):.1f}" y="{H-12:.0f}" text-anchor="middle" font-size="12" '
                 f'fill="{C["sub"]}">{rows[i]["label"]}</text>')
    p.append("</svg>")
    return "".join(p)


# ---------- カード ----------
def kpi_card(title, target_label, big, rate, bar_a, bar_f, bar_max,
             fore_label, right_label, pace_ratio, rate_label="達成率", rate_blue=False):
    ga = min(100.0, pct(bar_a, bar_max))
    gf = min(100.0 - ga, pct(bar_f, bar_max))
    return f"""
<div class="card kpi">
  <div class="kpitop"><span class="kt">{title}</span><span class="kg">{target_label}</span></div>
  <div class="kpimain"><span class="big">{big}</span>
    <span class="rate{' blue' if rate_blue else ''}"><b>{rate}</b><i>{rate_label}</i></span></div>
  <div class="track"><span class="fa" style="width:{ga:.2f}%"></span>
    <span class="ff" style="width:{gf:.2f}%"></span>
    <span class="pace" style="left:{min(99.0, pace_ratio):.2f}%"></span></div>
  <div class="pacelab" style="left:{min(96.0, pace_ratio):.2f}%">今の目安</div>
  <div class="kpifoot"><span class="fc">{fore_label}</span><span class="rm">{right_label}</span></div>
</div>"""


def member_gross(d, show_money):
    scale = max([m["grossTargetMan"] or 0 for m in d["members"]] +
                [m["grossMan"] + m["forecastMan"] for m in d["members"]])
    out = []
    for m in d["members"]:
        t = m["grossTargetMan"]
        wa, wf = pct(m["grossMan"], scale), pct(m["forecastMan"], scale)
        wt = pct(t or 0, scale)
        if show_money:
            val = man(m["grossMan"])
            note = (f'目標 {man(t)}　達成 {pctv(m["grossMan"], t)}' if t else "目標なし（記録のみ）")
            inbar = (f'<span class="inbar" style="left:{wa:.2f}%">見込 {m["forecastMan"]:,}万円</span>'
                     if m["forecastMan"] else "")
        else:
            val = pctv(m["grossMan"], t) if t else "—"
            note = "目標に対する達成率" if t else "目標なし（記録のみ）"
            inbar = ""
        out.append(f"""
<div class="mrow"><div class="mname"><b>{esc(m["name"])}</b><i>{esc(m["role"])}</i></div>
  <div class="mbar"><span class="mt" style="width:{wt:.2f}%"></span>
    <span class="ma" style="width:{wa:.2f}%"></span>
    <span class="mf" style="left:{wa:.2f}%;width:{wf:.2f}%"></span>{inbar}</div>
  <div class="mval"><b>{val}</b><i>{note}</i></div></div>""")
    return "".join(out)


def member_contracts(d):
    scale = max([max(m["contracts"], m["contractTarget"] or 0) for m in d["members"]] + [1])
    out = []
    for m in d["members"]:
        t = m["contractTarget"]
        wa, wt = pct(m["contracts"], scale), pct(t or 0, scale)
        val = f'{m["contracts"]} / {t} 件' if t else f'{m["contracts"]} 件'
        out.append(f"""
<div class="crow"><div class="cname">{esc(m["name"])}</div>
  <div class="cbar"><span class="ct" style="width:{wt:.2f}%"></span>
    <span class="ca" style="width:{wa:.2f}%"></span></div>
  <div class="cval">{val}</div></div>""")
    return "".join(out)


# ---------- ダッシュボード ----------
def dashboard(d, show_money):
    t, tot, f = d["targets"], d["totals"], d["fiscal"]
    pace = f["elapsedMonths"] / f["totalMonths"] * 100
    gap = t["grossMan"] - tot["grossForecastMan"]
    sgap = t["salesMan"] - tot["salesForecastMan"]
    need = gap / max(1, f["remainingMonths"])
    cards = (
        kpi_card("年間 粗利", f'目標 {man(t["grossMan"])}' if show_money else "年間目標に対して",
                 man(tot["grossActualMan"]) if show_money else pctv(tot["grossActualMan"], t["grossMan"]),
                 pctv(tot["grossActualMan"], t["grossMan"]),
                 tot["grossActualMan"], tot["grossForecastMan"] - tot["grossActualMan"], t["grossMan"],
                 (f'予定実績（実績＋見込）{man(tot["grossForecastMan"])}' if show_money
                  else f'予定実績（実績＋見込）{pctv(tot["grossForecastMan"], t["grossMan"])}'),
                 (f'残り {man(gap)}' if show_money
                  else f'残り {pctv(gap, t["grossMan"])}'), pace) +
        kpi_card("年間 売上", f'目標 {man(t["salesMan"])}' if show_money else "年間目標に対して",
                 man(tot["salesActualMan"]) if show_money else pctv(tot["salesActualMan"], t["salesMan"]),
                 pctv(tot["salesActualMan"], t["salesMan"]),
                 tot["salesActualMan"], tot["salesForecastMan"] - tot["salesActualMan"], t["salesMan"],
                 (f'予定実績（実績＋見込）{man(tot["salesForecastMan"])}' if show_money
                  else f'予定実績（実績＋見込）{pctv(tot["salesForecastMan"], t["salesMan"])}'),
                 (f'残り {man(sgap)}' if show_money
                  else f'残り {pctv(sgap, t["salesMan"])}'), pace) +
        kpi_card(f'契約件数（全社）<i class="cn">{esc(t["contractsNote"])}</i>',
                 f'目標 {t["contracts"]} 件', f'{tot["contractsActual"]} 件',
                 f'{tot["contractsForecast"]} 件',
                 tot["contractsActual"], tot["contractsForecast"] - tot["contractsActual"], t["contracts"],
                 f'予定実績（実績＋見込）{tot["contractsForecast"]} 件',
                 f'月平均 {tot["contractsActual"]/max(1,f["elapsedMonths"]):.1f} 件', pace,
                 rate_label="予定実績", rate_blue=True)
    )
    if show_money:
        pace_box = f"""
<div class="pacebox"><div><span class="pl">目標まで</span>
    <span class="pv">{man(gap)}</span></div>
  <div class="sep"></div>
  <div><span class="pl">残り {f["remainingMonths"]} ヶ月　必要なペース</span>
    <span class="pv">月 {man(need)}</span></div></div>"""
        unit_note = f'単位：万円　／　うすい棒＝月の目標 {t["monthlyGrossMan"]:,}万円'
        mnote = "単位：万円　／　うすい棒＝年間目標"
    else:
        pace_box = f"""
<div class="pacebox"><div><span class="pl">目標までの残り</span>
    <span class="pv">{pctv(gap, t["grossMan"])}</span></div>
  <div class="sep"></div>
  <div><span class="pl">残り {f["remainingMonths"]} ヶ月　1ヶ月あたり必要</span>
    <span class="pv">{pct(gap, t["grossMan"])/max(1,f["remainingMonths"]):.1f}%</span></div></div>"""
        unit_note = "月の目標に対する達成率（％）／ うすい棒＝月の目標"
        mnote = "うすい棒＝年間目標"
    secret = ("株式会社スマートハウス　社外秘　／　数字は第5期 経営進捗管理表より"
              if show_money else
              "株式会社スマートハウス　社内限　／　金額は非表示（達成率・件数のみ）")
    return f"""<meta charset="utf-8"><title>第5期 営業目標 進捗</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&display=swap">
<style>
@page{{size:A3 landscape;margin:0}}
*{{box-sizing:border-box;margin:0;padding:0}}
body{{font-family:{FONT};background:{C['paper']};color:{C['ink']};
  width:420mm;height:297mm;padding:7mm 8mm;display:flex;flex-direction:column;gap:6mm}}
.band{{background:{C['band']};border-radius:7px;padding:13px 22px;display:flex;align-items:center;gap:20px;color:#fff}}
.band .mark{{width:64px;height:64px;border-radius:12px;background:#fff;flex:0 0 auto;
  display:flex;align-items:center;justify-content:center}}
.band .mark svg{{width:54px;height:54px}}
.band .co b{{display:block;font-size:26px;font-weight:900;letter-spacing:.02em;line-height:1.2}}
.band .co i{{font-style:normal;font-size:11px;letter-spacing:.34em;opacity:.8}}
.band .mid{{flex:1;text-align:center}}
.band .mid b{{display:block;font-size:32px;font-weight:900;letter-spacing:.06em}}
.band .mid i{{font-style:normal;font-size:13px;opacity:.88}}
.band .rt{{text-align:right;font-size:12px;opacity:.9;line-height:1.75;flex:0 0 auto}}
.band .rt b{{display:block;font-size:16px;font-weight:700;opacity:1}}
.card{{background:{C['card']};border:1px solid {C['line']};border-radius:7px;padding:13px 17px 15px}}
.r1{{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6mm}}
.r2{{display:grid;grid-template-columns:1.55fr 1fr;gap:6mm;flex:1.05}}
.r3{{display:grid;grid-template-columns:1.55fr 1fr;gap:6mm;flex:1}}
.kpi{{position:relative}}
.kpitop{{display:flex;align-items:baseline;gap:10px;margin-bottom:2px}}
.kpitop .kt{{font-size:16px;font-weight:700}}
.kpitop .kt .cn{{font-style:normal;font-size:10.5px;font-weight:400;color:{C['sub']};margin-left:8px}}
.kpitop .kg{{margin-left:auto;font-size:14px;font-weight:700;white-space:nowrap}}
.kpimain{{display:flex;align-items:flex-end;gap:12px;margin:2px 0 9px}}
.kpimain .big{{font-size:42px;font-weight:900;color:{C['greenTxt']};line-height:1.05;letter-spacing:-.01em}}
.kpimain .rate{{margin-left:auto;text-align:right}}
".kpimain .rate b"{{display:block;font-size:26px;font-weight:900;color:{C['greenTxt']};line-height:1}}
.kpimain .rate i{{display:block;font-style:normal;font-size:10.5px;color:{C['sub']};line-height:1.3}}
.kpimain .rate.blue b{{color:{C['blueTxt']}}}
.track{{position:relative;height:13px;border-radius:3px;background:{C['gray']};overflow:hidden;display:flex}}
.track .fa{{background:{C['green']}}}.track .ff{{background:{C['blue']}}}
.track .pace{{position:absolute;top:-2px;bottom:-2px;width:0;border-left:1.5px dotted {C['sub']}}}
.pacelab{{position:relative;font-size:9.5px;color:{C['sub']};margin-top:2px;transform:translateX(-50%);width:max-content}}
.kpifoot{{display:flex;gap:10px;margin-top:5px;font-size:12px}}
.kpifoot .fc{{color:{C['blueTxt']};font-weight:700}}
.kpifoot .rm{{margin-left:auto;color:{C['sub']}}}
.chead{{display:flex;align-items:baseline;gap:10px;margin-bottom:7px}}
.chead h2{{font-size:18px;font-weight:900;color:{C['greenDark']};letter-spacing:.04em}}
.chead .n{{margin-left:auto;font-size:10.5px;color:{C['sub']}}}
.pacebox{{display:flex;align-items:center;gap:18px;border:1.5px solid {C['green']};
  border-radius:7px;background:#F6FAF0;padding:9px 18px;margin-top:6px}}
.pacebox .sep{{width:1px;align-self:stretch;background:{C['line']}}}
.pacebox .pl{{display:block;font-size:11px;color:{C['sub']}}}
.pacebox .pv{{display:block;font-size:26px;font-weight:900;color:{C['ink']};line-height:1.2}}
.mrow{{display:grid;grid-template-columns:112px 1fr 152px;align-items:center;gap:11px;margin-bottom:15px}}
.mrow .mname{{text-align:right}}
.mrow .mname b{{display:block;font-size:14px;font-weight:700}}
.mrow .mname i{{font-style:normal;font-size:9.5px;color:{C['sub']}}}
.mbar{{position:relative;height:19px;background:transparent}}
.mbar .mt{{position:absolute;top:0;left:0;height:100%;background:{C['gray']};border-radius:2px}}
.mbar .ma{{position:absolute;top:0;left:0;height:100%;background:{C['green']};border-radius:2px}}
.mbar .mf{{position:absolute;top:0;height:100%;background:{C['blue']};border-radius:2px}}
.mbar .inbar{{position:absolute;top:2px;font-size:10px;color:#fff;font-weight:700;padding-left:7px;white-space:nowrap}}
.mval{{text-align:right}}
.mval b{{display:block;font-size:18px;font-weight:900;color:{C['greenTxt']};line-height:1.2}}
.mval i{{font-style:normal;font-size:9.5px;color:{C['sub']}}}
.crow{{display:grid;grid-template-columns:88px 1fr 74px;align-items:center;gap:11px;margin-bottom:17px}}
.crow .cname{{text-align:right;font-size:14px;font-weight:700}}
.cbar{{position:relative;height:17px}}
.cbar .ct{{position:absolute;top:0;left:0;height:100%;background:{C['gray']};border-radius:2px}}
.cbar .ca{{position:absolute;top:0;left:0;height:100%;background:{C['green']};border-radius:2px}}
.cval{{text-align:right;font-size:16px;font-weight:900;color:{C['greenTxt']}}}
.foot{{display:flex;align-items:center;gap:16px;font-size:11px;color:{C['sub']}}}
.foot .lg{{display:flex;align-items:center;gap:6px}}
.foot .sw{{width:26px;height:11px;border-radius:2px;display:inline-block}}
.foot .sc{{margin-left:auto}}
.notes{{font-size:10.5px;color:{C['sub']};line-height:1.6;margin-top:5px}}
</style>
<div class="band">
  <span class="mark"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="36" fill="none"
    stroke="{C['green']}" stroke-width="7" stroke-linecap="round" stroke-dasharray="196 30"
    transform="rotate(-58 50 50)"/><circle cx="63" cy="17" r="8" fill="{C['green']}"/>
    <circle cx="75" cy="12" r="7" fill="{C['green']}"/><circle cx="84" cy="14" r="8" fill="#6FB7E0"/>
    <text x="50" y="64" text-anchor="middle" font-size="36" font-weight="700"
    font-family="{FONT}" fill="{C['green']}">SH</text>
    <path d="M14 62 q30 -6 48 16 q-26 14 -44 -2 z" fill="{C['green']}"/></svg></span>
  <span class="co"><b>株式会社スマートハウス</b><i>SMART HOUSE</i></span>
  <span class="mid"><b>第5期　営業目標 進捗</b>
    <i>{esc(d["fiscal"]["periodLabel"])}　／　目標・実績・予定実績</i></span>
  <span class="rt"><b>{esc(d["asOfLabel"])}</b>
    経過 {d["fiscal"]["elapsedMonths"]} / {d["fiscal"]["totalMonths"]} ヶ月<br>毎週更新</span>
</div>
<div class="r1">{cards}</div>
<div class="r2">
  <div class="card"><div class="chead"><h2>月別の粗利</h2><span class="n">{unit_note}</span></div>
    {monthly_chart(d, show_money)}</div>
  <div class="card"><div class="chead"><h2>粗利の累計</h2>
    <span class="n">{'目標' + man(t['grossMan']) + 'に対する到達' if show_money else '年間目標に対する到達率'}</span></div>
    {cumulative_chart(d, show_money)}{pace_box}</div>
</div>
<div class="r3">
  <div class="card"><div class="chead"><h2>担当者別 年間粗利</h2><span class="n">{mnote}</span></div>
    {member_gross(d, show_money)}</div>
  <div class="card"><div class="chead"><h2>担当者別 契約件数</h2><span class="n">実績 / 目標</span></div>
    {member_contracts(d)}</div>
</div>
<div class="foot">
  <span class="lg"><i class="sw" style="background:{C['green']}"></i>実績（契約済・決済済）</span>
  <span class="lg"><i class="sw" style="background:{C['blue']}"></i>見込（契約前）</span>
  <span class="lg"><i class="sw" style="background:{C['gray']}"></i>目標</span>
  <span>／　予定実績＝実績＋見込</span>
  <span class="sc">{esc(secret)}　／　{esc(d["baseNote"])}</span>
</div>
"""


# ---------- メール本文 ----------
def notes_for(d, show_money):
    """申し送り。小林さんあてのときだけ社内限の項目も足す。"""
    n = list(d.get("weeklyNotes", []))
    if show_money:
        n += list(d.get("notesKobayashiOnly", []))
    return n


MONEY_RE = re.compile(r"[0-9０-９][0-9,０-９]*\s*(万円|億円|億|円)|¥\s*[0-9]")


def assert_no_money(*texts):
    """全員あて（team）の成果物に金額が混ざっていないか機械的に確認する。"""
    hits = sorted({m.group(0).strip() for t in texts for m in MONEY_RE.finditer(t)})
    if hits:
        raise SystemExit("全員あての資料に金額が含まれています。データの申し送り等を確認してください: "
                         + ", ".join(hits))


def email_html(d, show_money):
    t, tot, f = d["targets"], d["totals"], d["fiscal"]
    gap = t["grossMan"] - tot["grossForecastMan"]
    need = gap / max(1, f["remainingMonths"])
    th = f'padding:7px 10px;border:1px solid {C["line"]};background:#F1F6EA;font-size:12px;text-align:left'
    td = f'padding:7px 10px;border:1px solid {C["line"]};font-size:13px'
    tdn = td + ";text-align:right;font-weight:700;white-space:nowrap"

    def kpi_rows():
        rows = [("年間 粗利", man(t["grossMan"]), man(tot["grossActualMan"]),
                 pctv(tot["grossActualMan"], t["grossMan"]), man(tot["grossForecastMan"])),
                ("年間 売上", man(t["salesMan"]), man(tot["salesActualMan"]),
                 pctv(tot["salesActualMan"], t["salesMan"]), man(tot["salesForecastMan"])),
                ("契約件数（全社）", f'{t["contracts"]} 件', f'{tot["contractsActual"]} 件',
                 pctv(tot["contractsActual"], t["contracts"]), f'{tot["contractsForecast"]} 件')]
        out = []
        for name, tg, ac, ra, fo in rows:
            if not show_money and name != "契約件数（全社）":
                tg, ac, fo = "—", ra, "—"
            out.append(f'<tr><td style="{td}">{name}</td><td style="{tdn}">{tg}</td>'
                       f'<td style="{tdn}">{ac}</td><td style="{tdn}">{ra}</td>'
                       f'<td style="{tdn}">{fo}</td></tr>')
        return "".join(out)

    def mem_rows():
        out = []
        for m in d["members"]:
            g = m["grossTargetMan"]
            if show_money:
                a = man(m["grossMan"])
                tg = man(g) if g else "—"
            else:
                a = pctv(m["grossMan"], g) if g else "—"
                tg = "—"
            ct = f'{m["contracts"]} / {m["contractTarget"]} 件' if m["contractTarget"] else f'{m["contracts"]} 件'
            rate = pctv(m["grossMan"], g) if g else "—"
            out.append(f'<tr><td style="{td}">{esc(m["name"])}<br>'
                       f'<span style="font-size:10.5px;color:{C["sub"]}">{esc(m["role"])}</span></td>'
                       f'<td style="{tdn}">{tg}</td><td style="{tdn}">{a}</td>'
                       f'<td style="{tdn}">{rate}</td><td style="{tdn}">{ct}</td></tr>')
        return "".join(out)

    notes = "".join(f'<li style="margin-bottom:5px">{esc(n)}</li>' for n in notes_for(d, show_money))
    pace = (f'目標まで（予定実績との差）<b>{man(gap)}</b>　／　'
            f'残り {f["remainingMonths"]} ヶ月　必要なペース <b>月 {man(need)}</b>'
            if show_money else
            f'年間目標の到達率 <b>{pctv(tot["grossActualMan"], t["grossMan"])}</b>　／　'
            f'残り {f["remainingMonths"]} ヶ月')
    secret = "社外秘（社内限り）" if show_money else "社内限（金額は非表示）"
    return f"""<div style="font-family:{FONT};color:{C['ink']};font-size:13px;line-height:1.85;max-width:760px">
<div style="background:{C['band']};color:#fff;padding:14px 18px;border-radius:6px">
  <div style="font-size:19px;font-weight:700">第5期　営業目標 進捗</div>
  <div style="font-size:12px;opacity:.9">{esc(d["fiscal"]["periodLabel"])}　／　{esc(d["asOfLabel"])}　／　
    経過 {f["elapsedMonths"]} / {f["totalMonths"]} ヶ月</div></div>
<p style="margin:14px 0 4px">お疲れさまです。第5期 営業目標の進捗（週次）をお送りします。</p>
<p style="margin:0 0 14px;color:{C['sub']};font-size:12px">基準：{esc(d["baseNote"])}</p>
<table style="border-collapse:collapse;width:100%;margin-bottom:8px">
  <tr><th style="{th}">項目</th><th style="{th};text-align:right">年間目標</th>
    <th style="{th};text-align:right">実績</th><th style="{th};text-align:right">達成率</th>
    <th style="{th};text-align:right">予定実績</th></tr>
  {kpi_rows()}
</table>
<div style="background:#F6FAF0;border:1px solid {C['green']};border-radius:6px;padding:10px 14px;margin:12px 0 18px">{pace}</div>
<div style="font-size:15px;font-weight:700;color:{C['greenDark']};margin-bottom:6px">担当者別</div>
<table style="border-collapse:collapse;width:100%">
  <tr><th style="{th}">担当者</th><th style="{th};text-align:right">年間 粗利目標</th>
    <th style="{th};text-align:right">粗利 実績</th><th style="{th};text-align:right">達成率</th>
    <th style="{th};text-align:right">契約件数</th></tr>
  {mem_rows()}
</table>
<div style="font-size:15px;font-weight:700;color:{C['greenDark']};margin:18px 0 4px">今週の申し送り</div>
<ul style="margin:0 0 16px;padding-left:1.3em">{notes}</ul>
<p style="margin:0 0 4px;font-size:12px;color:{C['sub']}">
  添付の PDF（A3横）が正式版です。数値は毎週、日報カウンターの成約登録と経営管理シートから更新しています。</p>
<p style="margin:14px 0 0;font-size:11px;color:{C['sub']};border-top:1px solid {C['line']};padding-top:8px">
  株式会社スマートハウス　{esc(secret)}　／　本メールの数字は第5期 経営進捗管理表より</p>
</div>"""


def email_text(d, show_money):
    t, tot, f = d["targets"], d["totals"], d["fiscal"]
    need = (t["grossMan"] - tot["grossForecastMan"]) / max(1, f["remainingMonths"])
    L = [f'第5期 営業目標 進捗　{d["asOfLabel"]}（経過 {f["elapsedMonths"]}/{f["totalMonths"]} ヶ月）',
         f'基準：{d["baseNote"]}', ""]
    if show_money:
        L += [f'年間粗利　目標 {man(t["grossMan"])}／実績 {man(tot["grossActualMan"])}'
              f'（達成 {pctv(tot["grossActualMan"], t["grossMan"])}）／予定実績 {man(tot["grossForecastMan"])}',
              f'年間売上　目標 {man(t["salesMan"])}／実績 {man(tot["salesActualMan"])}'
              f'（達成 {pctv(tot["salesActualMan"], t["salesMan"])}）／予定実績 {man(tot["salesForecastMan"])}']
    else:
        L += [f'年間粗利　達成率 {pctv(tot["grossActualMan"], t["grossMan"])}',
              f'年間売上　達成率 {pctv(tot["salesActualMan"], t["salesMan"])}']
    L += [f'契約件数　目標 {t["contracts"]}件／実績 {tot["contractsActual"]}件'
          f'（達成 {pctv(tot["contractsActual"], t["contracts"])}）／予定実績 {tot["contractsForecast"]}件', ""]
    if show_money:
        L += [f'目標まで（予定実績との差）{man(t["grossMan"] - tot["grossForecastMan"])}／'
              f'残り {f["remainingMonths"]}ヶ月　必要なペース 月 {man(need)}', ""]
    L.append("■ 担当者別")
    for m in d["members"]:
        g = m["grossTargetMan"]
        ct = f'{m["contracts"]}/{m["contractTarget"]}件' if m["contractTarget"] else f'{m["contracts"]}件'
        if show_money:
            gp = f'{man(m["grossMan"])}（目標 {man(g)}・達成 {pctv(m["grossMan"], g)}）' if g else f'{man(m["grossMan"])}（目標なし）'
        else:
            gp = f'達成 {pctv(m["grossMan"], g)}' if g else "目標なし"
        L.append(f'・{m["name"]}（{m["role"]}）　粗利 {gp}　契約 {ct}')
    L += ["", "■ 今週の申し送り"] + [f'・{n}' for n in notes_for(d, show_money)]
    L += ["", "添付の PDF（A3横）が正式版です。",
          f'株式会社スマートハウス　{"社外秘（社内限り）" if show_money else "社内限（金額は非表示）"}']
    return "\n".join(L)


def to_pdf(html_path, pdf_path):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        exe = None
        for c in ("/opt/pw-browsers/chromium",
                  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"):
            if pathlib.Path(c).exists():
                exe = c
                break
        b = pw.chromium.launch(executable_path=exe, args=["--no-sandbox"])
        pg = b.new_page()
        pg.goto(html_path.as_uri())
        pg.wait_for_timeout(2500)          # Web フォントの読み込み待ち
        pg.pdf(path=str(pdf_path), width="420mm", height="297mm",
               print_background=True, margin={k: "0" for k in ("top", "bottom", "left", "right")})
        b.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audience", choices=["kobayashi", "team"], default="kobayashi",
                    help="kobayashi=金額あり（小林さんあて）／team=金額なし（全員あて）")
    ap.add_argument("--data", default=str(ROOT / "data" / "fy5.json"))
    ap.add_argument("--no-pdf", action="store_true")
    a = ap.parse_args()

    d = json.loads(pathlib.Path(a.data).read_text(encoding="utf-8"))
    show_money = a.audience == "kobayashi"
    OUT.mkdir(exist_ok=True)
    tag = f'{d["asOf"]}_{a.audience}'

    dash_html, mail_h, mail_t = (dashboard(d, show_money), email_html(d, show_money),
                                 email_text(d, show_money))
    if not show_money:
        assert_no_money(dash_html, mail_h, mail_t)
    html = OUT / f"dashboard_{tag}.html"
    html.write_text(dash_html, encoding="utf-8")
    (OUT / f"mail_{tag}.html").write_text(mail_h, encoding="utf-8")
    (OUT / f"mail_{tag}.txt").write_text(mail_t, encoding="utf-8")
    made = [html.name, f"mail_{tag}.html", f"mail_{tag}.txt"]
    if not a.no_pdf:
        pdf = OUT / f"第5期_営業目標進捗_{d['asOf']}{'' if show_money else '_社内共有版'}.pdf"
        to_pdf(html, pdf)
        made.append(pdf.name)
    print("生成:", *made, sep="\n  ")


if __name__ == "__main__":
    sys.exit(main())
