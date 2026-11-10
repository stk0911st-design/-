#!/usr/bin/env python3
"""お客さま説明用 A3横2ページの市況資料をつくる。

  /usr/bin/python3.13 tools/build_customer_a3.py

reportlab に IPAPGothic を埋め込む方式。Chromium の --print-to-pdf だと
日本語が Type3 フォントで吐かれて700KB近くになり、メール添付やドライブ保存に
乗せられないため、こちらで作る。埋め込み subset なのでどの環境でも同じに見える。

載せてよい数字は各社・業界団体・報道が公表している公開情報のみ。自社の数字は入れない。
"""
import os
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A3, landscape
from reportlab.lib.colors import HexColor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "out")
FONT = "/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf"
# 既定は IPAPGothic を埋め込む（どの環境でも同じに見える／134KB前後）。
# BROKER_PDF_CID=1 で Adobe-Japan1 の CID フォント指定に切り替える。
# 字形を持たないぶん20KB台まで小さくなり、メール添付やドライブ保存に載せられる。
# 社内の日次PDFで使っている方式と同じ。
if os.environ.get("BROKER_PDF_CID") == "1":
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    pdfmetrics.registerFont(UnicodeCIDFont("HeiseiKakuGo-W5"))
    JPNAME = "HeiseiKakuGo-W5"
    # HeiseiKakuGo-W5 は IPAPGothic より字幅が最大11%広く、そのままだと枠からはみ出す。
    # 枠の位置は変えずに文字だけ1割縮めて、どちらの版も同じ体裁で収まるようにする。
    SCALE = 0.90
else:
    pdfmetrics.registerFont(TTFont("JP", FONT))
    JPNAME = "JP"
    SCALE = 1.0

W, H = landscape(A3)                 # 1190.55 x 841.89 pt
M = 38                               # 余白
NAVY   = HexColor("#13406e")
NAVY2  = HexColor("#1d5a98")
INK    = HexColor("#111111")
INK2   = HexColor("#4a4a46")
INK3   = HexColor("#8a8a84")
LINE   = HexColor("#d9d8d2")
PANEL  = HexColor("#f6f8fb")
PANEL2 = HexColor("#fbfaf7")
POS    = HexColor("#2a78d6")
NEG    = HexColor("#d84a49")
GRID   = HexColor("#e6e5e0")

# 首都圏中古マンション（東日本レインズ月例）。3月・4月は未取得。
MONTHS = [("2月", 2.1, 5458), ("3月", None, None), ("4月", None, None),
          ("5月", -3.4, 5067), ("6月", -1.3, 5208), ("7月", -8.6, 5267),
          ("8月", -10.5, 5129), ("9月", -22.7, 5111)]


def t(c, x, y, s, size=9.5, color=INK, align="l", bold=False, leading=None):
    """IPAゴシックに太字の字形が無いので、太字はごく僅かにずらして重ね描きする。"""
    size *= SCALE
    c.setFillColor(color)
    c.setFont(JPNAME, size)
    w = c.stringWidth(s, JPNAME, size)
    xx = x - w if align == "r" else (x - w / 2 if align == "c" else x)
    c.drawString(xx, y, s)
    if bold:
        d = max(0.22, size * 0.023)
        for dx, dy in ((d, 0), (0, d * 0.5), (d, d * 0.5)):
            c.drawString(xx + dx, y + dy, s)
    return w


def wrap(c, x, y, s, size, width, color=INK, leading=None, bold=False):
    """日本語をぶら下げなしで折り返す。戻り値は使った高さ。"""
    size *= SCALE
    lead = leading or size * 1.65
    line, yy = "", y
    for ch in s:
        if ch == "\n":
            t(c, x, yy, line, size / SCALE, color, bold=bold); line = ""; yy -= lead; continue
        if c.stringWidth(line + ch, JPNAME, size) > width and line:
            t(c, x, yy, line, size / SCALE, color, bold=bold); line = ch; yy -= lead
        else:
            line += ch
    if line:
        t(c, x, yy, line, size / SCALE, color, bold=bold); yy -= lead
    return y - yy


def panel(c, x, y, w, h, fill=PANEL2, stroke=LINE, r=4):
    c.setFillColor(fill); c.setStrokeColor(stroke); c.setLineWidth(0.7)
    c.roundRect(x, y, w, h, r, stroke=1, fill=1)


