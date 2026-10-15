#!/usr/bin/env bash
# 在庫監視 を単体で実行します。
#   ./scripts/run_02_inventory_watch.sh [--force] [--date YYYY-MM-DD] [--input DIR] [--tag NAME] [--dry-run]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/run_routine.sh" inventory_watch "$@"
