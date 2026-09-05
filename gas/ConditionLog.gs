/**
 * 毎日のコンディション記録（Apps Script ウェブアプリ）
 *
 * ガーミン（Garmin Connect）に出ている数値を毎朝1回入力して、
 * スプレッドシートに蓄積するための入力画面と保存処理。
 *
 * ガーミンの公式APIは法人向けで個人利用の申請が通らず、非公式の取得方法は
 * Garmin側の仕様変更で止まるため、「入力は手・蓄積と分析は自動」という方式にしている。
 * 経緯と他方式との比較は docs/garmin-condition.md を参照。
 *
 * 作られるシート:
 *   コンディション … 1日1行。同じ日付を再送すると上書きする。
 *
 * スクリプトプロパティ（どちらも任意。朝のリマインドを使うときだけ設定）:
 *   REMINDER_TO  … リマインドメールの宛先
 *   FORM_URL     … このウェブアプリのURL（メール本文に載せる）
 */

var SHEET_NAME = 'コンディション';
var TZ = 'Asia/Tokyo';
var WDAY = ['日', '月', '火', '水', '木', '金', '土'];

var HEAD = ['日付', '曜日', '睡眠スコア', '睡眠時間(h)', 'Body Battery(起床)', 'Body Battery(最低)',
            'HRV', '安静時心拍', 'ストレス平均', '歩数', '体感(1-5)', 'メモ', '記録日時'];

/** 入力欄のキーと、シートの列（1始まり）の対応。 */
var FIELDS = [
  { key: 'sleepScore', col: 3 },
  { key: 'sleepHours', col: 4 },
  { key: 'bbWake',     col: 5 },
  { key: 'bbLow',      col: 6 },
  { key: 'hrv',        col: 7 },
  { key: 'restingHr',  col: 8 },
  { key: 'stress',     col: 9 },
  { key: 'steps',      col: 10 },
  { key: 'feel',       col: 11 },
  { key: 'memo',       col: 12 }
];

/** 平均や増減を出す対象（メモと歩数以外の体調指標）。 */
var TREND = [
  { key: 'sleepScore', label: '睡眠スコア',        better: 'up' },
  { key: 'sleepHours', label: '睡眠時間(h)',       better: 'up' },
  { key: 'bbWake',     label: 'Body Battery(起床)', better: 'up' },
  { key: 'hrv',        label: 'HRV',               better: 'up' },
  { key: 'restingHr',  label: '安静時心拍',         better: 'down' },
  { key: 'stress',     label: 'ストレス平均',       better: 'down' },
  { key: 'feel',       label: '体感(1-5)',          better: 'up' }
];

/** 入力画面を表示する。?mode=json を付けると直近データをJSONで返す。 */
function doGet(e) {
  var mode = (e && e.parameter && e.parameter.mode) || '';
  if (mode === 'json') {
    return ContentService.createTextOutput(JSON.stringify(loadDashboard(30)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return HtmlService.createTemplateFromFile('ConditionForm')
    .evaluate()
    .setTitle('コンディション記録')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** 画面から呼ばれる保存処理。同じ日付があれば上書きする。 */
function saveCondition(payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var date = normalizeDate_(payload && payload.date);
    if (!date) throw new Error('日付が不正です');

    var sh = sheet_();
    var row = new Array(HEAD.length).fill('');
    row[0] = dateValue_(date);
    row[1] = WDAY[dateValue_(date).getDay()];
    FIELDS.forEach(function (f) {
      row[f.col - 1] = cleanValue_(f.key, payload[f.key]);
    });
    row[HEAD.length - 1] = new Date();

    var at = findRow_(sh, date);
    if (at) sh.getRange(at, 1, 1, HEAD.length).setValues([row]);
    else sh.appendRow(row);

    sortByDate_(sh);
    return loadDashboard(30);
  } finally {
    lock.releaseLock();
  }
}

/** 画面の初期表示用。直近 days 日分の記録と、平均・増減をまとめて返す。 */
function loadDashboard(days) {
  var rows = readRows_();
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var recent = rows.slice(-(days || 30));
  return {
    today: today,
    recent: recent.reverse(),
    stats: buildStats_(rows),
    total: rows.length
  };
}

/** 直近7日と、その前7日を比べる。 */
function buildStats_(rows) {
  var last7 = rows.slice(-7);
  var prev7 = rows.slice(-14, -7);
  return TREND.map(function (t) {
    var now = average_(last7, t.key);
    var before = average_(prev7, t.key);
    var diff = (now === null || before === null) ? null : round_(now - before, 1);
    var arrow = '';
    if (diff !== null && Math.abs(diff) >= 0.05) {
      var up = diff > 0;
      arrow = (up === (t.better === 'up')) ? 'good' : 'bad';
    }
    return { key: t.key, label: t.label, avg: round_(now, 1), prev: round_(before, 1), diff: diff, mood: arrow };
  });
}

function average_(rows, key) {
  var sum = 0, n = 0;
  rows.forEach(function (r) {
    var v = r[key];
    if (v === '' || v === null || v === undefined || isNaN(v)) return;
    sum += Number(v);
    n++;
  });
  return n ? sum / n : null;
}

function round_(v, digits) {
  if (v === null || v === undefined) return null;
  var p = Math.pow(10, digits);
  return Math.round(v * p) / p;
}

/** シート全体を、日付の古い順の配列にして返す。 */
function readRows_() {
  var sh = sheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, HEAD.length).getValues();
  var out = [];
  values.forEach(function (v) {
    var date = formatDate_(v[0]);
    if (!date) return;
    var row = { date: date, wday: String(v[1] || '') };
    FIELDS.forEach(function (f) {
      var cell = v[f.col - 1];
      row[f.key] = (cell === '' || cell === null) ? '' : cell;
    });
    out.push(row);
  });
  out.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
  return out;
}

function findInRows_(rows, date) {
  for (var i = rows.length - 1; i >= 0; i--) {
    if (rows[i].date === date) return rows[i];
  }
  return null;
}

function findRow_(sh, date) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var dates = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < dates.length; i++) {
    if (formatDate_(dates[i][0]) === date) return i + 2;
  }
  return 0;
}

