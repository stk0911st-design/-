#!/usr/bin/env bash
# 月次ルーティン（月次経営分析）（毎月1日 10:00）をまとめて実行します。
#   ./scripts/run_monthly.sh [--force] [--date YYYY-MM-DD] [--input DIR] [--tag NAME] [--dry-run]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/run_group.sh" monthly "$@"
