#!/usr/bin/env bash
# 金曜週間レビュー を単体で実行します。
#   ./scripts/run_06_friday_review.sh [--force] [--date YYYY-MM-DD] [--input DIR] [--tag NAME] [--dry-run]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/run_routine.sh" friday_review "$@"
