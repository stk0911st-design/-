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
 *
 * スクリプトプロパティ:
 *   TOKEN … 合言葉（必須）。アプリ側と同じ文字列にする。
 *           推測されにくい24文字以上のランダムな文字列にする。
 *           強さは、関数 checkTokenStrength を実行して確かめられる。
 *
 * セキュリティ上の約束:
 *   - 合言葉が一致しない送信は、シートに触れずに弾く（ロックも取らない）。
 *   - 書き込む文字が「= + - @」で始まるときは、数式として動かないよう先頭に ' を付ける。
 *   - 受け取る量（本文・行数・1セルの文字数）に上限を設ける。
 *   - 合言葉の不一致は _log に記録する（記録は10分あたり BAD_TOKEN_LOG_LIMIT 件まで）。
 */

var SHEET_LOG = '_log';
var SHEET_RAW = '_raw';
var SHEETS = { nippo: '日報明細', eigyo: '営業明細' };

var HEAD_LOG = ['受信日時', '種類', '送信元', '内容'];
var HEAD_RAW = ['key', 'value', '更新日時'];
var HEAD_ROW = ['日付', '担当者ID', '担当者', '区分', '項目', '件数', '備考', '指示元', '種別', '受信日時'];

/** 受け取る量の上限。実際の運用で足りなければ、ここだけ変える。 */
var MAX_BODY_CHARS = 200000;    // 1回の送信本文
var MAX_ROWS = 500;             // 1回で受け取る明細行
var MAX_CELL_CHARS = 2000;      // 1セルに書く文字数（超えた分は切り捨て）
var MAX_KEY_CHARS = 200;        // _raw の key
var MAX_RAW_CHARS = 45000;      // _raw の value（セルの上限 50000 より小さく）
var MIN_TOKEN_LENGTH = 24;      // 合言葉の最低の長さ
var BAD_TOKEN_LOG_LIMIT = 30;   // 10分間に _log へ書く不一致の最大件数

/** ブラウザで開いたときの動作確認用。 */
function doGet() {
  return json_({ ok: true, message: '受け皿は動いています。POSTでデータを受け取ります。' });
}

