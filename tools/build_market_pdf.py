#!/usr/bin/env python3
"""社内通知用「不動産仲介業者の最近の状況」の印刷用HTMLを組み立てる。

  python3 tools/build_market_pdf.py            # out/market-brief.html を書き出す

PDF への変換は Chromium の --print-to-pdf で行う（tools/README-pdf.md 参照）。
数値は data/brokers.json を参照元とし、社内配布向けに自社の数字は一切載せない。
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "out")

# --- 首都圏中古マンション 月次（東日本レインズ）------------------------
# 3月・4月は未取得。時間軸を正しく保つため空の枠として残す。
MONTHS = [
    ("2月", 2.1,   5458),
    ("3月", None,  None),
    ("4月", None,  None),
    ("5月", -3.4,  5067),
    ("6月", -1.3,  5208),
    ("7月", -8.6,  5267),
    ("8月", -10.5, 5129),
    ("9月", -22.7, 5111),
]

POS, NEG, GRID, INK, INK2, INK3 = "#2a78d6", "#e34948", "#e3e2dd", "#0b0b0b", "#52514e", "#8a8a84"


def bar_chart():
    """成約件数の前年同月比。ゼロを基準にした発散（プラス＝青／マイナス＝赤）。"""
    w, h = 660, 212
    pad_l, pad_r, pad_t, pad_b = 46, 10, 14, 26
    pw = w - pad_l - pad_r
    ph = h - pad_t - pad_b
    vmax, vmin = 5.0, -25.0
    slot = pw / len(MONTHS)
    bw = slot * 0.46

    def y(v):
        return pad_t + ph * (vmax - v) / (vmax - vmin)

    s = [f'<svg viewBox="0 0 {w} {h}" width="100%" role="img" '
         f'aria-label="首都圏中古マンション 成約件数の前年同月比">']
    # グリッド（控えめ）
    for g in (0, -5, -10, -15, -20, -25):
        yy = y(g)
        heavy = g == 0
        s.append(f'<line x1="{pad_l}" y1="{yy:.1f}" x2="{w-pad_r}" y2="{yy:.1f}" '
                 f'stroke="{INK3 if heavy else GRID}" stroke-width="{1.2 if heavy else 1}"/>')
        s.append(f'<text x="{pad_l-7}" y="{yy+3.5:.1f}" text-anchor="end" font-size="9.5" '
                 f'fill="{INK3}">{g:+d}%</text>' if not heavy else
                 f'<text x="{pad_l-7}" y="{yy+3.5:.1f}" text-anchor="end" font-size="9.5" '
                 f'fill="{INK2}">0%</text>')
    for i, (label, v, _) in enumerate(MONTHS):
        cx = pad_l + slot * (i + 0.5)
        s.append(f'<text x="{cx:.1f}" y="{h-8}" text-anchor="middle" font-size="10" '
                 f'fill="{INK2}">{label}</text>')
        if v is None:
            s.append(f'<text x="{cx:.1f}" y="{y(0)-6:.1f}" text-anchor="middle" font-size="9.5" '
                     f'fill="{INK3}">未取得</text>')
            continue
        col = POS if v > 0 else NEG
        y0, y1 = y(0), y(v)
        top, height = min(y0, y1), abs(y1 - y0)
        # データ側の端だけ丸める（基準線側は角のまま）
        r = 4
        if v > 0:
            path = (f'M{cx-bw/2:.1f},{y0:.1f} V{top+r:.1f} Q{cx-bw/2:.1f},{top:.1f} '
                    f'{cx-bw/2+r:.1f},{top:.1f} H{cx+bw/2-r:.1f} '
                    f'Q{cx+bw/2:.1f},{top:.1f} {cx+bw/2:.1f},{top+r:.1f} V{y0:.1f} Z')
            ty = top - 6
        else:
            bot = top + height
            path = (f'M{cx-bw/2:.1f},{y0:.1f} V{bot-r:.1f} Q{cx-bw/2:.1f},{bot:.1f} '
                    f'{cx-bw/2+r:.1f},{bot:.1f} H{cx+bw/2-r:.1f} '
                    f'Q{cx+bw/2:.1f},{bot:.1f} {cx+bw/2:.1f},{bot-r:.1f} V{y0:.1f} Z')
            ty = bot + 13
        s.append(f'<path d="{path}" fill="{col}"/>')
        s.append(f'<text x="{cx:.1f}" y="{ty:.1f}" text-anchor="middle" font-size="10.5" '
                 f'font-weight="600" fill="{INK}">{v:+.1f}</text>')
    s.append("</svg>")
    return "".join(s)


def line_chart():
    """成約平均価格。単一系列なので凡例は置かない（見出しが系列名）。"""
    w, h = 660, 180
    pad_l, pad_r, pad_t, pad_b = 46, 10, 20, 26
    pw = w - pad_l - pad_r
    ph = h - pad_t - pad_b
    vmax, vmin = 5600, 4900
    slot = pw / len(MONTHS)

    def y(v):
        return pad_t + ph * (vmax - v) / (vmax - vmin)

    s = [f'<svg viewBox="0 0 {w} {h}" width="100%" role="img" '
         f'aria-label="首都圏中古マンション 成約平均価格の推移">']
    for g in (5600, 5400, 5200, 5000):
        yy = y(g)
        s.append(f'<line x1="{pad_l}" y1="{yy:.1f}" x2="{w-pad_r}" y2="{yy:.1f}" '
                 f'stroke="{GRID}" stroke-width="1"/>')
        s.append(f'<text x="{pad_l-7}" y="{yy+3.5:.1f}" text-anchor="end" font-size="9.5" '
                 f'fill="{INK3}">{g:,}</text>')
    pts = [(pad_l + slot * (i + 0.5), y(v), lbl, v)
           for i, (lbl, _, v) in enumerate(MONTHS) if v is not None]
    # 3・4月が未取得なので線を途切れさせる（つなぐと誤解を生む）
    seg1, seg2 = pts[:1], pts[1:]
    if len(seg2) > 1:
        d = "M" + " L".join(f"{x:.1f},{yy:.1f}" for x, yy, _, _ in seg2)
        s.append(f'<path d="{d}" fill="none" stroke="{POS}" stroke-width="2" '
                 f'stroke-linejoin="round"/>')
    gx1, gy1 = seg1[0][0], seg1[0][1]
    gx2, gy2 = seg2[0][0], seg2[0][1]
    s.append(f'<line x1="{gx1:.1f}" y1="{gy1:.1f}" x2="{gx2:.1f}" y2="{gy2:.1f}" '
             f'stroke="{POS}" stroke-width="2" stroke-dasharray="3 4" opacity="0.5"/>')
    for i, (label, _, v) in enumerate(MONTHS):
        cx = pad_l + slot * (i + 0.5)
        s.append(f'<text x="{cx:.1f}" y="{h-8}" text-anchor="middle" font-size="10" '
                 f'fill="{INK2}">{label}</text>')
    for x, yy, lbl, v in pts:
        s.append(f'<circle cx="{x:.1f}" cy="{yy:.1f}" r="4.5" fill="{POS}" '
                 f'stroke="#ffffff" stroke-width="2"/>')
    for x, yy, lbl, v in (pts[0], pts[1], pts[-1]):
        s.append(f'<text x="{x:.1f}" y="{yy-11:.1f}" text-anchor="middle" font-size="10.5" '
                 f'font-weight="600" fill="{INK}">{v:,}</text>')
    s.append("</svg>")
    return "".join(s)


HTML = """<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<title>不動産仲介業者の最近の状況</title>
<style>
@page {{ size: A4; margin: 0; }}
* {{ box-sizing: border-box; }}
html, body {{ margin: 0; padding: 0; }}
body {{
  font-family: "IPAPGothic", "IPAGothic", sans-serif;
  color: #0b0b0b; background: #ffffff;
  font-size: 10.2pt; line-height: 1.62;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}}
