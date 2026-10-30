/**
 * 業者向け 物件紹介メール 差し込み一斉送信
 *
 * 業者名簿シートを1行ずつ読み、会社名を差し込んで「1社ずつ個別に」送信します。
 * BCC一括ではないため、宛先アドレスが他社に見えることはありません。
 *
 * 【社内情報はこのファイルに書きません】
 *   物件情報・文面・担当者名・宛先はすべてスプレッドシート側に置きます。
 *   スプレッドシートIDだけをスクリプトプロパティ SPREADSHEET_ID で渡します。
 *
 * 導入手順は docs/broker-blast-setup.md を参照。
 *
 * 実行順序（この順番を守ってください）
 *   1. setupBrokerBlastSheets()  … シートと見出しを作る
 *   2. validateBrokerList()      … 名簿の重複・形式エラーを洗う
 *   3. previewBrokerBlast()      … 1件目の文面をログで確認する（送信しない）
 *   4. createBrokerBlastDrafts() … Gmailの下書きを作る（送信しない）
 *   5. sendBrokerBlast()         … 実送信
 */

// ─── 設定 ──────────────────────────────────────────────

/** 名簿シート名 */
var SHEET_LIST = '業者名簿';

/** 文面シート名 */
var SHEET_TEMPLATE = '文面';

/** 1回の実行で送信する上限件数。Gmailの1日上限に当たらないよう区切る */
var BATCH_LIMIT = 50;

/** 1通送るごとに待つミリ秒。急がず送るための間隔 */
var SEND_INTERVAL_MS = 1200;

/** 名簿シートの列番号（1始まり） */
var COL = {
  company: 1,  // 会社名
  person:  2,  // 宛名（担当者名。空欄なら「ご担当者様」）
  email:   3,  // メールアドレス
  stop:    4,  // 配信停止（TRUE なら送らない）
  sent:    5,  // 送信済み（TRUE なら送らない）
  sentAt:  6,  // 送信日時
  error:   7   // エラー
};

var LIST_HEADERS = [
  '会社名', '宛名', 'メールアドレス', '配信停止', '送信済み', '送信日時', 'エラー'
];

/** 文面シートの行番号。値はすべて B 列に入れる */
var TPL = {
  fromName:   1,  // B1 差出人名（例：株式会社スマートハウス 営業部）
  subject:    2,  // B2 件名
  body:       3,  // B3 本文（{{会社名}} {{宛名}} が差し込まれる）
  attachIds:  4,  // B4 添付ファイルID（Google Drive。カンマ区切り。任意）
  replyTo:    5,  // B5 返信先アドレス（任意。空欄なら送信アカウント）
  bccCopy:    6   // B6 自社控えのBCC（任意。1件だけ指定可）
};

var TPL_LABELS = [
  ['差出人名',        ''],
  ['件名',            ''],
  ['本文',            ''],
  ['添付ファイルID',  ''],
  ['返信先アドレス',  ''],
  ['控え用BCC',       '']
];

// ─── 1. 初期セットアップ ────────────────────────────────

/**
 * 名簿シートと文面シートを作成します。
 * 既にあるシートは消しません。見出しが無いときだけ書き込みます。
 */