function doPost(e) {
  // 1. 認証の前は、シートにもロックにも触れない。
  var contents = (e && e.postData && e.postData.contents) || '';
  if (contents.length > MAX_BODY_CHARS) {
    return json_({ ok: false, error: 'too large' });
  }
  var body;
  try {
    body = JSON.parse(contents || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad request' });
  }
  if (!body || typeof body !== 'object') {
    return json_({ ok: false, error: 'bad request' });
  }
  if (!tokenOk_(body.token)) {
    noteBadToken_();
    return json_({ ok: false, error: 'bad token' });
  }

  // 2. 認証できた送信だけが、ロックを取って書き込む。
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json_({ ok: false, error: 'busy' });
  }
  try {
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
      default:
        return json_({ ok: false, error: 'unknown type: ' + String(body.type).slice(0, 30) });
    }
  } catch (err) {
    Logger.log('doPost error: ' + String(err));
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/** 合言葉の照合。長さが違っても、一致した文字数に関係なく同じ手間で比べる。 */
function tokenOk_(token) {
  var want = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!want) return false;
  var got = String(token);
  var diff = got.length ^ want.length;
  for (var i = 0; i < want.length; i++) {
    diff |= (got.charCodeAt(i) || 0) ^ want.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 合言葉の不一致を _log に残す。10分あたりの記録件数には上限を付ける
 * （大量に送られても、シートが膨らまないようにするため）。ここで失敗しても送信は止めない。
 */
function noteBadToken_() {
  try {
    var cache = CacheService.getScriptCache();
    var count = Number(cache.get('bad_token_count') || 0) + 1;
    cache.put('bad_token_count', String(count), 600);
    if (count <= BAD_TOKEN_LOG_LIMIT) {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      if (ss) writeLog_(ss, 'bad token', '', '合言葉の不一致（10分間の ' + count + ' 件目）');
    }
  } catch (err) {
    Logger.log('noteBadToken_ error: ' + String(err));
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * セルに書く文字列を安全にする。
 * ・長すぎるものは切り捨てる。
 * ・「= + - @」やタブ・改行で始まるものは、数式として動かないよう先頭に ' を付ける。
 */
function safe_(value) {
  var s = String(value === null || value === undefined ? '' : value);
  if (s.length > MAX_CELL_CHARS) s = s.slice(0, MAX_CELL_CHARS);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

/** シートから読んだ値と、送られてきた値が同じか。先頭の ' が付いた形も同じとみなす。 */
function same_(stored, incoming) {
  var s = String(stored);
  return s === incoming || s === safe_(incoming);
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
    .appendRow([new Date(), safe_(kind), safe_(from), safe_(note)]);
}

/** キーごとに1行。同じキーが来たら上書きする。 */
function saveRaw_(ss, body) {
  var sh = sheet_(ss, SHEET_RAW, HEAD_RAW);
  var key = String(body.key || '');
  if (!key) throw new Error('key is empty');
  if (key.length > MAX_KEY_CHARS) throw new Error('key is too long');
  var value = typeof body.value === 'string' ? body.value : JSON.stringify(body.value);
  if (String(value).length > MAX_RAW_CHARS) throw new Error('value is too large');

  var last = sh.getLastRow();
  var at = 0;
  if (last > 1) {
    var keys = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < keys.length; i++) {
      if (same_(keys[i][0], key)) { at = i + 2; break; }
    }
  }
  var row = [safe_(key), safe_value_(value), new Date()];
  if (at) sh.getRange(at, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
}

/** _raw の value 用。長さは上で確認済みなので、切り捨てずに数式の無害化だけ行う。 */
function safe_value_(value) {
  var s = String(value);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

/**
 * 展開済みの明細を保存する。
 * 同じ（日付・担当者）の行はいったん消してから入れ直すので、
 * 何度送っても重複しない。
 */
function saveRows_(ss, body) {
  var name = SHEETS[body.app];
  if (!name) throw new Error('unknown app: ' + String(body.app).slice(0, 30));

  var sh = sheet_(ss, name, HEAD_ROW);
  var date = String(body.date || '');
  var member = String(body.member || '');
  if (!date || !member) throw new Error('date or member is empty');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date format is invalid');
  if (member.length > 64 || /[\r\n]/.test(member)) throw new Error('member is invalid');

  var rows = body.rows || [];
  if (!Array.isArray(rows)) throw new Error('rows must be a list');
  if (rows.length > MAX_ROWS) throw new Error('too many rows');

  var now = new Date();
  var incoming = rows.map(function (r) {
    r = r || {};
    return [date, safe_(member), safe_(r.name || member), safe_(r.block), safe_(r.item),
            (r.count === '' || r.count == null) ? '' : Number(r.count) || 0,
            safe_(r.note), safe_(r.src), safe_(r.kind || '実績'), now];
  });

  var last = sh.getLastRow();
  var kept = [];
  if (last > 1) {
    var vals = sh.getRange(2, 1, last - 1, HEAD_ROW.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      var d = vals[i][0];
      var ds = (d instanceof Date) ? Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd') : String(d);
      if (ds === date && same_(vals[i][1], member)) continue;   // 入れ直す対象
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

/**
 * 合言葉の強さを確かめる（実行ログに結果だけを出す。合言葉の中身は出さない）。
 * 設置後と、合言葉を変えたあとに、1回実行する。
 */
function checkTokenStrength() {
  var t = PropertiesService.getScriptProperties().getProperty('TOKEN') || '';
  if (!t) {
    Logger.log('NG: TOKEN が未設定です。');
  } else if (t.length < MIN_TOKEN_LENGTH) {
    Logger.log('NG: 合言葉が短すぎます（' + t.length + '文字）。' + MIN_TOKEN_LENGTH + '文字以上のランダムな文字列に変えてください。');
  } else if (/nippo|sh-|2026|2025|password|1234/i.test(t)) {
    Logger.log('注意: 推測されやすい語（会社名・年・password など）が含まれています。ランダムな文字列に変えてください。');
  } else {
    Logger.log('OK: 合言葉は ' + t.length + '文字です。');
  }
}
