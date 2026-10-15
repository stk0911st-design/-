#!/usr/bin/env bash
# 月曜経営会議レポート を単体で実行します。
#   ./scripts/run_05_weekly_management.sh [--force] [--date YYYY-MM-DD] [--input DIR] [--tag NAME] [--dry-run]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/run_routine.sh" weekly_management "$@"
