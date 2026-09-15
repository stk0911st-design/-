/**
 * 社内通達 自動配信
 *
 * 管理スプレッドシートの「通達一覧」に1行書いておくと、指定した配信日時に
 * 次の4つを自動で実行する。
 *
 *   1. 全従業員へ HTML メール送信（PDF添付にも対応）
 *   2. Slack の通達チャンネルへ投稿
 *   3. Google カレンダーへ実施期間の終日予定を登録
 *   4. 通達ドキュメント・PDF を保管フォルダへ移動し、結果を行に書き戻し
 *
 * 本文は Google ドキュメントに書く。見出し・箇条書き・表をそのまま
 * メールの体裁と Slack の書式に変換する。
 *
 * 想定トリガー: 時間主導型 / 10分おき → checkNotices
 *
 * スクリプトプロパティ:
 *   RECIPIENTS         全従業員の宛先（カンマ区切り・必須）
 *   PRESIDENT_EMAIL    完了報告・テスト送信の宛先（必須）
 *   COMPANY_NAME       文書ヘッダーの会社名（任意）
 *   SIGNER             発信者の肩書き・氏名（任意）
 *   SLACK_WEBHOOK_URL  Slack Incoming Webhook（任意・未設定ならSlack投稿を省略）
 *   SLACK_CHANNEL_URL  完了報告に載せるチャンネルURL（任意）
 *   CALENDAR_ID        登録先カレンダーID（任意・既定は本人のカレンダー）
 *   ARCHIVE_FOLDER_ID  通達の保管フォルダID（任意・未設定なら移動しない）
 *   SPREADSHEET_ID     対象スプレッドシートID（コンテナバインドでない場合のみ必須）
 *
 * ※ アドレス・ID などの社内情報はすべてスクリプトプロパティに置く。
 *    このファイルには書かないこと。
 */

var ND_TZ = 'Asia/Tokyo';
var ND_SHEET = '通達一覧';
var ND_LOG = '配信ログ';

/** 通達一覧の列。1始まり。 */
var ND_COL = {
  DOC_NO: 1,      // 文書番号
  SUBJECT: 2,     // 件名
  BODY_DOC: 3,    // 本文（GoogleドキュメントのURLまたはID）
  PDF: 4,         // 添付PDF（URLまたはID・任意）
  SEND_AT: 5,     // 配信日時
  TERM_FROM: 6,   // 実施開始日（任意）
  TERM_TO: 7,     // 実施終了日（任意）
  TO: 8,          // 宛先（空欄なら全従業員）
  STATUS: 9,      // 状態
  RESULT: 10,     // 結果
  UPDATED: 11     // 更新日時
};

var ND_HEAD = ['文書番号', '件名', '本文（ドキュメント）', '添付PDF', '配信日時',
               '実施開始日', '実施終了日', '宛先（空欄=全従業員）', '状態', '結果', '更新日時'];
var ND_HEAD_LOG = ['日時', '文書番号', '件名', '結果', '内容'];

/** 配信予定時刻をこの時間以上過ぎた行は、事故防止のため送らない。 */
var ND_GRACE_HOURS = 24;

// ────────────────────────────────────────────────────────────
// エントリポイント
// ────────────────────────────────────────────────────────────

/** 10分おきのトリガーから呼ぶ本番用。配信時刻が来た行をすべて処理する。 */
function checkNotices() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log('別の実行が動いているため中止しました。');
    return;
  }
  try {
    var sh = noticeSheet_();
    var last = sh.getLastRow();
    if (last < 2) return;

    var values = sh.getRange(2, 1, last - 1, ND_HEAD.length).getValues();
    var now = new Date();
    var done = 0;

    for (var i = 0; i < values.length; i++) {
      var row = i + 2;
      var status = String(values[i][ND_COL.STATUS - 1] || '').trim();
      if (status && status !== '予定') continue;          // 配信済・エラーなどは触らない

      var sendAt = values[i][ND_COL.SEND_AT - 1];
      if (!(sendAt instanceof Date)) continue;             // 日時未入力は対象外
      if (sendAt.getTime() > now.getTime()) continue;      // まだ時刻前

      if (now.getTime() - sendAt.getTime() > ND_GRACE_HOURS * 3600 * 1000) {
        finish_(sh, row, 'エラー',
                '配信予定時刻を' + ND_GRACE_HOURS + '時間以上過ぎているため送信していません。' +
                '送る場合は配信日時を入れ直し、状態を空欄にしてください。');
        continue;
      }

      distribute_(sh, row, values[i], false);
      done++;
    }
    if (done) Logger.log(done + '件の通達を配信しました。');
  } finally {
    lock.releaseLock();
  }
}

