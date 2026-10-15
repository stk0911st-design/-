#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
config/schedule.json を読み、営業日判定とスケジュール生成を行うヘルパー。

このスクリプトは読み取り専用です。ファイルの作成・変更・削除は一切行いません。

使い方:
  schedule.py is-business-day [YYYY-MM-DD]   営業日なら exit 0 / 休日なら exit 1
  schedule.py should-run <key> [YYYY-MM-DD]  そのルーティンを実行すべきなら exit 0
  schedule.py get <key> <field>              ルーティン定義の項目を出力
  schedule.py list                           ルーティン一覧
  schedule.py group <group>                  グループに属するルーティンのkeyを出力
  schedule.py cron                           crontab 行を生成して出力（登録はしない）
  schedule.py systemd                        systemd user timer 定義を出力（登録はしない）
  schedule.py business-days-in-month [YYYY-MM]  当月の営業日数 / 経過営業日数
"""

import sys
import os
import json
import calendar
from datetime import date, datetime, timedelta

WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
WEEKDAY_JA = ["月", "火", "水", "木", "金", "土", "日"]
CRON_DOW = {"mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6, "sun": 0}

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CONFIG_PATH = os.path.join(BASE_DIR, "config", "schedule.json")


def load_config():
    if not os.path.exists(CONFIG_PATH):
        die("設定ファイルが見つかりません: %s" % CONFIG_PATH)
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        die("config/schedule.json のJSONが壊れています: %s" % e)


def die(msg, code=2):
    sys.stderr.write("[schedule.py] エラー: %s\n" % msg)
    sys.exit(code)


def parse_date(s):
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError:
        die("日付は YYYY-MM-DD 形式で指定してください: %s" % s)


def target_date(argv, idx):
    if len(argv) > idx:
        return parse_date(argv[idx])
    return date.today()


def business_day_info(cfg, d):
    """(is_business_day, reason) を返す"""
    iso = d.isoformat()
    if iso in (cfg.get("extra_business_days") or []):
        return True, "臨時営業日（extra_business_days）"
    wk = WEEKDAY_KEYS[d.weekday()]
    if wk in (cfg.get("holiday_weekdays") or []):
        return False, "会社休日（%s曜）" % WEEKDAY_JA[d.weekday()]
    if iso in (cfg.get("holidays") or []):
        return False, "休業日（holidays に登録）"
    return True, "営業日"


def routine_by_key(cfg, key):
    for r in cfg.get("routines", []):
        if r.get("key") == key:
            return r
    die("ルーティンが見つかりません: %s" % key)


def should_run(cfg, r, d):
    """(should_run, reason)"""
    if not r.get("enabled", True):
        return False, "このルーティンは無効（enabled=false）"

    days = r.get("days", "business_day")
    is_bd, bd_reason = business_day_info(cfg, d)

    if days == "business_day":
        if not is_bd:
            return False, bd_reason
        return True, bd_reason

    if days.startswith("day_of_month:"):
        want = days.split(":", 1)[1].strip()
        if want == "last":
            last = calendar.monthrange(d.year, d.month)[1]
            ok = d.day == last
        else:
            ok = d.day == int(want)
        if not ok:
            return False, "実行日ではありません（指定: 毎月%s日 / 本日: %d日）" % (want, d.day)
        return True, "月次実行日"

    if days == "every_day":
        return True, "毎日実行"

    wanted = [x.strip() for x in days.split(",")]
    for w in wanted:
        if w not in WEEKDAY_KEYS:
            die("days の指定が不正です: %s" % days)
    wk = WEEKDAY_KEYS[d.weekday()]
    if wk not in wanted:
        return False, "実行曜日ではありません（指定: %s / 本日: %s曜）" % (days, WEEKDAY_JA[d.weekday()])
    if iso_in_holidays(cfg, d):
        return False, "休業日（holidays に登録）"
    return True, "%s曜の定例" % WEEKDAY_JA[d.weekday()]


def iso_in_holidays(cfg, d):
    if d.isoformat() in (cfg.get("extra_business_days") or []):
        return False
    return d.isoformat() in (cfg.get("holidays") or [])


def cmd_is_business_day(cfg, argv):
    d = target_date(argv, 2)
    ok, reason = business_day_info(cfg, d)
    print("%s %s(%s): %s" % (d.isoformat(), "営業日" if ok else "休日",
                             WEEKDAY_JA[d.weekday()], reason))
    sys.exit(0 if ok else 1)


def cmd_should_run(cfg, argv):
    if len(argv) < 3:
        die("使い方: schedule.py should-run <key> [YYYY-MM-DD]")
    key = argv[2]
    d = target_date(argv, 3)
    r = routine_by_key(cfg, key)
    ok, reason = should_run(cfg, r, d)
    print("%s / %s: %s（%s）" % (d.isoformat(), r.get("name", key),
                                "実行対象" if ok else "スキップ", reason))
    sys.exit(0 if ok else 1)


def cmd_get(cfg, argv):
    if len(argv) < 4:
        die("使い方: schedule.py get <key> <field>")
    r = routine_by_key(cfg, argv[2])
    field = argv[3]
    if field == "timezone":
        print(cfg.get("timezone", "Asia/Tokyo"))
        return
    if field not in r:
        die("項目が見つかりません: %s" % field)
    print(r[field])


def cmd_list(cfg, argv):
    tz = cfg.get("timezone", "Asia/Tokyo")
    holi = "、".join(WEEKDAY_JA[WEEKDAY_KEYS.index(w)] for w in (cfg.get("holiday_weekdays") or []))
    print("タイムゾーン : %s" % tz)
    print("会社休日     : %s曜" % (holi or "なし"))
    print("祝日登録数   : %d件" % len(cfg.get("holidays") or []))
    print("")
    print("%-22s %-22s %-7s %-16s %-9s %s" % ("KEY", "名称", "時刻", "曜日/日", "グループ", "有効"))
    print("-" * 96)
    for r in cfg.get("routines", []):
        print("%-22s %-22s %-7s %-16s %-9s %s" % (
            r.get("key", ""), r.get("name", ""), r.get("time", ""),
            r.get("days", ""), r.get("group", ""),
            "有効" if r.get("enabled", True) else "無効"))


def cmd_group(cfg, argv):
    if len(argv) < 3:
        die("使い方: schedule.py group <group>")
    g = argv[2]
    keys = [r["key"] for r in cfg.get("routines", [])
            if r.get("group") == g and r.get("enabled", True)]
    if not keys:
        sys.stderr.write("[schedule.py] グループ '%s' に有効なルーティンがありません\n" % g)
        sys.exit(1)
    for k in keys:
        print(k)


def cron_dow_expr(cfg, days):
    if days == "business_day":
        holidays = set(cfg.get("holiday_weekdays") or [])
        nums = sorted(CRON_DOW[w] for w in WEEKDAY_KEYS if w not in holidays)
        return ",".join(str(n) for n in nums), "*"
    if days.startswith("day_of_month:"):
        want = days.split(":", 1)[1].strip()
        return "*", want
    if days == "every_day":
        return "*", "*"
    nums = sorted(CRON_DOW[w.strip()] for w in days.split(","))
    return ",".join(str(n) for n in nums), "*"


def cmd_cron(cfg, argv):
    tz = cfg.get("timezone", "Asia/Tokyo")
    runner = os.path.join(BASE_DIR, "scripts", "run_routine.sh")
    print("# ─────────────────────────────────────────────")
    print("# 株式会社スマートハウス AI経営管理ルーティン crontab")
    print("# 生成: %s" % datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    print("# ※ このファイルは自動登録されません。内容を確認してから登録してください。")
    print("# ※ 各スクリプトは実行時にも営業日判定を行うため、祝日を追加すれば自動でスキップします。")
    print("# ─────────────────────────────────────────────")
    print("CRON_TZ=%s" % tz)
    print("SHELL=/bin/bash")
    print("")
    for r in cfg.get("routines", []):
        if not r.get("enabled", True):
            print("# （無効）%s" % r.get("name", r.get("key")))
            continue
        hh, mm = r["time"].split(":")
        dow, dom = cron_dow_expr(cfg, r.get("days", "business_day"))
        print("# %s（%s %s）" % (r.get("name", ""), r.get("days", ""), r.get("time", "")))
        print("%s %s %s * %s %s %s" % (int(mm), int(hh), dom, dow, runner, r["key"]))
        print("")


def cmd_systemd(cfg, argv):
    tz = cfg.get("timezone", "Asia/Tokyo")
    runner = os.path.join(BASE_DIR, "scripts", "run_routine.sh")
    print("# systemd user unit 定義（登録はしません）")
    print("# 保存先: ~/.config/systemd/user/")
    print("# OnCalendar は %s で解釈させるため Timer に Persistent と タイムゾーン指定を入れています。" % tz)
    print("")
    for r in cfg.get("routines", []):
        if not r.get("enabled", True):
            continue
        key = r["key"]
        hh, mm = r["time"].split(":")
        days = r.get("days", "business_day")
        if days == "business_day":
            holidays = set(cfg.get("holiday_weekdays") or [])
            dows = [WEEKDAY_KEYS[i].capitalize() for i in range(7)
                    if WEEKDAY_KEYS[i] not in holidays]
            oncal = "%s *-*-* %02d:%02d:00 %s" % (",".join(dows), int(hh), int(mm), tz)
        elif days.startswith("day_of_month:"):
            dom = days.split(":", 1)[1].strip()
            oncal = "*-*-%02d %02d:%02d:00 %s" % (int(dom), int(hh), int(mm), tz)
        elif days == "every_day":
            oncal = "*-*-* %02d:%02d:00 %s" % (int(hh), int(mm), tz)
        else:
            dows = [w.strip().capitalize() for w in days.split(",")]
            oncal = "%s *-*-* %02d:%02d:00 %s" % (",".join(dows), int(hh), int(mm), tz)

        print("### ~/.config/systemd/user/smarthouse-%s.service" % key)
        print("[Unit]")
        print("Description=スマートハウス AI経営ルーティン: %s" % r.get("name", key))
        print("")
        print("[Service]")
        print("Type=oneshot")
        print("WorkingDirectory=%s" % BASE_DIR)
        print("ExecStart=%s %s" % (runner, key))
        print("")
        print("### ~/.config/systemd/user/smarthouse-%s.timer" % key)
        print("[Unit]")
        print("Description=スマートハウス AI経営ルーティン タイマー: %s" % r.get("name", key))
        print("")
        print("[Timer]")
        print("OnCalendar=%s" % oncal)
        print("Persistent=true")
        print("")
        print("[Install]")
        print("WantedBy=timers.target")
        print("")


def cmd_business_days_in_month(cfg, argv):
    if len(argv) > 2:
        try:
            y, m = argv[2].split("-")
            y, m = int(y), int(m)
        except ValueError:
            die("月は YYYY-MM 形式で指定してください")
        today = date.today()
    else:
        today = date.today()
        y, m = today.year, today.month
    last = calendar.monthrange(y, m)[1]
    total = 0
    elapsed = 0
    for day in range(1, last + 1):
        d = date(y, m, day)
        ok, _ = business_day_info(cfg, d)
        if ok:
            total += 1
            if d <= today:
                elapsed += 1
    print("対象月: %04d-%02d" % (y, m))
    print("総営業日数: %d" % total)
    print("経過営業日数: %d" % elapsed)


def main():
    argv = sys.argv
    if len(argv) < 2:
        print(__doc__)
        sys.exit(2)
    cmd = argv[1]
    cfg = load_config()
    table = {
        "is-business-day": cmd_is_business_day,
        "should-run": cmd_should_run,
        "get": cmd_get,
        "list": cmd_list,
        "group": cmd_group,
        "cron": cmd_cron,
        "systemd": cmd_systemd,
        "business-days-in-month": cmd_business_days_in_month,
    }
    if cmd not in table:
        die("不明なコマンド: %s\n%s" % (cmd, __doc__))
    table[cmd](cfg, argv)


if __name__ == "__main__":
    # head 等でパイプが閉じられたときにトレースバックを出さない
    try:
        main()
    except BrokenPipeError:
        try:
            sys.stdout.close()
        except Exception:
            pass
        os._exit(0)
    except KeyboardInterrupt:
        sys.stderr.write("\n[schedule.py] 中断しました\n")
        sys.exit(130)
