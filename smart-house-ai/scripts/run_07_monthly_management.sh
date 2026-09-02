#!/usr/bin/env bash
# 月次経営分析 を単体で実行します。
#   ./scripts/run_07_monthly_management.sh [--force] [--date YYYY-MM-DD] [--input DIR] [--tag NAME] [--dry-run]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/run_routine.sh" monthly_management "$@"
