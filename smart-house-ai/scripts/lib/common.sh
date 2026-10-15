#!/usr/bin/env bash
# ─────────────────────────────────────────────
# 共通関数ライブラリ
#
# 安全方針:
#   - 削除系コマンド（rm / rmdir / find -delete 等）は一切使いません。
#   - 既存の出力ファイルを上書きしません（連番を付けます）。
#   - input/ 配下には一切書き込みません。
# ─────────────────────────────────────────────

set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG_DIR="$BASE_DIR/config"
PROMPT_DIR="$BASE_DIR/prompts"
OUTPUT_DIR="$BASE_DIR/output"
LOG_DIR="$BASE_DIR/logs"
TMP_DIR="$LOG_DIR/tmp"
SCHEDULE_PY="$BASE_DIR/scripts/lib/schedule.py"

mkdir -p "$LOG_DIR" "$TMP_DIR" "$OUTPUT_DIR/daily" "$OUTPUT_DIR/weekly" "$OUTPUT_DIR/monthly"

# ── 設定読み込み ────────────────────────────
CLAUDE_BIN="claude"
CLAUDE_OUTPUT_FORMAT="text"
CLAUDE_MODEL=""
ROUTINE_TIMEOUT_SECONDS="900"
INPUT_DIR="input"
LOG_RETENTION_DAYS="180"
CLAUDE_ALLOWED_TOOLS="Read,Glob,Grep"

if [[ -f "$CONFIG_DIR/runtime.env" ]]; then
  # shellcheck disable=SC1091
  source "$CONFIG_DIR/runtime.env"
fi

# タイムゾーンを config/schedule.json に合わせる（日付がJSTでずれないように）
SH_TZ="$(python3 -c "import json;print(json.load(open('$CONFIG_DIR/schedule.json')).get('timezone','Asia/Tokyo'))" 2>/dev/null || echo "Asia/Tokyo")"
export TZ="$SH_TZ"

RUN_ID="$(date '+%Y%m%d_%H%M%S')"

# ── ログ ────────────────────────────────────
LOG_FILE=""

log_init() {
  local name="$1"
  LOG_FILE="$LOG_DIR/$(date '+%Y-%m-%d')_${name}_${RUN_ID}.log"
  {
    echo "════════════════════════════════════════════"
    echo " 株式会社スマートハウス AI経営管理ルーティン"
    echo " ルーティン : $name"
    echo " 開始日時   : $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo " 実行ホスト : $(hostname 2>/dev/null || echo unknown)"
    echo " 作業ディレクトリ : $BASE_DIR"
    echo "════════════════════════════════════════════"
  } >> "$LOG_FILE"
}

log()      { local m="[$(date '+%H:%M:%S')] $*"; echo "$m"; [[ -n "$LOG_FILE" ]] && echo "$m" >> "$LOG_FILE" || true; }
log_ok()   { log "✅ $*"; }
log_warn() { log "⚠️  $*"; }
log_err()  { local m="[$(date '+%H:%M:%S')] 🚨 ERROR: $*"; echo "$m" >&2; [[ -n "$LOG_FILE" ]] && echo "$m" >> "$LOG_FILE" || true; }

# ── 上書き防止 ──────────────────────────────
# 既存ファイルがある場合は _2, _3 ... と連番を付けたパスを返す
safe_output_path() {
  local path="$1"
  if [[ ! -e "$path" ]]; then
    echo "$path"; return 0
  fi
  local dir base ext n
  dir="$(dirname "$path")"
  base="$(basename "$path")"
  ext=""
  if [[ "$base" == *.* ]]; then
    ext=".${base##*.}"
    base="${base%.*}"
  fi
  n=2
  while [[ -e "$dir/${base}_${n}${ext}" ]]; do
    n=$((n + 1))
    if [[ $n -gt 99 ]]; then
      log_err "同名ファイルが多すぎます: $path"
      return 1
    fi
  done
  echo "$dir/${base}_${n}${ext}"
}

# ── 入力データの一覧（読み取りのみ） ─────────
list_input_files() {
  local dir="$1"
  if [[ ! -d "$dir" ]]; then
    echo "（入力ディレクトリが存在しません: $dir）"
    return 0
  fi
  local found
  found="$(find "$dir" -type f \
      \( -iname '*.csv' -o -iname '*.tsv' -o -iname '*.xlsx' -o -iname '*.xls' \
         -o -iname '*.md' -o -iname '*.txt' -o -iname '*.json' \) \
      -not -name '.*' 2>/dev/null | sort || true)"
  if [[ -z "$found" ]]; then
    echo "（対象ファイルが1件もありません）"
  else
    echo "$found"
  fi
}

# ── 入力データの改ざん検知（読み取りのみ） ───
input_checksum() {
  local dir="$1"
  if [[ ! -d "$dir" ]]; then echo "no-input-dir"; return 0; fi
  find "$dir" -type f -not -name '.*' 2>/dev/null | sort | while read -r f; do
    printf '%s  %s\n' "$(md5sum "$f" 2>/dev/null | awk '{print $1}')" "${f#"$BASE_DIR"/}"
  done
}

# ── 事前チェック ────────────────────────────
preflight() {
  local ok=0
  if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
    log_err "Claude Code が見つかりません（CLAUDE_BIN=$CLAUDE_BIN）。config/runtime.env を確認してください。"
    ok=1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    log_err "python3 が見つかりません。スケジュール判定に必要です。"
    ok=1
  fi
  if [[ ! -f "$CONFIG_DIR/schedule.json" ]]; then
    log_err "config/schedule.json がありません。"
    ok=1
  fi
  return $ok
}
