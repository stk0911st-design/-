/**
 * 営業日報 まとめメール
 *
 * 日報カウンターのスプレッドシートから、日報の入力（保存）レコードを
 * 集計し、指定アドレスへ HTML メールで送信する。
 *
 * 3つのエントリポイントがある。
 *   sendDailyReportMail    … 平日 午前8時台。前営業日分のまとめを小林様へ（従来どおり）。
 *   sendMorningReminderMail … 毎朝9:30。担当者ひとりずつに「本日分を入力してください」を送る。
 *   sendEveningReportMail  … 毎晩20:00。当日分のまとめを小林様へ（未入力者ぶんはCCで全担当者にも共有）。
 *
 * 想定トリガー: 時間主導型 / 日付ベースを3本設定する（下記READMEも参照）。
 *
 * スクリプトプロパティ:
 *   RECIPIENT       送信先メールアドレス（必須・小林様宛のアドレス）
 *   CC              夜間まとめメールの固定CCアドレス（任意・カンマ区切り）
 *   SPREADSHEET_ID  対象スプレッドシートID（コンテナバインドでない場合のみ必須）
 *   STAFF_EMAILS    担当者名→メールアドレスのJSON（例 {"山田":"yamada@example.com"}）。
 *                   朝のリマインドと、夜のまとめメールを全担当者にもCCする機能で使う。
 *   BROADCAST_CC    "true" にすると、夜のまとめメールを STAFF_EMAILS 全員にもCCする（任意・既定false）。
 *   REPORT_APP_URL  日報カウンターアプリのURL（朝のリマインドに載せるボタンのリンク先）。
 *
 * ※ STAFF_EMAILS・BROADCAST_CC・REPORT_APP_URL は、社内の運用判断（全員の勤務・成果を
 *   全員に共有する／個人メールに直接送るなど）を伴うため、既定では空＝機能オフになっている。
 *   実際に使う場合は、社内で内容と運用方法を確認したうえで値を設定すること。
 */

var TZ = 'Asia/Tokyo';

/** value(JSON) のキーと表示名。表の列順もこの順。 */
var FIELDS = [
  ['call', '架電'],
  ['mail', 'メール'],
  ['information', '物件情報取得'],
  ['assessment', '査定'],
  ['visit', '訪問・面談'],
  ['site', '現地調査'],
  ['offer', '買付・価格提示'],
  ['contract', '契約'],
  ['other', 'その他']
];

/** 定期トリガーから呼ぶ本番用エントリポイント。 */
function sendDailyReportMail() {
  run_(false);
}

/** 送信せずに文面をログ出力する確認用エントリポイント。 */
function previewDailyReportMail() {
  run_(true);
}

function run_(isPreview) {
  var now = new Date();
  var targetDates = resolveTargetDates_(now);
  if (targetDates.length === 0) {
    Logger.log('土日のため送信対象外です。');
    return;
  }

  var ss = openSpreadsheet_();
  var records = readRecords_(ss, targetDates);
  var staffList = readStaffList_(ss);
  var subject = buildSubject_(targetDates);
  var html = buildHtml_(targetDates, records, staffList);

  if (isPreview) {
    Logger.log('件名: ' + subject);
    Logger.log(html);
    return;
  }

  var props = PropertiesService.getScriptProperties();
  var recipient = props.getProperty('RECIPIENT');
  if (!recipient) {
    throw new Error('スクリプトプロパティ RECIPIENT が未設定です。');
  }
  var options = { htmlBody: html, name: '営業日報まとめ' };
  var cc = props.getProperty('CC');
  if (cc) {
    options.cc = cc;
  }
  MailApp.sendEmail(recipient, subject, htmlToPlainText_(html), options);
  Logger.log('送信しました: ' + subject + ' → ' + recipient + '（' + records.length + '件）');
}

/** 毎晩20:00トリガーから呼ぶ本番用エントリポイント（当日分のまとめを小林様へ）。 */
function sendEveningReportMail() {
  runEvening_(false);
}

/** 送信せずに文面をログ出力する確認用エントリポイント。 */
function previewEveningReportMail() {
  runEvening_(true);
}