def head(c, x, y, w, label, size=12):
    """見出し：左に濃紺の縦棒。"""
    c.setFillColor(NAVY); c.rect(x, y - 1, 3.4, size * 1.18, stroke=0, fill=1)
    t(c, x + 9, y + 2, label, size, NAVY, bold=True)
    return size * 1.3


def page_header(c, title, sub):
    c.setFillColor(NAVY); c.rect(0, H - 66, W, 66, stroke=0, fill=1)
    t(c, M, H - 40, title, 21, HexColor("#ffffff"), bold=True)
    t(c, M, H - 57, sub, 9.5, HexColor("#b9cde4"))
    t(c, W - M, H - 34, "株式会社スマートハウス", 11, HexColor("#ffffff"), align="r")
    t(c, W - M, H - 50, "2026年11月10日 作成", 8.5, HexColor("#b9cde4"), align="r")


def page_footer(c, n):
    c.setStrokeColor(LINE); c.setLineWidth(0.7)
    c.line(M, 30, W - M, 30)
    t(c, M, 19, "出典：東日本不動産流通機構（レインズ）／不動産経済研究所／不動産流通推進センター／"
                "帝国データバンク／日本銀行・住宅金融支援機構／各社IR・ニュースリリース", 7.6, INK3)
    t(c, W - M, 19, f"{n} / 2", 8, INK3, align="r")


def bar_chart(c, x, y, w, h):
    """成約件数の前年同月比。0を基準に、プラス青・マイナス赤。"""
    pl, pt_, pb = 30, 14, 20
    pw, ph = w - pl - 6, h - pt_ - pb
    vmax, vmin = 5.0, -25.0
    slot = pw / len(MONTHS)
    yy = lambda v: y + pb + ph * (v - vmin) / (vmax - vmin)
    for g in (0, -5, -10, -15, -20, -25):
        gy = yy(g)
        c.setStrokeColor(INK3 if g == 0 else GRID)
        c.setLineWidth(0.9 if g == 0 else 0.5)
        c.line(x + pl, gy, x + w - 6, gy)
        t(c, x + pl - 4, gy - 2.6, f"{g:+d}%" if g else "0%", 6.8, INK3, align="r")
    for i, (lab, v, _) in enumerate(MONTHS):
        cx = x + pl + slot * (i + 0.5)
        t(c, cx, y + 7, lab, 7.2, INK2, align="c")
        if v is None:
            t(c, cx, yy(0) + 5, "–", 7.2, INK3, align="c"); continue
        bw = slot * 0.5
        y0, y1 = yy(0), yy(v)
        c.setFillColor(POS if v > 0 else NEG)
        c.roundRect(cx - bw / 2, min(y0, y1), bw, abs(y1 - y0), 2.2, stroke=0, fill=1)
        ty = max(y0, y1) + 3.5 if v > 0 else min(y0, y1) - 8.5
        t(c, cx, ty, f"{v:+.1f}", 7.4, INK, align="c", bold=True)


def line_chart(c, x, y, w, h):
    """成約平均価格。単一系列なので凡例は置かない。"""
    pl, pt_, pb = 34, 16, 20
    pw, ph = w - pl - 6, h - pt_ - pb
    vmax, vmin = 5600, 4950
    slot = pw / len(MONTHS)
    yy = lambda v: y + pb + ph * (v - vmin) / (vmax - vmin)
    for g in (5600, 5400, 5200, 5000):
        gy = yy(g)
        c.setStrokeColor(GRID); c.setLineWidth(0.5); c.line(x + pl, gy, x + w - 6, gy)
        t(c, x + pl - 4, gy - 2.6, f"{g:,}", 6.8, INK3, align="r")
    pts = [(x + pl + slot * (i + 0.5), yy(v), v)
           for i, (_, _, v) in enumerate(MONTHS) if v is not None]
    c.setStrokeColor(POS); c.setLineWidth(1.7)
    for a, b in zip(pts[1:], pts[2:]):
        c.line(a[0], a[1], b[0], b[1])
    c.setDash(2, 3); c.setLineWidth(1.1); c.setStrokeColor(HexColor("#9cc2ee"))
    c.line(pts[0][0], pts[0][1], pts[1][0], pts[1][1]); c.setDash()
    for i, (lab, _, _) in enumerate(MONTHS):
        t(c, x + pl + slot * (i + 0.5), y + 7, lab, 7.2, INK2, align="c")
    for px, py, v in pts:
        c.setFillColor(HexColor("#ffffff")); c.setStrokeColor(POS); c.setLineWidth(1.6)
        c.circle(px, py, 3.1, stroke=1, fill=1)
    for px, py, v in (pts[0], pts[-1]):
        t(c, px, py + 7, f"{v:,}", 7.4, INK, align="c", bold=True)


