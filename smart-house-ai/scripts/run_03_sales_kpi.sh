#!/usr/bin/env bash
# 営業KPI を単体で実行します。
#   ./scripts/run_03_sales_kpi.sh [--force] [--date YYYY-MM-DD] [--input DIR] [--tag NAME] [--dry-run]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/run_routine.sh" sales_kpi "$@"
