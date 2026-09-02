/**
 * 不動産ニュース投稿ログ 転記スクリプト
 *
 * Claude のルーティンが毎朝送る「【不動産ニュース投稿ログ】YYYY-MM-DD」というメールを読み、
 * スプレッドシートに1行ずつ追記します。
 *
 * Claude の Google Drive コネクタは既存スプレッドシートへの行追記ができないため、
 * 「Claude はメールを送るだけ、追記は GAS が行う」という分担にしています。
 *
 * 設定はスクリプトプロパティで管理します（コードに社内情報を書かないため）。
 *   SPREADSHEET_ID … 転記先スプレッドシートのID（必須）
 *   SHEET_NAME     … シート名（任意、既定 'ログ'）
 *   MAIL_QUERY     … Gmail 検索クエリ（任意、既定は下記 DEFAULT_QUERY）
 *
 * 導入手順は gas/README.md を参照。
 */

var PROCESSED_LABEL = '不動産ニュース投稿ログ_処理済';
var DEFAULT_SHEET_NAME = 'ログ';
var DEFAULT_QUERY = 'subject:"【不動産ニュース投稿ログ】" -label:' + PROCESSED_LABEL;

var HEADERS = [
  '日付',
  'テーマ',
  '記事タイトル',
  '文字数',
  'note原稿URL',
  'X要約',
  'X投稿URL',
  '参照ソース',
  'Slack投稿URL',
  '取込日時'
];

/** 本文の「キー: 値」行と、書き出す列の対応 */
var FIELD_KEYS = [
  '日付',
  'テーマ',
  '記事タイトル',
  '文字数',
  'note原稿URL',
  'X要約',
  'X投稿URL',
  '参照ソース',
  'Slack投稿URL'
];

/**
 * 時間主導トリガーから呼ぶメイン関数。
 * 未処理のログメールをすべて取り込み、処理済みラベルを付けます。
 */
function importNewsPostLogs() {
  var props = PropertiesService.getScriptProperties();
  var spreadsheetId = props.getProperty('SPREADSHEET_ID');
  if (!spreadsheetId) {
    throw new Error('スクリプトプロパティ SPREADSHEET_ID が未設定です。');
  }

  var sheet = getOrCreateSheet_(spreadsheetId, props.getProperty('SHEET_NAME') || DEFAULT_SHEET_NAME);
  var label = getOrCreateLabel_(PROCESSED_LABEL);
  var query = props.getProperty('MAIL_QUERY') || DEFAULT_QUERY;

  var threads = GmailApp.search(query, 0, 50);
  if (threads.length === 0) {
    Logger.log('取り込み対象のログメールはありません。');
    return;
  }

  // 古いメールから順に追記する
  threads.reverse();

  var existingDates = readExistingDates_(sheet);
  var appended = 0;

  for (var i = 0; i < threads.length; i++) {
    var messages = threads[i].getMessages();
    for (var j = 0; j < messages.length; j++) {
      var message = messages[j];
      if (!/【不動産ニュース投稿ログ】/.test(message.getSubject())) {
        continue;
      }

      var parsed = parseLogBody_(message.getPlainBody());
      var date = parsed['日付'] || subjectDate_(message.getSubject()) || '';

      // 同じ日付の行がすでにあれば二重登録しない
      if (date && existingDates[date]) {
        Logger.log('重複のためスキップ: ' + date);
        continue;
      }

      sheet.appendRow(buildRow_(parsed, date, message.getDate()));
      if (date) {
        existingDates[date] = true;
      }
      appended++;
    }
    threads[i].addLabel(label);
  }

  Logger.log(appended + ' 件を追記しました。');
}

/** 本文の「キー: 値」形式を解析する。値は次のキー行が現れるまでの複数行を許容する。 */
function parseLogBody_(body) {
  var result = {};
  if (!body) {
    return result;
  }

  var lines = body.replace(/\r\n/g, '\n').split('\n');
  var currentKey = null;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var matched = null;

    for (var k = 0; k < FIELD_KEYS.length; k++) {
      var key = FIELD_KEYS[k];
      // 全角コロンも受け付ける
      var re = new RegExp('^\\s*' + key + '\\s*[:：]\\s*(.*)$');
      var m = line.match(re);
      if (m) {
        matched = { key: key, value: m[1] };
        break;
      }
    }

    if (matched) {
      currentKey = matched.key;
      result[currentKey] = matched.value;
    } else if (currentKey && line.trim() !== '') {
      result[currentKey] += '\n' + line.trim();
    } else if (line.trim() === '') {
      currentKey = null;
    }
  }

  for (var key in result) {
    result[key] = String(result[key]).trim();
  }
  return result;
}

/** 件名から YYYY-MM-DD を拾う（本文に日付行がなかった場合の保険） */
function subjectDate_(subject) {
  var m = String(subject).match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function buildRow_(parsed, date, receivedAt) {
  var charCount = parsed['文字数'] ? Number(String(parsed['文字数']).replace(/[^\d]/g, '')) : '';
  return [
    date,
    parsed['テーマ'] || '',
    parsed['記事タイトル'] || '',
    isNaN(charCount) ? '' : charCount,
    parsed['note原稿URL'] || '',
    parsed['X要約'] || '',
    parsed['X投稿URL'] || '',
    parsed['参照ソース'] || '',
    parsed['Slack投稿URL'] || '',
    Utilities.formatDate(receivedAt || new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm')
  ];
}

function getOrCreateSheet_(spreadsheetId, sheetName) {
  var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  var sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

/** すでに取り込み済みの日付を集合として返す */
function readExistingDates_(sheet) {
  var seen = {};
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return seen;
  }
  var values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    var value = values[i][0];
    if (!value) {
      continue;
    }
    if (Object.prototype.toString.call(value) === '[object Date]') {
      seen[Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy-MM-dd')] = true;
    } else {
      seen[String(value).trim()] = true;
    }
  }
  return seen;
}

/**
 * 毎朝9:00（JST）に実行するトリガーを作成します。
 * スクリプトエディタから1度だけ手動実行してください。二重登録は自動で防ぎます。
 */
function createDailyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'importNewsPostLogs') {
      Logger.log('トリガーはすでに登録されています。');
      return;
    }
  }
  ScriptApp.newTrigger('importNewsPostLogs')
    .timeBased()
    .atHour(9)
    .everyDays(1)
    .inTimezone('Asia/Tokyo')
    .create();
  Logger.log('毎朝9時のトリガーを作成しました。');
}
