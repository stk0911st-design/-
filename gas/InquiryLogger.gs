/**
 * HP問い合わせ 自動記録
 *
 * ホームページの問い合わせフォームから届いたメールを Gmail から拾い、
 * スプレッドシートに1件1行で記録して、月ごとの件数を集計する。
 *
 * 対応している通知メール:
 *   新HP（smarthouse77.jp / Netlify Forms）… 件名「【HP問い合わせ】新しいお問い合わせがありました」
 *   旧HP（s-house.biz）                    … 件名「【HPメール問い合わせ】…」
 *
 * 想定トリガー: 時間主導型 / 1時間おき（または日付ベースで1日1回）
 *
 * スクリプトプロパティ:
 *   SPREADSHEET_ID      記録先スプレッドシートID（コンテナバインドでない場合のみ必須）
 *   SEARCH_QUERY        （任意）Gmail検索条件。既定は新旧フォーム両対応の条件
 *   SEARCH_DAYS         （任意）何日前まで遡って探すか。既定 30
 *   LABEL_NAME          （任意）記録済みメールに付けるGmailラベル名。未設定なら付けない
 *   SUMMARY_RECIPIENT   （任意）月次サマリーメールの送信先。未設定なら送信しない
 *   SUMMARY_CC          （任意）月次サマリーメールのCC。カンマ区切り
 *
 * メールは削除も既読化もしない。記録済みかどうかはメッセージIDで判定するため、
 * 何度実行しても同じ問い合わせが二重に記録されることはない。
 */

var INQUIRY_TZ = 'Asia/Tokyo';

var SHEET_INQUIRY = 'HP問い合わせ';
var SHEET_MONTHLY = 'HP問い合わせ月次';

var HEAD_INQUIRY = [
  '受信日時', '経路', '種別', '会社名', '担当者名', '電話番号', 'メールアドレス',
  '物件所在地', '物件種別', '希望価格', '内容', '件名', '差出人', '本文', 'メッセージID', '記録日時'
];
var HEAD_MONTHLY = ['月', '実件数', 'テスト件数', '合計'];

/** 既定のGmail検索条件。新HP・旧HPの通知メールを両方拾う。 */
var DEFAULT_SEARCH_QUERY =
  '(from:formresponses@netlify.com OR subject:"【HP問い合わせ】" OR subject:"【HPメール問い合わせ】")';

/**
 * 本文の「ラベル: 値」を列に振り分ける対応表。
 * フォームの項目名が変わっても、別名をここに足せば追従できる。
 */
var INQUIRY_FIELDS = [
  ['会社名', ['貴社名', '会社名', '御社名', '法人名']],
  ['担当者名', ['担当者名', 'お名前', '氏名', 'ご氏名', 'ご担当者名']],
  ['電話番号', ['電話番号', '電話', 'TEL', 'お電話番号']],
  ['メールアドレス', ['メール', 'メールアドレス', 'Eメール', 'E-mail', 'mail']],
  ['物件所在地', ['物件所在地', '所在地', '物件住所', 'ご住所']],
  ['物件種別', ['物件種別', '種別', '物件の種類']],
  ['希望価格', ['希望価格', 'ご希望価格', '価格']],
  ['内容', ['備考', 'お問い合わせ内容', 'お問合せ内容', 'ご相談内容', 'ご要望', '内容', 'メッセージ']]
];

/** 定期トリガーから呼ぶ本番用エントリポイント。 */
function logInquiries() {
  var ss = openInquirySpreadsheet_();
  var sheet = inquirySheet_(ss, SHEET_INQUIRY, HEAD_INQUIRY);
  var known = knownMessageIds_(sheet);
  var messages = searchInquiryMessages_();

  var rows = [];
  var added = [];
  messages.forEach(function (message) {
    var id = message.getId();
    if (known[id]) {
      return;
    }
    known[id] = true;
    rows.push(toInquiryRow_(message));
    added.push(message);
  });

  if (rows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEAD_INQUIRY.length).setValues(rows);
    applyLabel_(added);
  }

  rebuildMonthly_(ss, sheet);
  Logger.log('新規 ' + rows.length + '件を記録しました（検索対象 ' + messages.length + '件）。');
  return rows.length;
}

