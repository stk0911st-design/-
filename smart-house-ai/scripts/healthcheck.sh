#!/usr/bin/env bash
# ─────────────────────────────────────────────
# 環境チェック（読み取りのみ。何も変更しません）
#   ./scripts/healthcheck.sh
# トラブル時に最初に実行してください。
# ─────────────────────────────────────────────
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/common.sh"

NG=0
ok()   { echo "  ✅ $*"; }
warn() { echo "  ⚠️  $*"; }
ng()   { echo "  🚨 $*"; NG=$((NG+1)); }

echo "════════════════════════════════════════════"
echo " スマートハウス AI経営管理ルーティン 環境チェック"
echo " $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "════════════════════════════════════════════"

echo ""
echo "【1】実行環境"
echo "  OS: $(uname -s) $(uname -r)"
command -v "$CLAUDE_BIN" >/dev/null 2>&1 \
  && ok "Claude Code: $("$CLAUDE_BIN" --version 2>/dev/null | head -1)" \
  || ng "Claude Code が見つかりません（CLAUDE_BIN=$CLAUDE_BIN）"
command -v python3 >/dev/null 2>&1 && ok "python3: $(python3 --version 2>&1)" || ng "python3 がありません"
command -v timeout  >/dev/null 2>&1 && ok "timeout コマンドあり" || warn "timeout がありません（タイムアウト制御が効きません）"
echo "  タイムゾーン: $TZ / 現在時刻 $(date '+%Y-%m-%d %H:%M')"

echo ""
echo "【2】ディレクトリ"
for d in config prompts scripts input output/daily output/weekly output/monthly logs archive; do
  [[ -d "$BASE_DIR/$d" ]] && ok "$d/" || ng "$d/ がありません"
done
[[ -w "$OUTPUT_DIR" ]] && ok "output/ に書き込み可能" || ng "output/ に書き込めません"
[[ -w "$LOG_DIR" ]]    && ok "logs/ に書き込み可能"   || ng "logs/ に書き込めません"

echo ""
echo "【3】設定ファイル"
for f in CLAUDE.md config/schedule.json config/company.json config/runtime.env; do
  [[ -f "$BASE_DIR/$f" ]] && ok "$f" || ng "$f がありません"
done
python3 -c "import json;json.load(open('$CONFIG_DIR/schedule.json'))" 2>/dev/null \
  && ok "schedule.json のJSON構文OK" || ng "schedule.json のJSONが壊れています"
python3 -c "import json;json.load(open('$CONFIG_DIR/company.json'))" 2>/dev/null \
  && ok "company.json のJSON構文OK" || ng "company.json のJSONが壊れています"

echo ""
echo "【4】プロンプト"
while read -r p; do
  [[ -f "$BASE_DIR/$p" ]] && ok "$p" || ng "$p がありません"
done < <(python3 -c "
import json
cfg=json.load(open('$CONFIG_DIR/schedule.json'))
[print(r['prompt']) for r in cfg['routines']]")
[[ -f "$PROMPT_DIR/00_common_rules.md" ]] && ok "prompts/00_common_rules.md" || ng "prompts/00_common_rules.md がありません"

echo ""
echo "【5】スケジュール"
python3 "$SCHEDULE_PY" list | sed 's/^/  /'
echo ""
if python3 "$SCHEDULE_PY" is-business-day >/dev/null 2>&1; then
  ok "本日は営業日です（$(python3 "$SCHEDULE_PY" is-business-day)）"
else
  warn "本日は休日です（$(python3 "$SCHEDULE_PY" is-business-day 2>&1 || true)）→ ルーティンはスキップされます"
fi

echo ""
echo "【6】自動実行の登録状況"
if command -v crontab >/dev/null 2>&1; then
  if crontab -l 2>/dev/null | grep -q "smart-house-ai"; then
    ok "cron に登録済み"
    crontab -l 2>/dev/null | grep -A1 "smart-house-ai" | sed 's/^/     /' | head -20
  else
    warn "cron 未登録（自動実行されません）"
  fi
else
  warn "crontab コマンドなし"
fi
if command -v systemctl >/dev/null 2>&1; then
  if systemctl --user list-timers 'smarthouse-*' 2>/dev/null | grep -q smarthouse; then
    ok "systemd timer 登録済み"
    systemctl --user list-timers 'smarthouse-*' --no-pager 2>/dev/null | sed 's/^/     /' | head -12
  else
    warn "systemd timer 未登録（自動実行されません）"
  fi
fi

echo ""
echo "【7】入力データ"
IN="$BASE_DIR/$INPUT_DIR"
if [[ -d "$IN" ]]; then
  CNT="$(list_input_files "$IN" | grep -c '^/' || true)"
  if [[ "$CNT" -gt 0 ]]; then ok "$INPUT_DIR/ に $CNT 件"; list_input_files "$IN" | sed "s|$BASE_DIR/|     |"
  else warn "$INPUT_DIR/ にデータがありません → レポートは「データなし」になります"; fi
else
  ng "$INPUT_DIR/ がありません"
fi

echo ""
echo "【8】直近の出力"
for d in daily weekly monthly; do
  LATEST="$(ls -1t "$OUTPUT_DIR/$d"/*.md 2>/dev/null | head -3 || true)"
  if [[ -n "$LATEST" ]]; then
    echo "  output/$d/"; echo "$LATEST" | sed "s|$OUTPUT_DIR/$d/|     |"
  else
    echo "  output/$d/ ： まだ出力なし"
  fi
done

echo ""
echo "【9】直近のログ"
LATEST_LOGS="$(ls -1t "$LOG_DIR"/*.log 2>/dev/null | head -5 || true)"
if [[ -n "$LATEST_LOGS" ]]; then
  echo "$LATEST_LOGS" | while read -r l; do
    # grep -c は0件のとき終了コード1を返すので || true で受ける（echo 0 だと値が二重になる）
    ERR="$(grep -c 'ERROR' "$l" 2>/dev/null || true)"
    ERR="${ERR:-0}"
    if [[ "$ERR" -gt 0 ]]; then echo "  🚨 $(basename "$l") （エラー ${ERR}件）"
    else echo "  ✅ $(basename "$l")"; fi
  done
else
  echo "  まだログがありません"
fi
OLD="$(find "$LOG_DIR" -maxdepth 1 -name '*.log' -mtime "+$LOG_RETENTION_DAYS" 2>/dev/null | wc -l)"
[[ "$OLD" -gt 0 ]] && warn "${LOG_RETENTION_DAYS}日より古いログが ${OLD}件あります（自動削除はしません）"

echo ""
echo "════════════════════════════════════════════"
if [[ $NG -eq 0 ]]; then
  echo " ✅ 問題は見つかりませんでした。"
else
  echo " 🚨 ${NG}件の問題があります。上の 🚨 を確認してください。"
fi
echo "════════════════════════════════════════════"
exit $NG
