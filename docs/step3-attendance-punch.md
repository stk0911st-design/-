# ステップ③ 出勤・退勤の打刻を代表へ即時メール

日報カウンターの「勤務開始」「勤務終了」を押した瞬間に、代表へメールが飛ぶようにします。

## いまの状態（なぜ届いていないか）

日報カウンターは打刻すると、アーティファクトのデータベースに
「あとで通知してください」という控え（`slackq` コレクション）を `status: "pending"` で
置くだけの作りになっています。**その控えを読んで実際に送る担当がいなかったため、
打刻は記録されているのにメールが1通も出ていませんでした。**

このステップで、その「送る担当」を Apps Script 側に用意します。
Apps Script はブラウザを閉じても Claude のセッション状態にも依存しないため、
打刻のたびに確実に送れます。

## 仕組み

```
日報カウンター（勤務開始／勤務終了を押す）
        │  POST { type:"punch", ... }
        ▼
Receiver.gs（受け皿ウェブアプリ）
        │
        ├─ 勤怠シートに1行追記（追記のみ・消さない）
        └─ Attendance.gs が代表へ即時メール
```

## 1. Apps Script にファイルを追加

1. 受け皿のスプレッドシートで **拡張機能 → Apps Script**
2. 左の **＋ → スクリプト** で新しいファイルを作り、名前を `Attendance` にする
3. `gas/Attendance.gs` の中身を全部貼り付ける
4. `Receiver.gs` を最新版（`case 'punch':` が入っているもの）に差し替える
5. 保存

## 2. 通知先を設定する

**プロジェクトの設定 → スクリプト プロパティ** に追加します。

| プロパティ | 値 |
| --- | --- |
| `ATTENDANCE_RECIPIENT` | 打刻通知の宛先メールアドレス |
| `ATTENDANCE_CC` | （任意）CCアドレス。カンマ区切り |

`ATTENDANCE_RECIPIENT` が未設定のときは、日報まとめメールと同じ `RECIPIENT` を使います。
アドレスそのものはこのリポジトリには置きません。

## 3. 再デプロイ

`Receiver.gs` を変更したので、**デプロイ → デプロイを管理 → 編集（鉛筆）→
バージョン：新バージョン → デプロイ** を実行します。
ウェブアプリの URL は変わりません。

## 4. 日報カウンター側から送る

打刻したときに、受け皿へ次の形で POST します。

```json
{
  "token":  "（合言葉）",
  "type":   "punch",
  "member": "mori",
  "name":   "森比査子",
  "kind":   "in",
  "date":   "2026-09-09",
  "note":   "",
  "from":   "日報カウンター"
}
```

| キー | 内容 |
| --- | --- |
| `type` | `punch` 固定 |
| `member` | 担当者ID（日報明細と同じもの。必須） |
| `name` | 表示名。省略時は `member` を使う |
| `kind` | `in`＝出勤 / `out`＝退勤（`出勤` `退勤` でも可。必須） |
| `date` | 対象日 `yyyy-MM-dd`。省略時は当日 |
| `note` | 備考（任意） |

応答は次の形です。`mailed` が `false` のときは打刻は残っていますが通知が出ていません。

```json
{ "ok": true, "type": "punch", "kind": "出勤", "at": "09:02",
  "count": 1, "mailed": true, "mailError": "" }
```

日報カウンターの打刻ハンドラに足すコードは次のとおりです。
`GAS_URL` と `GAS_TOKEN` は画面の設定欄から読む形にして、HTML に直接書かないでください。

```js
/* 打刻を受け皿へ送る。失敗しても画面の記録は消さない。 */
async function postPunch(mid, date, kind){
  const url = cfg.gasUrl, token = cfg.gasToken;
  if(!url || !token) return { ok:false, error:"未設定" };
  try{
    const res = await fetch(url, {
      method: "POST",
      // GAS のウェブアプリは preflight を返さないので text/plain で送る
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        token: token, type: "punch", from: "日報カウンター",
        member: mid, name: nameOf(mid), kind: kind, date: date
      })
    });
    return await res.json();
  }catch(e){
    return { ok:false, error: String(e) };
  }
}
```

`clkIn` / `clkOut` のハンドラで `await saveDay(...)` のあとに `await postPunch(who, currentDate, "in")`
（退勤は `"out"`）を呼びます。戻り値の `mailed` を見て、画面下部のステータスに
「代表へ通知しました」／「通知できませんでした」を出してください。

## 5. 確認

1. Apps Script で `previewPunchMail` を実行する（送信されません）
   - 実行ログに宛先・件名・本文が出ます
   - まだ打刻が1件も無い場合は、先に日報カウンターから1回打刻してください
2. 実際に「勤務開始」を押して、メールが届くか確認する
3. 受け皿のスプレッドシートに `勤怠` タブができ、行が追記されていることを確認する

## メールに載る内容

- 担当者・種別（出勤／退勤）・打刻時刻・備考
- その日の打刻が複数あるときは、本日の打刻一覧
- 退勤時は、その日の最初の出勤から最後の退勤までの拘束時間（休憩は差し引きません）
- 同じ種別を2回以上押している場合は、打ち間違いの注意書き

## 注意

- 勤怠シートは**追記のみ**です。打ち間違いも記録として残ります。
  訂正は行を消さず、備考欄や別途の申請で対応してください。
- メール送信に失敗しても打刻は保存されます。失敗は `_log` シートに
  `punch-mail-failed` として残ります。
- 受け皿の URL と合言葉は社外に出さないでください。
