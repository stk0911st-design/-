/**
 * 他社からの物件情報メール → Backlog 課題 自動登録
 *
 * 受信メール（個別紹介＝仕入れ候補）を拾い、
 * ★（売却）不動産情報一覧★ プロジェクトの課題として登録する。
 *
 * 2つのモードを持つ。
 *   MODE = 'api' … Backlog API で課題を直接作成（完全自動）
 *   MODE = 'csv' … Backlog「一括登録」用のCSVを作ってメール添付で送る（担当者がアップロード）
 *
 * 想定トリガー: 時間主導型 / 日付ベース / 午前7時〜8時
 *
 * スクリプトプロパティ:
 *   MODE                  'api' または 'csv'（未設定なら 'api'）
 *   BACKLOG_SPACE         例: smarthouse.backlog.com
 *   BACKLOG_API_KEY       Backlog の個人設定 → API で発行したキー（MODE=api のとき必須）
 *   BACKLOG_PROJECT_KEY   例: FDA
 *   DEFAULT_ASSIGNEE      既定の担当者名（Backlog上の表示名）。空なら未設定
 *   DEFAULT_CATEGORY      既定のカテゴリー名。例: 査定
 *   DEFAULT_ISSUE_TYPE    既定の種別名（未設定なら タスク）
 *   DEFAULT_PRIORITY      既定の優先度名（未設定なら 中）
 *   CSV_RECIPIENT         CSVモードの送信先メールアドレス
 *   GMAIL_QUERY           対象メールの検索条件（未設定なら既定値）
 *   MASK_PRICE            'false' にすると金額をマスクしない（既定は マスクする）
 *   DRIVE_FOLDER_ID       CSVを保存するGoogleドライブのフォルダID（任意）
 */

var TZ_IMPORT = 'Asia/Tokyo';

/** 登録済みメールに付けるGmailラベル。二重登録の防止に使う。 */
var DONE_LABEL = 'Backlog登録済み';

/** 手動確認が必要なメールに付けるラベル。 */
var REVIEW_LABEL = 'Backlog要確認';

/** 既定のGmail検索条件。個別の物件紹介・買取相談を広めに拾う。 */
var DEFAULT_QUERY = [
  'newer_than:2d',
  '-in:draft',
  '-in:sent',
  '-label:' + DONE_LABEL,
  '(ご紹介 OR ご相談 OR ご依頼 OR 査定 OR 買取 OR 物件 OR 売却)'
].join(' ');

/**
 * 差出人ドメイン → 業者の呼び名。
 * 件名は社内の既存ルール ＜業者名 支店 担当者様＞MMDD_物件名 に合わせる。
 */
var VENDOR_MAP = {
  'mu-res.co.jp': '三菱',
  'mizuho-re.co.jp': 'みずほ',
  'livable.jp': '東急リバブル',
  'ma.livable.jp': '東急リバブル',
  'nomura-re.co.jp': '野村',
  'wills.co.jp': 'ウィル',
  'kinoshita-group.co.jp': '木下',
  'stepon.co.jp': '住友ステップ',
  'sumitomo-rd.co.jp': '住友不動産',
  'daiwahouse.co.jp': '大和ハウス',
  'tokyu-land.co.jp': '東急不動産',
  'starts.co.jp': 'スターツ',
  'century21.jp': 'センチュリー21',
  'ohmiyaeki.co.jp': '大宮駅前'
};

/**
 * 一斉配信・買取募集・広告メールの差出人。課題にはしない。
 * （社内の日報分類でいう「一斉配信の物件情報」「買取募集・情報依頼」に相当）
 */
var EXCLUDE_DOMAINS = [
  'suumo.jp', 'e.suumo.jp', 'rakumachi.jp', 'carsensor.net', 'athome.co.jp',
  'homes.co.jp', 'beyondborders.jp', 'globalink.co.jp', 'nomad-a.jp',
  'landnet.co.jp', 'sagafu.co.jp', 'stepon.co.jp', 'snowpeak.co.jp',
  'mail.jrkyushu.co.jp', 'backlog.com', 'google.com', 'smarthouse77.jp',
  'smarthouse77.xyz'
];

/** 件名に含まれていたら一斉配信と判断するキーワード。 */
var EXCLUDE_SUBJECT_WORDS = [
  '物件情報が公開されました', '新着', 'メルマガ', '号外', 'セミナー', 'キャンペーン',
  '買取案件募集', '案件募集', '募集！', 'お部屋をご提案', 'ニュースレター',
  '配信停止', 'アンケート', '【PR】', '広告'
];

