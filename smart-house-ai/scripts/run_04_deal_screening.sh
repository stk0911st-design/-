#!/usr/bin/env bash
# 新規案件査定 を単体で実行します。
#   ./scripts/run_04_deal_screening.sh [--force] [--date YYYY-MM-DD] [--input DIR] [--tag NAME] [--dry-run]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/run_routine.sh" deal_screening "$@"