function setupBrokerBlastSheets() {
  var ss = openSpreadsheet_();

  var list = ss.getSheetByName(SHEET_LIST);
  if (!list) {
    list = ss.insertSheet(SHEET_LIST);
  }
  if (!String(list.getRange(1, 1).getValue())) {
    list.getRange(1, 1, 1, LIST_HEADERS.length).setValues([LIST_HEADERS]);
    list.getRange(1, 1, 1, LIST_HEADERS.length).setFontWeight('bold');
    list.setFrozenRows(1);
    list.setColumnWidth(COL.company, 260);
    list.setColumnWidth(COL.email, 260);
    list.setColumnWidth(COL.error, 320);
    Logger.log('「%s」シートに見出しを作成しました。', SHEET_LIST);
  } else {
    Logger.log('「%s」シートは既にあります。そのまま使います。', SHEET_LIST);
  }

  var tpl = ss.getSheetByName(SHEET_TEMPLATE);
  if (!tpl) {
    tpl = ss.insertSheet(SHEET_TEMPLATE);
  }
  if (!String(tpl.getRange(1, 1).getValue())) {
    tpl.getRange(1, 1, TPL_LABELS.length, 2).setValues(TPL_LABELS);
    tpl.getRange(1, 1, TPL_LABELS.length, 1).setFontWeight('bold');
    tpl.setColumnWidth(1, 160);
    tpl.setColumnWidth(2, 700);
    tpl.getRange(TPL.body, 2).setWrap(true);
    Logger.log('「%s」シートに見出しを作成しました。件名と本文を記入してください。', SHEET_TEMPLATE);
  } else {
    Logger.log('「%s」シートは既にあります。そのまま使います。', SHEET_TEMPLATE);
  }

  Logger.log('セットアップ完了。次は名簿を貼り付けて validateBrokerList() を実行してください。');
}

// ─── 2. 名簿のチェック ──────────────────────────────────

/**
 * 名簿の形式をチェックします。送信も変更もしません。
 * ・メールアドレスの形式
 * ・重複（大文字小文字は同一とみなす）
 * ・会社名の空欄
 */
function validateBrokerList() {
  var rows = readBrokerRows_();
  if (rows.length === 0) {
    Logger.log('名簿が空です。「%s」シートの2行目以降に貼り付けてください。', SHEET_LIST);
    return;
  }

  var seen = {};
  var badFormat = [];
  var duplicated = [];
  var noCompany = [];
  var stopped = 0;
  var alreadySent = 0;
  var sendable = 0;

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];

    if (!r.company) {
      noCompany.push(r.rowNumber);
    }
    if (!isValidEmail_(r.email)) {
      badFormat.push(r.rowNumber + '行目: ' + (r.email || '(空欄)'));
      continue;
    }

    var key = r.email.toLowerCase();
    if (seen[key]) {
      duplicated.push(r.rowNumber + '行目: ' + r.email + '（' + seen[key] + '行目と重複）');
    } else {
      seen[key] = r.rowNumber;
    }

    if (r.stop) {
      stopped++;
    } else if (r.sent) {
      alreadySent++;
    } else {
      sendable++;
    }
  }

  Logger.log('───── 名簿チェック結果 ─────');
  Logger.log('名簿の行数　　　　：%s 件', rows.length);
  Logger.log('送信できる件数　　：%s 件', sendable);
  Logger.log('配信停止　　　　　：%s 件', stopped);
  Logger.log('送信済み　　　　　：%s 件', alreadySent);
  Logger.log('アドレス形式エラー：%s 件', badFormat.length);
  Logger.log('重複　　　　　　　：%s 件', duplicated.length);
  Logger.log('会社名が空欄　　　：%s 件', noCompany.length);

  if (badFormat.length) {
    Logger.log('\n【形式エラーの行】\n%s', badFormat.join('\n'));
  }
  if (duplicated.length) {
    Logger.log('\n【重複している行】（後の行は送信対象から外してください）\n%s', duplicated.join('\n'));
  }
  if (noCompany.length) {
    Logger.log('\n【会社名が空欄の行】%s', noCompany.join(', '));
    Logger.log('会社名が空欄だと差し込みができず「ご担当者様」のみになります。');
  }
  Logger.log('\n残りの送信可能数（Gmailの1日上限）：%s 通', MailApp.getRemainingDailyQuota());
}

// ─── 3. 文面プレビュー ──────────────────────────────────

/**
 * 送信対象の1件目について、実際に送られる件名と本文をログに出します。
 * 送信も下書き作成もしません。必ずこれで確認してから進めてください。
 */