function runEvening_(isPreview) {
  var now = new Date();
  var ymd = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
  var targetDates = [ymd];

  var ss = openSpreadsheet_();
  var records = readRecords_(ss, targetDates);
  var staffList = readStaffList_(ss);
  var pending = pendingStaff_(records, staffList);
  var subject = '【本日の営業日報】' + formatDateLabel_(ymd) + '分';
  var html = buildEveningHtml_(ymd, records, pending);

  if (isPreview) {
    Logger.log('件名: ' + subject);
    Logger.log(html);
    return;
  }

  var props = PropertiesService.getScriptProperties();
  var recipient = props.getProperty('RECIPIENT');
  if (!recipient) {
    throw new Error('スクリプトプロパティ RECIPIENT が未設定です。');
  }
  var options = { htmlBody: html, name: '営業日報まとめ' };
  var ccList = [];
  var fixedCc = props.getProperty('CC');
  if (fixedCc) {
    ccList.push(fixedCc);
  }
  if (String(props.getProperty('BROADCAST_CC')).toLowerCase() === 'true') {
    var staffEmails = readStaffEmails_();
    staffList.forEach(function (name) {
      if (staffEmails[name]) {
        ccList.push(staffEmails[name]);
      }
    });
  }
  if (ccList.length > 0) {
    options.cc = ccList.join(',');
  }
  MailApp.sendEmail(recipient, subject, htmlToPlainText_(html), options);
  Logger.log('送信しました: ' + subject + ' → ' + recipient + '（CC ' + ccList.length + '件 / 記録 ' + records.length + '件）');
}

/** 毎朝9:30トリガーから呼ぶ本番用エントリポイント（担当者ごとに個別送信）。 */
function sendMorningReminderMail() {
  runMorningReminder_(false);
}

/** 送信せずに文面をログ出力する確認用エントリポイント（1件だけ生成してログに出す）。 */
function previewMorningReminderMail() {
  runMorningReminder_(true);
}

function runMorningReminder_(isPreview) {
  var staffEmails = readStaffEmails_();
  var names = Object.keys(staffEmails);
  if (names.length === 0) {
    Logger.log('STAFF_EMAILS が未設定のため、朝のリマインドは送信できません。');
    return;
  }
  var appUrl = PropertiesService.getScriptProperties().getProperty('REPORT_APP_URL') || '';
  var subject = '【本日の営業日報】入力のお願い';

  names.forEach(function (name) {
    var html = buildReminderHtml_(name, appUrl);
    if (isPreview) {
      Logger.log('宛先: ' + name + ' <' + staffEmails[name] + '>');
      Logger.log(html);
      return;
    }
    MailApp.sendEmail(staffEmails[name], subject, htmlToPlainText_(html), { htmlBody: html, name: '営業日報' });
  });
  if (!isPreview) {
    Logger.log('送信しました（朝のリマインド）: ' + names.length + '名');
  }
}

/** STAFF_EMAILS（JSON: 担当者名→メールアドレス）を読む。未設定なら空オブジェクト。 */
function readStaffEmails_() {
  var raw = PropertiesService.getScriptProperties().getProperty('STAFF_EMAILS');
  if (!raw) {
    return {};
  }
  try {
    var parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    Logger.log('STAFF_EMAILS の解析に失敗しました: ' + raw);
    return {};
  }
}

/**
 * 実行日（JST）から集計対象日を決める。
 * 火〜金 → 前日1日分 / 月 → 前週の金・土・日 / 土日 → 対象なし
 */
function resolveTargetDates_(now) {
  var day = Number(Utilities.formatDate(now, TZ, 'u')); // 1=月 ... 7=日
  if (day === 6 || day === 7) {
    return [];
  }
  var offsets = (day === 1) ? [3, 2, 1] : [1];
  return offsets.map(function (n) {
    return Utilities.formatDate(addDays_(now, -n), TZ, 'yyyy-MM-dd');
  });
}

function addDays_(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function openSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) {
    return SpreadsheetApp.openById(id);
  }
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw new Error('スプレッドシートを特定できません。スクリプトプロパティ SPREADSHEET_ID を設定してください。');
  }
  return active;
}

/**
 * ヘッダー行に指定の見出しをすべて含むシートを探す。
 * シート名の変更に影響されないようにするため、見出しで判定する。
 */
function findSheetByHeaders_(ss, requiredHeaders) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var sheet = sheets[i];
    if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) {
      continue;
    }
    var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(function (v) {
      return String(v).trim();
    });
    var hasAll = requiredHeaders.every(function (h) {
      return header.indexOf(h) !== -1;
    });
    if (hasAll) {
      return { sheet: sheet, header: header };
    }
  }
  return null;
}