/** 何が記録されるかをログで確認する。スプレッドシートには書き込まない。 */
function previewInquiries() {
  var messages = searchInquiryMessages_();
  Logger.log('検索でヒットしたメール: ' + messages.length + '件');
  messages.forEach(function (message) {
    var row = toInquiryRow_(message);
    Logger.log([
      Utilities.formatDate(row[0], INQUIRY_TZ, 'yyyy-MM-dd HH:mm'),
      row[1], row[2], row[4] || row[3] || '(名前なし)', row[10]
    ].join(' | '));
  });
}

/** 月次サマリーをメール送信する。SUMMARY_RECIPIENT 未設定なら何もしない。 */
function sendInquirySummaryMail() {
  summaryMail_(false);
}

/** 送信せずに月次サマリーの文面をログ出力する。 */
function previewInquirySummaryMail() {
  summaryMail_(true);
}

function summaryMail_(isPreview) {
  var props = PropertiesService.getScriptProperties();
  var recipient = props.getProperty('SUMMARY_RECIPIENT');
  if (!recipient && !isPreview) {
    Logger.log('SUMMARY_RECIPIENT が未設定のため、メールは送信しません。');
    return;
  }

  var ss = openInquirySpreadsheet_();
  var sheet = inquirySheet_(ss, SHEET_INQUIRY, HEAD_INQUIRY);
  var records = readInquiryRecords_(sheet);

  var now = new Date();
  var month = Utilities.formatDate(now, INQUIRY_TZ, 'yyyy-MM');
  var thisMonth = records.filter(function (rec) {
    return rec.month === month && !rec.isTest;
  });
  var subject = '【HP問い合わせ】' + month.replace('-', '年') + '月分 ' + thisMonth.length + '件';
  var html = buildSummaryHtml_(month, thisMonth, records);

  if (isPreview) {
    Logger.log('件名: ' + subject);
    Logger.log(html);
    return;
  }

  var options = { htmlBody: html, name: 'HP問い合わせ集計' };
  var cc = props.getProperty('SUMMARY_CC');
  if (cc) {
    options.cc = cc;
  }
  MailApp.sendEmail(recipient, subject, inquiryHtmlToText_(html), options);
  Logger.log('送信しました: ' + subject + ' → ' + recipient);
}

/** 設置後に1回実行して、シートが作られるか確かめる。 */
function inquirySelfTest() {
  var ss = openInquirySpreadsheet_();
  inquirySheet_(ss, SHEET_INQUIRY, HEAD_INQUIRY);
  inquirySheet_(ss, SHEET_MONTHLY, HEAD_MONTHLY);
  Logger.log('シートを用意しました。「' + SHEET_INQUIRY + '」タブを確認してください。');
}

function searchInquiryMessages_() {
  var props = PropertiesService.getScriptProperties();
  var base = props.getProperty('SEARCH_QUERY') || DEFAULT_SEARCH_QUERY;
  var days = Number(props.getProperty('SEARCH_DAYS')) || 30;
  var query = base + ' newer_than:' + days + 'd';

  var messages = [];
  GmailApp.search(query, 0, 200).forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      if (isInquiryMessage_(message)) {
        messages.push(message);
      }
    });
  });
  messages.sort(function (a, b) {
    return a.getDate() - b.getDate();
  });
  return messages;
}

/**
 * スレッド単位の検索結果には返信なども混ざるため、
 * フォーム通知そのものだけを残す。
 */
function isInquiryMessage_(message) {
  var subject = String(message.getSubject() || '');
  var from = String(message.getFrom() || '');
  if (from.indexOf('formresponses@netlify.com') !== -1) {
    return true;
  }
  if (subject.indexOf('【HP問い合わせ】') !== -1 || subject.indexOf('【HPメール問い合わせ】') !== -1) {
    return subject.indexOf('Re:') !== 0 && subject.indexOf('Fwd:') !== 0;
  }
  return false;
}

