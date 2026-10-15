#!/usr/bin/env bash
# 金曜ルーティン（週間レビュー）（毎週金曜 18:00）をまとめて実行します。
#   ./scripts/run_friday.sh [--force] [--date YYYY-MM-DD] [--input DIR] [--tag NAME] [--dry-run]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/run_group.sh" weekly_friday "$@"