function sortByDate_(sh) {
  var last = sh.getLastRow();
  if (last > 2) sh.getRange(2, 1, last - 1, HEAD.length).sort({ column: 1, ascending: true });
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('スプレッドシートに紐付いていません');
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('yyyy-mm-dd');
    sh.setColumnWidth(12, 320);
  }
  return sh;
}

/** 'yyyy-MM-dd' に揃える。Dateでも文字列でも受ける。 */
function normalizeDate_(value) {
  if (!value) return '';
  if (value instanceof Date) return Utilities.formatDate(value, TZ, 'yyyy-MM-dd');
  var m = String(value).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return '';
  return m[1] + '-' + pad_(m[2]) + '-' + pad_(m[3]);
}

function formatDate_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, TZ, 'yyyy-MM-dd');
  return normalizeDate_(value);
}

/** 時差でずれないよう正午の Date にして保存する。 */
function dateValue_(date) {
  var p = date.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0);
}

function pad_(n) {
  return ('0' + n).slice(-2);
}

/** 数値の欄は数値に、メモは文字列にする。空欄はそのまま空で残す。 */
function cleanValue_(key, value) {
  if (value === '' || value === null || value === undefined) return '';
  if (key === 'memo') return String(value);
  var n = Number(value);
  return isNaN(n) ? '' : n;
}

/**
 * 朝のリマインドメール。
 * スクリプトプロパティ REMINDER_TO と FORM_URL を設定したうえで、
 * トリガー（時間主導型・毎朝）に登録して使う。
 */
function sendConditionReminder() {
  var props = PropertiesService.getScriptProperties();
  var to = props.getProperty('REMINDER_TO');
  var url = props.getProperty('FORM_URL');
  if (!to) return;

  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  if (findInRows_(readRows_(), today)) return;   // もう入力済みなら送らない

  MailApp.sendEmail({
    to: to,
    subject: '[コンディション] ' + today + ' の記録',
    body: 'ガーミンの数値を入力してください。\n\n' +
          '睡眠スコア / 睡眠時間 / Body Battery(起床・最低) / HRV / 安静時心拍 / ストレス平均 / 歩数 / 体感\n\n' +
          (url ? url + '\n' : '')
  });
}

/** 設置後にここから1回実行して、シートが作られるか確かめる。 */
function selfTest() {
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  saveCondition({ date: today, sleepScore: 80, sleepHours: 6.5, bbWake: 75, bbLow: 20,
                  hrv: 45, restingHr: 52, stress: 30, steps: 8000, feel: 4, memo: 'selfTestで作成' });
  Logger.log('コンディションシートに ' + today + ' の行を作りました。内容を確認して、不要なら消してください。');
}
