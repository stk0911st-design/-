#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""南万騎が原駅 中古マンション 売り出し／成約 事例トラッカー

週次のスナップショット（その週に売りに出ている物件の一覧）を取り込み、
前週との差分から「新規掲載 / 価格改定 / 掲載終了」を自動判定して蓄積する。

使い方:
    python3 scripts/mansion_track.py ingest <snapshot.csv> [--date YYYY-MM-DD]
    python3 scripts/mansion_track.py report [--date YYYY-MM-DD]
    python3 scripts/mansion_track.py view   [--out reports/index.html]
    python3 scripts/mansion_track.py stats
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import os
import re
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
SNAPDIR = os.path.join(DATA, "snapshots")
REPORTS = os.path.join(ROOT, "reports")

LISTINGS = os.path.join(DATA, "listings.csv")
HISTORY = os.path.join(DATA, "price_history.csv")
EVENTS = os.path.join(DATA, "events.csv")
CONTRACTS = os.path.join(DATA, "contracts.csv")

# スナップショット（収集側が吐く正規化済みCSV）の列
SNAPSHOT_COLS = [
    "source", "source_id", "url", "mansion_name", "address",
    "station", "walk_min", "price_man", "layout", "area_m2",
    "balcony_m2", "floor", "floors_total", "built_ym",
    "units_total", "management_fee", "repair_fund", "remarks",
]

# 蓄積される売り出し事例マスタの列
LISTING_COLS = [
    "listing_id", "status", "first_seen", "last_seen", "closed_date",
    "weeks_on_market", "source", "source_id", "url",
    "mansion_name", "address", "station", "walk_min",
    "price_initial_man", "price_current_man", "price_cut_count",
    "layout", "area_m2", "balcony_m2", "unit_price_man_tsubo",
    "floor", "floors_total", "built_ym", "age_years",
    "units_total", "management_fee", "repair_fund", "remarks",
]

HISTORY_COLS = ["listing_id", "observed_date", "price_man"]
EVENT_COLS = ["event_date", "event_type", "listing_id", "mansion_name",
              "layout", "area_m2", "detail"]
CONTRACT_COLS = [
    "contract_id", "contract_period", "source", "mansion_name", "area_name",
    "price_man", "layout", "area_m2", "built_ym", "floor",
    "station", "walk_min", "unit_price_man_tsubo", "remarks",
]

TSUBO = 3.30578  # 1坪 = 3.30578 m2


# ---------------------------------------------------------------- utilities
def read_csv(path, cols):
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8-sig") as f:
        return [dict(r) for r in csv.DictReader(f)]


def write_csv(path, cols, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in cols})
    os.replace(tmp, path)


def num(v):
    """'4,280万円' / '68.5m2' などから数値を取り出す。取れなければ None。"""
    if v is None:
        return None
    s = str(v).replace(",", "").strip()
    if not s:
        return None
    m = re.search(r"-?\d+(?:\.\d+)?", s)
    return float(m.group()) if m else None


def fmt(v, digits=0):
    n = num(v)
    if n is None:
        return ""
    return f"{n:,.{digits}f}"


def parse_built(ym):
    """'1995年3月' / '1995/03' / '199503' → (year, month)。不明は (None, None)。"""
    if not ym:
        return None, None
    s = str(ym)
    m = re.search(r"(19|20)\d{2}", s)
    if not m:
        return None, None
    year = int(m.group())
    rest = s[m.end():]
    mm = re.search(r"\d{1,2}", rest)
    month = int(mm.group()) if mm and 1 <= int(mm.group()) <= 12 else None
    return year, month


def age_years(built_ym, on=None):
    y, m = parse_built(built_ym)
    if not y:
        return ""
    on = on or dt.date.today()
    a = on.year - y - (1 if (m and on.month < m) else 0)
    return str(max(a, 0))


def unit_price(price_man, area_m2):
    """坪単価（万円/坪）。"""
    p, a = num(price_man), num(area_m2)
    if not p or not a:
        return ""
    return f"{p / (a / TSUBO):.1f}"