function previewBrokerBlast() {
  var tpl = readTemplate_();
  var rows = readBrokerRows_();
  var target = null;

  for (var i = 0; i < rows.length; i++) {
    if (!rows[i].stop && !rows[i].sent && isValidEmail_(rows[i].email)) {
      target = rows[i];
      break;
    }
  }

  if (!target) {
    Logger.log('送信対象の行がありません。名簿と「配信停止」「送信済み」列を確認してください。');
    return;
  }

  var rendered = render_(tpl, target);

  Logger.log('───── 1件目のプレビュー（%s行目） ─────', target.rowNumber);
  Logger.log('差出人名：%s', tpl.fromName || '(未設定。送信アカウント名が使われます)');
  Logger.log('宛先　　：%s', target.email);
  Logger.log('返信先　：%s', tpl.replyTo || '(未設定。送信アカウントになります)');
  Logger.log('控えBCC ：%s', tpl.bccCopy || '(なし)');
  Logger.log('件名　　：%s', rendered.subject);
  Logger.log('\n【本文】\n%s', rendered.body);

  var files = resolveAttachments_(tpl.attachIds);
  if (files.errors.length) {
    Logger.log('\n【添付の取得エラー】\n%s', files.errors.join('\n'));
  }
  if (files.blobs.length) {
    var names = [];
    for (var j = 0; j < files.blobs.length; j++) {
      names.push(files.blobs[j].getName());
    }
    Logger.log('\n【添付ファイル】%s', names.join(' / '));
  } else {
    Logger.log('\n【添付ファイル】なし');
  }

  var leftover = findPlaceholders_(rendered.subject + '\n' + rendered.body);
  if (leftover.length) {
    Logger.log('\n⚠ 差し込まれていない箇所が残っています：%s', leftover.join(', '));
  }
  var brackets = countBrackets_(rendered.subject + '\n' + rendered.body);
  if (brackets > 0) {
    Logger.log('⚠ 未記入の【　】が %s 箇所あります。埋めてから送信してください。', brackets);
  }
}

// ─── 4. 下書き作成 ─────────────────────────────────────

/**
 * 送信対象すべてについて Gmail の下書きを作ります。送信はしません。
 * 下書きを目で確認してから送りたい場合に使います。
 * 件数が多いと下書きが大量にできるので、まずは少数で試してください。
 */
function createBrokerBlastDrafts() {
  var result = deliver_(true);
  Logger.log('下書きを %s 件作成しました。Gmailの下書きフォルダを確認してください。', result.done);
  if (result.failed) {
    Logger.log('作成に失敗：%s 件。名簿の「エラー」列を確認してください。', result.failed);
  }
}

// ─── 5. 実送信 ─────────────────────────────────────────

/**
 * 実際に送信します。1回の実行で BATCH_LIMIT 件まで。
 * 送信できた行は「送信済み」が TRUE になり、次回は飛ばされます。
 * 件数が多い場合は、日を分けて複数回実行してください。
 */
function sendBrokerBlast() {
  var result = deliver_(false);
  Logger.log('───── 送信結果 ─────');
  Logger.log('送信　　：%s 件', result.done);
  Logger.log('失敗　　：%s 件', result.failed);
  Logger.log('未送信　：%s 件（次回の実行で送られます）', result.remaining);
  Logger.log('本日の残り送信可能数：%s 通', MailApp.getRemainingDailyQuota());
  if (result.failed) {
    Logger.log('失敗した行は名簿の「エラー」列に理由が入っています。');
  }
}

// ─── 配信停止の反映 ────────────────────────────────────

/**
 * 配信停止にしたいアドレスを名簿に反映します。
 * 「配信停止」と返信があったアドレスを、カンマ区切りまたは改行区切りで渡してください。
 *
 * 例：markUnsubscribed('aaa@example.com, bbb@example.com')
 */