def table(c, x, y, w, cols, rows, head_h=22, row_h=30):
    """cols: [(見出し, 幅比, 寄せ)]  rows: [[セル, ...]]"""
    total = sum(cw for _, cw, _ in cols)
    xs, acc = [], x
    for _, cw, _ in cols:
        xs.append(acc); acc += w * cw / total
    xs.append(x + w)
    c.setFillColor(HexColor("#e9eff6")); c.rect(x, y - head_h, w, head_h, stroke=0, fill=1)
    for i, (label, _, al) in enumerate(cols):
        cx = xs[i] + 7 if al == "l" else xs[i + 1] - 7
        t(c, cx, y - head_h + 7.5, label, 8.6, NAVY, align=("l" if al == "l" else "r"), bold=True)
    yy = y - head_h
    for r, row in enumerate(rows):
        if r % 2:
            c.setFillColor(PANEL2); c.rect(x, yy - row_h, w, row_h, stroke=0, fill=1)
        c.setStrokeColor(LINE); c.setLineWidth(0.5); c.line(x, yy, x + w, yy)
        for i, cell in enumerate(row):
            al = cols[i][2]
            cx = xs[i] + 7 if al == "l" else xs[i + 1] - 7
            parts = cell.split("\n")
            ty = yy - row_h + (row_h - (len(parts) - 1) * 9.4) / 2 - 2.6
            for j, p in enumerate(reversed(parts)):
                size = 9.2 if j == len(parts) - 1 else 7.6
                col = INK if j == len(parts) - 1 else INK3
                t(c, cx, ty + j * 9.4, p, size, col, align=("l" if al == "l" else "r"))
        yy -= row_h
    c.setStrokeColor(LINE); c.line(x, yy, x + w, yy)
    return y - yy