def make_listing_id(row):
    """source_id があればそれを、無ければ物件の同一性を示す属性からハッシュを作る。"""
    src = (row.get("source") or "").strip()
    sid = (row.get("source_id") or "").strip()
    if sid:
        key = f"{src}|{sid}"
    else:
        key = "|".join([
            src,
            (row.get("mansion_name") or "").strip(),
            (row.get("layout") or "").strip(),
            fmt(row.get("area_m2"), 2),
            (row.get("floor") or "").strip(),
        ])
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]


def week_span(d1, d2):
    try:
        a = dt.date.fromisoformat(d1)
        b = dt.date.fromisoformat(d2)
    except (ValueError, TypeError):
        return ""
    return str(max((b - a).days // 7, 0))


# ------------------------------------------------------------------ ingest
def ingest(path, date=None):
    date = date or dt.date.today().isoformat()
    snap = read_csv(path, SNAPSHOT_COLS)
    if not snap:
        print(f"[ingest] {path} に行がありません。処理を中止します。", file=sys.stderr)
        return 1

    listings = {r["listing_id"]: r for r in read_csv(LISTINGS, LISTING_COLS)}
    history = read_csv(HISTORY, HISTORY_COLS)
    events = read_csv(EVENTS, EVENT_COLS)

    # このスナップショットが網羅しているソース（この範囲だけを「掲載終了」判定の対象にする）
    sources = {(r.get("source") or "").strip() for r in snap}
    seen = set()
    n_new = n_price = n_same = 0

    for row in snap:
        lid = make_listing_id(row)
        seen.add(lid)
        price = fmt(row.get("price_man"), 0).replace(",", "")
        prev = listings.get(lid)

        base = {
            "listing_id": lid,
            "status": "売出中",
            "last_seen": date,
            "closed_date": "",
            "source": row.get("source", ""),
            "source_id": row.get("source_id", ""),
            "url": row.get("url", ""),
            "mansion_name": row.get("mansion_name", ""),
            "address": row.get("address", ""),
            "station": row.get("station", ""),
            "walk_min": row.get("walk_min", ""),
            "price_current_man": price,
            "layout": row.get("layout", ""),
            "area_m2": fmt(row.get("area_m2"), 2),
            "balcony_m2": fmt(row.get("balcony_m2"), 2),
            "unit_price_man_tsubo": unit_price(price, row.get("area_m2")),
            "floor": row.get("floor", ""),
            "floors_total": row.get("floors_total", ""),
            "built_ym": row.get("built_ym", ""),
            "age_years": age_years(row.get("built_ym"), dt.date.fromisoformat(date)),
            "units_total": row.get("units_total", ""),
            "management_fee": row.get("management_fee", ""),
            "repair_fund": row.get("repair_fund", ""),
            "remarks": row.get("remarks", ""),
        }

        if prev is None:
            base["first_seen"] = date
            base["price_initial_man"] = price
            base["price_cut_count"] = "0"
            base["weeks_on_market"] = "0"
            listings[lid] = base
            history.append({"listing_id": lid, "observed_date": date, "price_man": price})
            events.append({
                "event_date": date, "event_type": "新規掲載", "listing_id": lid,
                "mansion_name": base["mansion_name"], "layout": base["layout"],
                "area_m2": base["area_m2"],
                "detail": f"{fmt(price)}万円 / {base['layout']} / {base['area_m2']}m2",
            })
            n_new += 1
            continue

        old_price = (prev.get("price_current_man") or "").strip()
        merged = dict(prev)
        merged.update(base)
        merged["first_seen"] = prev.get("first_seen") or date
        merged["price_initial_man"] = prev.get("price_initial_man") or price
        merged["price_cut_count"] = prev.get("price_cut_count") or "0"
        merged["weeks_on_market"] = week_span(merged["first_seen"], date)

        if price and old_price and price != old_price:
            diff = (num(price) or 0) - (num(old_price) or 0)
            if diff < 0:
                merged["price_cut_count"] = str(int(num(merged["price_cut_count"]) or 0) + 1)
            history.append({"listing_id": lid, "observed_date": date, "price_man": price})
            events.append({
                "event_date": date, "event_type": "価格改定", "listing_id": lid,
                "mansion_name": merged["mansion_name"], "layout": merged["layout"],
                "area_m2": merged["area_m2"],
                "detail": f"{fmt(old_price)}万円 → {fmt(price)}万円 ({diff:+,.0f}万円)",
            })
            n_price += 1
        else:
            n_same += 1
        listings[lid] = merged

    # スナップショットに現れなかった＝掲載終了（成約 or 取下げ）
    n_closed = 0
    for lid, r in listings.items():
        if lid in seen or r.get("status") != "売出中":
            continue
        if (r.get("source") or "").strip() not in sources:
            continue  # 今回のスナップショットが扱っていないソースは触らない
        r["status"] = "掲載終了"
        r["closed_date"] = date
        r["weeks_on_market"] = week_span(r.get("first_seen"), date)
        events.append({
            "event_date": date, "event_type": "掲載終了", "listing_id": lid,
            "mansion_name": r.get("mansion_name", ""), "layout": r.get("layout", ""),
            "area_m2": r.get("area_m2", ""),
            "detail": f"最終 {fmt(r.get('price_current_man'))}万円 / 掲載 {r.get('weeks_on_market')}週",
        })
        n_closed += 1

    rows = sorted(listings.values(),
                  key=lambda r: (r.get("status") != "売出中", r.get("mansion_name") or ""))
    write_csv(LISTINGS, LISTING_COLS, rows)
    write_csv(HISTORY, HISTORY_COLS, history)
    write_csv(EVENTS, EVENT_COLS, events)

    os.makedirs(SNAPDIR, exist_ok=True)
    write_csv(os.path.join(SNAPDIR, f"{date}.csv"), SNAPSHOT_COLS, snap)

    print(f"[ingest] {date}: 取込 {len(snap)}件 / 新規 {n_new} / 価格改定 {n_price} "
          f"/ 継続 {n_same} / 掲載終了 {n_closed}")
    return 0


# ------------------------------------------------------------------ report
def report(date=None):
    date = date or dt.date.today().isoformat()
    listings = {r["listing_id"]: r for r in read_csv(LISTINGS, LISTING_COLS)}
    events = [e for e in read_csv(EVENTS, EVENT_COLS) if e.get("event_date") == date]
    active = [r for r in listings.values() if r.get("status") == "売出中"]

    by_type = defaultdict(list)
    for e in events:
        by_type[e["event_type"]].append(e)

    prices = [num(r.get("price_current_man")) for r in active]
    prices = sorted(p for p in prices if p)
    tsubo = [num(r.get("unit_price_man_tsubo")) for r in active]
    tsubo = sorted(t for t in tsubo if t)

    def median(xs):
        if not xs:
            return None
        n = len(xs)
        return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2

    L = []
    L.append(f"# 南万騎が原駅 中古マンション 週次レポート（{date}）\n")
    L.append("## サマリー\n")
    L.append(f"- 売出中：**{len(active)}件**")
    L.append(f"- 今週の新規掲載：**{len(by_type['新規掲載'])}件**")
    L.append(f"- 今週の価格改定：**{len(by_type['価格改定'])}件**")
    L.append(f"- 今週の掲載終了（成約・取下げ）：**{len(by_type['掲載終了'])}件**")
    if prices:
        L.append(f"- 売出価格　中央値 {median(prices):,.0f}万円"
                 f"（{prices[0]:,.0f}〜{prices[-1]:,.0f}万円）")
    if tsubo:
        L.append(f"- 坪単価　　中央値 {median(tsubo):,.1f}万円/坪"
                 f"（{tsubo[0]:,.1f}〜{tsubo[-1]:,.1f}）")
    L.append("")

    def table(evs, title, note=""):
        L.append(f"## {title}\n")
        if note:
            L.append(f"{note}\n")
        if not evs:
            L.append("該当なし\n")
            return
        L.append("| マンション名 | 間取り | 専有面積 | 内容 |")
        L.append("| --- | --- | --- | --- |")
        for e in evs:
            L.append(f"| {e['mansion_name']} | {e['layout']} | "
                     f"{e['area_m2']}m2 | {e['detail']} |")
        L.append("")

    table(by_type["新規掲載"], "新規に売り出された物件")
    table(by_type["価格改定"], "価格が変わった物件")
    table(by_type["掲載終了"], "掲載が終わった物件",
          "※ 掲載終了＝成約とは限りません（売主都合の取下げ・媒介先の変更を含む）。"
          "成約の確定はレインズ等の成約事例で照合してください。")

    L.append("## 売出中 一覧\n")
    if active:
        L.append("| マンション名 | 価格 | 坪単価 | 間取り | 専有面積 | 階 | 築年 | 徒歩 | 掲載週数 | 値下げ |")
        L.append("| --- | ---: | ---: | --- | ---: | --- | --- | ---: | ---: | ---: |")
        for r in sorted(active, key=lambda x: -(num(x.get("price_current_man")) or 0)):
            L.append(
                f"| {r.get('mansion_name','')} | {fmt(r.get('price_current_man'))}万円 "
                f"| {r.get('unit_price_man_tsubo','')} | {r.get('layout','')} "
                f"| {r.get('area_m2','')}m2 | {r.get('floor','')} | {r.get('built_ym','')} "
                f"| {r.get('walk_min','')}分 | {r.get('weeks_on_market','')}週 "
                f"| {r.get('price_cut_count','')}回 |")
    else:
        L.append("データがありません。スナップショットを ingest してください。")
    L.append("")

    os.makedirs(REPORTS, exist_ok=True)
    out = os.path.join(REPORTS, f"{date}.md")
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(L))
    print(f"[report] {out} を作成しました")
    return 0


# -------------------------------------------------------------------- stats
def stats():
    listings = read_csv(LISTINGS, LISTING_COLS)
    events = read_csv(EVENTS, EVENT_COLS)
    contracts = read_csv(CONTRACTS, CONTRACT_COLS)
    active = [r for r in listings if r.get("status") == "売出中"]
    snaps = sorted(f[:-4] for f in os.listdir(SNAPDIR)) if os.path.isdir(SNAPDIR) else []
    print(f"売出中 {len(active)}件 / 累積 {len(listings)}件 / "
          f"イベント {len(events)}件 / 成約事例 {len(contracts)}件 / "
          f"スナップショット {len(snaps)}回" + (f"（{snaps[0]}〜{snaps[-1]}）" if snaps else ""))
    return 0


# --------------------------------------------------------------------- view
def view(out=None):
    out = out or os.path.join(REPORTS, "index.html")
    payload = {
        "generated": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "listings": read_csv(LISTINGS, LISTING_COLS),
        "events": read_csv(EVENTS, EVENT_COLS),
        "history": read_csv(HISTORY, HISTORY_COLS),
        "contracts": read_csv(CONTRACTS, CONTRACT_COLS),
    }
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    tpl = os.path.join(ROOT, "scripts", "view_template.html")
    with open(tpl, encoding="utf-8") as f:
        html = f.read()
    html = html.replace("/*__DATA__*/null",
                        json.dumps(payload, ensure_ascii=False))
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"[view] {out} を作成しました（物件 {len(payload['listings'])}件）")
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("ingest", help="週次スナップショットCSVを取り込む")
    pi.add_argument("path")
    pi.add_argument("--date", help="スナップショットの基準日 (YYYY-MM-DD)")

    pr = sub.add_parser("report", help="週次レポート(Markdown)を作る")
    pr.add_argument("--date")

    pv = sub.add_parser("view", help="一覧HTMLを作る")
    pv.add_argument("--out")

    sub.add_parser("stats", help="蓄積状況を表示する")

    a = p.parse_args()
    if a.cmd == "ingest":
        return ingest(a.path, a.date)
    if a.cmd == "report":
        return report(a.date)
    if a.cmd == "view":
        return view(a.out)
    return stats()


if __name__ == "__main__":
    sys.exit(main())
