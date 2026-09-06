#!/usr/bin/env bash
# 朝のルーティン（社長ダッシュボード＋在庫監視）（毎営業日 9:30 / 9:40）をまとめて実行します。
#   ./scripts/run_morning.sh [--force] [--date YYYY-MM-DD] [--input DIR] [--tag NAME] [--dry-run]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/run_group.sh" morning "$@"