# ───────────────────────── 1ページ目 ─────────────────────────
def page1(c):
    page_header(c, "いまの不動産市場", "首都圏・恵比寿エリアの状況　／　2026年11月")

    y = H - 66 - 26
    panel(c, M, y - 30, W - 2 * M, 30, PANEL, HexColor("#cfdded"))
    t(c, M + 14, y - 19,
      "2026年に入り、首都圏の中古マンション市場は方向が変わりました。"
      "価格が上がり続けた局面から、成約件数・単価ともに調整に入っています。",
      11.5, NAVY, bold=True)

    top = y - 44
    colw = (W - 2 * M - 2 * 20) / 3
    c1, c2, c3 = M, M + colw + 20, M + 2 * (colw + 20)
    bottom_band_h = 110
    month_h = 168
    colh = 335

    # 左：中古マンション（首都圏）
    panel(c, c1, top - colh, colw, colh)
    yy = top - 20
    head(c, c1 + 12, yy, colw - 24, "中古マンション（首都圏）")
    yy -= 22
    t(c, c1 + 12, yy, "成約件数の前年同月比", 9, INK2)
    yy -= 8
    bar_chart(c, c1 + 6, yy - 150, colw - 12, 150)
    yy -= 162
    lx = c1 + 12
    c.setFillColor(POS); c.rect(lx, yy + 0.3, 6, 6, stroke=0, fill=1)
    lx += 9 + t(c, lx + 9, yy, "前年を上回る", 7.4, INK3) + 12
    c.setFillColor(NEG); c.rect(lx, yy + 0.3, 6, 6, stroke=0, fill=1)
    lx += 9 + t(c, lx + 9, yy, "前年を下回る", 7.4, INK3) + 12
    t(c, lx, yy, "（3月・4月は数値を取得できていません）", 7.4, INK3)
    yy -= 20
    for label, val, note in (
            ("成約件数（9月）", "3,457件", "前年同月比 ▲22.7%／6か月連続の減少"),
            ("成約坪単価（9月）", "267.5万円", "前年同月比 ▲4.8%／5か月連続の下落"),
            ("東京都区部の㎡単価", "8月に下落へ", "約6年4か月ぶりの方向転換。9月も続落")):
        t(c, c1 + 12, yy, label, 8.4, INK2)
        t(c, c1 + colw - 12, yy, val, 12, NAVY, align="r", bold=True)
        yy -= 12
        t(c, c1 + 12, yy, note, 7.6, INK3)
        yy -= 17

    # 中央：価格の推移 ＋ 新築 ＋ 金利
    panel(c, c2, top - colh, colw, colh)
    yy = top - 20
    head(c, c2 + 12, yy, colw - 24, "成約価格の推移と、周辺の動き")
    yy -= 22
    t(c, c2 + 12, yy, "中古マンション 成約平均価格（万円）", 9, INK2)
    yy -= 8
    line_chart(c, c2 + 6, yy - 132, colw - 12, 132)
    yy -= 146
    c.setStrokeColor(LINE); c.setLineWidth(0.6); c.line(c2 + 12, yy, c2 + colw - 12, yy)
    yy -= 16
    t(c, c2 + 12, yy, "新築マンション（首都圏）", 9.4, NAVY, bold=True)
    yy -= 14
    yy -= wrap(c, c2 + 12, yy,
               "2026年度上半期の平均価格は1億1,494万円（前年同期比+21.1%）。"
               "1973年の調査開始以来、半期で初めて1億円を超えました。"
               "一方で発売戸数は8,601戸（▲6.0%）。建築費の高騰を価格に乗せ、"
               "戸数を絞って売る形に変わっています。", 8.2, colw - 24, INK2) - 4
    c.setStrokeColor(LINE); c.line(c2 + 12, yy, c2 + colw - 12, yy)
    yy -= 16
    t(c, c2 + 12, yy, "金利", 9.4, NAVY, bold=True)
    yy -= 14
    for k, v in (("日本銀行の政策金利", "1.25%程度（2026年9月）"),
                 ("フラット35", "3.83%（集計開始以来の最高）")):
        t(c, c2 + 12, yy, k, 8.2, INK2)
        t(c, c2 + colw - 12, yy, v, 8.6, INK, align="r")
        yy -= 13
    yy -= 2
    wrap(c, c2 + 12, yy,
         "すでに変動金利で借りている方の返済額は、多くの銀行で2027年4月から"
         "増える見込みです。", 8.2, colw - 24, INK2)

    # 右：恵比寿・渋谷
    panel(c, c3, top - colh, colw, colh)
    yy = top - 20
    head(c, c3 + 12, yy, colw - 24, "恵比寿・渋谷エリア")
    yy -= 26
    t(c, c3 + 12, yy, "成約ベース（実際に売れた価格）", 9.4, NAVY, bold=True)
    yy -= 16
    for k, v in (("渋谷区全体", "坪 656.6万円（+4.5%）"),
                 ("恵比寿", "190万円/㎡"), ("恵比寿南", "215万円/㎡"),
                 ("恵比寿西", "182万円/㎡")):
        t(c, c3 + 12, yy, k, 8.6, INK2)
        t(c, c3 + colw - 12, yy, v, 9, INK, align="r")
        yy -= 15
    yy -= 6
    c.setStrokeColor(LINE); c.setLineWidth(0.6); c.line(c3 + 12, yy, c3 + colw - 12, yy)
    yy -= 18
    t(c, c3 + 12, yy, "売出ベース（売り出し中の価格）", 9.4, NAVY, bold=True)
    yy -= 16
    for k, v in (("恵比寿駅周辺", "坪 710万円（+11.5%）"),
                 ("恵比寿西", "坪 911万円（+14.6%）"),
                 ("恵比寿南", "坪 840万円（+7.5%）")):
        t(c, c3 + 12, yy, k, 8.6, INK2)
        t(c, c3 + colw - 12, yy, v, 9, INK, align="r")
        yy -= 15
    yy -= 10
    bh = 86
    panel(c, c3 + 10, yy - bh, colw - 20, bh, HexColor("#fff8ec"), HexColor("#ecd9b4"))
    t(c, c3 + 22, yy - 20, "ここが今いちばん大事な点です", 9.6, HexColor("#8a5a12"), bold=True)
    wrap(c, c3 + 22, yy - 36,
         "売り出し価格は上がっていますが、実際に成約した価格は首都圏全体で"
         "5か月連続で下がっています。「希望する価格」と「売れる価格」の差が"
         "開いている局面です。", 8.2, colw - 44, HexColor("#6b4a14"))

    # 中段：月ごとの推移
    my = top - colh - 16
    panel(c, M, my - month_h, W - 2 * M, month_h)
    head(c, M + 14, my - 22, W - 2 * M - 28, "首都圏 中古マンション　月ごとの推移")
    mrows = [
        ("成約件数", ["4,241件", "—", "—", "3,709件", "—", "3,638件", "3,180件", "3,457件"]),
        ("前年同月比", ["+2.1%", "—", "—", "▲3.4%", "▲1.3%", "▲8.6%", "▲10.5%", "▲22.7%"]),
        ("成約平均価格", ["5,458万円", "—", "—", "5,067万円", "5,208万円", "5,267万円",
                      "5,129万円", "5,111万円"]),
    ]
    lblw = 96
    cellw = (W - 2 * M - 28 - lblw) / 8
    hy = my - 44
    c.setFillColor(HexColor("#e9eff6"))
    c.rect(M + 14 + lblw, hy - 4, cellw * 8, 20, stroke=0, fill=1)
    for i, (lab, _, _) in enumerate(MONTHS):
        t(c, M + 14 + lblw + cellw * (i + 0.5), hy + 2, f"2026年{lab}", 8.4, NAVY,
          align="c", bold=True)
    ry = hy - 12
    for r, (name, vals) in enumerate(mrows):
        if r % 2 == 0:
            c.setFillColor(PANEL2)
            c.rect(M + 14, ry - 22, W - 2 * M - 28, 22, stroke=0, fill=1)
        t(c, M + 14 + 6, ry - 15, name, 8.8, INK2)
        for i, v in enumerate(vals):
            neg = v.startswith("▲")
            t(c, M + 14 + lblw + cellw * (i + 0.5), ry - 15, v, 9.4,
              NEG if neg else (INK3 if v == "—" else INK), align="c", bold=not neg and v != "—")
        ry -= 22
    t(c, M + 14 + 6, ry - 13,
      "中古戸建は8月の成約が1,641件（前年同月比+1.9%）、成約価格は+1.7%で8か月連続の上昇です。"
      "マンションと戸建で動きが分かれています。", 8.2, INK2)

    # 下帯：3点
    by = my - month_h - 14
    panel(c, M, by - bottom_band_h, W - 2 * M, bottom_band_h, PANEL, HexColor("#cfdded"))
    t(c, M + 16, by - 21, "いま、売るとき・買うときに押さえておきたい3点", 12, NAVY, bold=True)
    tw = (W - 2 * M - 32 - 2 * 18) / 3
    for i, (ttl, body) in enumerate((
            ("① 売るとき",
             "売り出し価格の相場ではなく、成約価格の相場で判断します。"
             "両者の差が開いている局面では、高く出しても動かないことがあります。"),
            ("② 買うとき",
             "金利は上がっています。借入額だけでなく、"
             "2027年4月から返済額が変わる可能性もあわせてご確認ください。"),
            ("③ 物件によって差があります",
             "中古マンションは調整に入っていますが、"
             "中古戸建は8か月連続で価格が上がっています。市場は一律ではありません。"))):
        tx = M + 16 + i * (tw + 18)
        t(c, tx, by - 42, ttl, 10.2, NAVY2, bold=True)
        wrap(c, tx, by - 58, body, 8.4, tw, INK2)

    page_footer(c, 1)