/** 中継サービス等、差出人ドメインでは業者がわからない送信元。 */
var RELAY_DOMAINS = ['facilo.jp', 'awstrack.me', 'sendgrid.net', 'cloud.nomad-a.jp'];

/**
 * メールの中身からカテゴリーを決める。上から順に見て最初に当たったものを使う。
 * 当たらなければ DEFAULT_CATEGORY（未設定ならカテゴリーなし）。
 */
var CATEGORY_RULES = [
  { pattern: /査定|目線|買取価格|価格をお伺い|買取のご相談|買取のご依頼/, name: '査定' }
];

/* ============================ エントリポイント ============================ */

/** 定期トリガーから呼ぶ本番用。MODE に従って動く。 */
function importPropertyEmails() {
  var mode = prop_('MODE') || 'api';
  if (mode === 'api') {
    runApiMode_(false);
  } else {
    runCsvMode_(false);
  }
}

/** 何も登録・送信せず、抽出結果だけ実行ログに出す確認用。 */
function previewPropertyEmails() {
  var items = collectCandidates_();
  Logger.log('抽出 ' + items.length + '件');
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    Logger.log('---- ' + (i + 1) + ' ----');
    Logger.log('件名     : ' + it.summary);
    Logger.log('要確認   : ' + (it.needsReview ? it.reviewReason : 'なし'));
    Logger.log('詳細     :\n' + it.description);
  }
}

/**
 * 登録はせず、Backlogに何を作るつもりかを実行ログに出す（API設定の確認込み）。
 * 本番トリガーを付ける前に、これを1回実行して内容を確かめる。
 */
function dryRunApiImport() {
  runApiMode_(true);
}

/** CSVだけ作ってメールする（担当者が Backlog の「一括登録」でアップロード）。 */
function sendImportCsv() {
  runCsvMode_(false);
}

/**
 * Backlogにつながるか、設定値が正しいかだけを確かめる。
 * APIキーを入れた直後に実行し、実行ログに出る内容を確認する。
 */
function testBacklogConnection() {
  var space = prop_('BACKLOG_SPACE');
  var apiKey = prop_('BACKLOG_API_KEY');
  var projectKey = prop_('BACKLOG_PROJECT_KEY');
  var missing = [];
  if (!space) { missing.push('BACKLOG_SPACE'); }
  if (!apiKey) { missing.push('BACKLOG_API_KEY'); }
  if (!projectKey) { missing.push('BACKLOG_PROJECT_KEY'); }
  if (missing.length > 0) {
    Logger.log('NG: スクリプトプロパティが未設定です → ' + missing.join(' / '));
    return;
  }

  var ctx;
  try {
    ctx = buildApiContext_();
  } catch (e) {
    Logger.log('NG: ' + e);
    Logger.log('※ 401なら APIキー、404なら スペース名かプロジェクトキーを見直してください。');
    return;
  }

  Logger.log('OK: Backlogに接続できました。');
  Logger.log('  スペース     : ' + space);
  Logger.log('  プロジェクト : ' + projectKey + '（ID ' + ctx.projectId + '）');
  Logger.log('  種別         : ' + (prop_('DEFAULT_ISSUE_TYPE') || 'タスク') + '（ID ' + ctx.issueTypeId + '）');
  Logger.log('  優先度       : ' + (prop_('DEFAULT_PRIORITY') || '中') + '（ID ' + ctx.priorityId + '）');
  Logger.log('  担当者       : ' + (prop_('DEFAULT_ASSIGNEE') || '（未設定）') +
    (ctx.assigneeId ? '（ID ' + ctx.assigneeId + '）' : ''));

  var names = [];
  for (var i = 0; i < ctx.categories.length; i++) {
    names.push(ctx.categories[i].name);
  }
  Logger.log('  カテゴリー   : ' + names.join(' / '));
  for (var j = 0; j < CATEGORY_RULES.length; j++) {
    if (names.indexOf(CATEGORY_RULES[j].name) < 0) {
      Logger.log('  ※ 自動判定で使う「' + CATEGORY_RULES[j].name + '」がBacklogにありません。カテゴリーなしで登録されます。');
    }
  }
  Logger.log('次に dryRunApiImport を実行して、登録される中身を確認してください。');
}

/* ============================== 処理本体 ============================== */

