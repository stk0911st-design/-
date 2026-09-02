# 株式会社スマートハウス AI経営管理ルーティンシステム

Claude Code を「質問に答えるAI」ではなく、
**毎日・毎週・毎月、会社の情報を自動で整理・分析し、社長が判断すべきことをまとめるAI経営補佐**
として動かすための仕組みです。

---

## ① 何を作ったか

`input/` フォルダに会社のデータ（CSV・Excel・メモなど）を置いておくと、
決まった時刻に AI がそれを読んで、レポートを `output/` に自動で作ります。

作ったレポートは7種類です。

| # | レポート | いつ | 内容 |
| --- | --- | --- | --- |
| 1 | 社長ダッシュボード | 毎営業日 9:30 | 会社の今の状態と、今日やることTOP5 |
| 2 | 在庫監視 | 毎営業日 9:40 | 物件を1件ずつ点検してA〜Eに分類。長期在庫を警告 |
| 3 | 営業KPI | 毎営業日 18:00 | 営業担当者ごとの活動量と成果、明日の行動 |
| 4 | 新規案件査定 | 毎営業日 18:15 | その日の案件をS〜Dで判定し「いくらなら買うか」を提示 |
| 5 | 経営会議レポート | 毎週月曜 10:00 | 先週の総括と今週やること |
| 6 | 週間レビュー | 毎週金曜 18:00 | 今週の締めと「来週放置すると危険なこと」 |
| 7 | 月次経営分析 | 毎月1日 10:00 | 前月分析と、今月の重点目標5つ |

### 🚨 このシステムが「絶対にしないこと」

安全のため、以下は**仕組みとして禁止**しています（設定ファイルでブロック済み）。

- ファイルを削除しない
- 既存のレポートを上書きしない（同名なら `_2` `_3` と連番を付ける）
- **メールを送らない**
- **Slack・LINE・SNSに投稿しない**
- **銀行・顧客・取引先に何も送らない**
- **Webに公開しない**
- **git push / git commit をしない**
- **支払い・購入・契約・送金をしない**
- `input/` のデータを一切変更しない（実行のたびにチェックサムで確認しています）

やるのは **「読む → 集計する → 分析する → 警告する → レポートを書く」** だけです。

### 🚨 AIが数字を作らない仕組み

入力データに無い数字を、AIが「たぶんこれくらい」で埋めてしまうと危険です。
そのため、データが無い項目は必ず次のように書くルールにしています。

- `データなし` … そのデータが存在しない
- `不明` … 値が分からない
- `要確認` … 値はあるが信用できない
- `仮定` … 試算のために置いた前提（置いた値も必ず書く）

**レポートに具体的な金額が書いてあれば、それは必ず入力データに根拠があります。**

---

## ② フォルダ構成

```
smart-house-ai/
├── CLAUDE.md              会社の共通ルール（AIが毎回読む）
├── README.md              このファイル
├── .gitignore             実データをgitに入れないための設定
├── .claude/
│   └── settings.json      安全設定（何を許可し、何を禁止するか）
├── config/                ★ 設定を変えるならここ
│   ├── schedule.json        曜日・時刻・休日の設定
│   ├── company.json         粗利率・金利などの基準値
│   └── runtime.env          実行環境の設定
├── prompts/               AIへの指示書（7種類＋共通ルール）
│   ├── 00_common_rules.md
│   ├── 01_morning_ceo_dashboard.md
│   ├── 02_inventory_watch.md
│   ├── 03_sales_kpi.md
│   ├── 04_deal_screening.md
│   ├── 05_weekly_management.md
│   ├── 06_friday_review.md
│   └── 07_monthly_management.md
├── scripts/               実行スクリプト
│   ├── run_routine.sh       共通ランナー（すべての実行はここを通る）
│   ├── run_01〜07_*.sh      個別実行
│   ├── run_morning.sh       朝まとめて実行
│   ├── run_evening.sh       夕方まとめて実行
│   ├── run_weekly.sh        月曜まとめて実行
│   ├── run_friday.sh        金曜まとめて実行
│   ├── run_monthly.sh       月初まとめて実行
│   ├── install_schedule.sh  自動実行の登録
│   ├── uninstall_schedule.sh 自動実行の停止
│   ├── healthcheck.sh       ★ 困ったらまずこれ
│   └── lib/
│       ├── common.sh
│       └── schedule.py
├── input/                 ★ ここに会社のデータを置く
├── output/                レポートの出力先
│   ├── daily/
│   ├── weekly/
│   └── monthly/
├── logs/                  実行ログ（トラブル時に見る）
├── archive/               古いデータの保管場所
└── sample/                テスト用の架空データ
```

