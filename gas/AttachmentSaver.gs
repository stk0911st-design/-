/**
 * メール添付ファイル 自動保存（Apps Script）
 *
 * 毎晩19:30の自動保存（Claude のルーティン）は、物件メールの本文を
 * Googleドキュメントにしてドライブのフォルダへ保存し、メールに
 * 「ドライブ保存済」ラベルを付ける。ただし Claude からは添付ファイルを
 * 取り出せないため、添付は手作業で入れる運用になっていた。
 *
 * このスクリプトはその添付を自動で入れる。
 *   1. 「ドライブ保存済」ラベルが付いていて添付のあるメールを探す
 *   2. 保存済みドキュメントに書かれた「元メール」のリンク（メールID）を手がかりに、
 *      そのドキュメントが入っているフォルダを見つける
 *   3. 添付ファイルをそのフォルダへ保存し、「添付保存済」ラベルを付ける
 *   4. フォルダが見つからないメールは保存せず「添付保存_要確認」ラベルを付けて知らせる
 *
 * 関数:
 *   previewAttachmentSave … 確認用。何も保存せず、ラベルも付けず、予定だけをログに出す
 *   saveAttachments       … 本番。1時間ごとのトリガーで動かす
 *   setupHourlyTrigger    … 1時間ごとのトリガーを作る（手で作る場合は不要）
 *
 * スクリプトプロパティ（すべて任意）:
 *   NOTIFY_TO     … 要確認が出たときのお知らせ先メールアドレス。未設定ならメールは送らない
 *   START_DATE    … この日以降のメールだけを対象にする（例：2026/10/01）。未設定なら全期間
 *   EXCLUDE_FROM  … 添付を保存しない差出人（自社の送信分など）。カンマ区切りで、
 *                   アドレスかドメインの一部を書く（例：@example.co.jp,@example.jp）
 *   MIN_IMAGE_KB  … これより小さい画像は署名のロゴとみなして保存しない。既定 30
 */

var LABEL_SOURCE = 'ドライブ保存済';
var LABEL_DONE = '添付保存済';
var LABEL_CHECK = '添付保存_要確認';

var MAX_THREADS_PER_RUN = 15;      // 1回に処理するメール（スレッド）の上限
var TIME_BUDGET_MS = 4.5 * 60 * 1000; // Apps Script の実行上限（6分）より手前で止める
var WAIT_HOURS_BEFORE_CHECK = 48;  // ドキュメントの検索反映を待つ時間。これを過ぎても見つからなければ要確認

/** 確認用。保存もラベル付けもメール送信もしない。 */
function previewAttachmentSave() {
  run_(true);
}

/** 本番。トリガーから1時間ごとに呼ばれる。 */
function saveAttachments() {
  run_(false);
}

/** 1時間ごとのトリガーを作る。すでにあれば作らない。 */
function setupHourlyTrigger() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'saveAttachments';
  });
  if (exists) {
    Logger.log('saveAttachments のトリガーはすでにあります。');
    return;
  }
  ScriptApp.newTrigger('saveAttachments').timeBased().everyHours(1).create();
  Logger.log('saveAttachments を1時間ごとに動かすトリガーを作りました。');
}

function run_(dryRun) {
  var started = Date.now();
  var conf = config_();
  var lock = LockService.getScriptLock();
  if (!dryRun && !lock.tryLock(1000)) {
    Logger.log('前回の処理がまだ動いているため、今回はスキップします。');
    return;
  }
  try {
    var threads = GmailApp.search(query_(conf), 0, MAX_THREADS_PER_RUN);
    Logger.log((dryRun ? '【確認モード】' : '') + '対象のメール：' + threads.length + '件（1回の上限 ' + MAX_THREADS_PER_RUN + '件）');

    var labelDone = dryRun ? null : label_(LABEL_DONE);
    var labelCheck = dryRun ? null : label_(LABEL_CHECK);
    var result = { saved: 0, skipped: 0, waiting: 0, check: [], errors: [] };

    for (var i = 0; i < threads.length; i++) {
      if (Date.now() - started > TIME_BUDGET_MS) {
        Logger.log('時間の上限に近づいたため、残りは次回に回します。');
        break;
      }
      try {
        handleThread_(threads[i], conf, dryRun, labelDone, labelCheck, result);
      } catch (err) {
        result.errors.push(subject_(threads[i]) + '：' + err);
        Logger.log('エラー：' + subject_(threads[i]) + '：' + err);
      }
    }

    Logger.log('保存 ' + result.saved + '件／同名で保存済みのためスキップ ' + result.skipped + '件／' +
      'ドキュメント待ち ' + result.waiting + '件／要確認 ' + result.check.length + '件／エラー ' + result.errors.length + '件');
    if (!dryRun) notify_(conf, result);
  } finally {
    if (!dryRun) lock.releaseLock();
  }
}