/** 選択中の行を、社長宛だけに【見本】として試し送りする。 */
function sendTestForSelectedRow() {
  var sh = noticeSheet_();
  var row = SpreadsheetApp.getActiveSheet().getActiveRange().getRow();
  if (SpreadsheetApp.getActiveSheet().getName() !== ND_SHEET || row < 2) {
    ui_().alert('「' + ND_SHEET + '」シートで、試し送りしたい通達の行を選んでから実行してください。');
    return;
  }
  var values = sh.getRange(row, 1, 1, ND_HEAD.length).getValues()[0];
  var result = distribute_(sh, row, values, true);
  ui_().alert(result.ok
    ? '見本を送信しました。\n\n' + result.message
    : '見本を送信できませんでした。\n\n' + result.message);
}

/** 選択中の行を、予定時刻を待たずに今すぐ本番配信する。 */
function sendNowForSelectedRow() {
  var sh = noticeSheet_();
  var row = SpreadsheetApp.getActiveSheet().getActiveRange().getRow();
  if (SpreadsheetApp.getActiveSheet().getName() !== ND_SHEET || row < 2) {
    ui_().alert('「' + ND_SHEET + '」シートで、配信したい通達の行を選んでから実行してください。');
    return;
  }
  var values = sh.getRange(row, 1, 1, ND_HEAD.length).getValues()[0];
  var subject = String(values[ND_COL.SUBJECT - 1] || '(件名なし)');
  var to = resolveRecipients_(values[ND_COL.TO - 1]);
  var answer = ui_().alert('この通達を今すぐ全員へ配信します。よろしいですか？',
    '件名：' + subject + '\n宛先：' + to.length + '名\n\n' + to.join('\n'),
    ui_().ButtonSet.OK_CANCEL);
  if (answer !== ui_().Button.OK) return;

  var result = distribute_(sh, row, values, false);
  ui_().alert(result.ok ? '配信しました。\n\n' + result.message
                        : '配信できませんでした。\n\n' + result.message);
}

/** 10分おきのトリガーを設置する（同じものがあれば入れ直す）。 */
function setupTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'checkNotices') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('checkNotices').timeBased().everyMinutes(10).create();
  Logger.log('10分おきのトリガーを設置しました。');
}

/** 設定とシートの状態をまとめて確認する。 */
function checkSetup() {
  var p = PropertiesService.getScriptProperties();
  var lines = [];
  var recipients = resolveRecipients_('');
  lines.push('宛先（RECIPIENTS）：' + (recipients.length ? recipients.length + '名' : '未設定 ← 必須'));
  lines.push('完了報告先（PRESIDENT_EMAIL）：' + (p.getProperty('PRESIDENT_EMAIL') || '未設定 ← 必須'));
  lines.push('Slack（SLACK_WEBHOOK_URL）：' + (p.getProperty('SLACK_WEBHOOK_URL') ? '設定済み' : '未設定 → Slack投稿は省略されます'));
  lines.push('カレンダー（CALENDAR_ID）：' + (p.getProperty('CALENDAR_ID') || '本人のカレンダー'));
  lines.push('保管フォルダ（ARCHIVE_FOLDER_ID）：' + (p.getProperty('ARCHIVE_FOLDER_ID') ? '設定済み' : '未設定 → 移動しません'));

  var hasTrigger = false;
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'checkNotices') hasTrigger = true;
  }
  lines.push('自動チェック：' + (hasTrigger ? '動いています（10分おき）' : '未設置 ← メニューから設置してください'));

  var text = lines.join('\n');
  Logger.log(text);
  try { ui_().alert('通達配信の設定', text, ui_().ButtonSet.OK); } catch (e) { /* 手動実行時 */ }
}