function runApiMode_(isDryRun) {
  var items = collectCandidates_();
  if (items.length === 0) {
    Logger.log('対象メールはありませんでした。');
    return;
  }
  var ctx = buildApiContext_();
  var created = [];
  var failed = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (isDryRun) {
      created.push({ key: '(dry-run)', item: it });
      Logger.log('---- dry-run ' + (i + 1) + ' ----');
      Logger.log('件名      : ' + it.summary);
      Logger.log('カテゴリー: ' + (it.category || '（なし）'));
      Logger.log('要確認    : ' + (it.needsReview ? it.reviewReason : 'なし'));
      Logger.log('詳細      :\n' + it.description);
      continue;
    }
    try {
      var issue = createIssue_(ctx, it);
      created.push({ key: issue.issueKey, item: it });
      markDone_(it, issue.issueKey);
    } catch (e) {
      failed.push({ item: it, error: String(e) });
      markReview_(it, String(e));
    }
  }
  Logger.log('登録 ' + created.length + '件 / 失敗 ' + failed.length + '件');
  if (!isDryRun) {
    notifyResult_(created, failed);
  }
}

function runCsvMode_(isDryRun) {
  var items = collectCandidates_();
  var today = Utilities.formatDate(new Date(), TZ_IMPORT, 'yyyyMMdd');
  var csv = buildCsv_(items);
  var fileName = 'backlog_import_' + today + '.csv';
  var blob = Utilities.newBlob('', 'text/csv', fileName).setDataFromString('﻿' + csv, 'UTF-8');

  if (isDryRun) {
    Logger.log(csv);
    return;
  }

  var folderId = prop_('DRIVE_FOLDER_ID');
  var fileUrl = '';
  if (folderId) {
    try {
      fileUrl = DriveApp.getFolderById(folderId).createFile(blob).getUrl();
    } catch (e) {
      Logger.log('ドライブ保存に失敗: ' + e);
    }
  }

  var recipient = prop_('CSV_RECIPIENT');
  if (!recipient) {
    Logger.log('CSV_RECIPIENT が未設定のため送信しません。');
    return;
  }
  var subject = '【Backlog一括登録用】' +
    Utilities.formatDate(new Date(), TZ_IMPORT, 'M/d') + ' 物件情報 ' + items.length + '件';
  var body = buildCsvMailBody_(items, fileUrl);
  MailApp.sendEmail(recipient, subject, body, {
    name: '物件情報 Backlog登録',
    attachments: [blob]
  });
  for (var i = 0; i < items.length; i++) {
    markDone_(items[i], 'CSV出力');
  }
  Logger.log('CSVを送信しました: ' + items.length + '件 → ' + recipient);
}

/* ============================ メールの抽出 ============================ */

/** Gmailを検索し、課題の材料に整形して返す。 */
function collectCandidates_() {
  var query = prop_('GMAIL_QUERY') || DEFAULT_QUERY;
  var threads = GmailApp.search(query, 0, 100);
  var items = [];
  var seen = {};
  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      if (seen[msg.getId()]) {
        continue;
      }
      seen[msg.getId()] = true;
      if (!isTargetMessage_(msg)) {
        continue;
      }
      items.push(buildItem_(msg, threads[t]));
    }
  }
  return items;
}

/** 個別の物件紹介・買取相談かどうかを判定する。 */
function isTargetMessage_(msg) {
  var from = msg.getFrom();
  var domain = extractDomain_(from);
  var subject = msg.getSubject() || '';

  for (var i = 0; i < EXCLUDE_DOMAINS.length; i++) {
    if (endsWithDomain_(domain, EXCLUDE_DOMAINS[i])) {
      return false;
    }
  }
  for (var j = 0; j < EXCLUDE_SUBJECT_WORDS.length; j++) {
    if (subject.indexOf(EXCLUDE_SUBJECT_WORDS[j]) >= 0) {
      return false;
    }
  }
  // 宛先が個人名（担当者アドレス）か、本文に「様」で始まる呼びかけがあるものを個別扱いにする。
  var body = plainBody_(msg);
  var isIndividual = /^\s*\S{1,12}様/.test(body) || /(ご相談|ご依頼|ご紹介|お伺い|査定)/.test(subject + body);
  return isIndividual;
}

