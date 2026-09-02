#!/usr/bin/env sh
# 当日の日記ファイルをテンプレートから作成する（既存なら上書きしない）
set -eu

DATE="${1:-$(date +%Y-%m-%d)}"
YEAR=$(echo "$DATE" | cut -d- -f1)
MONTH=$(echo "$DATE" | cut -d- -f2)
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/MY-LIFE/03_日記/$YEAR/$MONTH/$DATE.md"

if [ -f "$OUT" ]; then
  echo "既に存在します（上書きしません）: $OUT"
  exit 0
fi

mkdir -p "$(dirname "$OUT")"
sed "s/YYYY-MM-DD/$DATE/" "$ROOT/MY-LIFE/10_資料保管/テンプレート/日記.md" > "$OUT"
echo "作成しました: $OUT"
