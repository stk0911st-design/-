#!/usr/bin/env bash
# ─────────────────────────────────────────────
# スケジュールのOS登録スクリプト（Linux: cron / systemd timer）
#
#   ./scripts/install_schedule.sh [--method cron|systemd] [--apply]
#
# ★ 既定では「登録内容を表示するだけ」です。実際には登録しません。
# ★ 実際に登録するには --apply を付け、さらに画面の確認に yes と入力する必要があります。
# ★ 削除は行いません。cron の既存設定は残したまま、このシステムの行を追記します。
#
# 解除方法は ./scripts/uninstall_schedule.sh を参照してください。
# ─────────────────────────────────────────────
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/common.sh"

METHOD=""
APPLY=0
MARKER_BEGIN="# >>> smart-house-ai routines >>>"
MARKER_END="# <<< smart-house-ai routines <<<"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --method) METHOD="${2:-}"; shift 2 ;;
    --apply)  APPLY=1; shift ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "不明なオプション: $1" >&2; exit 2 ;;
  esac
done

OS_NAME="$(uname -s)"
echo "検出したOS: $OS_NAME"

if [[ "$OS_NAME" != "Linux" ]]; then
  cat <<MSG

⚠️  このスクリプトは Linux 用です。

  macOS の場合 : launchd（~/Library/LaunchAgents/*.plist）で登録してください。
  Windows の場合: PowerShell + タスクスケジューラで登録してください。
  いずれも README.md の「⑤自動実行方法」に手順を記載しています。

MSG
  exit 1
fi

# ── 方式の自動判定 ──────────────────────────
if [[ -z "$METHOD" ]]; then
  if command -v crontab >/dev/null 2>&1; then
    METHOD="cron"
  elif command -v systemctl >/dev/null 2>&1; then
    METHOD="systemd"
  else
    echo "🚨 cron も systemd も見つかりません。手動実行のみ可能です。" >&2
    exit 1
  fi
  echo "登録方式（自動判定）: $METHOD"
else
  echo "登録方式（指定）: $METHOD"
fi

echo ""
echo "════════════════════════════════════════════"
echo " 登録予定のスケジュール"
echo "════════════════════════════════════════════"
python3 "$SCHEDULE_PY" list
echo ""

case "$METHOD" in
  cron)
    if ! command -v crontab >/dev/null 2>&1; then
      echo "🚨 crontab コマンドがありません。--method systemd を試すか、cron をインストールしてください。" >&2
      exit 1
    fi
    GEN="$(python3 "$SCHEDULE_PY" cron)"
    echo "──────── crontab に追記する内容 ────────"
    echo "$MARKER_BEGIN"
    echo "$GEN"
    echo "$MARKER_END"
    echo "────────────────────────────────────────"
    echo ""

    if crontab -l 2>/dev/null | grep -qF "$MARKER_BEGIN"; then
      echo "⚠️  既にこのシステムの設定が crontab に登録されています。"
      echo "   重複登録を避けるため、先に ./scripts/uninstall_schedule.sh で解除してください。"
      exit 1
    fi

    if [[ $APPLY -eq 0 ]]; then
      echo "ℹ️  これは表示のみです。実際には登録していません。"
      echo "   登録する場合: ./scripts/install_schedule.sh --method cron --apply"
      exit 0
    fi

    echo "🚨 これから crontab を変更します（既存の設定は残したまま追記します）。"
    read -r -p "本当に登録しますか？ 続けるには yes と入力してください: " ANS
    if [[ "$ANS" != "yes" ]]; then
      echo "中止しました。何も変更していません。"
      exit 0
    fi

    BACKUP="$LOG_DIR/crontab_backup_$(date '+%Y%m%d_%H%M%S').txt"
    crontab -l > "$BACKUP" 2>/dev/null || echo "# (登録なし)" > "$BACKUP"
    echo "既存 crontab を退避しました: $BACKUP"

    { cat "$BACKUP"; echo ""; echo "$MARKER_BEGIN"; echo "$GEN"; echo "$MARKER_END"; } | crontab -
    echo "✅ crontab に登録しました。確認: crontab -l"
    ;;

  systemd)
    if ! command -v systemctl >/dev/null 2>&1; then
      echo "🚨 systemctl がありません。" >&2
      exit 1
    fi
    UNIT_DIR="$HOME/.config/systemd/user"
    echo "──────── 生成する systemd ユニット ────────"
    python3 "$SCHEDULE_PY" systemd
    echo "──────────────────────────────────────────"
    echo "保存先: $UNIT_DIR"
    echo ""

    if [[ $APPLY -eq 0 ]]; then
      echo "ℹ️  これは表示のみです。実際には登録していません。"
      echo "   登録する場合: ./scripts/install_schedule.sh --method systemd --apply"
      # 登録できる環境かどうかだけ先に知らせる（プレビュー自体は成功扱い）
      if ! systemctl --user show-environment >/dev/null 2>&1; then
        echo ""
        echo "⚠️  ただし、この環境では systemd のユーザーセッションに接続できないため、"
        echo "    --apply を付けても登録できません（詳細は --apply 実行時に表示されます）。"
      fi
      exit 0
    fi

    # systemd が実際に動いているか確認する。
    # コンテナ等では systemctl コマンドがあっても systemd が PID1 として動いておらず、
    # ユニットファイルだけ作られて「登録できたつもり」になる事故が起きるため。
    if ! systemctl --user show-environment >/dev/null 2>&1; then
      cat >&2 <<'MSG'

🚨 systemd のユーザーセッションに接続できません。この環境では登録できません。

  考えられる原因:
    - systemd が PID1 として動いていない（Docker等のコンテナでよくあります）
    - ユーザーセッションが開始されていない（XDG_RUNTIME_DIR が未設定）
    - SSHでログインしただけで、ログインセッションが確立していない

  確認方法:
    ps -p 1 -o comm=            → systemd と表示されるか
    echo $XDG_RUNTIME_DIR       → /run/user/<uid> が表示されるか

  対処:
    - 通常のデスクトップPC／サーバーであれば、デスクトップにログインするか
      `loginctl enable-linger $USER` を実行してから再試行してください。
    - cron が使える環境なら --method cron をお試しください。
    - どちらも使えない場合は、手動実行（./scripts/run_morning.sh 等）でご利用ください。

MSG
      exit 1
    fi

    echo "🚨 これから $UNIT_DIR に .service / .timer を作成し、タイマーを有効化します。"
    read -r -p "本当に登録しますか？ 続けるには yes と入力してください: " ANS
    if [[ "$ANS" != "yes" ]]; then
      echo "中止しました。何も変更していません。"
      exit 0
    fi

    mkdir -p "$UNIT_DIR"
    python3 - "$UNIT_DIR" "$BASE_DIR" <<'PY'
import subprocess, sys, os
unit_dir, base = sys.argv[1], sys.argv[2]
out = subprocess.run([sys.executable, os.path.join(base,'scripts','lib','schedule.py'), 'systemd'],
                     capture_output=True, text=True, check=True).stdout
cur, buf = None, []
def flush():
    if cur and buf:
        path = os.path.join(unit_dir, os.path.basename(cur))
        if os.path.exists(path):
            print("⚠️  既存のため上書きしません: %s" % path)
        else:
            with open(path, 'w', encoding='utf-8') as f:
                f.write("\n".join(buf).strip() + "\n")
            print("作成: %s" % path)
for line in out.splitlines():
    if line.startswith('### '):
        flush(); cur = line[4:].strip(); buf = []
    elif cur is not None:
        buf.append(line)
flush()
PY
    if ! systemctl --user daemon-reload; then
      echo "🚨 daemon-reload に失敗しました。タイマーは有効化されていません。" >&2
      echo "   作成済みのユニットファイル: $UNIT_DIR" >&2
      exit 1
    fi
    ENABLED=0; FAILED=0
    while read -r key; do
      [[ -z "$key" ]] && continue
      if systemctl --user enable --now "smarthouse-${key}.timer"; then
        echo "✅ 有効化: smarthouse-${key}.timer"; ENABLED=$((ENABLED+1))
      else
        echo "🚨 有効化に失敗: smarthouse-${key}.timer" >&2; FAILED=$((FAILED+1))
      fi
    done < <(python3 -c "
import json,os
cfg=json.load(open(os.path.join('$BASE_DIR','config','schedule.json'),encoding='utf-8'))
[print(r['key']) for r in cfg['routines'] if r.get('enabled',True)]")
    echo ""
    if [[ $FAILED -gt 0 ]]; then
      echo "🚨 ${FAILED}件の有効化に失敗しました（成功 ${ENABLED}件）。" >&2
      echo "   確認: systemctl --user list-timers 'smarthouse-*'" >&2
      exit 1
    fi
    echo "✅ ${ENABLED}件のタイマーを登録しました。"
    echo "   確認: systemctl --user list-timers 'smarthouse-*'"
    echo "ℹ️  ログアウトしても動かすには: loginctl enable-linger \$USER"
    ;;
  *)
    echo "🚨 不明な方式: $METHOD（cron または systemd）" >&2
    exit 2 ;;
esac
