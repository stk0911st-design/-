#!/usr/bin/env bash
# 夕方のルーティン（営業KPI＋新規案件査定）（毎営業日 18:00 / 18:15）をまとめて実行します。
#   ./scripts/run_evening.sh [--force] [--date YYYY-MM-DD] [--input DIR] [--tag NAME] [--dry-run]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/run_group.sh" evening "$@"