function markUnsubscribed(addresses) {
  if (!addresses) {
    Logger.log('アドレスを渡してください。例：markUnsubscribed(\'aaa@example.com\')');
    return;
  }

  var targets = {};
  var parts = String(addresses).split(/[,\n\r\t ]+/);
  for (var i = 0; i < parts.length; i++) {
    var a = parts[i].trim().toLowerCase();
    if (a) {
      targets[a] = true;
    }
  }

  var sheet = getSheet_(SHEET_LIST);
  var rows = readBrokerRows_();
  var hit = 0;
  var notFound = [];

  for (var j = 0; j < rows.length; j++) {
    var key = (rows[j].email || '').toLowerCase();
    if (key && targets[key]) {
      sheet.getRange(rows[j].rowNumber, COL.stop).setValue(true);
      hit++;
      delete targets[key];
    }
  }

  for (var left in targets) {
    if (targets.hasOwnProperty(left)) {
      notFound.push(left);
    }
  }

  Logger.log('配信停止にしました：%s 件', hit);
  if (notFound.length) {
    Logger.log('名簿に見つかりませんでした：%s', notFound.join(', '));
  }
}

// ─── 内部処理 ──────────────────────────────────────────

/**
 * 送信または下書き作成の本体。
 * @param {boolean} draftOnly true なら下書きだけ作る
 */
function deliver_(draftOnly) {
  var tpl = readTemplate_();

  if (!tpl.subject) {
    throw new Error('「' + SHEET_TEMPLATE + '」シートの件名（B' + TPL.subject + '）が空です。');
  }
  if (!tpl.body) {
    throw new Error('「' + SHEET_TEMPLATE + '」シートの本文（B' + TPL.body + '）が空です。');
  }

  // 未記入の【　】が残っていたら止める。業者に出す文面なので辻褄合わせはしない。
  var unfilled = countBrackets_(tpl.subject + '\n' + tpl.body);
  if (unfilled > 0) {
    throw new Error(
      '本文または件名に未記入の【　】が ' + unfilled + ' 箇所あります。' +
      '間取り・面積・階・現況・担当者名などを埋めてから実行してください。'
    );
  }

  var attach = resolveAttachments_(tpl.attachIds);
  if (attach.errors.length) {
    throw new Error('添付ファイルを取得できません。\n' + attach.errors.join('\n'));
  }

  var sheet = getSheet_(SHEET_LIST);
  var rows = readBrokerRows_();
  var quota = MailApp.getRemainingDailyQuota();

  var done = 0;
  var failed = 0;
  var remaining = 0;

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];

    if (r.stop || r.sent) {
      continue;
    }
    if (!isValidEmail_(r.email)) {
      sheet.getRange(r.rowNumber, COL.error).setValue('アドレスの形式が不正');
      failed++;
      continue;
    }
    if (done >= BATCH_LIMIT) {
      remaining++;
      continue;
    }
    if (!draftOnly && quota - done <= 0) {
      remaining++;
      continue;
    }

    var rendered = render_(tpl, r);
    var options = { name: tpl.fromName || undefined };

    if (attach.blobs.length) {
      options.attachments = attach.blobs;
    }
    if (tpl.replyTo) {
      options.replyTo = tpl.replyTo;
    }
    if (tpl.bccCopy) {
      options.bcc = tpl.bccCopy;
    }

    try {
      if (draftOnly) {
        GmailApp.createDraft(r.email, rendered.subject, rendered.body, options);
      } else {
        GmailApp.sendEmail(r.email, rendered.subject, rendered.body, options);
        sheet.getRange(r.rowNumber, COL.sent).setValue(true);
        sheet.getRange(r.rowNumber, COL.sentAt).setValue(new Date());
      }
      sheet.getRange(r.rowNumber, COL.error).clearContent();
      done++;
    } catch (e) {
      sheet.getRange(r.rowNumber, COL.error).setValue(String(e && e.message ? e.message : e));
      failed++;
    }

    Utilities.sleep(SEND_INTERVAL_MS);
  }

  return { done: done, failed: failed, remaining: remaining };
}

