#!/usr/bin/env bash
# 週次ルーティン（月曜経営会議レポート）（毎週月曜 10:00）をまとめて実行します。
#   ./scripts/run_weekly.sh [--force] [--date YYYY-MM-DD] [--input DIR] [--tag NAME] [--dry-run]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/run_group.sh" weekly "$@"
