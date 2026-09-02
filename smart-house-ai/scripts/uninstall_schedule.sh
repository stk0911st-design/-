#!/usr/bin/env bash
# ─────────────────────────────────────────────
# スケジュールの解除（自動実行を止める）
#
#   ./scripts/uninstall_schedule.sh [--method cron|systemd] [--apply]
#
# ★ 既定では「何をするか表示するだけ」です。--apply を付けたときだけ実行します。
# ★ cron: このシステムが追記した範囲の行だけを取り除きます（他の設定はそのまま）。
# ★ systemd: タイマーを停止・無効化します。ユニットファイルは削除しません
#            （不要になったら手動で削除してください）。
# ─────────────────────────────────────────────
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/common.sh"

METHOD=""; APPLY=0
MARKER_BEGIN="# >>> smart-house-ai routines >>>"
MARKER_END="# <<< smart-house-ai routines <<<"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --method) METHOD="${2:-}"; shift 2 ;;
    --apply)  APPLY=1; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "不明なオプション: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$METHOD" ]]; then
  if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -qF "$MARKER_BEGIN"; then
    METHOD="cron"
  elif command -v systemctl >/dev/null 2>&1; then
    METHOD="systemd"
  else
    echo "解除対象が見つかりませんでした。" ; exit 0
  fi
fi
echo "解除方式: $METHOD"

case "$METHOD" in
  cron)
    if ! crontab -l 2>/dev/null | grep -qF "$MARKER_BEGIN"; then
      echo "crontab にこのシステムの設定はありません。何もしません。"; exit 0
    fi
    echo "──── 取り除く行 ────"
    crontab -l | awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" '$0==b{f=1} f{print} $0==e{f=0}'
    echo "────────────────────"
    if [[ $APPLY -eq 0 ]]; then
      echo "ℹ️  表示のみです。実行する場合: ./scripts/uninstall_schedule.sh --method cron --apply"
      exit 0
    fi
    read -r -p "crontab から上記を取り除きます。続けるには yes: " ANS
    [[ "$ANS" == "yes" ]] || { echo "中止しました。"; exit 0; }
    BACKUP="$LOG_DIR/crontab_backup_$(date '+%Y%m%d_%H%M%S').txt"
    crontab -l > "$BACKUP"
    echo "退避しました: $BACKUP"
    crontab -l | awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" '$0==b{f=1} !f{print} $0==e{f=0}' | crontab -
    echo "✅ 解除しました。確認: crontab -l"
    ;;
  systemd)
    mapfile -t KEYS < <(python3 -c "
import json,os
cfg=json.load(open(os.path.join('$BASE_DIR','config','schedule.json'),encoding='utf-8'))
[print(r['key']) for r in cfg['routines']]")
    echo "──── 停止・無効化するタイマー ────"
    for k in "${KEYS[@]}"; do echo "  smarthouse-${k}.timer"; done
    echo "──────────────────────────────────"
    echo "※ ユニットファイル（~/.config/systemd/user/）は削除しません。"
    if [[ $APPLY -eq 0 ]]; then
      echo "ℹ️  表示のみです。実行する場合: ./scripts/uninstall_schedule.sh --method systemd --apply"
      exit 0
    fi
    read -r -p "上記タイマーを停止・無効化します。続けるには yes: " ANS
    [[ "$ANS" == "yes" ]] || { echo "中止しました。"; exit 0; }
    for k in "${KEYS[@]}"; do
      systemctl --user disable --now "smarthouse-${k}.timer" 2>/dev/null \
        && echo "✅ 停止: smarthouse-${k}.timer" \
        || echo "－ 未登録: smarthouse-${k}.timer"
    done
    systemctl --user daemon-reload
    echo "✅ 解除しました。確認: systemctl --user list-timers 'smarthouse-*'"
    ;;
  *) echo "不明な方式: $METHOD" >&2; exit 2 ;;
esac