---

## ③ 毎日の動き

```
  朝 9:30  ─┐
            ├─ AIが input/ を読む → output/daily/ にレポートを保存
  朝 9:40  ─┘

  夕 18:00 ─┐
            ├─ AIが input/ を読む → output/daily/ にレポートを保存
  夕 18:15 ─┘

  月曜 10:00 → output/weekly/ に経営会議レポート
  金曜 18:00 → output/weekly/ に週間レビュー
  1日 10:00 → output/monthly/ に月次経営分析
```

**社長がやること**は2つだけです。

1. `input/` に最新のデータを置いておく（週1回でも構いません）
2. 朝、`output/daily/` の最新レポートを開いて読む

**水曜日と日曜日は会社休日**として設定しているため、ルーティンは動きません。

---

## ④ 手動実行方法

ターミナル（黒い画面）を開いて、まずこのフォルダに移動します。

```bash
cd /home/user/-/smart-house-ai
```

### 1本だけ動かす

```bash
./scripts/run_01_morning_ceo_dashboard.sh    # 社長ダッシュボード
./scripts/run_02_inventory_watch.sh          # 在庫監視
./scripts/run_03_sales_kpi.sh                # 営業KPI
./scripts/run_04_deal_screening.sh           # 新規案件査定
./scripts/run_05_weekly_management.sh        # 経営会議レポート
./scripts/run_06_friday_review.sh            # 週間レビュー
./scripts/run_07_monthly_management.sh       # 月次経営分析
```

### まとめて動かす

```bash
./scripts/run_morning.sh     # 朝の2本（ダッシュボード＋在庫）
./scripts/run_evening.sh     # 夕方の2本（営業KPI＋案件査定）
./scripts/run_weekly.sh      # 月曜の1本
./scripts/run_friday.sh      # 金曜の1本
./scripts/run_monthly.sh     # 月初の1本
```

### 便利なオプション

| オプション | 意味 | 使いどころ |
| --- | --- | --- |
| `--force` | 休日でも実行する | 休みの日に確認したいとき |
| `--date 2026-09-01` | 日付を指定して作り直す | 過去分を作りたいとき |
| `--input sample/input` | 読み込み先を変える | サンプルで試すとき |
| `--tag TEST` | 出力名に `_TEST` を付ける | 本番レポートと混ぜたくないとき |
| `--dry-run` | AIを呼ばず、指示内容だけ表示 | 動作確認だけしたいとき（無料） |

```bash
# 例：サンプルデータで安全に試す
./scripts/run_01_morning_ceo_dashboard.sh --input sample/input --tag SAMPLE --force

# 例：昨日分を作り直す
./scripts/run_01_morning_ceo_dashboard.sh --date 2026-09-01
```

実行が終わると、最後に**出力ファイルの場所**と**ログの場所**が表示されます。

---

## ⑤ 自動実行方法

### 🚨 まず「登録内容の確認」から

いきなり登録はしません。まず**何が登録されるかを表示するだけ**のコマンドを実行します。

```bash
./scripts/install_schedule.sh
```

画面に登録予定のスケジュールが出るので、内容を確認してください。
**この時点では何も登録されていません。**

### 実際に登録する

内容に問題がなければ `--apply` を付けます。
さらに `yes` と入力しないと登録されません（2段階の確認）。

```bash
# Linux（cron がある場合）
./scripts/install_schedule.sh --method cron --apply

# Linux（systemd の場合）
./scripts/install_schedule.sh --method systemd --apply
```

登録前に既存の crontab を `logs/` に自動退避するので、元に戻せます。

### 登録できたか確認する

```bash
crontab -l                                    # cron の場合
systemctl --user list-timers 'smarthouse-*'   # systemd の場合
```

### macOS・Windows の場合

このPCは **Linux** なので上記の方法になりますが、他のOSでは次のようにします。

<details>
<summary>macOS（launchd）の手順</summary>

`~/Library/LaunchAgents/com.smarthouse.ceo-dashboard.plist` を作成します。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.smarthouse.ceo-dashboard</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/path/to/smart-house-ai/scripts/run_routine.sh</string>
    <string>morning_ceo_dashboard</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Weekday</key><integer>2</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Weekday</key><integer>4</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Weekday</key><integer>5</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Weekday</key><integer>6</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
  </array>