.page {{ width: 210mm; height: 297mm; padding: 15mm 16mm 16mm; position: relative;
         overflow: hidden; page-break-after: always; break-after: page; }}
.page:last-child {{ page-break-after: auto; break-after: auto; }}
h1 {{ font-size: 19pt; margin: 0 0 2mm; letter-spacing: .01em; }}
.sub {{ color: #52514e; font-size: 9.4pt; margin: 0 0 1mm; }}
.rule {{ height: 3px; background: #184f95; margin: 3mm 0 5mm; }}
h2 {{ font-size: 12.4pt; margin: 6mm 0 2.5mm; padding: 1.4mm 0 1.4mm 3mm;
      border-left: 4px solid #184f95; }}
h2:first-child {{ margin-top: 0; }}
p {{ margin: 0 0 2.2mm; }}
.lead {{ background: #f2f6fb; border: 1px solid #d6e3f2; border-radius: 3px;
         padding: 4mm 5mm; margin-bottom: 5mm; }}
.lead ol {{ margin: 0; padding-left: 6mm; }}
.lead li {{ margin-bottom: 2.4mm; }}
.lead li:last-child {{ margin-bottom: 0; }}
.lead b {{ color: #11365f; }}
table {{ border-collapse: collapse; width: 100%; font-size: 9.2pt; margin: 2mm 0 1mm; }}
th, td {{ border: 1px solid #d8d7d1; padding: 1.4mm 2mm; }}
th {{ background: #eef2f7; text-align: left; font-weight: 600; }}
td.n, th.n {{ text-align: right; white-space: nowrap; }}
tr.hl td {{ background: #fafcff; }}
.note {{ font-size: 8.4pt; color: #52514e; line-height: 1.5; margin-top: 1.5mm; }}
.chart {{ background: #fcfcfb; border: 1px solid #e3e2dd; border-radius: 3px;
          padding: 3mm 3mm 1mm; margin-bottom: 2.5mm; }}
.chart .cap {{ font-size: 9.6pt; font-weight: 600; margin: 0 0 1mm; }}
.chart .key {{ font-size: 8.5pt; color: #52514e; margin: 0 0 1.5mm; }}
.sw {{ display: inline-block; width: 8px; height: 8px; border-radius: 2px;
       vertical-align: -1px; margin-right: 2px; }}
.grid2 {{ display: grid; grid-template-columns: 1fr 1fr; gap: 5mm; }}
.box {{ border: 1px solid #d8d7d1; border-radius: 3px; padding: 3mm 3.5mm; }}
.box h4 {{ margin: 0 0 1.5mm; font-size: 10pt; color: #184f95; }}
.box p {{ margin: 0; font-size: 9.3pt; }}
.pt {{ margin-bottom: 3.4mm; }}
.pt b {{ display: block; font-size: 10.3pt; color: #11365f; }}
.foot {{ position: absolute; bottom: 8mm; left: 16mm; right: 16mm;
         border-top: 1px solid #e3e2dd; padding-top: 2mm;
         font-size: 8pt; color: #8a8a84; display: flex; justify-content: space-between; }}
.tag {{ display: inline-block; background: #184f95; color: #fff; font-size: 8pt;
        padding: .6mm 2mm; border-radius: 2px; vertical-align: 1.5px; }}
.warn {{ background: #fffaf0; border: 1px solid #f0dcb4; border-radius: 3px;
         padding: 3mm 4mm; font-size: 9pt; color: #52514e; }}
</style></head><body>

<div class="page">
  <h1>不動産仲介業者の最近の状況</h1>
  <p class="sub">2026年10月30日 作成　／　<span class="tag">社内資料</span></p>
  <div class="rule"></div>

  <div class="lead">
    <ol>
      <li><b>大手の決算は過去最高でした。ただしそれは2026年3月期＝半年以上前の数字です。</b><br>
      大手21社のうち17社が手数料収入を増やし、7社は2桁の伸びでした。</li>
      <li><b>足元の市場は明確に転換しています。</b><br>
      首都圏の中古マンションは成約件数が6か月連続で減り、9月は前年同月比▲22.7%。
      成約坪単価も5か月連続で下落しました。</li>
      <li><b>大手は「件数より単価」に軸を移し、店舗を選別し、買取の機能を持ち、
      売買仲介に事業を絞り込んでいます。</b></li>
    </ol>
  </div>

  <h2>1. 首都圏 中古マンションの動き</h2>

  <div class="chart">
    <p class="cap">成約件数の前年同月比（％）</p>
    <p class="key"><span class="sw" style="background:{POS}"></span>前年を上回る　
      <span class="sw" style="background:{NEG}"></span>前年を下回る
      　／　各棒に数値を直接表示しています</p>
    {BAR}
  </div>
  <div class="chart">
    <p class="cap">成約平均価格の推移（万円）</p>
    <p class="key">3月・4月は数値を取得できていないため、線を途切れさせています（点線は参考）</p>
    {LINE}
  </div>
  <p class="note">出所：東日本不動産流通機構（東日本レインズ）月例速報 Market Watch。
  7月・8月・9月は公表値を報道・解説サイト経由で確認したものです。</p>
  <p style="margin-top:4mm">2月の時点では件数も価格もプラスでした。
  5月に成約坪単価が73か月ぶりに下落して以降は一方向で、
  9月は件数が前年同月比▲22.7%、坪単価▲4.8%。東京都区部の㎡単価も8月に
  76か月ぶりの下落に転じ、9月も続落しています。</p>

  <div class="foot"><span>不動産仲介業者の最近の状況（2026年10月30日）</span><span>1 / 5</span></div>
</div>

<div class="page">
  <h2>2. 市場の全体像（数字）</h2>
  <table>
    <tr><th style="width:26%">項目</th><th>直近の数字</th><th style="width:30%">読み方</th></tr>
    <tr><td>中古マンション<br>成約件数（首都圏）</td>
        <td>2026年9月 3,457件（前年同月比 <b>▲22.7%</b>）<br>6か月連続の減少で、減少幅は拡大</td>
        <td>前年9月が4,475件（+46.9%）と高かった反動もありますが、
            単価まで下がっているので反動だけでは説明がつきません</td></tr>
    <tr class="hl"><td>中古マンション<br>成約坪単価</td>
        <td>267.5万円（<b>▲4.8%</b>）／5か月連続の下落<br>
            東京都区部の㎡単価は8月に<b>76か月ぶり</b>の下落に転じ、9月も続落</td>
        <td>約6年4か月ぶりの方向転換です</td></tr>
    <tr><td>新築マンション<br>（首都圏）</td>
        <td>2026年度上半期の平均 <b>1億1,494万円</b>（+21.1%）＝調査開始（1973年）以来、
            半期で初の1億円超。一方で発売は8,601戸（▲6.0%）</td>
        <td>建築費の高騰を価格に乗せ、戸数を絞って高く売る形に変わっています</td></tr>
    <tr class="hl"><td>金利</td>
        <td>日銀の政策金利は2026年6月に1.00%、9月18日に<b>1.25%</b>程度へ。
            フラット35は<b>3.83%</b>で集計開始以来の最高</td>
        <td>すでに借りている変動金利の方の返済額増加は、
            多くの銀行で<b>2027年4月</b>から本格化します</td></tr>
    <tr><td>業界の倒産</td>
        <td>不動産代理・仲介業の倒産は2026年1〜8月で<b>86件</b>。
            過去最多だった2025年通年133件に迫るペース</td>
        <td>大手は増収、中小は倒産増という二極化が進んでいます</td></tr>
    <tr class="hl"><td>中古戸建</td>
        <td>8月の成約1,641件（+1.9%）、成約価格は+1.7%で<b>8か月連続の上昇</b></td>
        <td>マンションだけが崩れており、戸建ては底堅いままです</td></tr>
  </table>
  <p class="note">出所：東日本レインズ、不動産経済研究所（新築マンション市場動向）、
  日本銀行・住宅金融支援機構、帝国データバンク。</p>

  <h2>3. 大手7社の実績（2025年度／2026年3月期）</h2>
  <table>
    <tr><th>会社</th><th class="n">取扱件数</th><th class="n">取扱高</th>
        <th class="n">手数料収入</th><th class="n">店舗</th><th class="n">人員</th></tr>
    <tr><td>三井不動産リアルティG（三井のリハウス）</td><td class="n">36,220件<br>（▲4.9%）</td>
        <td class="n">—</td><td class="n">過去最高<br>（金額未公表）</td><td class="n">269店</td>
        <td class="n">4,605名</td></tr>
    <tr class="hl"><td>東急リバブル</td><td class="n">33,922件<br>（+3.0%）</td>
        <td class="n">2兆5,635億円</td><td class="n">1,093億円<br>（+12%）</td><td class="n">232拠点</td>
        <td class="n">4,052名</td></tr>
    <tr><td>住友不動産ステップ（旧・住友不動産販売）</td><td class="n">28,848件<br>（▲2,155件）</td>
        <td class="n">1兆4,885億円</td><td class="n">754億円</td><td class="n">—<br>（1年で36店減）</td>
        <td class="n">3,060名</td></tr>
    <tr class="hl"><td>野村不動産ソリューションズ（野村の仲介＋）</td><td class="n">—</td>
        <td class="n">—</td><td class="n">643億円</td><td class="n">94店</td><td class="n">2,120名</td></tr>
    <tr><td>三菱UFJ不動産販売</td><td class="n">—</td><td class="n">—</td><td class="n">—</td>
        <td class="n">37店</td><td class="n">1,039名</td></tr>
    <tr class="hl"><td>大京穴吹不動産</td><td class="n">4,366件</td><td class="n">—</td>
        <td class="n">—</td><td class="n">61店</td><td class="n">1,287名</td></tr>
    <tr><td>大成有楽不動産販売</td><td class="n">—</td><td class="n">1,204億円</td>
        <td class="n">—</td><td class="n">24店</td><td class="n">358名</td></tr>
  </table>
  <p class="note">人員は各社の会社概要・採用情報による（2026年3月末〜4月時点。大京穴吹は2025年6月）。
  「—」は公表されていない、または確認できていない項目で、推測では埋めていません。</p>

  <div class="foot"><span>不動産仲介業者の最近の状況（2026年10月30日）</span><span>2 / 5</span></div>
</div>

<div class="page">
  <h2>4. 取扱件数の5年推移（件）</h2>
  <table>
    <tr><th>会社</th><th class="n">FY2021</th><th class="n">FY2022</th><th class="n">FY2023</th>
        <th class="n">FY2024</th><th class="n">FY2025</th><th class="n">5年の変化</th></tr>
    <tr><td>三井のリハウス</td><td class="n">41,183</td><td class="n">39,106</td>
        <td class="n">38,680</td><td class="n">38,103</td><td class="n">36,220</td>
        <td class="n" style="color:{NEG}">▲12.1%</td></tr>
    <tr class="hl"><td>東急リバブル</td><td class="n">—</td><td class="n">29,577</td>
        <td class="n">—</td><td class="n">32,918</td><td class="n">33,922</td>
        <td class="n" style="color:{POS}">+14.7%</td></tr>
    <tr><td>住友ステップ</td><td class="n">—</td><td class="n">34,906</td><td class="n">—</td>
        <td class="n">31,003</td><td class="n">28,848</td>
        <td class="n" style="color:{NEG}">▲17.4%</td></tr>
  </table>
  <p class="note">東急・住友の5年の変化はFY2022との比較。三井のFY2020は38,507件。
  件数首位の三井が5年で1割以上減らす一方、東急リバブルだけが件数を伸ばしています。</p>

  <h2>5. 体制のちがい</h2>
  <div class="grid2">
    <div class="box"><h4>店舗を絞る会社は1拠点が厚い</h4>
      <p>三菱UFJ 約28名／37店<br>野村 約23名／94店<br>大京穴吹 約21名／61店<br>
      三井 約17名／269店<br>東急リバブル 約17名／232拠点<br>大成有楽 約15名／24店</p></div>
    <div class="box"><h4>店舗網の方針は正反対</h4>
      <p>三井は277→269店へ統廃合、住友は1年で36店減。
      一方で東急リバブルは出店を続け、9月に白金高輪センターを移転、
      10月に明石センターを新規開設しました。<br><br>
      前の2社は「1人あたりの生産性」、東急は「面を取ってシェアを広げる」を選んでいます。</p></div>
  </div>

  <h2>6. 利益の出方</h2>
  <table>
    <tr><th>会社（仲介事業ないし相当セグメント）</th><th class="n">売上</th><th class="n">利益</th></tr>
    <tr><td>東急リバブル（不動産流通セグメント）</td><td class="n">3,647億円</td>
        <td class="n">営業利益 644億円</td></tr>
    <tr class="hl"><td>三井不動産リアルティ（単体）</td><td class="n">2,105億円</td>
        <td class="n">未公表（前年度は319.5億円）</td></tr>
    <tr><td>大京穴吹不動産（単体）</td><td class="n">832億円</td><td class="n">純利益 21.2億円</td></tr>
    <tr class="hl"><td>住友不動産 ステップ事業</td><td class="n">754億円</td>
        <td class="n">営業利益 236.0億円（利益率 <b>31.3%</b>）</td></tr>
    <tr><td>野村不動産HD 仲介・CRE</td><td class="n">643億円</td>
        <td class="n">営業利益 189億円</td></tr>
    <tr class="hl"><td>三菱UFJ不動産販売（単体）</td><td class="n">前年度 258億円</td>
        <td class="n">純利益 87.6億円</td></tr>
  </table>
  <p class="note">住友は取扱件数を2,155件減らし店舗も36店減らしながら、営業利益は前年比+21.0%で
  過去最高でした。東急リバブルの仲介事業の営業利益は5年前の約3.8倍です。
  記載した金額はすべて各社が公表している公開情報です。</p>

  <div class="foot"><span>不動産仲介業者の最近の状況（2026年10月30日）</span><span>3 / 5</span></div>
</div>

<div class="page">
  <h2>7. 大手は何を基準に動いているか</h2>
  <div class="warn">以下は各社が方針として公表したものではなく、
  公表された実績と実際の打ち手から読み取った解釈です。断定ではありません。</div>

  <div style="margin-top:4mm">
    <div class="pt"><b>① 件数ではなく単価で評価している</b>
      上位3社すべてが2025年度に取扱件数を落としながら手数料収入を伸ばしました。
      三井は件数▲4.9%で手数料が過去最高、住友は件数▲2,155件で営業利益+21.0%。
      「何件さばいたか」から「1件でいくら取れたか」へ、評価の軸が移っています。</div>

    <div class="pt"><b>② 店舗網の扱いで方針が真っ二つ</b>
      三井は統廃合して高単価エリアに人員を集中、住友も店舗を減らしました。
      対して東急リバブルは出店を継続。
      2025年度の結果だけ見れば、出店を続けた東急が通期で初の業界首位を取りました。</div>

    <div class="pt"><b>③ 仲介だけでは回らないと見て、買取に寄せている</b>
      住友は2026年4月時点で買取専門部署「ステップ買取エージェント」を
      首都圏5拠点・関西1拠点に設置しました。大京穴吹は売上832億円の相当部分が買取再販です。
      価格が下がる局面では売主が売り急がなくなり媒介が取りにくくなるため、
      自社で買う機能を持っておく、という判断です。</div>

    <div class="pt"><b>④ 事業を売買仲介に絞り込んでいる</b>
      住友は9月4日、賃貸仲介管理事業を会社分割して
      住友不動産の完全子会社「住友不動産住宅リース」へ承継すると発表しました（10月1日効力発生）。
      野村は10月1日付で流通事業本部に上野営業部を新設。
      儲かる事業に人と拠点を寄せ、周辺事業は切り出す動きです。</div>

    <div class="pt"><b>⑤ 高単価・法人・相続へ寄せている</b>
      三菱UFJは37店のまま、信託銀行の顧客基盤で資産家・法人の高額物件や相続案件に集中。
      野村も94店（大手3社の約3分の1）で高単価案件に絞っています。
      店舗を増やさずに取扱高を伸ばす形で、薄い案件は取りに行っていません。</div>

    <div class="pt"><b>⑥ 顧客満足度を前面に出し始めた</b>
      oriconの顧客満足度調査（不動産仲介・戸建て購入／10月6日配信）で
      東急リバブルが総合1位（7年ぶり4度目）、2位が三井のリハウス、3位が住友不動産ステップ。
      野村は売却マンション部門で首都圏1位（9月1日発表）。
      価格が下がり件数も減る局面では、値付けの強さより「選ばれる理由」を出す競争に寄っています。</div>

    <div class="pt"><b>⑦ ただし市況観そのものは慎重</b>
      三井不動産の植田社長は2026年の年頭所感で、
      米国の通商政策の影響と地政学リスクにより不確実性が残るとしています。
      各社の数字は強いものの、強気の投資宣言は出ていません。</div>
  </div>

  <div class="foot"><span>不動産仲介業者の最近の状況（2026年10月30日）</span><span>4 / 5</span></div>
</div>

<div class="page">
  <h2>8. 恵比寿・渋谷エリア</h2>
  <div class="grid2">
    <div class="box"><h4>成約ベース</h4>
      <p>渋谷区全体 198.6万円/㎡（坪656.6万円・前年比+4.5%）<br><br>
      恵比寿 190万円/㎡<br>恵比寿南 215万円/㎡<br>恵比寿西 182万円/㎡</p></div>
    <div class="box"><h4>売出ベースは逆に上がっている</h4>
      <p>恵比寿駅周辺 710万円/坪（前年比+11.5%）<br><br>
      恵比寿西 911万円/坪（+14.6%）<br>恵比寿南 840万円/坪（+7.5%）</p></div>
  </div>
  <p style="margin-top:4mm">首都圏全体の成約価格が5か月連続で下がっているのに、
  当エリアの<b>売出価格は上がっています</b>。
  売主の希望と、実際に売れる水準の差が開いている、ということです。
  この局面では、価格を追いかけて媒介を取るよりも、
  <b>売主に現実の成約水準を先に見せられるか</b>で結果が分かれます。</p>
  <p class="note">渋谷区の数字は2026年3月時点までの257件に基づく集計。
  売出ベースの坪単価は募集価格であり、成約価格ではありません。</p>

  <h2>9. 制度（確認事項）</h2>
  <p>2025年1月1日施行の宅地建物取引業法施行規則の改正により、
  レインズの取引状況（ステータス）を実態と一致させることが義務になっています。
  実際の販売状況と登録内容が違う場合は、宅建業法第65条第1項に基づく指示処分の対象です。</p>
  <p>両手仲介そのものは禁止されていません。他社の広告可否は現在も規制の対象外です。
  2026年の追加改正は確認できていません。</p>

  <h2>出典・注記</h2>
  <p class="note">
  三井不動産リアルティ ニュースリリース（2026年6月9日）／
  R.E.port「25年度仲介実績、東急リバブルが初の年間トップ」「初の手数料1,000億円超／東急リバブル26年3月期」
  「5期連続で経常最高益／住友不26年3月期」「過去最高業績を更新／野村不HD26年3月期」「2026年 年頭所感」／
  東急リバブル ニュースリリース・実績推移／東急不動産ホールディングス 業績予想／
  三井不動産 2026年3月期決算短信／住友不動産ステップ 会社情報／
  日本経済新聞「住友不動産ステップ、賃貸仲介管理事業を分社化」／
  野村不動産ホールディングス ニュースリリース（2026年9月18日）／
  公益財団法人 不動産流通推進センター「不動産業統計集［不動産流通］」／
  東日本不動産流通機構 月例速報 Market Watch／不動産経済研究所／NHK／
  帝国データバンク「不動産代理・仲介業の倒産動向（2026年1-8月）」／oricon ME 顧客満足度調査
  </p>
  <p class="note">
  年度の表記は会計年度です（FY2025 ＝ 2025年4月〜2026年3月 ＝ 2026年3月期）。
  記載した金額はすべて各社・業界団体・報道が公表している公開情報で、当社の数字は含みません。
  確認できていない項目は「—」のままとし、推測では埋めていません。
  一次資料のPDFを直接開けない環境で作成しているため、数値は複数の公表・報道情報を
  突き合わせて確認しています。
  </p>

  <div class="foot"><span>不動産仲介業者の最近の状況（2026年10月30日）</span><span>5 / 5</span></div>
</div>
</body></html>
"""


def main():
    os.makedirs(OUT, exist_ok=True)
    html = HTML.format(BAR=bar_chart(), LINE=line_chart(), POS=POS, NEG=NEG)
    path = os.path.join(OUT, "market-brief.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    print("wrote", path)


if __name__ == "__main__":
    main()