function toInquiryRow_(message) {
  var body = String(message.getPlainBody() || '');
  var fields = parseInquiryBody_(body);
  var subject = String(message.getSubject() || '');
  var from = String(message.getFrom() || '');

  return [
    message.getDate(),
    routeOf_(from, subject),
    isTestInquiry_(body, fields) ? 'テスト' : '問い合わせ',
    fields['会社名'] || '',
    fields['担当者名'] || '',
    fields['電話番号'] || '',
    fields['メールアドレス'] || '',
    fields['物件所在地'] || '',
    fields['物件種別'] || '',
    fields['希望価格'] || '',
    fields['内容'] || summarizeBody_(body),
    subject,
    from,
    truncate_(body, 3000),
    message.getId(),
    new Date()
  ];
}

/** 本文の「ラベル: 値」形式を拾って、対応表どおりに振り分ける。 */
function parseInquiryBody_(body) {
  var fields = {};
  var lines = body.replace(/\r\n/g, '\n').split('\n');
  var current = null;

  lines.forEach(function (line) {
    var matched = line.match(/^\s*([^:：]{1,24})\s*[:：]\s*(.*)$/);
    if (matched) {
      var column = columnOf_(matched[1].trim());
      if (column) {
        current = column;
        fields[column] = appendValue_(fields[column], matched[2].trim());
        return;
      }
      current = null;
      return;
    }
    // 直前が本文系の項目なら、折り返された続きとして足す
    if (current === '内容' && line.trim() !== '') {
      fields[current] = appendValue_(fields[current], line.trim());
    }
  });
  return fields;
}

function columnOf_(label) {
  var normalized = label.replace(/[■●・\s]/g, '');
  for (var i = 0; i < INQUIRY_FIELDS.length; i++) {
    var column = INQUIRY_FIELDS[i][0];
    var aliases = INQUIRY_FIELDS[i][1];
    for (var j = 0; j < aliases.length; j++) {
      if (normalized === aliases[j]) {
        return column;
      }
    }
  }
  return null;
}

function appendValue_(existing, value) {
  if (value === '') {
    return existing || '';
  }
  return existing ? (existing + ' ' + value) : value;
}

function routeOf_(from, subject) {
  if (from.indexOf('formresponses@netlify.com') !== -1) {
    return '新HP';
  }
  if (subject.indexOf('【HPメール問い合わせ】') !== -1) {
    return '旧HP';
  }
  return 'その他';
}

/** テスト送信を件数から除けるように印を付ける。 */
function isTestInquiry_(body, fields) {
  var target = [fields['会社名'], fields['担当者名'], fields['内容']].join(' ');
  if (/テスト|てすと|tesuto/i.test(target)) {
    return true;
  }
  return /^\s*(test|テスト)\s*$/i.test(String(fields['担当者名'] || '')) || /テスト送信/.test(body);
}

/** 項目に振り分けられなかった場合の、内容欄の埋め合わせ。 */
function summarizeBody_(body) {
  return truncate_(body.replace(/\r\n/g, '\n').split('\n').filter(function (line) {
    return line.trim() !== '';
  }).join(' / '), 200);
}

function truncate_(value, max) {
  var text = String(value || '');
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function openInquirySpreadsheet_() {
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

function inquirySheet_(ss, name, header) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** 記録済み判定用。メッセージIDを集める。 */
function knownMessageIds_(sheet) {
  var known = {};
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return known;
  }
  var col = HEAD_INQUIRY.indexOf('メッセージID') + 1;
  sheet.getRange(2, col, lastRow - 1, 1).getDisplayValues().forEach(function (row) {
    var id = String(row[0]).trim();
    if (id) {
      known[id] = true;
    }
  });
  return known;
}

function applyLabel_(messages) {
  var name = PropertiesService.getScriptProperties().getProperty('LABEL_NAME');
  if (!name || messages.length === 0) {
    return;
  }
  var label = GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
  messages.forEach(function (message) {
    message.getThread().addLabel(label);
  });
}

function readInquiryRecords_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }
  var values = sheet.getRange(2, 1, lastRow - 1, HEAD_INQUIRY.length).getValues();
  var records = [];
  values.forEach(function (row) {
    var received = row[0];
    var date = (received instanceof Date) ? received : new Date(received);
    if (isNaN(date.getTime())) {
      return;
    }
    records.push({
      date: date,
      month: Utilities.formatDate(date, INQUIRY_TZ, 'yyyy-MM'),
      route: String(row[1] || ''),
      isTest: String(row[2] || '') === 'テスト',
      company: String(row[3] || ''),
      name: String(row[4] || ''),
      content: String(row[10] || '')
    });
  });
  records.sort(function (a, b) {
    return a.date - b.date;
  });
  return records;
}