function onOpen() {
  ui_().createMenu('通達配信')
    .addItem('選んだ行を見本で送る（社長のみ）', 'sendTestForSelectedRow')
    .addItem('選んだ行を今すぐ配信する', 'sendNowForSelectedRow')
    .addSeparator()
    .addItem('配信時刻が来た行を今すぐ確認する', 'checkNotices')
    .addItem('自動チェックを設置する（10分おき）', 'setupTrigger')
    .addItem('設定を確認する', 'checkSetup')
    .addToUi();
}

// ────────────────────────────────────────────────────────────
// 配信本体
// ────────────────────────────────────────────────────────────

/**
 * 1件の通達を配信する。
 * isTest なら社長宛だけに【見本】を送り、Slack・カレンダー・保管は行わない。
 */
function distribute_(sh, row, values, isTest) {
  var docNo = String(values[ND_COL.DOC_NO - 1] || '').trim();
  var subject = String(values[ND_COL.SUBJECT - 1] || '').trim();
  var notes = [];

  try {
    if (!subject) throw new Error('件名が空です。');

    var docId = extractId_(values[ND_COL.BODY_DOC - 1]);
    if (!docId) throw new Error('本文のドキュメントが指定されていません。');

    if (!isTest) setStatus_(sh, row, '送信中', '');

    var notice = {
      docNo: docNo,
      subject: subject,
      blocks: parseDoc_(docId),
      termFrom: asDate_(values[ND_COL.TERM_FROM - 1]),
      termTo: asDate_(values[ND_COL.TERM_TO - 1]),
      sendAt: asDate_(values[ND_COL.SEND_AT - 1]) || new Date()
    };

    // 1. メール
    var props = PropertiesService.getScriptProperties();
    var president = props.getProperty('PRESIDENT_EMAIL');
    var to = isTest ? [president] : resolveRecipients_(values[ND_COL.TO - 1]);
    if (!to.length || !to[0]) throw new Error('宛先が設定されていません。');

    var attachments = [];
    var pdfId = extractId_(values[ND_COL.PDF - 1]);
    if (pdfId) {
      var blob = DriveApp.getFileById(pdfId).getBlob();
      if (blob.getBytes().length > 24 * 1024 * 1024) {
        notes.push('PDFが大きすぎるため添付しませんでした。');
      } else {
        attachments.push(blob);
      }
    }

    var mailSubject = (isTest ? '【見本】' : '') +
                      (docNo ? '【社内通達 ' + docNo + '】' : '') + subject;
    GmailApp.sendEmail(to.join(','), mailSubject, buildPlainBody_(notice), {
      htmlBody: buildHtmlBody_(notice, isTest),
      attachments: attachments,
      name: props.getProperty('COMPANY_NAME') || undefined
    });
    notes.push('メール ' + to.length + '名へ送信');

    if (isTest) {
      log_('見本', docNo, subject, notes.join(' / '));
      return { ok: true, message: notes.join('\n') };
    }

    // 2. Slack
    var webhook = props.getProperty('SLACK_WEBHOOK_URL');
    if (webhook) {
      postSlack_(webhook, buildSlackText_(notice));
      notes.push('Slack へ投稿');
    } else {
      notes.push('Slack は未設定のため省略');
    }

    // 3. カレンダー
    if (notice.termFrom) {
      createTermEvent_(notice);
      notes.push('カレンダーへ実施期間を登録');
    }

    // 4. 保管
    var moved = archive_(docId, pdfId);
    if (moved) notes.push('保管フォルダへ移動');

    var message = notes.join(' / ');
    finish_(sh, row, '配信済', message);
    log_('配信済', docNo, subject, message);
    reportToPresident_(notice, to, message, null);
    return { ok: true, message: notes.join('\n') };

  } catch (err) {
    var reason = String(err && err.message ? err.message : err);
    if (!isTest) {
      finish_(sh, row, 'エラー', reason);
      log_('エラー', docNo, subject, reason);
      reportToPresident_({ docNo: docNo, subject: subject }, [], notes.join(' / '), reason);
    }
    return { ok: false, message: reason };
  }
}

/** 配信結果を行に書き戻す。 */
function finish_(sh, row, status, message) {
  setStatus_(sh, row, status, message);
}

