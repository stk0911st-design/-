/**
 * 日報・営業目標アプリ 受け皿（Apps Script ウェブアプリ）
 *
 * アーティファクトの入力画面から送られてきた内容を、このスクリプトを紐付けた
 * スプレッドシートに書き込む。アーティファクト側の保存はそのまま残し、
 * ここへは「控え」を二重に書く。
 *
 * 作られるシート:
 *   _log     … 疎通テストの記録（届いたかどうかの確認用）
 *   _raw     … 送られてきた生データ（キーごとに1行・上書き）
 *   日報明細  … 日報カウンターの内容を1件1行に展開したもの
 *   営業明細  … 営業目標管理の内容を1件1行に展開したもの
 *   取込     … 恵比寿の物件情報（type:'land'。LandStock.gs が同じプロジェクトにある場合）
 *
 * スクリプトプロパティ:
 *   TOKEN … 合言葉（必須）。アプリ側と同じ文字列にする。
 */

var SHEET_LOG = '_log';
var SHEET_RAW = '_raw';
var SHEETS = { nippo: '日報明細', eigyo: '営業明細' };

var HEAD_LOG = ['受信日時', '種類', '送信元', '内容'];
var HEAD_RAW = ['key', 'value', '更新日時'];
var HEAD_ROW = ['日付', '担当者ID', '担当者', '区分', '項目', '件数', '備考', '指示元', '種別', '受信日時'];

/** ブラウザで開いたときの動作確認用。 */
function doGet() {
  return json_({ ok: true, message: '受け皿は動いています。POSTでデータを受け取ります。' });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json_({ ok: false, error: 'busy' });
  }
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!tokenOk_(body.token)) {
      return json_({ ok: false, error: 'bad token' });
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) {
      return json_({ ok: false, error: 'no spreadsheet' });
    }

    switch (body.type) {
      case 'ping':
        writeLog_(ss, 'ping', body.from, body.note);
        return json_({ ok: true, type: 'ping' });
      case 'rows':
        var n = saveRows_(ss, body);
        writeLog_(ss, 'rows', body.from, body.app + ' / ' + body.date + ' / ' + body.member + ' / ' + n + '行');
        return json_({ ok: true, type: 'rows', saved: n });
      case 'raw':
        saveRaw_(ss, body);
        return json_({ ok: true, type: 'raw' });
      case 'land':
        // 恵比寿の物件情報。LandStock.gs を同じプロジェクトに入れている場合のみ使える。
        if (typeof lsIntakeFromPost_ !== 'function') {
          return json_({ ok: false, error: 'LandStock.gs がこのプロジェクトにありません' });
        }
        var landRows = lsIntakeFromPost_(ss, body);
        writeLog_(ss, 'land', body.from, landRows + '行');
        return json_({ ok: true, type: 'land', saved: landRows });
      default:
        return json_({ ok: false, error: 'unknown type: ' + body.type });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function tokenOk_(token) {
  var want = PropertiesService.getScriptProperties().getProperty('TOKEN');
  return !!want && String(token) === want;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sheet_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function writeLog_(ss, kind, from, note) {
  sheet_(ss, SHEET_LOG, HEAD_LOG)
    .appendRow([new Date(), kind, String(from || ''), String(note || '')]);
}

/** キーごとに1行。同じキーが来たら上書きする。 */
function saveRaw_(ss, body) {
  var sh = sheet_(ss, SHEET_RAW, HEAD_RAW);
  var key = String(body.key || '');
  if (!key) throw new Error('key is empty');
  var value = typeof body.value === 'string' ? body.value : JSON.stringify(body.value);

  var last = sh.getLastRow();
  var at = 0;
  if (last > 1) {
    var keys = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < keys.length; i++) {
      if (String(keys[i][0]) === key) { at = i + 2; break; }
    }
  }
  var row = [key, value, new Date()];
  if (at) sh.getRange(at, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
}

/**
 * 展開済みの明細を保存する。
 * 同じ（日付・担当者）の行はいったん消してから入れ直すので、
 * 何度送っても重複しない。
 */
function saveRows_(ss, body) {
  var name = SHEETS[body.app];
  if (!name) throw new Error('unknown app: ' + body.app);

  var sh = sheet_(ss, name, HEAD_ROW);
  var date = String(body.date || '');
  var member = String(body.member || '');
  if (!date || !member) throw new Error('date or member is empty');

  var now = new Date();
  var incoming = (body.rows || []).map(function (r) {
    return [date, member, String(r.name || member), String(r.block || ''), String(r.item || ''),
            (r.count === '' || r.count == null) ? '' : Number(r.count) || 0,
            String(r.note || ''), String(r.src || ''), String(r.kind || '実績'), now];
  });

  var last = sh.getLastRow();
  var kept = [];
  if (last > 1) {
    var vals = sh.getRange(2, 1, last - 1, HEAD_ROW.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      var d = vals[i][0];
      var ds = (d instanceof Date) ? Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd') : String(d);
      if (ds === date && String(vals[i][1]) === member) continue;   // 入れ直す対象
      kept.push(vals[i]);
    }
  }

  var out = kept.concat(incoming);
  if (last > 1) sh.getRange(2, 1, last - 1, HEAD_ROW.length).clearContent();
  if (out.length) sh.getRange(2, 1, out.length, HEAD_ROW.length).setValues(out);
  return incoming.length;
}

/** 設置後にここから1回実行して、シートが作られるか確かめる。 */
function selfTest() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  writeLog_(ss, 'selfTest', 'Apps Script', '手動実行');
  saveRows_(ss, {
    app: 'nippo', date: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'),
    member: 'test', rows: [{ name: 'テスト', block: '動作確認', item: 'テスト行', count: 1, note: 'selfTestで作成' }]
  });
  Logger.log('シートを作成しました。日報明細タブを確認してください。');
}