/** 月次集計シートを毎回作り直す（記録シートが正、集計は写し）。 */
function rebuildMonthly_(ss, inquirySheet) {
  var records = readInquiryRecords_(inquirySheet);
  var months = {};
  var order = [];
  records.forEach(function (rec) {
    if (!months[rec.month]) {
      months[rec.month] = { real: 0, test: 0 };
      order.push(rec.month);
    }
    if (rec.isTest) {
      months[rec.month].test += 1;
    } else {
      months[rec.month].real += 1;
    }
  });
  order.sort();

  var sheet = inquirySheet_(ss, SHEET_MONTHLY, HEAD_MONTHLY);
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, HEAD_MONTHLY.length).clearContent();
  }
  if (order.length === 0) {
    return;
  }
  var rows = order.map(function (month) {
    var count = months[month];
    return [month, count.real, count.test, count.real + count.test];
  });
  sheet.getRange(2, 1, rows.length, HEAD_MONTHLY.length).setValues(rows);
}

function buildSummaryHtml_(month, thisMonth, allRecords) {
  var out = [];
  out.push('<div style="font-family:sans-serif;font-size:14px;line-height:1.7;color:#222">');
  out.push('<p>小林様<br>お世話になっております。</p>');
  out.push('<p>' + esc2_(month) + ' のホームページ問い合わせは <b>' + thisMonth.length + '件</b> です。</p>');

  if (thisMonth.length > 0) {
    var th = 'style="border:1px solid #ccc;padding:6px 10px;background:#f2f2f2;white-space:nowrap"';
    var td = 'style="border:1px solid #ccc;padding:6px 10px"';
    out.push('<table style="border-collapse:collapse;font-size:13px"><thead><tr>');
    ['受信日時', '経路', 'お名前', '内容'].forEach(function (label) {
      out.push('<th ' + th + '>' + esc2_(label) + '</th>');
    });
    out.push('</tr></thead><tbody>');
    thisMonth.forEach(function (rec) {
      out.push('<tr>');
      out.push('<td ' + td + '>' + esc2_(Utilities.formatDate(rec.date, INQUIRY_TZ, 'M/d HH:mm')) + '</td>');
      out.push('<td ' + td + '>' + esc2_(rec.route) + '</td>');
      out.push('<td ' + td + '>' + esc2_(rec.name || rec.company || '(未記入)') + '</td>');
      out.push('<td ' + td + '>' + esc2_(truncate_(rec.content, 120)) + '</td>');
      out.push('</tr>');
    });
    out.push('</tbody></table>');
  }

  out.push('<p style="margin-top:20px">' + esc2_(monthlyTrendText_(allRecords)) + '</p>');
  out.push('<p style="color:#666;font-size:12px;margin-top:24px">');
  out.push('※ 件数はテスト送信を除いた実件数です。<br>');
  out.push('※ 本メールはフォーム通知メールを自動集計したものです。');
  out.push('</p>');
  out.push('</div>');
  return out.join('');
}

function monthlyTrendText_(records) {
  var months = {};
  var order = [];
  records.forEach(function (rec) {
    if (rec.isTest) {
      return;
    }
    if (!months[rec.month]) {
      months[rec.month] = 0;
      order.push(rec.month);
    }
    months[rec.month] += 1;
  });
  order.sort();
  var recent = order.slice(-6);
  if (recent.length === 0) {
    return '過去の記録はまだありません。';
  }
  return '直近の推移：' + recent.map(function (month) {
    return month + ' ' + months[month] + '件';
  }).join(' / ');
}

function esc2_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inquiryHtmlToText_(html) {
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