/** メール1通から課題1件分の材料を作る。 */
function buildItem_(msg, thread) {
  var body = plainBody_(msg);
  var subject = msg.getSubject() || '';
  var vendor = detectVendor_(msg, body);
  var person = detectPerson_(msg, body);
  var branch = detectBranch_(body, vendor);
  var property = detectProperty_(subject, body);
  var needsReview = false;
  var reasons = [];

  if (!vendor) {
    vendor = '要確認';
    needsReview = true;
    reasons.push('業者名');
  }
  if (!person) {
    person = '';
    needsReview = true;
    reasons.push('担当者名');
  }
  if (!property) {
    property = '要確認（資料参照）';
    needsReview = true;
    reasons.push('物件名');
  }

  var mmdd = Utilities.formatDate(msg.getDate(), TZ_IMPORT, 'MMdd');
  var head = vendor + (branch ? ' ' + branch : '') + (person ? ' ' + person + '様' : '');
  var summary = '＜' + head + '＞' + mmdd + '_' + property;

  return {
    messageId: msg.getId(),
    thread: thread,
    date: msg.getDate(),
    category: detectCategory_(subject, body),
    summary: mask_(summary),
    description: buildDescription_(msg, vendor, branch, person, property, body),
    needsReview: needsReview,
    reviewReason: reasons.join('・') + ' が取れませんでした',
    sourceSubject: subject,
    sourceFrom: msg.getFrom(),
    hasAttachment: msg.getAttachments().length > 0
  };
}

/**
 * 課題の詳細。社内の既存フォーマットに合わせる。
 * 物件名 → ●Gドライブ / ●Gマップ / ●レインズ / ●AI査定 / ●お礼メール送信 → 差出人情報
 */
function buildDescription_(msg, vendor, branch, person, property, body) {
  var lines = [];
  lines.push(property);
  lines.push('');
  lines.push('●Gドライブ');
  lines.push('');
  lines.push('●Gマップ');
  lines.push('');
  lines.push('●レインズ');
  lines.push('');
  lines.push('●AI査定');
  lines.push('');
  lines.push('●お礼メール送信');
  lines.push('');
  lines.push('■ 情報元');
  lines.push(vendor + (branch ? ' ' + branch : ''));
  if (person) {
    lines.push(person + '様');
  }
  lines.push(extractAddress_(msg.getFrom()));
  lines.push('受信日: ' + Utilities.formatDate(msg.getDate(), TZ_IMPORT, 'yyyy/MM/dd HH:mm'));
  lines.push('元メール: https://mail.google.com/mail/u/0/#all/' + msg.getId());
  if (msg.getAttachments().length > 0) {
    lines.push('添付: ' + msg.getAttachments().length + '件（元メールから保存してください）');
  }
  lines.push('');
  lines.push('■ メール本文（抜粋）');
  lines.push(mask_(trim_(body, 1200)));
  return lines.join('\n');
}

function detectVendor_(msg, body) {
  var domain = extractDomain_(msg.getFrom());
  for (var key in VENDOR_MAP) {
    if (endsWithDomain_(domain, key)) {
      return VENDOR_MAP[key];
    }
  }
  // 中継サービス経由のときは CC のドメインと本文の社名から拾う。
  var cc = msg.getCc() || '';
  var ccDomain = extractDomain_(cc);
  for (var key2 in VENDOR_MAP) {
    if (ccDomain && endsWithDomain_(ccDomain, key2)) {
      return VENDOR_MAP[key2];
    }
  }
  var m = body.match(/((?:株式会社|有限会社)?[^\n\r　 ]{2,20}(?:不動産販売|不動産|リバブル|ハウス|ホーム|住宅|開発|建設|コンサルティング)(?:株式会社)?)/);
  return m ? m[1] : '';
}

