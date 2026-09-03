# Apps Script スクリプト

- `DailyReportMailer.gs` … 営業日報のまとめメール
- `MailTriage.gs` … メールの自動仕分け・予定登録・エスカレーション

---

## DailyReportMailer（営業日報まとめ）

日報カウンターのスプレッドシートから、前営業日に入力された内容を集計して
指定アドレスへメール送信する Apps Script です。

### 導入手順

1. 日報カウンターのスプレッドシートを開き、「拡張機能 → Apps Script」。
   （スプレッドシートの編集権限が必要です）
2. `DailyReportMailer.gs` の内容を新しいスクリプトファイルに貼り付ける。
3. 「プロジェクトの設定 → スクリプト プロパティ」に次を追加する。

   | プロパティ | 値 |
   | --- | --- |
   | `RECIPIENT` | 送信先メールアドレス |
   | `CC` | （任意）CCアドレス。カンマ区切り |

   ※ 別ファイルのスプレッドシートを対象にする場合のみ `SPREADSHEET_ID` も設定します。
   スクリプトを日報カウンターのスプレッドシートに紐付けて作成した場合は不要です。
4. `previewDailyReportMail` を実行して、実行ログで文面を確認する（送信はされません）。
5. 問題なければ「トリガー → トリガーを追加」で次を設定する。
   - 実行する関数: `sendDailyReportMail`
   - イベントのソース: 時間主導型
   - 日付ベースのタイマー: 午前8時〜9時
   - ※ 土日は関数側でスキップします。

### 動作

- 火〜金：前日1日分
- 月：前週の金・土・日の3日分
- 土日：何もしない
- 対象日に入力が0件でも「入力なし」のメールを送信します。

---

## MailTriage（メール自動仕分け・予定登録・エスカレーション）

代表アドレスおよび指定メンバー宛のメールを走査し、営業DM等を除外したうえで、
仕分け・カレンダーへの仮予定登録・代表へのエスカレーション・返信下書き・記録を行います。

設計と判定基準は [`../docs/mail-triage.md`](../docs/mail-triage.md) を参照してください。

### 導入手順

1. Apps Script プロジェクトを新規作成し、`MailTriage.gs` を貼り付ける。
2. 「プロジェクトの設定 → スクリプト プロパティ」に下表を設定する（必須は3つだけ）。
3. `previewMailTriage` を実行し、実行ログで判定結果を確認する。**何も作成されません。**
4. 判定がずれていれば `MT_KEYWORDS` / `NOISE_SENDERS` を調整して 3 を繰り返す。
5. 納得できたら `DRY_RUN` を `false` にし、`runMailTriage` を手動で1回実行する。
6. `installMailTriageTriggers` を実行して定期実行にする（1時間ごと＋毎日18時台のまとめ）。

### スクリプトプロパティ

**必須**

| プロパティ | 内容 |
| --- | --- |
| `REP_ADDRESSES` | 代表アドレス。カンマ区切りで複数可 |
| `MEMBER_ADDRESSES` | 小林・森・久世のアドレス。カンマ区切り |
| `BOSS_EMAIL` | エスカレーション先（小林）のアドレス |

**動作の調整**

| プロパティ | 既定値 | 内容 |
| --- | --- | --- |
| `DRY_RUN` | `true` | `true` の間は何も作成・送信しない |
| `ESCALATE_MODE` | `draft` | `send` にすると至急メールを自動送信する。既定は下書き |
| `REPLY_DRAFT` | `true` | 返信下書きを作るか |
| `CREATE_EVENTS` | `true` | カレンダーに仮予定を作るか |
| `CALENDAR_ID` | `primary` | 予定の登録先カレンダーID |
| `LOOKBACK_DAYS` | `2` | 何日前まで遡って走査するか |
| `MAX_THREADS` | `50` | 1回の実行で処理するスレッド数の上限 |
| `SENDER_NAME` | （空） | 返信下書きの署名に入れる名乗り |
| `NOISE_SENDERS` | （空） | 除外したい送信元を追加。カンマ区切りの部分一致 |

**記録先（任意。未設定ならスキップされます）**

| プロパティ | 内容 |
| --- | --- |
| `LOG_SPREADSHEET_ID` | 処理ログを書き込むスプレッドシートID。未設定だと夕方のまとめが空になります |
| `BACKLOG_SPACE_URL` | 例 `https://xxxxx.backlog.jp` |
| `BACKLOG_API_KEY` | Backlog の API キー |
| `BACKLOG_PROJECT_KEY` | 起票先プロジェクトキー |
| `BACKLOG_ISSUE_TYPE_NAME` | 課題種別名。未設定なら先頭の種別を使う |
| `BACKLOG_PRIORITY_ID` | 優先度ID（既定 `3` ＝中） |
| `KINTONE_DOMAIN` | 例 `xxxxx.cybozu.com` |
| `KINTONE_APP_ID` | アプリID |
| `KINTONE_API_TOKEN` | API トークン |
| `KINTONE_FIELD_MAP` | フィールドコードの対応表（JSON）。未設定なら日本語の既定名を使う |

### 関数

| 関数 | 内容 |
| --- | --- |
| `previewMailTriage` | 判定結果をログに出すだけ。メール・予定・課題は作成しない |
| `runMailTriage` | 本番処理。定期トリガーから呼ぶ |
| `sendMailTriageDigest` | 当日分の要対応まとめを代表宛に作る（既定は下書き） |
| `installMailTriageTriggers` | 定期トリガーをまとめて作成する |

### 付与されるラベル

`AI/処理済` `AI/対象外` `AI/要対応` `AI/重要` `AI/予定登録` `AI/エスカレーション`

無ければ自動作成されます。処理済みラベルによって同じメールを二重処理しません。

### 判定ロジックのテスト

日時・金額・期限の抽出ロジックは Node で検証できます。

```
TZ=Asia/Tokyo node gas/test/MailTriage.test.js
```

`MT_KEYWORDS` や日時抽出の正規表現を変更したら、このテストを通してから反映してください。
