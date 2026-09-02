#!/usr/bin/env bash
# ─────────────────────────────────────────────
# ルーティン実行スクリプト（共通ランナー）
#
#   ./scripts/run_routine.sh <ルーティンkey> [オプション]
#
# オプション:
#   --force            営業日でなくても実行する
#   --date YYYY-MM-DD  基準日を指定する（過去分の作り直しなど）
#   --input DIR        入力ディレクトリを変更する（既定: config/runtime.env の INPUT_DIR）
#   --tag NAME         出力ファイル名に _NAME を付ける（テスト用）
#   --dry-run          Claude を呼ばず、渡すプロンプトだけ表示する
#   --list             ルーティン一覧を表示して終了
#
# 安全:
#   - ファイルの削除は一切行いません。
#   - 出力ファイルが既にある場合は上書きせず連番を付けます。
#   - input/ 配下には書き込みません（実行前後でチェックサムを比較します）。
#   - --dangerously-skip-permissions は使いません。
# ─────────────────────────────────────────────

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/common.sh"

FORCE=0
DRY_RUN=0
RUN_DATE=""
TAG=""
KEY=""

usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)   FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --date)    RUN_DATE="${2:-}"; shift 2 ;;
    --input)   INPUT_DIR="${2:-}"; shift 2 ;;
    --tag)     TAG="${2:-}"; shift 2 ;;
    --list)    python3 "$SCHEDULE_PY" list; exit 0 ;;
    -h|--help) usage; exit 0 ;;
    -*)        echo "不明なオプション: $1" >&2; usage; exit 2 ;;
    *)         KEY="$1"; shift ;;
  esac
done

if [[ -z "$KEY" ]]; then
  echo "ルーティンkeyを指定してください。" >&2
  echo "" >&2
  python3 "$SCHEDULE_PY" list >&2
  exit 2
fi

log_init "$KEY"

if ! preflight; then
  log_err "事前チェックに失敗しました。中止します。"
  exit 1
fi

# ── ルーティン定義の取得 ────────────────────
NAME="$(python3 "$SCHEDULE_PY" get "$KEY" name)"
PROMPT_REL="$(python3 "$SCHEDULE_PY" get "$KEY" prompt)"
PERIOD="$(python3 "$SCHEDULE_PY" get "$KEY" period)"
OUT_NAME="$(python3 "$SCHEDULE_PY" get "$KEY" output_name)"
PROMPT_FILE="$BASE_DIR/$PROMPT_REL"

if [[ ! -f "$PROMPT_FILE" ]]; then
  log_err "プロンプトファイルがありません: $PROMPT_FILE"
  exit 1
fi

TODAY="${RUN_DATE:-$(date '+%Y-%m-%d')}"
WEEKDAY_JA="$(python3 -c "
import datetime,sys
d=datetime.datetime.strptime('$TODAY','%Y-%m-%d').date()
print('月火水木金土日'[d.weekday()])")"

log "ルーティン : $NAME ($KEY)"
log "基準日     : $TODAY($WEEKDAY_JA)"
log "入力       : $INPUT_DIR"

# ── 営業日・スケジュール判定 ────────────────
if [[ $FORCE -eq 1 ]]; then
  log_warn "--force 指定のためスケジュール判定をスキップします。"
else
  if ! SCHED_MSG="$(python3 "$SCHEDULE_PY" should-run "$KEY" "$TODAY")"; then
    log "$SCHED_MSG"
    log_ok "本日は実行対象外のため、正常終了します。"
    exit 0
  fi
  log "$SCHED_MSG"
fi

# ── 出力先の決定 ────────────────────────────
case "$PERIOD" in
  daily)   OUT_SUBDIR="daily";   FILE_BASE="${TODAY}_${OUT_NAME}" ;;
  weekly)  OUT_SUBDIR="weekly";  FILE_BASE="${TODAY}_${OUT_NAME}" ;;
  monthly) OUT_SUBDIR="monthly"; FILE_BASE="$(date -d "$TODAY" '+%Y-%m')_${OUT_NAME}" ;;
  *)       log_err "不明な period: $PERIOD"; exit 1 ;;