# ───────────────────────── 2ページ目 ─────────────────────────
def page2(c):
    page_header(c, "大手仲介会社の実績", "2025年度（2025年4月〜2026年3月）　各社の公表値")

    y = H - 66 - 26
    wrap(c, M, y - 10,
         "ご参考までに、大手7社が公表している実績をまとめました。"
         "記載した数字はすべて、各社・業界団体・報道が公表している公開情報です。",
         10, W - 2 * M, INK2)

    y -= 36
    tw = W - 2 * M - 330
    cols = [("会社", 2.55, "l"), ("取扱件数", 1.0, "r"), ("取扱高", 1.05, "r"),
            ("売上", 1.0, "r"), ("店舗", 0.72, "r"), ("人員", 0.72, "r")]
    rows = [
        ["三井不動産リアルティグループ\n（三井のリハウス）", "36,220件\n前年比 ▲4.9%", "—",
         "2,105億円\n単体", "269店", "4,605名"],
        ["東急リバブル", "33,922件\n前年比 +3.0%", "2兆5,635億円\n3年連続1位",
         "3,647億円\nセグメント", "232拠点", "4,052名"],
        ["住友不動産ステップ\n（旧・住友不動産販売）", "28,848件\n前年比 ▲2,155件", "1兆4,885億円",
         "754億円\nステップ事業", "—\n1年で36店減", "3,060名"],
        ["野村不動産ソリューションズ\n（野村の仲介＋）", "—", "—", "643億円\n仲介・CRE", "94店", "2,120名"],
        ["三菱UFJ不動産販売", "—", "—", "258億円\n2024年度", "37店", "1,039名"],
        ["大京穴吹不動産", "4,366件", "—", "832億円\n買取再販を含む", "61店", "1,287名"],
        ["大成有楽不動産販売", "—", "1,204億円", "—", "24店", "358名"],
    ]
    used = table(c, M, y, tw, cols, rows, head_h=24, row_h=31)

    ny = y - used - 12
    ny -= wrap(c, M, ny,
               "※「—」は公表されていない、または確認できていない項目です。推測では埋めていません。"
               "売上は会社によって集計の範囲が異なります（グループのセグメント単位・単体・"
               "買取再販を含むなど）ので、規模の目安としてご覧ください。", 8, tw, INK3)

    # 取扱件数の5年推移
    ny -= 18
    head(c, M, ny, tw, "取扱件数の5年推移（件）", 11)
    ny -= 20
    years = ["2021年度", "2022年度", "2023年度", "2024年度", "2025年度", "5年の変化"]
    trend = [
        ("三井のリハウス", ["41,183", "39,106", "38,680", "38,103", "36,220", "▲12.1%"]),
        ("東急リバブル", ["—", "29,577", "—", "32,918", "33,922", "+14.7%"]),
        ("住友不動産ステップ", ["—", "34,906", "—", "31,003", "28,848", "▲17.4%"]),
    ]
    lblw2 = 150
    cw2 = (tw - lblw2) / len(years)
    c.setFillColor(HexColor("#e9eff6")); c.rect(M + lblw2, ny - 4, cw2 * len(years), 19, stroke=0, fill=1)
    for i, yr in enumerate(years):
        t(c, M + lblw2 + cw2 * (i + 0.5), ny + 2, yr, 8.2, NAVY, align="c", bold=True)
    ry = ny - 11
    for r, (name, vals) in enumerate(trend):
        if r % 2 == 0:
            c.setFillColor(PANEL2); c.rect(M, ry - 21, tw, 21, stroke=0, fill=1)
        t(c, M + 6, ry - 14.5, name, 8.8, INK2)
        for i, v in enumerate(vals):
            last = i == len(vals) - 1
            col = (NEG if v.startswith("▲") else POS) if last else (INK3 if v == "—" else INK)
            t(c, M + lblw2 + cw2 * (i + 0.5), ry - 14.5, v, 9.2, col, align="c",
              bold=last or (v != "—" and not last and i == len(vals) - 2))
        ry -= 21
    c.setStrokeColor(LINE); c.setLineWidth(0.5); c.line(M, ry, M + tw, ry)
    ry -= 14
    t(c, M, ry, "東急・住友の5年の変化は2022年度との比較です。三井のリハウスの2020年度は38,507件でした。",
      8, INK3)

    # ことばの説明
    ry -= 26
    head(c, M, ry, tw, "ことばの説明", 11)
    ry -= 22
    terms = [("取扱件数", "売買の仲介を成立させた件数です。"),
             ("取扱高", "仲介した物件の価格を合計した金額です。手数料の収入ではありません。"),
             ("手数料収入", "仲介の対価として実際に受け取った金額です。")]
    for k, v in terms:
        t(c, M + 6, ry, k, 9, NAVY2, bold=True)
        t(c, M + 96, ry, v, 8.6, INK2)
        ry -= 16

    # よくあるご質問
    ry -= 26
    head(c, M, ry, tw, "よくあるご質問", 11)
    ry -= 24
    qa = [
        ("いま売るのは不利でしょうか。",
         "一律には言えません。首都圏全体の中古マンションは調整に入っていますが、"
         "恵比寿・渋谷エリアの成約単価は前年を上回っています。中古戸建は8か月連続で上昇しています。"
         "ご所有の物件がどちらに近いかで、判断が変わります。"),
        ("待てば価格は戻りますか。",
         "先のことは分かりません。ただ、政策金利は2026年6月と9月に引き上げられ、"
         "変動金利で借りている方の返済額は2027年4月から増える見込みです。"
         "買う側の予算が下がる要因は、今のところ増えています。"),
        ("売り出し価格は高めに設定したほうがよいですか。",
         "いまは売り出し価格と成約価格の差が開いている局面です。高く出して反応がないまま"
         "時間が経つと、結果として値下げの回数が増えることがあります。"
         "近隣の成約事例をもとに決めることをおすすめします。"),
    ]
    for q, a in qa:
        t(c, M + 6, ry, "Q.", 9, NAVY2, bold=True)
        t(c, M + 22, ry, q, 9, NAVY2, bold=True)
        ry -= 15
        t(c, M + 6, ry, "A.", 8.6, INK3)
        ry -= wrap(c, M + 22, ry, a, 8.5, tw - 28, INK2) + 10

    # 右側：3つのポイント
    px = M + tw + 24
    pw_ = W - M - px
    ptop = y + 2
    ph_ = 330
    panel(c, px, ptop - ph_, pw_, ph_, PANEL, HexColor("#cfdded"))
    yy = ptop - 24
    t(c, px + 16, yy, "この表から読み取れること", 12.5, NAVY, bold=True)
    yy -= 26
    for ttl, body in (
            ("① 見る指標で順位が変わります",
             "取扱件数でいちばん多いのは三井のリハウスで、40年連続の1位です。"
             "一方、売上でいちばん大きいのは東急リバブル。"
             "同じ大手でも、稼ぎ方がそれぞれ違います。"),
            ("② 件数を減らしても、利益は伸びています",
             "住友不動産ステップは取扱件数を2,155件、店舗を1年で36店減らしました。"
             "それでも営業利益は前年比+21.0%で過去最高です。"
             "1件あたりの価格が上がったためです。"),
            ("③ 会社の規模と、取引の中身は別です",
             "三菱UFJ不動産販売は37店舗と少数ですが、1拠点あたり約28名。"
             "資産家・法人・相続といった高額の案件に絞っています。"
             "店舗数の多さが、そのまま得意分野を表すわけではありません."),
            ("④ 業界全体では差が開いています",
             "大手各社が増収となる一方で、不動産の代理・仲介業の倒産は"
             "2026年1〜8月で86件。2025年通年の133件（過去最多）に迫るペースです。")):
        t(c, px + 16, yy, ttl, 10.4, NAVY2, bold=True)
        yy -= 15
        yy -= wrap(c, px + 16, yy, body, 8.5, pw_ - 32, INK2) + 9

    # 右下：売却をご検討の方へ
    qy = ptop - ph_ - 18
    qh = 150
    panel(c, px, qy - qh, pw_, qh, HexColor("#fff8ec"), HexColor("#ecd9b4"))
    t(c, px + 16, qy - 24, "売却をご検討の方へ", 12.5, HexColor("#8a5a12"), bold=True)
    wrap(c, px + 16, qy - 46,
         "2025年1月から、不動産会社には「レインズ（不動産流通機構）に登録した"
         "物件の取引状況を、実際の販売状況と一致させること」が義務づけられました。"
         "売り止めにしていないか、他社からの問い合わせを断っていないかは、"
         "売主さまご自身でも確認できます。", 8.5, pw_ - 32, HexColor("#6b4a14"))
    wrap(c, px + 16, qy - 112,
         "ご不明な点は、担当までお気軽にお尋ねください。", 8.8, pw_ - 32, HexColor("#6b4a14"), bold=True)

    page_footer(c, 2)


def main():
    os.makedirs(OUT, exist_ok=True)
    suffix = "_軽量版" if os.environ.get("BROKER_PDF_CID") == "1" else ""
    path = os.path.join(OUT, f"いまの不動産市場_お客さま用_2026-11-10{suffix}.pdf")
    c = canvas.Canvas(path, pagesize=landscape(A3), pageCompression=1)
    c.setTitle("いまの不動産市場（2026年11月）")
    c.setAuthor("株式会社スマートハウス")
    page1(c); c.showPage()
    page2(c); c.showPage()
    c.save()
    print("wrote", path, os.path.getsize(path), "bytes")


if __name__ == "__main__":
    main()