</dict>
</plist>
```

登録：`launchctl load ~/Library/LaunchAgents/com.smarthouse.ceo-dashboard.plist`
解除：`launchctl unload ~/Library/LaunchAgents/com.smarthouse.ceo-dashboard.plist`

※ Weekday は 0=日, 1=月 … 6=土。水(3)と日(0)を外しています。
</details>

<details>
<summary>Windows（タスクスケジューラ）の手順</summary>

PowerShell を管理者権限で開き、次を実行します（登録前に必ず内容を確認してください）。

```powershell
$action  = New-ScheduledTaskAction -Execute "bash.exe" `
           -Argument "C:\path\to\smart-house-ai\scripts\run_routine.sh morning_ceo_dashboard"
$trigger = New-ScheduledTaskTrigger -Weekly `
           -DaysOfWeek Monday,Tuesday,Thursday,Friday,Saturday -At 9:30am
Register-ScheduledTask -TaskName "SmartHouse_CEO_Dashboard" `
           -Action $action -Trigger $trigger -Description "社長ダッシュボード"
```

確認：`Get-ScheduledTask -TaskName "SmartHouse_*"`
削除：`Unregister-ScheduledTask -TaskName "SmartHouse_CEO_Dashboard"`

※ WSL または Git Bash が必要です。
</details>

---

## ⑥ 止める方法

### 一時的に1本だけ止める

`config/schedule.json` を開き、止めたいルーティンの `"enabled": true` を
`"enabled": false` に変えて保存します。

```json
{
  "key": "sales_kpi",
  "enabled": false
}
```

### 全部止める

```bash
./scripts/uninstall_schedule.sh              # まず何をするか表示（止まりません）
./scripts/uninstall_schedule.sh --apply      # 実際に止める（yes の入力が必要）
```

cron の場合、このシステムが追記した行だけを取り除きます。
**他の設定はそのまま残ります。**

### 実行中のものを止める

ターミナルで `Ctrl + C` を押してください。
途中まで作ったレポートは保存されません（不完全なレポートは残さない設計です）。

---

## ⑦ ログを見る方法

ログは `logs/` に「日付＋ルーティン名＋時刻」のファイル名で保存されます。

```bash
# 新しい順に一覧
ls -lt logs/*.log | head

# 最新のログを見る
cat "$(ls -t logs/*.log | head -1)"

# エラーだけ探す
grep -l ERROR logs/*.log

# 今日のログをまとめて見る
cat logs/$(date +%Y-%m-%d)_*.log
```

### ログの読み方

| 記号 | 意味 |
| --- | --- |
| `✅` | 正常に終わった |
| `⚠️` | 注意（動いてはいる） |
| `🚨 ERROR` | 失敗した。ここを読む |

`logs/tmp/` には、AIに渡した指示文と生の出力が残っています。
**「なぜこのレポートになったのか」を調べたいとき**に見てください。

---

## ⑧ 入力データを追加する方法

`input/` にファイルを置くだけです。次の実行から自動で読み込まれます。

```bash
cp ~/Downloads/売上実績_2026-09.csv input/
```

### 置き方のコツ

1. **ファイル名に「何のデータか」と「日付」を入れる**
   → `在庫一覧_2026-09-01.csv` のように
2. **1行目を見出し行にする**
3. **数字だけを書く**（`42,800,000円` より `42800000`）
4. **分からない値は空欄のままにする**（0で埋めない。0と「不明」は意味が違います）
5. **古いデータは `archive/` に移す**（削除しなくてよい）

詳しくは `input/README.md` を見てください。

### 対応形式

CSV / TSV / Excel（.xlsx .xls）/ Markdown / テキスト / JSON

文字コードは **UTF-8** を推奨します（Excelから出すときは「CSV UTF-8」を選択）。

---

## ⑨ 設定変更方法

設定はすべて `config/` にあります。**プロンプトやスクリプトを直す必要はありません。**

### 休日を変える（例：水曜も営業日にする）

`config/schedule.json`

```json
"holiday_weekdays": ["sun"]
```

### 祝日を追加する

`config/schedule.json`

```json
"holidays": ["2027-01-01", "2027-01-02", "2027-01-03"]
```

※ 祝日は**最初から自動判定していません**。上に書いた日だけ休みになります。
　 休日曜日でも出社する日は `extra_business_days` に書けば営業日扱いになります。

### 実行時刻を変える

`config/schedule.json` の `"time"` を直します。

```json
{ "key": "morning_ceo_dashboard", "time": "08:30" }
```

**変更後は自動実行を登録し直してください。**

```bash
./scripts/uninstall_schedule.sh --apply
./scripts/install_schedule.sh --apply
```

### 判断基準を変える（粗利率・金利など）