/** 生データ表（key / value / 更新日時）から対象日のレコードを取り出す。 */
function readRecords_(ss, targetDates) {
  var found = findSheetByHeaders_(ss, ['key', 'value', '更新日時']);
  if (!found) {
    throw new Error('生データ表（key / value / 更新日時）が見つかりません。シート構成を確認してください。');
  }
  var sheet = found.sheet;
  var keyCol = found.header.indexOf('key');
  var valueCol = found.header.indexOf('value');
  var updatedCol = found.header.indexOf('更新日時');

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }
  var rows = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  var records = [];

  rows.forEach(function (row) {
    var updated = row[updatedCol];
    if (!updated) {
      return;
    }
    var updatedDate = (updated instanceof Date) ? updated : new Date(updated);
    if (isNaN(updatedDate.getTime())) {
      return;
    }
    var ymd = Utilities.formatDate(updatedDate, TZ, 'yyyy-MM-dd');
    if (targetDates.indexOf(ymd) === -1) {
      return;
    }
    var parsed = parseValue_(row[valueCol]);
    if (!parsed) {
      return;
    }
    records.push({
      staff: parsed.staff || staffFromKey_(row[keyCol]),
      week: parsed.week || '',
      memo: parsed.memo || '',
      counts: parsed,
      updatedAt: updatedDate,
      updatedLabel: Utilities.formatDate(updatedDate, TZ, 'M/d HH:mm')
    });
  });

  records.sort(function (a, b) {
    return a.updatedAt - b.updatedAt;
  });
  return records;
}

function parseValue_(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return null;
  }
  try {
    var parsed = JSON.parse(String(raw));
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch (e) {
    Logger.log('value の解析に失敗しました: ' + raw);
    return null;
  }
}

/** key は `report|<週開始日>|<担当者>` 形式。 */
function staffFromKey_(key) {
  var parts = String(key || '').split('|');
  return parts.length >= 3 ? parts[2] : '(不明)';
}

/** 集計表の担当者列から、未入力者判定用の名簿を作る。 */
function readStaffList_(ss) {
  var found = findSheetByHeaders_(ss, ['週開始日', '担当者']);
  if (!found) {
    return [];
  }
  var sheet = found.sheet;
  var staffCol = found.header.indexOf('担当者');
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }
  var values = sheet.getRange(2, staffCol + 1, lastRow - 1, 1).getDisplayValues();
  var seen = {};
  var list = [];
  values.forEach(function (row) {
    var name = String(row[0]).trim();
    if (name && !seen[name]) {
      seen[name] = true;
      list.push(name);
    }
  });
  return list;
}

function buildSubject_(targetDates) {
  return '【営業日報まとめ】' + formatDateRangeLabel_(targetDates) + '分';
}

function formatDateRangeLabel_(targetDates) {
  return targetDates.map(function (ymd) {
    return formatDateLabel_(ymd);
  }).join('・');
}

function formatDateLabel_(ymd) {
  var parts = ymd.split('-');
  var date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  var wd = ['日', '月', '火', '水', '木', '金', '土'][date.getDay()];
  return parts[0] + '年' + Number(parts[1]) + '月' + Number(parts[2]) + '日(' + wd + ')';
}

function buildHtml_(targetDates, records, staffList) {
  var label = formatDateRangeLabel_(targetDates);
  var out = [];
  out.push('<div style="font-family:sans-serif;font-size:14px;line-height:1.7;color:#222">');
  out.push('<p>小林様<br>お世話になっております。</p>');

  if (records.length === 0) {
    out.push('<p>' + esc_(label) + 'は、日報の入力がありませんでした。</p>');
  } else {
    out.push('<p>' + esc_(label) + 'に入力があった日報をまとめました（入力 ' + records.length + '件）。</p>');
    out.push(buildTable_(records));
    out.push(buildMemoList_(records));
  }

  var pending = pendingStaff_(records, staffList);
  if (pending.length > 0) {
    out.push('<p><b>未入力</b>：' + esc_(pending.join('、')) + '</p>');
  }

  out.push('<p style="color:#666;font-size:12px;margin-top:24px">');
  out.push('※ 数値は日報カウンターの<b>週単位の累計値</b>です（当日の増分ではありません）。<br>');
  out.push('※ 本メールは日報カウンターの入力内容を自動集計したものです。');
  out.push('</p>');
  out.push('</div>');
  return out.join('');
}

/** 夜20:00の当日まとめメール本文。未入力者への注意文を含む。 */
function buildEveningHtml_(ymd, records, pending) {
  var label = formatDateLabel_(ymd);
  var out = [];
  out.push('<div style="font-family:sans-serif;font-size:14px;line-height:1.7;color:#222">');
  out.push('<p>小林様<br>お世話になっております。</p>');

  if (records.length === 0) {
    out.push('<p>' + esc_(label) + 'は、本日時点で日報の入力がありませんでした。</p>');
  } else {
    out.push('<p>' + esc_(label) + 'の日報入力状況をまとめました（入力 ' + records.length + '件）。</p>');
    out.push(buildTable_(records));
    out.push(buildMemoList_(records));
  }

  if (pending.length > 0) {
    out.push('<p><b>未入力</b>：' + esc_(pending.join('、')) + '</p>');
    out.push('<p>本日分の入力がない担当者については、原則として当日の稼働記録が確認できないものとして扱います。' +
      '入力漏れの場合は、お早めに日報カウンターへの入力をお願いいたします。</p>');
    out.push('<p style="color:#555">今後、採用を増やしていく予定です。日々の入力状況は、皆さんの日々の稼働を確認するための' +
      '大切な記録になりますので、引き続きご協力をお願いいたします。</p>');
  }

  out.push('<p style="color:#666;font-size:12px;margin-top:24px">');
  out.push('※ 数値は日報カウンターの<b>週単位の累計値</b>です（当日の増分ではありません）。<br>');
  out.push('※ 本メールは日報カウンターの入力内容を自動集計したものです。');
  out.push('</p>');
  out.push('</div>');
  return out.join('');
}

