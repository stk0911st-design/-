#!/usr/bin/env bash
# ─────────────────────────────────────────────
# グループ一括実行（config/schedule.json の group で束ねます）
#   ./scripts/run_group.sh <グループ名> [オプション]
#
# 1本が失敗しても残りは実行し、最後にまとめて結果を報告します。
# ─────────────────────────────────────────────
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/common.sh"

# common.sh が set -e を有効にするため、ここで明示的に無効化します。
# グループ実行では 1本が失敗しても残りを最後まで実行する必要があるためです。
set +e

GROUP="${1:-}"
if [[ -z "$GROUP" ]]; then
  echo "使い方: ./scripts/run_group.sh <グループ名> [オプション]" >&2
  echo "グループ: morning / evening / weekly / weekly_friday / monthly" >&2
  exit 2
fi
shift || true

log_init "group_${GROUP}"
log "グループ実行を開始します: $GROUP"

if ! KEYS="$(python3 "$SCHEDULE_PY" group "$GROUP" 2>&1)"; then
  log_err "$KEYS"
  exit 1
fi

TOTAL=0; SUCCESS=0; SKIPPED=0; FAILED=0
declare -a RESULTS=()

while read -r key; do
  [[ -z "$key" ]] && continue
  TOTAL=$((TOTAL + 1))
  log "─────────────────────────────────────"
  log "▶ 実行: $key"
  OUT="$("$SCRIPT_DIR/run_routine.sh" "$key" "$@" 2>&1)"
  RC=$?
  echo "$OUT" | sed 's/^/    /'
  echo "$OUT" >> "$LOG_FILE"
  if [[ $RC -ne 0 ]]; then
    FAILED=$((FAILED + 1)); RESULTS+=("🚨 失敗   : $key")
  elif echo "$OUT" | grep -q "実行対象外"; then
    SKIPPED=$((SKIPPED + 1)); RESULTS+=("⏭  スキップ: $key")
  else
    SUCCESS=$((SUCCESS + 1)); RESULTS+=("✅ 完了   : $key")
  fi
done <<< "$KEYS"

log "─────────────────────────────────────"
log "【グループ実行結果】$GROUP"
for r in "${RESULTS[@]}"; do log "  $r"; done
log "  合計 $TOTAL 件 / 完了 $SUCCESS / スキップ $SKIPPED / 失敗 $FAILED"
log "  ログ: ${LOG_FILE#"$BASE_DIR"/}"

[[ $FAILED -gt 0 ]] && exit 1
exit 0