function detectPerson_(msg, body) {
  // 本文の自己紹介「〜の○○と申します／でございます／です」
  var m = body.match(/の([^\n\r、。　 ]{1,8}?)(?:と申します|でございます|と申し上げます)/);
  if (m) {
    return cleanPerson_(m[1]);
  }
  // 件名の『会社名＋担当者名』『／会社名 担当者名』形式。会社名を落として姓だけ残す。
  var subject = msg.getSubject() || '';
  var b = subject.match(/[『「\[]([^』」\]]{2,30})[』」\]]/);
  if (b) {
    var tail = stripCompany_(b[1]);
    if (tail) {
      return cleanPerson_(tail);
    }
  }
  var slash = subject.match(/[／\/]\s*([^／\/]{2,20})\s*$/);
  if (slash) {
    var tail2 = stripCompany_(slash[1]);
    if (tail2) {
      return cleanPerson_(tail2);
    }
  }
  // 差出人の表示名（姓だけを使う）
  var name = msg.getFrom().replace(/<[^>]*>/, '').replace(/["']/g, '').trim();
  if (name && !/@/.test(name) && name.length <= 12) {
    return cleanPerson_(name.split(/[\s　]+/)[0]);
  }
  return '';
}

/** 社名・法人格・部署を落として、末尾に残る人名らしい部分を返す。 */
function stripCompany_(text) {
  var t = String(text).replace(/[\s　]/g, '');
  t = t.replace(/(?:株式会社|有限会社|合同会社|\(株\)|（株）)/g, '');
  var cut = t.replace(/^.*?(?:不動産販売|不動産|ソリューションズ|リバブル|ハウジング|ハウス|ホーム|住宅|建設|開発|コンサルティング|グループ|センター|支店|営業部|営業所|店)/, '');
  if (cut && cut.length <= 6) {
    return cut;
  }
  // 手掛かりが無ければ末尾2文字を姓とみなす（日本人の姓は2文字が最多）
  return t.length >= 2 ? t.slice(-2) : '';
}

/** 読み仮名・敬称・肩書きを落とす。 */
function cleanPerson_(text) {
  return String(text)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/(?:様|さん|氏|課長|部長|次長|係長|主任|店長|支店長)$/, '')
    .replace(/[\s　]+$/, '')
    .trim();
}

function detectCategory_(subject, body) {
  var text = String(subject) + '\n' + String(body);
  for (var i = 0; i < CATEGORY_RULES.length; i++) {
    if (CATEGORY_RULES[i].pattern.test(text)) {
      return CATEGORY_RULES[i].name;
    }
  }
  return prop_('DEFAULT_CATEGORY') || '';
}

function detectBranch_(body, vendor) {
  var m = body.match(/([^\n\r　 ]{2,16}(?:センター|支店|営業部|営業所|開発部))/);
  if (!m) {
    return '';
  }
  var branch = m[1];
  // 「東急リバブル勝どきセンター」のように社名を含むことがあるので落とす。
  branch = branch.replace(/(?:株式会社|有限会社|\(株\)|（株）)/g, '');
  if (vendor && branch.indexOf(vendor) === 0) {
    branch = branch.substring(vendor.length);
  }
  branch = branch.replace(/^.*?(?:不動産販売|不動産|ソリューションズ|リバブル|ハウス|ホーム|住宅)/, '');
  return branch.length >= 2 ? branch : '';
}

function detectProperty_(subject, body) {
  // 本文の「■物件名」
  var m = body.match(/^[■●]\s*([^\n\r]{3,40})$/m);
  if (m && !/情報元|メール本文|おすすめ|ポイント/.test(m[1])) {
    return trimName_(m[1]);
  }
  // 「物件名：○○」
  var n = body.match(/物件名[：:]\s*([^\n\r]{2,40})/);
  if (n) {
    return trimName_(n[1]);
  }
  // 件名の【】内
  var s = subject.match(/[【\[]([^】\]]{3,30})[】\]]/);
  if (s && !/未公開|新着|PR|重要/.test(s[1])) {
    return trimName_(s[1]);
  }
  // 所在地でも手掛かりになる
  var a = body.match(/所在[地]?[：:]\s*([^\n\r]{4,40})/);
  if (a) {
    return trimName_(a[1]);
  }
  return '';
}

/* ============================== Backlog API ============================== */

function buildApiContext_() {
  var space = prop_('BACKLOG_SPACE');
  var apiKey = prop_('BACKLOG_API_KEY');
  var projectKey = prop_('BACKLOG_PROJECT_KEY');
  if (!space || !apiKey || !projectKey) {
    throw new Error('BACKLOG_SPACE / BACKLOG_API_KEY / BACKLOG_PROJECT_KEY を設定してください。');
  }
  var base = 'https://' + space + '/api/v2';
  var ctx = { base: base, apiKey: apiKey, projectKey: projectKey };

  var project = apiGet_(ctx, '/projects/' + projectKey);
  ctx.projectId = project.id;

  var issueTypes = apiGet_(ctx, '/projects/' + projectKey + '/issueTypes');
  ctx.issueTypeId = findIdByName_(issueTypes, prop_('DEFAULT_ISSUE_TYPE') || 'タスク');

  var priorities = apiGet_(ctx, '/priorities');
  ctx.priorityId = findIdByName_(priorities, prop_('DEFAULT_PRIORITY') || '中');

  ctx.categories = apiGet_(ctx, '/projects/' + projectKey + '/categories');

  var assigneeName = prop_('DEFAULT_ASSIGNEE');
  if (assigneeName) {
    var users = apiGet_(ctx, '/projects/' + projectKey + '/users');
    ctx.assigneeId = findIdByName_(users, assigneeName);
  }
  return ctx;
}

