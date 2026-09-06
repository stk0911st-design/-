#!/usr/bin/env bash
# 社長ダッシュボード を単体で実行します。
#   ./scripts/run_01_morning_ceo_dashboard.sh [--force] [--date YYYY-MM-DD] [--input DIR] [--tag NAME] [--dry-run]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/run_routine.sh" morning_ceo_dashboard "$@"
