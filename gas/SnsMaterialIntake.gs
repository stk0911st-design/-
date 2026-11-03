/**
 * SNS素材の受付（メール → Google ドライブ）
 *
 * 社員が件名に目印（既定は「【SNS素材】」）を付けて送ったメールの添付ファイル
 * （写真・動画）と本文メモを、ドライブの「受付」フォルダへ自動保存する。
 * 保存済みのスレッドには Gmail ラベルを付け、二重保存を防ぐ。
 * 投稿に使った素材は markAsUsed で「使用済み」フォルダへ移す。
 *
 * 想定トリガー: 時間主導型 / 分ベース / 15分おき（saveMailMaterials）
 *
 * スクリプトプロパティ:
 *   INTAKE_FOLDER_ID  「受付（未使用）」フォルダのID（必須）
 *   USED_FOLDER_ID    「使用済み」フォルダのID（必須）
 *   SUBJECT_KEY       件名の目印（任意。既定「【SNS素材】」）
 *   SAVED_LABEL       保存済みスレッドに付けるラベル名（任意。既定「SNS素材-保存済み」）
 *
 * 注意: このスクリプトを動かす Google アカウントが受信するメールだけが対象。
 *       全社員から届くようにするには、そのアカウント宛て（共有アドレス・グループ等）に送ってもらう。
 */

var SNS_TZ = 'Asia/Tokyo';
var DEFAULT_SUBJECT_KEY = '【SNS素材】';
var DEFAULT_SAVED_LABEL = 'SNS素材-保存済み';
var MATERIAL_MIME_PREFIXES = ['image/', 'video/'];

/** 定期トリガーから呼ぶ本番用エントリポイント。 */
function saveMailMaterials() {
  runIntake_(false);
}

/** 保存せずに、対象メールと保存予定ファイルを実行ログへ出す。まずこれで確認する。 */
function previewSaveMailMaterials() {
  runIntake_(true);
}

/**
 * 指定したファイルIDを「受付」から「使用済み」へ移す。
 * 例: markAsUsed(['<FILE_ID_1>', '<FILE_ID_2>'])
 */
function markAsUsed(fileIds) {
  var used = DriveApp.getFolderById(requireProp_('USED_FOLDER_ID'));
  var moved = [];
  (fileIds || []).forEach(function (id) {
    var file = DriveApp.getFileById(id);
    file.moveTo(used);
    moved.push(file.getName());
  });
  Logger.log('使用済みへ移動: ' + moved.length + '件\n' + moved.join('\n'));
  return moved;
}

/** 「受付」フォルダの未使用素材を一覧にして実行ログへ出す。 */
function listIntake() {
  var folder = DriveApp.getFolderById(requireProp_('INTAKE_FOLDER_ID'));
  var files = folder.getFiles();
  var rows = [];
  while (files.hasNext()) {
    var f = files.next();
    rows.push(f.getId() + '\t' + f.getName() + '\t' + f.getMimeType());
  }
  Logger.log('未使用: ' + rows.length + '件\n' + rows.join('\n'));
  return rows;
}

function runIntake_(dryRun) {
  var props = PropertiesService.getScriptProperties();
  var subjectKey = props.getProperty('SUBJECT_KEY') || DEFAULT_SUBJECT_KEY;
  var labelName = props.getProperty('SAVED_LABEL') || DEFAULT_SAVED_LABEL;
  var intake = DriveApp.getFolderById(requireProp_('INTAKE_FOLDER_ID'));
  var label = GmailApp.getUserLabelByName(labelName) || GmailApp.createLabel(labelName);

  var query = 'subject:"' + subjectKey + '" -label:"' + labelName + '" newer_than:14d';
  var threads = GmailApp.search(query, 0, 50);
  var savedFiles = 0;

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      var stamp = Utilities.formatDate(msg.getDate(), SNS_TZ, 'yyyyMMdd-HHmmss');
      var index = 0;

      msg.getAttachments({ includeInlineImages: false }).forEach(function (att) {
        if (!isMaterial_(att.getContentType())) return;
        index++;
        var name = stamp + '_' + index + '_' + att.getName();
        Logger.log((dryRun ? '[保存予定] ' : '[保存] ') + name);
        if (!dryRun) {
          intake.createFile(att.copyBlob()).setName(name)
            .setDescription('送信日時: ' + stamp + ' / 件名: ' + msg.getSubject());
        }
        savedFiles++;
      });

      var memo = msg.getPlainBody().trim();
      if (index > 0 && memo) {
        var memoName = stamp + '_メモ.txt';
        Logger.log((dryRun ? '[保存予定] ' : '[保存] ') + memoName);
        if (!dryRun) {
          intake.createFile(memoName, memo, MimeType.PLAIN_TEXT);
        }
      }
    });
    if (!dryRun) thread.addLabel(label);
  });

  Logger.log((dryRun ? '（プレビュー）' : '') + '対象スレッド: ' + threads.length +
    '件 / 素材ファイル: ' + savedFiles + '件');
}

function isMaterial_(contentType) {
  return MATERIAL_MIME_PREFIXES.some(function (p) { return contentType.indexOf(p) === 0; });
}

function requireProp_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('スクリプトプロパティ ' + key + ' が未設定です');
  return v;
}