`config/company.json`

```json
"deal_criteria": {
  "gross_margin_rate_min": 0.12,      ← 最低粗利率を12%に
  "gross_margin_rate_target": 0.18,   ← 目標を18%に
  "recovery_months_max": 8,           ← 回収期間を8か月に
  "loan_interest_rate_annual": 0.035  ← 金利を3.5%に
}
```

### 月次目標を設定する（達成率が出るようになります）

`config/company.json`

```json
"monthly_targets": {
  "sales": 180000000,
  "gross_profit": 22000000,
  "purchase_count": 3,
  "sale_count": 4
}
```

### レポートの中身を変える

`prompts/` の該当ファイルを編集します。日本語で書いてあるので、
項目を足したり減らしたりできます。

**変更したら必ず `--dry-run` と `--tag TEST` で試してから本番に使ってください。**

```bash
./scripts/run_01_morning_ceo_dashboard.sh --input sample/input --tag TEST --force
```

### 設定を変えたあとの確認

```bash
./scripts/healthcheck.sh
```

---

## ⑩ トラブル時の確認方法

### まずこれを実行

```bash
./scripts/healthcheck.sh
```

環境・設定・プロンプト・スケジュール・入力データ・ログをまとめて点検します。
**何も変更しません**（読むだけ）。

### よくある症状と対処

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| レポートが作られない | 今日が休日 | `./scripts/run_...sh --force` で試す |
| レポートが作られない | 自動実行が未登録 | `./scripts/install_schedule.sh` で確認 |
| レポートが「データなし」だらけ | `input/` が空 | `ls input/` を確認してデータを置く |
| 「Claude Code が見つかりません」 | パスが通っていない | `which claude` を実行。出なければ再インストール |
| 「タイムアウトしました」 | データが多すぎる | `config/runtime.env` の `ROUTINE_TIMEOUT_SECONDS` を増やす |
| 数字が思っていたのと違う | 入力データが古い/重複 | レポートの「参照データ」で読んだファイルを確認 |
| ファイルが `_2` になっている | 同じ日に2回実行した | 正常です（上書き防止） |
| 文字化けする | Shift_JIS のCSV | UTF-8 で保存し直す |

### 調べる順番

```
1. ./scripts/healthcheck.sh          … 環境に問題はないか
2. ls -lt logs/*.log | head          … 実行された形跡はあるか
3. cat "$(ls -t logs/*.log|head -1)" … エラーは出ていないか
4. ls -lt output/daily/ | head       … 出力はできているか
5. logs/tmp/ の *_prompt.md          … AIに何を渡したか
6. logs/tmp/ の *_output.md          … AIが何を返したか
```

### レポートの数字が疑わしいとき

レポートの末尾にある **「参照データ」** を見てください。
AIが読んだファイル名と、足りなかったデータが必ず書いてあります。

そこに書かれていないデータから出た数字があれば、**それは異常**です。
`logs/tmp/` の `*_prompt.md` と `*_output.md` を添えて報告してください。

### 元データが心配なとき

`input/` のファイルは、実行のたびに**実行前と実行後でチェックサムを比較**しています。
ログに次の行があれば、1バイトも変わっていません。

```
✅ 入力データは変更されていません（チェックサム一致）。
```

---

## 補足：初回だけ必要な設定

Claude Code は、初めて使うフォルダに対して**信頼の確認**を求めます。
未確認のままだと `.claude/settings.json` の「許可リスト」が無視され、
ログに次の警告が出ます。

```
Ignoring N permissions.allow entries from .claude/settings.json:
this workspace has not been trusted.
```

⚠️ **この警告が出ていても、レポート作成は正常に動きます。**
実行スクリプトが `--allowed-tools "Read,Glob,Grep"`（読み取りのみ）を
明示的に指定しているためです。**禁止リスト（deny）は常に有効です。**

警告を消したい場合は、このフォルダで一度だけ対話的に Claude Code を起動し、
信頼ダイアログで承認してください。

```bash
cd /home/user/-/smart-house-ai
claude
```

---

## 安全に関する最終確認

このシステムは、以下を**一度も実行しません**。

- メール送信 / SNS投稿 / 外部送信 / Web公開
- ファイル削除 / 既存ファイルの上書き
- git push / git commit
- 支払い / 購入 / 契約 / 送金
- `--dangerously-skip-permissions` の使用

外部への送信・公開・課金・契約・重要な設定変更が必要になった場合、
AIはレポートに **「社長判断事項」** として書くだけで、実行はしません。

**判断するのは常に人間です。**