esac
[[ -n "$TAG" ]] && FILE_BASE="${FILE_BASE}_${TAG}"

DESIRED_OUT="$OUTPUT_DIR/$OUT_SUBDIR/${FILE_BASE}.md"
OUT_PATH="$(safe_output_path "$DESIRED_OUT")"
if [[ "$OUT_PATH" != "$DESIRED_OUT" ]]; then
  log_warn "同名ファイルが既にあるため上書きせず別名で保存します: $(basename "$OUT_PATH")"
fi
log "出力先     : ${OUT_PATH#"$BASE_DIR"/}"

# ── 入力データの確認 ────────────────────────
INPUT_ABS="$BASE_DIR/$INPUT_DIR"
[[ "$INPUT_DIR" = /* ]] && INPUT_ABS="$INPUT_DIR"

INPUT_LIST="$(list_input_files "$INPUT_ABS")"
INPUT_COUNT="$(echo "$INPUT_LIST" | grep -c '^/' || true)"
log "入力ファイル数: $INPUT_COUNT"
if [[ "$INPUT_COUNT" -eq 0 ]]; then
  log_warn "入力ファイルが見つかりません。レポートは「データなし」中心の内容になります。"
fi

CHECKSUM_BEFORE="$TMP_DIR/${RUN_ID}_${KEY}_input_before.md5"
input_checksum "$INPUT_ABS" > "$CHECKSUM_BEFORE"

# ── プロンプト組み立て ──────────────────────
PROMPT_TMP="$TMP_DIR/${RUN_ID}_${KEY}_prompt.md"
{
  cat "$PROMPT_DIR/00_common_rules.md"
  echo ""
  echo "---"
  echo ""
  echo "# 実行コンテキスト（このセクションは実行スクリプトが自動生成しています）"
  echo ""
  echo "| 項目 | 値 |"
  echo "| --- | --- |"
  echo "| 本日の日付 | ${TODAY}（${WEEKDAY_JA}曜） |"
  echo "| タイムゾーン | ${TZ} |"
  echo "| ルーティン | ${NAME} |"
  echo "| 作業ディレクトリ | ${BASE_DIR} |"
  echo "| 入力ディレクトリ | ${INPUT_DIR} |"
  echo "| 会社ルール | CLAUDE.md（必ず読むこと） |"
  echo "| 基準値 | config/company.json（必ず読むこと） |"
  echo "| 過去レポート | output/daily, output/weekly, output/monthly |"
  echo ""
  echo "## 入力ディレクトリにあるファイル（このファイル群だけを読み込み対象にしてください）"
  echo ""
  echo '```'
  echo "$INPUT_LIST"
  echo '```'
  echo ""
  echo "※ 上記以外のファイルを勝手に探しに行かないでください。"
  echo "※ 入力ファイルは読み取りのみ。変更・削除しないでください。"
  echo "※ レポート本文だけを標準出力に書いてください。ファイルの作成・書き込みはしないでください。"
  echo ""
  echo "---"
  echo ""
  cat "$PROMPT_FILE"
} > "$PROMPT_TMP"

log "プロンプト : ${PROMPT_TMP#"$BASE_DIR"/}（$(wc -c < "$PROMPT_TMP") bytes）"

if [[ $DRY_RUN -eq 1 ]]; then
  log_warn "--dry-run のため Claude は実行しません。プロンプトを表示します。"
  echo "────────────── プロンプトここから ──────────────"
  cat "$PROMPT_TMP"
  echo "────────────── プロンプトここまで ──────────────"
  log_ok "dry-run 完了。"
  exit 0
fi

# ── Claude 実行 ─────────────────────────────
CLAUDE_ARGS=(-p --output-format "$CLAUDE_OUTPUT_FORMAT" --allowed-tools "$CLAUDE_ALLOWED_TOOLS")
[[ -n "$CLAUDE_MODEL" ]] && CLAUDE_ARGS+=(--model "$CLAUDE_MODEL")

PARTIAL="$TMP_DIR/${RUN_ID}_${KEY}_output.md"
STDERR_FILE="$TMP_DIR/${RUN_ID}_${KEY}_stderr.log"

log "Claude 実行中...（タイムアウト ${ROUTINE_TIMEOUT_SECONDS}秒）"
START_TS=$(date +%s)
# プロンプトは標準入力から渡します。
#   理由1: --allowed-tools が可変長オプションのため、位置引数のプロンプトを飲み込んでしまう
#   理由2: コマンドライン引数の長さ制限を受けない
set +e
( cd "$BASE_DIR" && timeout "$ROUTINE_TIMEOUT_SECONDS" \
    "$CLAUDE_BIN" "${CLAUDE_ARGS[@]}" < "$PROMPT_TMP" ) \
    > "$PARTIAL" 2> "$STDERR_FILE"
CLAUDE_EXIT=$?
set -e
END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))
log "実行時間   : ${ELAPSED}秒 / 終了コード: $CLAUDE_EXIT"

if [[ -s "$STDERR_FILE" ]]; then
  log_warn "標準エラー出力あり（ログに記録します）"
  { echo "----- claude stderr -----"; cat "$STDERR_FILE"; echo "----- ここまで -----"; } >> "$LOG_FILE"
fi

if [[ $CLAUDE_EXIT -eq 124 ]]; then
  log_err "タイムアウトしました（${ROUTINE_TIMEOUT_SECONDS}秒）。config/runtime.env の ROUTINE_TIMEOUT_SECONDS を見直してください。"
  log_err "途中出力: ${PARTIAL#"$BASE_DIR"/}"
  exit 1
fi
if [[ $CLAUDE_EXIT -ne 0 ]]; then
  log_err "Claude の実行に失敗しました（終了コード $CLAUDE_EXIT）。"
  log_err "詳細: ${STDERR_FILE#"$BASE_DIR"/}"
  exit 1
fi

# ── 出力の検証 ──────────────────────────────
OUT_BYTES=$(wc -c < "$PARTIAL")
if [[ "$OUT_BYTES" -lt 100 ]]; then
  log_err "出力が短すぎます（${OUT_BYTES} bytes）。レポートとして保存しません。"
  log_err "内容: $(head -c 300 "$PARTIAL")"
  exit 1
fi

# json 形式の場合は result フィールドを取り出す
if [[ "$CLAUDE_OUTPUT_FORMAT" == "json" ]]; then
  EXTRACTED="$TMP_DIR/${RUN_ID}_${KEY}_result.md"
  if python3 -c "
import json,sys
d=json.load(open('$PARTIAL',encoding='utf-8'))
t=d.get('result') or d.get('text') or ''
open('$EXTRACTED','w',encoding='utf-8').write(t)
sys.exit(0 if t.strip() else 1)
"; then
    PARTIAL="$EXTRACTED"
    log "JSON出力から result を取り出しました。"
  else
    log_err "JSON出力から本文を取り出せませんでした。生のJSONを保存します。"
  fi
fi

# ── 入力データが変更されていないか確認 ──────
CHECKSUM_AFTER="$TMP_DIR/${RUN_ID}_${KEY}_input_after.md5"
input_checksum "$INPUT_ABS" > "$CHECKSUM_AFTER"
if diff -q "$CHECKSUM_BEFORE" "$CHECKSUM_AFTER" > /dev/null 2>&1; then
  log_ok "入力データは変更されていません（チェックサム一致）。"
else
  log_err "入力データが変更された可能性があります。差分を確認してください。"
  diff "$CHECKSUM_BEFORE" "$CHECKSUM_AFTER" >> "$LOG_FILE" 2>&1 || true
fi

# ── 保存 ────────────────────────────────────
OUT_PATH="$(safe_output_path "$DESIRED_OUT")"
cp "$PARTIAL" "$OUT_PATH"
log_ok "レポートを保存しました: ${OUT_PATH#"$BASE_DIR"/}（$(wc -c < "$OUT_PATH") bytes / $(wc -l < "$OUT_PATH") 行）"
log_ok "完了: $NAME"
echo ""
echo "出力ファイル: $OUT_PATH"
echo "ログ        : $LOG_FILE"