/** 朝9:30の個別リマインドメール本文。 */
function buildReminderHtml_(name, appUrl) {
  var out = [];
  out.push('<div style="font-family:sans-serif;font-size:14px;line-height:1.7;color:#222">');
  out.push('<p>' + esc_(name) + 'さん<br>おはようございます。今日もよろしくお願いします。</p>');
  out.push('<p>本日の営業日報（日報カウンター）への入力を、必ずお願いします。</p>');
  if (appUrl) {
    out.push('<p><a href="' + esc_(appUrl) + '" ' +
      'style="display:inline-block;padding:10px 20px;background:#2b6cb0;color:#fff;' +
      'text-decoration:none;border-radius:6px;font-weight:bold">日報カウンターを開く</a></p>');
  }
  out.push('<p style="color:#666;font-size:12px;margin-top:24px">※ 本メールは日報カウンターの入力を促す自動送信メールです。</p>');
  out.push('</div>');
  return out.join('');
}

function buildTable_(records) {
  var th = 'style="border:1px solid #ccc;padding:6px 10px;background:#f2f2f2;white-space:nowrap"';
  var td = 'style="border:1px solid #ccc;padding:6px 10px;text-align:center"';
  var tdLeft = 'style="border:1px solid #ccc;padding:6px 10px"';

  var html = ['<table style="border-collapse:collapse;font-size:13px"><thead><tr>'];
  html.push('<th ' + th + '>担当者</th>');
  html.push('<th ' + th + '>週開始日</th>');
  FIELDS.forEach(function (f) {
    html.push('<th ' + th + '>' + esc_(f[1]) + '</th>');
  });
  html.push('<th ' + th + '>合計</th>');
  html.push('<th ' + th + '>入力時刻</th>');
  html.push('</tr></thead><tbody>');

  var totals = {};
  var grandTotal = 0;

  records.forEach(function (rec) {
    html.push('<tr>');
    html.push('<td ' + tdLeft + '>' + esc_(rec.staff) + '</td>');
    html.push('<td ' + td + '>' + esc_(rec.week) + '</td>');
    var rowTotal = 0;
    FIELDS.forEach(function (f) {
      var n = toNumber_(rec.counts[f[0]]);
      rowTotal += n;
      totals[f[0]] = (totals[f[0]] || 0) + n;
      html.push('<td ' + td + '>' + n + '</td>');
    });
    grandTotal += rowTotal;
    html.push('<td ' + td + '><b>' + rowTotal + '</b></td>');
    html.push('<td ' + td + '>' + esc_(rec.updatedLabel) + '</td>');
    html.push('</tr>');
  });

  html.push('<tr style="background:#fafafa">');
  html.push('<td ' + tdLeft + ' colspan="2"><b>合計</b></td>');
  FIELDS.forEach(function (f) {
    html.push('<td ' + td + '><b>' + (totals[f[0]] || 0) + '</b></td>');
  });
  html.push('<td ' + td + '><b>' + grandTotal + '</b></td>');
  html.push('<td ' + td + '></td>');
  html.push('</tr>');
  html.push('</tbody></table>');
  return html.join('');
}

function buildMemoList_(records) {
  var withMemo = records.filter(function (rec) {
    return String(rec.memo).trim() !== '';
  });
  if (withMemo.length === 0) {
    return '';
  }
  var html = ['<p style="margin-top:20px"><b>コメント</b></p><ul>'];
  withMemo.forEach(function (rec) {
    html.push('<li>' + esc_(rec.staff) + '：' + esc_(rec.memo) + '</li>');
  });
  html.push('</ul>');
  return html.join('');
}

function pendingStaff_(records, staffList) {
  var entered = {};
  records.forEach(function (rec) {
    entered[rec.staff] = true;
  });
  return staffList.filter(function (name) {
    return !entered[name];
  });
}

function toNumber_(value) {
  var n = Number(value);
  return isNaN(n) ? 0 : n;
}

function esc_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlToPlainText_(html) {
  return html
    .replace(/<\/(p|tr|li|div)>/g, '\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/t[dh]>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