/** 文面を差し込んで組み立てる */
function render_(tpl, row) {
  var company = row.company || '';
  var person = row.person || 'ご担当者様';

  return {
    subject: fill_(tpl.subject, company, person),
    body: fill_(tpl.body, company, person)
  };
}

function fill_(text, company, person) {
  return String(text)
    .replace(/\{\{会社名\}\}/g, company)
    .replace(/\{\{宛名\}\}/g, person);
}

/** 差し込み漏れの {{...}} を探す */
function findPlaceholders_(text) {
  var found = String(text).match(/\{\{[^}]*\}\}/g);
  return found ? found : [];
}

/** 未記入の【　】（全角スペースのみ、または空）を数える */
function countBrackets_(text) {
  var found = String(text).match(/【[\s　]*】/g);
  return found ? found.length : 0;
}

/** 名簿を読む */
function readBrokerRows_() {
  var sheet = getSheet_(SHEET_LIST);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  var values = sheet.getRange(2, 1, lastRow - 1, LIST_HEADERS.length).getValues();
  var rows = [];

  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    var email = String(v[COL.email - 1] || '').trim();
    var company = String(v[COL.company - 1] || '').trim();

    // 会社名もアドレスも空の行は、名簿の終わりとして飛ばす
    if (!email && !company) {
      continue;
    }

    rows.push({
      rowNumber: i + 2,
      company: company,
      person: String(v[COL.person - 1] || '').trim(),
      email: email,
      stop: isTrue_(v[COL.stop - 1]),
      sent: isTrue_(v[COL.sent - 1])
    });
  }

  return rows;
}

/** 文面シートを読む */
function readTemplate_() {
  var sheet = getSheet_(SHEET_TEMPLATE);
  return {
    fromName:  String(sheet.getRange(TPL.fromName, 2).getValue() || '').trim(),
    subject:   String(sheet.getRange(TPL.subject, 2).getValue() || '').trim(),
    body:      String(sheet.getRange(TPL.body, 2).getValue() || ''),
    attachIds: String(sheet.getRange(TPL.attachIds, 2).getValue() || '').trim(),
    replyTo:   String(sheet.getRange(TPL.replyTo, 2).getValue() || '').trim(),
    bccCopy:   String(sheet.getRange(TPL.bccCopy, 2).getValue() || '').trim()
  };
}

/** Drive のファイルIDから添付用の blob を作る */
function resolveAttachments_(idsText) {
  var blobs = [];
  var errors = [];

  if (!idsText) {
    return { blobs: blobs, errors: errors };
  }

  var ids = String(idsText).split(/[,\n\r\t ]+/);
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i].trim();
    if (!id) {
      continue;
    }
    try {
      blobs.push(DriveApp.getFileById(id).getBlob());
    } catch (e) {
      errors.push('ファイルID ' + id + ' を取得できません：' + (e && e.message ? e.message : e));
    }
  }

  return { blobs: blobs, errors: errors };
}

function openSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) {
    // スプレッドシートに紐づけたスクリプトなら、そのまま開けます
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) {
      return active;
    }
    throw new Error(
      'スクリプトプロパティ SPREADSHEET_ID が未設定です。' +
      'プロジェクトの設定 > スクリプト プロパティ に追加してください。'
    );
  }
  return SpreadsheetApp.openById(id);
}

function getSheet_(name) {
  var sheet = openSpreadsheet_().getSheetByName(name);
  if (!sheet) {
    throw new Error('「' + name + '」シートがありません。setupBrokerBlastSheets() を実行してください。');
  }
  return sheet;
}

function isValidEmail_(value) {
  var s = String(value || '').trim();
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/.test(s);
}

function isTrue_(value) {
  if (value === true) {
    return true;
  }
  var s = String(value || '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'はい' || s === '○' || s === 'yes';
}