function setStatus_(sh, row, status, message) {
  sh.getRange(row, ND_COL.STATUS).setValue(status);
  sh.getRange(row, ND_COL.RESULT).setValue(message || '');
  sh.getRange(row, ND_COL.UPDATED).setValue(new Date());
  SpreadsheetApp.flush();
}

function log_(kind, docNo, subject, note) {
  var ss = openSpreadsheetNd_();
  var sh = ss.getSheetByName(ND_LOG);
  if (!sh) {
    sh = ss.insertSheet(ND_LOG);
    sh.getRange(1, 1, 1, ND_HEAD_LOG.length).setValues([ND_HEAD_LOG]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  sh.appendRow([new Date(), docNo, subject, kind, note]);
}

// ────────────────────────────────────────────────────────────
// 通達ドキュメントの読み取り
// ────────────────────────────────────────────────────────────

/**
 * Google ドキュメントを、メールと Slack の両方に使える中間形に変換する。
 * 返り値: [{kind:'h1'|'h2'|'p'|'li'|'table', text/html/rows}, ...]
 */
function parseDoc_(docId) {
  var body = DocumentApp.openById(docId).getBody();
  var blocks = [];
  var n = body.getNumChildren();

  for (var i = 0; i < n; i++) {
    var el = body.getChild(i);
    var type = el.getType();

    if (type === DocumentApp.ElementType.LIST_ITEM) {
      var li = el.asListItem();
      if (!li.getText()) continue;
      blocks.push({ kind: 'li', text: li.getText(), html: richHtml_(li) });
      continue;
    }

    if (type === DocumentApp.ElementType.PARAGRAPH) {
      var p = el.asParagraph();
      var text = p.getText();
      if (!text.replace(/\s/g, '')) continue;
      var h = p.getHeading();
      var kind = 'p';
      if (h === DocumentApp.ParagraphHeading.TITLE || h === DocumentApp.ParagraphHeading.HEADING1) kind = 'h1';
      else if (h === DocumentApp.ParagraphHeading.HEADING2 || h === DocumentApp.ParagraphHeading.HEADING3) kind = 'h2';
      blocks.push({ kind: kind, text: text, html: richHtml_(p) });
      continue;
    }

    if (type === DocumentApp.ElementType.TABLE) {
      var table = el.asTable();
      var rows = [];
      for (var r = 0; r < table.getNumRows(); r++) {
        var tr = table.getRow(r);
        var cells = [];
        for (var c = 0; c < tr.getNumCells(); c++) cells.push(tr.getCell(c).getText());
        rows.push(cells);
      }
      if (rows.length) blocks.push({ kind: 'table', rows: rows });
    }
  }
  return blocks;
}

/** 太字を <b> として残しつつ HTML エスケープする。 */
function richHtml_(paragraphOrItem) {
  var text = paragraphOrItem.editAsText();
  var raw = text.getText();
  if (!raw) return '';

  var idx = text.getTextAttributeIndices();
  if (!idx.length) return esc_(raw);
  if (idx[0] !== 0) idx.unshift(0);

  var out = [];
  for (var i = 0; i < idx.length; i++) {
    var start = idx[i];
    var end = (i + 1 < idx.length) ? idx[i + 1] : raw.length;
    if (end <= start) continue;
    var part = esc_(raw.substring(start, end));
    if (text.isBold(start)) part = '<b>' + part + '</b>';
    out.push(part);
  }
  return out.join('');
}

function esc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ────────────────────────────────────────────────────────────
// 文面の組み立て
// ────────────────────────────────────────────────────────────

function buildHtmlBody_(notice, isTest) {
  var props = PropertiesService.getScriptProperties();
  var company = props.getProperty('COMPANY_NAME') || '';
  var signer = props.getProperty('SIGNER') || '';
  var dateText = Utilities.formatDate(notice.sendAt, ND_TZ, 'yyyy年M月d日') + '（' + youbi_(notice.sendAt) + '）';

  var h = [];
  h.push('<div style="font-family:\'Hiragino Sans\',\'Yu Gothic\',\'Meiryo\',sans-serif;font-size:14px;line-height:1.7;color:#222;max-width:720px;margin:0 auto;">');

  if (isTest) {
    h.push('<div style="background:#fff3cd;border:1px solid #e0b400;padding:10px 14px;margin-bottom:16px;font-size:13px;">' +
           '<b>【見本】</b>配信前の確認用です。本番ではこの枠は付きません。</div>');
  }

  h.push('<table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:3px solid #1e7a3c;margin-bottom:12px;"><tr>' +
         '<td style="font-size:16px;font-weight:bold;color:#1e7a3c;padding:6px 0;">' + esc_(company) + '</td>' +
         '<td style="text-align:right;font-size:12px;color:#555;">' +
         (notice.docNo ? '社内通達 <b style="color:#1e7a3c;">' + esc_(notice.docNo) + '</b><br>' : '') +
         dateText + '</td></tr></table>');

  h.push('<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
         '<td style="font-size:15px;font-weight:bold;">従業員各位</td>' +
         '<td style="text-align:right;font-size:13px;">' + esc_(company) + (signer ? '<br>' + esc_(signer) : '') +
         '</td></tr></table>');

  h.push('<div style="background:#1e7a3c;color:#fff;padding:14px 18px;border-radius:6px;margin:14px 0;">' +
         '<div style="font-size:11px;letter-spacing:.1em;">社長通達</div>' +
         '<div style="font-size:20px;font-weight:bold;">' + esc_(notice.subject) + '</div>' +
         (termText_(notice) ? '<div style="font-size:13px;margin-top:8px;background:#fff;color:#1e7a3c;display:inline-block;padding:2px 10px;border-radius:4px;font-weight:bold;">実施期間：' + esc_(termText_(notice)) + '</div>' : '') +
         '</div>');

  h.push(blocksToHtml_(notice.blocks));

  h.push('<p style="text-align:right;font-weight:bold;">以上</p>');
  h.push('<p style="font-size:11px;color:#777;border-top:1px solid #ddd;padding-top:6px;">' +
         esc_(company) + '　' + (notice.docNo ? '社内通達 ' + esc_(notice.docNo) : '社内通達') +
         '（本メールは社内通達チャンネルにも同内容を掲載しています）</p>');
  h.push('</div>');
  return h.join('\n');
}

function blocksToHtml_(blocks) {
  var out = [];
  var inList = false;
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    if (b.kind === 'li') {
      if (!inList) { out.push('<ul style="margin:0 0 8px 20px;padding:0;">'); inList = true; }
      out.push('<li>' + b.html + '</li>');
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }

    if (b.kind === 'h1') {
      out.push('<h3 style="background:#1e7a3c;color:#fff;padding:6px 12px;font-size:14px;margin:18px 0 8px;">' + b.html + '</h3>');
    } else if (b.kind === 'h2') {
      out.push('<h4 style="color:#1e7a3c;font-size:14px;margin:14px 0 6px;border-left:4px solid #1e7a3c;padding-left:8px;">' + b.html + '</h4>');
    } else if (b.kind === 'table') {
      out.push(tableToHtml_(b.rows));
    } else {
      out.push('<p style="margin:6px 0;">' + b.html + '</p>');
    }
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

function tableToHtml_(rows) {
  var out = ['<table width="100%" cellpadding="6" cellspacing="0" style="border:1px solid #ccc;border-collapse:collapse;font-size:13px;margin:8px 0;">'];
  for (var r = 0; r < rows.length; r++) {
    out.push('<tr>');
    for (var c = 0; c < rows[r].length; c++) {
      var cell = esc_(rows[r][c]);
      if (r === 0) {
        out.push('<td style="border:1px solid #ccc;background:#1e7a3c;color:#fff;font-weight:bold;">' + cell + '</td>');
      } else {
        out.push('<td style="border:1px solid #ccc;">' + cell + '</td>');
      }
    }
    out.push('</tr>');
  }
  out.push('</table>');
  return out.join('');
}

function buildPlainBody_(notice) {
  var props = PropertiesService.getScriptProperties();
  var lines = ['従業員各位', ''];
  if (notice.docNo) lines.push('社内通達 ' + notice.docNo);
  lines.push(notice.subject);
  var company = props.getProperty('COMPANY_NAME');
  var signer = props.getProperty('SIGNER');
  if (company) lines.push(company + (signer ? '　' + signer : ''));
  if (termText_(notice)) lines.push('実施期間：' + termText_(notice));
  lines.push('');

  for (var i = 0; i < notice.blocks.length; i++) {
    var b = notice.blocks[i];
    if (b.kind === 'h1') lines.push('', '■ ' + b.text);
    else if (b.kind === 'h2') lines.push('', '＜' + b.text + '＞');
    else if (b.kind === 'li') lines.push('・' + b.text);
    else if (b.kind === 'table') {
      for (var r = 0; r < b.rows.length; r++) lines.push('　' + b.rows[r].join(' ／ '));
    } else lines.push(b.text);
  }
  lines.push('', '以上');
  return lines.join('\n');
}

function buildSlackText_(notice) {
  var props = PropertiesService.getScriptProperties();
  var company = props.getProperty('COMPANY_NAME') || '';
  var signer = props.getProperty('SIGNER') || '';
  var dateText = Utilities.formatDate(notice.sendAt, ND_TZ, 'yyyy年M月d日') + '（' + youbi_(notice.sendAt) + '）';

  var lines = ['<!channel>'];
  lines.push('*' + (notice.docNo ? '【社内通達 ' + notice.docNo + '（社長通達）】' : '【社内通達】') + notice.subject + '*');
  lines.push(dateText + '　従業員各位　' + company + (signer ? '　' + signer : ''));
  if (termText_(notice)) lines.push('*実施期間：' + termText_(notice) + '*');
  lines.push('');

  for (var i = 0; i < notice.blocks.length; i++) {
    var b = notice.blocks[i];
    if (b.kind === 'h1') lines.push('', '*' + b.text + '*');
    else if (b.kind === 'h2') lines.push('_' + b.text + '_');
    else if (b.kind === 'li') lines.push('・' + b.text);
    else if (b.kind === 'table') {
      for (var r = 0; r < b.rows.length; r++) {
        lines.push((r === 0 ? '*' + b.rows[r].join(' ／ ') + '*' : '・' + b.rows[r].join(' ／ ')));
      }
    } else lines.push(b.text);
  }
  lines.push('', '以上', '※同内容を全従業員宛にメールでもお送りしています。');
  return lines.join('\n');
}

function termText_(notice) {
  if (!notice.termFrom) return '';
  var from = Utilities.formatDate(notice.termFrom, ND_TZ, 'yyyy年M月d日') + '（' + youbi_(notice.termFrom) + '）';
  if (!notice.termTo) return from + 'から';
  var to = Utilities.formatDate(notice.termTo, ND_TZ, 'yyyy年M月d日') + '（' + youbi_(notice.termTo) + '）';
  return from + '〜' + to;
}

function youbi_(d) {
  return ['日', '月', '火', '水', '木', '金', '土'][
    Number(Utilities.formatDate(d, ND_TZ, 'u')) % 7
  ];
}

// ────────────────────────────────────────────────────────────
// 送信先ごとの処理
// ────────────────────────────────────────────────────────────

function postSlack_(webhook, text) {
  var res = UrlFetchApp.fetch(webhook, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: text, link_names: 1 }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Slack へ投稿できませんでした（' + code + ' ' + res.getContentText() + '）');
  }
}

function createTermEvent_(notice) {
  var props = PropertiesService.getScriptProperties();
  var calId = props.getProperty('CALENDAR_ID');
  var cal = calId ? CalendarApp.getCalendarById(calId) : CalendarApp.getDefaultCalendar();
  if (!cal) throw new Error('カレンダーが見つかりません（CALENDAR_ID を確認してください）。');

  var title = '【実施中' + (notice.termTo ? ' ' + Utilities.formatDate(notice.termFrom, ND_TZ, 'M/d') +
              '〜' + Utilities.formatDate(notice.termTo, ND_TZ, 'M/d') : '') + '】' +
              notice.subject + (notice.docNo ? '（社長通達 ' + notice.docNo + '）' : '');

  var end = new Date((notice.termTo || notice.termFrom).getTime());
  end.setDate(end.getDate() + 1);            // 終日予定の終了日は翌日を指定する

  var desc = [];
  if (notice.docNo) desc.push('社長通達 ' + notice.docNo);
  desc.push('実施期間：' + termText_(notice));
  desc.push('');
  desc.push(buildPlainBody_(notice));

  var ev = cal.createAllDayEvent(title, notice.termFrom, end, { description: desc.join('\n') });
  ev.setTransparency(CalendarApp.EventTransparency.TRANSPARENT);   // 予定を塞がない
  return ev;
}

/** 通達ドキュメントと PDF を保管フォルダへ移す。 */
function archive_(docId, pdfId) {
  var folderId = PropertiesService.getScriptProperties().getProperty('ARCHIVE_FOLDER_ID');
  if (!folderId) return false;
  var folder = DriveApp.getFolderById(folderId);
  var ids = [docId, pdfId];
  var moved = false;
  for (var i = 0; i < ids.length; i++) {
    if (!ids[i]) continue;
    try {
      DriveApp.getFileById(ids[i]).moveTo(folder);
      moved = true;
    } catch (e) {
      Logger.log('保管フォルダへ移せませんでした: ' + ids[i] + ' / ' + e);
    }
  }
  return moved;
}

function reportToPresident_(notice, to, message, errorReason) {
  var props = PropertiesService.getScriptProperties();
  var president = props.getProperty('PRESIDENT_EMAIL');
  if (!president) return;

  var subject = errorReason
    ? '【配信エラー】社内通達 ' + (notice.docNo || '') + ' ' + (notice.subject || '')
    : '【配信完了】社内通達 ' + (notice.docNo || '') + ' ' + (notice.subject || '');

  var lines = ['小林様', ''];
  if (errorReason) {
    lines.push('社内通達の自動配信で問題が起きたため、配信を止めました。');
    lines.push('');
    lines.push('■ 原因');
    lines.push(errorReason);
    lines.push('');
    lines.push('管理シートの該当行を直し、状態の欄を空にすると、次の確認（10分おき）で再度配信します。');
  } else {
    lines.push('社内通達の自動配信が完了しました。');
    lines.push('');
    lines.push('■ 配信内容');
    if (notice.docNo) lines.push('文書番号：' + notice.docNo);
    lines.push('件名：' + notice.subject);
    if (termText_(notice)) lines.push('実施期間：' + termText_(notice));
    lines.push('宛先：' + to.length + '名');
    lines.push('');
    lines.push('■ 実行した内容');
    lines.push(message);
    var channel = props.getProperty('SLACK_CHANNEL_URL');
    if (channel) lines.push('', 'Slack：' + channel);
  }
  lines.push('', '以上');

  GmailApp.sendEmail(president, subject, lines.join('\n'));
}

// ────────────────────────────────────────────────────────────
// 小道具
// ────────────────────────────────────────────────────────────

function openSpreadsheetNd_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('SPREADSHEET_ID が設定されていません。');
  return SpreadsheetApp.openById(id);
}

/** 通達一覧シートを返す。無ければ見出し付きで作る。 */
function noticeSheet_() {
  var ss = openSpreadsheetNd_();
  var sh = ss.getSheetByName(ND_SHEET);
  if (!sh) {
    sh = ss.insertSheet(ND_SHEET);
    sh.getRange(1, 1, 1, ND_HEAD.length).setValues([ND_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setColumnWidth(ND_COL.SUBJECT, 320);
    sh.setColumnWidth(ND_COL.RESULT, 320);
  }
  return sh;
}

/** 宛先を決める。行に指定があればそれを、無ければ全従業員を使う。 */
function resolveRecipients_(override) {
  var text = String(override || '').trim();
  if (!text) text = PropertiesService.getScriptProperties().getProperty('RECIPIENTS') || '';
  var list = text.split(/[,\s;、]+/);
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var a = list[i].trim();
    if (a && a.indexOf('@') > 0) out.push(a);
  }
  return out;
}

/** URL でも ID でも受け取れるようにする。 */
function extractId_(value) {
  var s = String(value || '').trim();
  if (!s) return '';
  var m = s.match(/[-\w]{25,}/);
  return m ? m[0] : '';
}

function asDate_(value) {
  if (value instanceof Date) return value;
  if (!value) return null;
  var d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function ui_() {
  return SpreadsheetApp.getUi();
}
