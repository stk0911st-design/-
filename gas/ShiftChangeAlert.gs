/**
 * 勤務表の変更アラート（勤務表スプレッドシートに紐付けて使う）
 *
 * 月が始まった後（＝月初に確定した後）に勤務表のシフト欄を変更すると、
 *   1. 変更した人の画面に「サイボウズ ガルーンの予定も変更してください」と表示
 *   2. 変更したセルにメモ（日時・変更前→変更後）を追記
 *   3. 「変更履歴」シートに1行記録
 * を行う。
 *
 * 単純トリガー（onEdit）で動くため、トリガー設定や承認は不要。
 * 導入手順は docs/shift-change-alert-setup.md を参照。
 */

// ---- 勤務表のレイアウト（変わったらここを直す） ----
var SCA_SHEET_NAME_PATTERN = /^(\d{4})年(\d{1,2})月$/; // 月別シート名「2026年10月」
var SCA_HEADER_ROW = 13;   // 日付（1〜31）が並ぶ行
var SCA_NAME_COL = 2;      // 氏名が入る列（B列）
var SCA_LOG_SHEET = '変更履歴';
var SCA_TZ = 'Asia/Tokyo';

function onEdit(e) {
  if (!e || !e.range) return;
  try {
    handleShiftEdit_(e);
  } catch (err) {
    // 勤務表の入力自体は止めない
    console.error(err);
  }
}

function handleShiftEdit_(e) {
  var range = e.range;
  var sheet = range.getSheet();
  var m = sheet.getName().match(SCA_SHEET_NAME_PATTERN);
  if (!m) return;

  // 月が始まる前（来月分を組んでいる段階）はアラートしない
  var sheetYm = Number(m[1]) * 100 + Number(m[2]);
  var nowYm = Number(Utilities.formatDate(new Date(), SCA_TZ, 'yyyyMM'));
  if (sheetYm > nowYm) return;

  var month = Number(m[2]);
  var changes = collectChanges_(sheet, range, e, month);
  if (changes.length === 0) return;

  var now = Utilities.formatDate(new Date(), SCA_TZ, 'yyyy/MM/dd HH:mm');
  var user = '';
  try { user = Session.getActiveUser().getEmail(); } catch (ignore) {}

  changes.forEach(function (c) {
    if (c.single) {
      appendNote_(sheet.getRange(c.row, c.col),
        now + ' 変更：「' + c.oldValue + '」→「' + c.newValue + '」');
    }
    writeLog_(sheet.getParent(), [now, sheet.getName(), c.name, c.dateLabel,
      c.oldValue, c.newValue, user || '（取得不可）']);
  });

  showAlert_(sheet.getParent(), changes);
}

/** 編集範囲のうちシフト欄（氏名のある行 × 日付の列）だけを拾う */
function collectChanges_(sheet, range, e, month) {
  var single = range.getNumRows() === 1 && range.getNumColumns() === 1;
  var r0 = range.getRow();
  var c0 = range.getColumn();
  var nRows = range.getNumRows();
  var nCols = range.getNumColumns();
  if (r0 + nRows - 1 <= SCA_HEADER_ROW) return [];

  var headers = sheet.getRange(SCA_HEADER_ROW, c0, 1, nCols).getDisplayValues()[0];
  var names = sheet.getRange(r0, SCA_NAME_COL, nRows, 1).getDisplayValues();
  var values = range.getDisplayValues();
  var out = [];

  for (var i = 0; i < nRows; i++) {
    var row = r0 + i;
    var name = String(names[i][0]).trim();
    if (row <= SCA_HEADER_ROW || !name) continue; // 備考行・見出しは対象外
    for (var j = 0; j < nCols; j++) {
      var day = Number(headers[j]);
      if (!(day >= 1 && day <= 31) || String(headers[j]).trim() !== String(day)) continue;
      var oldValue = single ? (e.oldValue === undefined ? '' : String(e.oldValue)) : '（不明）';
      var newValue = values[i][j];
      if (single && oldValue === newValue) continue;
      out.push({
        row: row, col: c0 + j, name: name, dateLabel: month + '/' + day,
        oldValue: oldValue === '' ? '空欄' : oldValue,
        newValue: newValue === '' ? '空欄' : newValue,
        single: single
      });
    }
  }
  return out;
}

function showAlert_(ss, changes) {
  var lines = changes.slice(0, 10).map(function (c) {
    return '・' + c.name + 'さん ' + c.dateLabel + '：' + c.oldValue + ' → ' + c.newValue;
  });
  if (changes.length > 10) lines.push('…ほか ' + (changes.length - 10) + ' 件');

  var msg = '勤務表の予定が変更されました。\n\n' + lines.join('\n') +
    '\n\n【必ず】サイボウズ ガルーンの予定（休み／出勤）も同じように変更してください。';
  try {
    SpreadsheetApp.getUi().alert('勤務表の変更', msg, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (err) {
    // ポップアップが出せない環境では右下の通知で代替
    ss.toast('ガルーンの予定も変更してください', '勤務表の変更', 15);
  }
}

function appendNote_(cell, text) {
  var note = cell.getNote();
  cell.setNote(note ? note + '\n' + text : text);
}

function writeLog_(ss, row) {
  var log = ss.getSheetByName(SCA_LOG_SHEET);
  if (!log) {
    log = ss.insertSheet(SCA_LOG_SHEET);
    log.appendRow(['変更日時', 'シート', '氏名', '対象日', '変更前', '変更後', '変更した人']);
    log.setFrozenRows(1);
  }
  log.appendRow(row);
}