function handleThread_(thread, conf, dryRun, labelDone, labelCheck, result) {
  var messages = thread.getMessages();
  var title = subject_(thread);

  // 保存先フォルダを、保存済みドキュメントの「元メール」リンクから探す
  var ids = [thread.getId()].concat(messages.map(function (m) { return m.getId(); }));
  var folders = findFolders_(ids);

  if (folders.length === 0) {
    var last = thread.getLastMessageDate();
    var hours = (Date.now() - last.getTime()) / 3600000;
    if (hours < WAIT_HOURS_BEFORE_CHECK) {
      // ドキュメントを作った直後は検索に出てこないことがあるので、次回にもう一度探す
      result.waiting++;
      Logger.log('  待ち：' + title + '（保存先ドキュメントがまだ見つかりません。次回もう一度探します）');
      return;
    }
    result.check.push(title + '（' + fmt_(last) + '）');
    Logger.log('  要確認：' + title + '（保存先ドキュメントが見つかりません）');
    if (!dryRun) thread.addLabel(labelCheck);
    return;
  }

  var folderNames = folders.map(function (f) { return f.getName(); }).join('／');
  Logger.log('■ ' + title + ' → ' + folderNames);

  messages.forEach(function (msg) {
    if (excluded_(msg.getFrom(), conf.excludeFrom)) return;
    var atts = msg.getAttachments({ includeInlineImages: false, includeAttachments: true });
    atts.forEach(function (att) {
      if (isSmallImage_(att, conf.minImageBytes)) return;
      folders.forEach(function (folder) {
        if (alreadyInFolder_(folder, att)) {
          result.skipped++;
          Logger.log('  スキップ（同じ名前・同じ大きさのファイルあり）：' + att.getName());
          return;
        }
        Logger.log('  ' + (dryRun ? '保存予定' : '保存') + '：' + att.getName() + '（' + kb_(att.getSize()) + '）');
        if (!dryRun) folder.createFile(att.copyBlob()).setName(att.getName());
        result.saved++;
      });
    });
  });

  if (!dryRun) thread.addLabel(labelDone);
}

/** 保存済みドキュメントのうち、いずれかのメールIDを含むものを探し、その親フォルダを返す。 */
function findFolders_(ids) {
  var seen = {};
  var folders = [];
  ids.forEach(function (id) {
    if (folders.length > 0) return;
    var q = "fullText contains '" + id + "' and mimeType = 'application/vnd.google-apps.document' and trashed = false";
    var files = DriveApp.searchFiles(q);
    while (files.hasNext()) {
      var parents = files.next().getParents();
      while (parents.hasNext()) {
        var f = parents.next();
        if (!seen[f.getId()]) {
          seen[f.getId()] = true;
          folders.push(f);
        }
      }
    }
  });
  return folders;
}

function alreadyInFolder_(folder, att) {
  var files = folder.getFilesByName(att.getName());
  while (files.hasNext()) {
    if (files.next().getSize() === att.getSize()) return true;
  }
  return false;
}

function isSmallImage_(att, minBytes) {
  return /^image\//.test(att.getContentType()) && att.getSize() < minBytes;
}

function excluded_(from, list) {
  var f = String(from).toLowerCase();
  return list.some(function (x) { return f.indexOf(x) !== -1; });
}

function query_(conf) {
  var q = 'label:' + LABEL_SOURCE + ' -label:' + LABEL_DONE + ' -label:' + LABEL_CHECK + ' has:attachment';
  if (conf.startDate) q += ' after:' + conf.startDate;
  return q;
}

function config_() {
  var p = PropertiesService.getScriptProperties();
  var minKb = Number(p.getProperty('MIN_IMAGE_KB'));
  return {
    notifyTo: (p.getProperty('NOTIFY_TO') || '').trim(),
    startDate: (p.getProperty('START_DATE') || '').trim(),
    excludeFrom: (p.getProperty('EXCLUDE_FROM') || '')
      .split(',')
      .map(function (s) { return s.trim().toLowerCase(); })
      .filter(function (s) { return s; }),
    minImageBytes: (isNaN(minKb) || !p.getProperty('MIN_IMAGE_KB') ? 30 : minKb) * 1024
  };
}

function label_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

/** 要確認・エラーがあったときだけ、お知らせ先にメールを送る。 */
function notify_(conf, result) {
  if (!conf.notifyTo) return;
  if (result.check.length === 0 && result.errors.length === 0) return;
  var lines = ['添付ファイルの自動保存で、確認が必要なものがあります。', ''];
  if (result.check.length) {
    lines.push('■ 保存先フォルダが見つからなかったメール（' + result.check.length + '件）');
    lines.push('Gmail の「' + LABEL_CHECK + '」ラベルに入っています。添付は手で保存してください。');
    lines.push('フォルダを用意したあとでラベルを外すと、次の回にもう一度自動で保存を試みます。');
    result.check.forEach(function (s) { lines.push('・' + s); });
    lines.push('');
  }
  if (result.errors.length) {
    lines.push('■ エラー（' + result.errors.length + '件）※次の回にもう一度試みます');
    result.errors.forEach(function (s) { lines.push('・' + s); });
    lines.push('');
  }
  lines.push('※このメールは Apps Script「メール添付ファイル 自動保存」から自動送信しています。');
  MailApp.sendEmail(conf.notifyTo, '【添付保存】確認が必要なメール ' + (result.check.length + result.errors.length) + '件', lines.join('\n'));
}

function subject_(thread) {
  return thread.getFirstMessageSubject() || '（件名なし）';
}

function fmt_(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'M/d HH:mm');
}

function kb_(bytes) {
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + 'MB' : Math.ceil(bytes / 1024) + 'KB';
}