function createIssue_(ctx, item) {
  var payload = {
    projectId: ctx.projectId,
    summary: item.summary,
    issueTypeId: ctx.issueTypeId,
    priorityId: ctx.priorityId,
    description: item.description,
    startDate: Utilities.formatDate(item.date, TZ_IMPORT, 'yyyy-MM-dd')
  };
  var categoryId = lookupCategoryId_(ctx, item.category);
  if (categoryId) {
    payload['categoryId[]'] = categoryId;
  }
  if (ctx.assigneeId) {
    payload.assigneeId = ctx.assigneeId;
  }
  var res = UrlFetchApp.fetch(ctx.base + '/issues?apiKey=' + encodeURIComponent(ctx.apiKey), {
    method: 'post',
    payload: payload,
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('課題作成に失敗 (' + res.getResponseCode() + '): ' + res.getContentText());
  }
  return JSON.parse(res.getContentText());
}

/** カテゴリー名からIDを引く。名前が無ければカテゴリーなしで登録する。 */
function lookupCategoryId_(ctx, name) {
  if (!name || !ctx.categories) {
    return null;
  }
  for (var i = 0; i < ctx.categories.length; i++) {
    if (ctx.categories[i].name === name) {
      return ctx.categories[i].id;
    }
  }
  Logger.log('カテゴリー「' + name + '」がBacklogに無いため、カテゴリーなしで登録します。');
  return null;
}

function apiGet_(ctx, path) {
  var res = UrlFetchApp.fetch(ctx.base + path + '?apiKey=' + encodeURIComponent(ctx.apiKey), {
    method: 'get',
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('API取得に失敗 ' + path + ' (' + res.getResponseCode() + '): ' + res.getContentText());
  }
  return JSON.parse(res.getContentText());
}

function findIdByName_(list, name) {
  for (var i = 0; i < list.length; i++) {
    if (list[i].name === name) {
      return list[i].id;
    }
  }
  throw new Error('Backlogに「' + name + '」が見つかりません。設定値を確認してください。');
}

/* ================================ CSV ================================ */

/**
 * 一括登録用CSVの列。
 * Backlog の「課題」画面 →「一括登録」→「サンプルをダウンロード」で取得できる
 * 公式テンプレートの列名・列順に必ず合わせること（違うとアップロード時にエラーになる）。
 */
var CSV_HEADERS = [
  '件名', '詳細', '種別', 'カテゴリー', '優先度', '担当者',
  '開始日', '期限日', 'マイルストーン', '発生バージョン', '予定時間', '親課題'
];

function buildCsv_(items) {
  var rows = [CSV_HEADERS];
  var issueType = prop_('DEFAULT_ISSUE_TYPE') || 'タスク';
  var priority = prop_('DEFAULT_PRIORITY') || '中';
  var assignee = prop_('DEFAULT_ASSIGNEE') || '';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    rows.push([
      it.summary,
      it.description,
      issueType,
      it.category || '',
      priority,
      assignee,
      Utilities.formatDate(it.date, TZ_IMPORT, 'yyyy/MM/dd'),
      '', '', '', '', ''
    ]);
  }
  var lines = [];
  for (var r = 0; r < rows.length; r++) {
    var cells = [];
    for (var c = 0; c < rows[r].length; c++) {
      cells.push('"' + String(rows[r][c]).replace(/"/g, '""') + '"');
    }
    lines.push(cells.join(','));
  }
  return lines.join('\r\n');
}

function buildCsvMailBody_(items, fileUrl) {
  var lines = [];
  lines.push('おはようございます。');
  lines.push('本日ぶんの物件情報メールから、Backlog「一括登録」用のCSVを作成しました。');
  lines.push('');
  lines.push('■ 件数: ' + items.length + '件');
  var review = 0;
  for (var i = 0; i < items.length; i++) {
    if (items[i].needsReview) {
      review++;
    }
  }
  lines.push('■ うち要確認: ' + review + '件（件名に「要確認」が入っています）');
  lines.push('');
  lines.push('■ 登録のしかた');
  lines.push('1. Backlog → ★（売却）不動産情報一覧★ → 「課題」 →「一括登録」');
  lines.push('2. 添付のCSVをアップロード → 内容を確認して登録');
  lines.push('   ※「状態」はBacklogの仕様で全件「未対応」になります。');
  lines.push('3. 登録後、添付資料は元メールから各課題に添付してください。');
  if (fileUrl) {
    lines.push('');
    lines.push('■ ドライブ: ' + fileUrl);
  }
  lines.push('');
  lines.push('■ 一覧');
  for (var j = 0; j < items.length; j++) {
    lines.push((j + 1) + '. ' + items[j].summary + (items[j].needsReview ? '  ← ' + items[j].reviewReason : ''));
  }
  return lines.join('\n');
}

/* =============================== 後処理 =============================== */

function markDone_(item, note) {
  try {
    getLabel_(DONE_LABEL).addToThread(item.thread);
    Logger.log('登録済み: ' + note + ' / ' + item.summary);
  } catch (e) {
    Logger.log('ラベル付与に失敗: ' + e);
  }
}

function markReview_(item, reason) {
  try {
    getLabel_(REVIEW_LABEL).addToThread(item.thread);
    Logger.log('要確認: ' + reason + ' / ' + item.summary);
  } catch (e) {
    Logger.log('ラベル付与に失敗: ' + e);
  }
}

function getLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function notifyResult_(created, failed) {
  var recipient = prop_('CSV_RECIPIENT');
  if (!recipient) {
    return;
  }
  var lines = [];
  lines.push('物件情報メールの Backlog 登録結果です。');
  lines.push('');
  lines.push('■ 登録 ' + created.length + '件');
  for (var i = 0; i < created.length; i++) {
    lines.push('・' + created[i].key + ' ' + created[i].item.summary +
      (created[i].item.needsReview ? '  ← ' + created[i].item.reviewReason : ''));
  }
  if (failed.length > 0) {
    lines.push('');
    lines.push('■ 失敗 ' + failed.length + '件（手動で登録してください）');
    for (var j = 0; j < failed.length; j++) {
      lines.push('・' + failed[j].item.summary + ' / ' + failed[j].error);
    }
  }
  lines.push('');
  lines.push('※ 添付資料は元メールから各課題に付け直してください。');
  MailApp.sendEmail(recipient,
    '【Backlog登録】' + Utilities.formatDate(new Date(), TZ_IMPORT, 'M/d') +
    ' 物件情報 ' + created.length + '件',
    lines.join('\n'),
    { name: '物件情報 Backlog登録' });
}

/* =============================== 小道具 =============================== */

function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function plainBody_(msg) {
  var body = msg.getPlainBody() || '';
  return body.replace(/\r\n/g, '\n');
}

function extractAddress_(from) {
  var m = String(from).match(/<([^>]+)>/);
  return m ? m[1] : String(from).trim();
}

function extractDomain_(from) {
  var addr = extractAddress_(from);
  var i = addr.indexOf('@');
  return i < 0 ? '' : addr.substring(i + 1).toLowerCase();
}

function endsWithDomain_(domain, candidate) {
  if (!domain || !candidate) {
    return false;
  }
  if (domain === candidate) {
    return true;
  }
  var suffix = '.' + candidate;
  var at = domain.length - suffix.length;
  return at > 0 && domain.lastIndexOf(suffix) === at;
}

/** 金額は社内ルールで課題にも残さない。MASK_PRICE=false で無効化できる。 */
function mask_(text) {
  if (prop_('MASK_PRICE') === 'false') {
    return text;
  }
  return String(text)
    .replace(/[0-9０-９,，\.]+\s*億\s*[0-9０-９,，]*\s*万?円/g, '（金額省略）')
    .replace(/[0-9０-９,，\.]+\s*万\s*円/g, '（金額省略）')
    .replace(/[0-9０-９,，]{4,}\s*円/g, '（金額省略）');
}

function trim_(text, max) {
  var t = String(text).replace(/\n{3,}/g, '\n\n').trim();
  return t.length <= max ? t : t.substring(0, max) + '\n…（以下省略／元メール参照）';
}

function trimName_(text) {
  return String(text).replace(/[\s　]+$/, '').replace(/^[\s　]+/, '').substring(0, 40);
}
