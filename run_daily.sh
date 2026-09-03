#!/usr/bin/env bash
# 毎日の不動産チェックを一括で回す。
#   ./run_daily.sh
#
# 事前準備: レインズでエクスポートしたCSVを置く
#   data/reins_export/売出/  … 販売中（売出）物件
#   data/reins_export/成約/  … 成約物件
set -uo pipefail
cd "$(dirname "$0")"

echo "=== 1/3 レインズCSVの正規化 ==="
python3 scripts/normalize_reins.py || echo "  → CSVが無いのでスキップしました"

echo "=== 2/3 公開データ（国交省）の取得 ==="
python3 scripts/fetch_public.py

echo "=== 3/3 日次レポート作成 ==="
python3 scripts/daily_report.py
