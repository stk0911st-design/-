# 不動産デイリーチェック

毎日の不動産情報チェックを半自動化する仕組みです。
**レインズ（不動産流通標準情報システム）へのログイン・自動巡回は行いません。**

## なぜレインズを直接見に行かないのか

- レインズは宅建業者専用のクローズドシステムで、会員ID・パスワードが必要
- 会員規約により、会員以外への情報提供や自動収集・スクレイピングは禁止
- したがって「レインズからの情報取得は人（会員）が手動で行い、その後の加工・比較・
  レポート化を自動化する」という役割分担にしている

## 全体の流れ

```
[人] レインズにログインしてCSVエクスポート
        ↓  data/reins_export/ に保存
[自動] normalize_reins.py  … 列名の揺れ・文字コードを吸収して日次スナップショット化
[自動] diff_snapshots.py   … 前日との差分（新規 / 値下げ / 掲載終了 / その他変更）
[自動] fetch_public.py     … 国交省「不動産情報ライブラリ」から公開の取引価格を取得
[自動] daily_report.py     … data/reports/YYYY-MM-DD.md にレポート出力
```

## 使い方

```bash
# 1. 当日のレインズCSVを data/reins_export/ に置く
# 2. 一括実行
./run_daily.sh
```

個別に動かす場合:

```bash
python3 scripts/normalize_reins.py            # CSV -> data/snapshots/<日付>.json
python3 scripts/diff_snapshots.py --json      # 差分をJSONで確認
python3 scripts/fetch_public.py               # 公開データの取得（要APIキー）
python3 scripts/daily_report.py               # レポート生成
```

Python 3.9+ の標準ライブラリだけで動きます（追加インストール不要）。

## 設定

### `config/search_criteria.json`

追いかけたい物件条件。`null` や `[]` は「条件なし」として無視されます。

| 項目 | 意味 | 例 |
| --- | --- | --- |
| `areas` | 所在地・沿線・駅名に含まれるキーワード（いずれか一致） | `["世田谷区", "杉並区"]` |
| `area_exclude` | 除外したいエリア | `["埋立地"]` |
| `property_types` | 物件種目（部分一致） | `["戸建", "土地"]` |
| `price_min_man` / `price_max_man` | 価格（万円） | `3000` / `8000` |
| `land_area_min_sqm` | 土地面積の下限（㎡） | `100` |
| `building_area_min_sqm` | 建物面積の下限（㎡） | `80` |
| `walk_minutes_max` | 駅徒歩の上限（分） | `10` |
| `built_year_min` | 築年の下限（西暦） | `2000` |
| `keywords_any` / `keywords_none` | 全項目を対象にした含む／含まないキーワード | `["角地"]` / `["借地"]` |
| `report.price_drop_threshold_pct` | 何%以上の価格変動を報告するか | `3.0` |

### `config/field_mapping.json`

レインズCSVの列名は出力形式によって違うので、`正規化名 → 候補列名` の対応表で吸収します。
手元のCSVの列名が拾われていないときは、ここに追記してください。

### 公開データのAPIキー（任意）

国土交通省「不動産情報ライブラリ」の不動産取引価格情報APIを使う場合のみ必要です。
申請して取得したキーを環境変数に設定します。

```bash
export REINFOLIB_API_KEY="取得したキー"
```

未設定でも日次処理は止まらず、公開データのセクションが省略されるだけです。

## 出力

- `data/snapshots/YYYY-MM-DD.json` … 正規化済みの当日データ（差分計算の元）
- `data/reports/YYYY-MM-DD.md` … 日次レポート
- `data/public/` … 公開データのキャッシュと相場サマリ

## 情報の取り扱い

- `data/` 配下は `.gitignore` で除外しており、リポジトリには一切コミットされません
- レインズ由来の物件情報は会員規約の範囲内でのみ利用してください（会員外への提供・公開は不可）
- スナップショットは自動削除しません（過去の差分を追えるように残します）
