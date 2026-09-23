/**
 * LINE・Instagram 自動投稿（週1不動産トピック）
 *
 * Claude のルーティンが毎週送る「【LINE原稿】」メールを読み、
 * 配信予定日の 20 時台に LINE 公式アカウント（一斉配信）と Instagram へ投稿する。
 *
 * 承認の方式（スクリプトプロパティ APPROVAL_MODE）:
 *   optin  （既定）代表が「OK」と返信したものだけ投稿する。返信がなければ投稿しない。
 *   optout 代表から「NG」「中止」の返信がない限り投稿する。
 * どちらの方式でも「NG」「中止」の返信があれば取りやめる。
 *
 * 想定トリガー: 時間主導型 / 時間ベース / 1時間おき（関数 snsHourlyJob）
 *
 * スクリプトプロパティ:
 *   LINE_CHANNEL_ACCESS_TOKEN  LINE Messaging API のチャネルアクセストークン（長期）
 *   IG_USER_ID                 Instagram のユーザーID（数字）
 *   IG_ACCESS_TOKEN            Instagram のアクセストークン（長期。週1回自動で更新）
 *   APPROVER_EMAILS            原稿の送信元・承認者として認めるアドレス（カンマ区切り）
 *   NOTIFY_TO                  結果の通知先（カンマ区切り）
 *   IMAGE_FOLDER_ID            （任意）投稿画像を保存する Drive フォルダのID。未設定ならマイドライブ直下
 *   LINE_WITH_IMAGE            （任意）true で LINE にも画像を付ける。既定は文章のみ
 *   APPROVAL_MODE              （任意）optin（既定）または optout。上記参照
 *   DRY_RUN                    （任意）true の間は投稿せず、投稿予定の内容を通知メールで送る
 *
 * 原稿メールの書式（Claude のルーティンが出力する）:
 *   POST_DATE: 2026-10-01
 *   IMAGE_URL: https://...（Canva の書き出しURL）
 *   ===LINE_START=== 〜 ===LINE_END===   LINE に送る本文
 *   ===IG_START===   〜 ===IG_END===     Instagram のキャプション
 *   目印の行には「（ここから下をLINEに貼り付け）」のような説明を続けて書いてよい。
 *   手で貼り付けて投稿する担当者向けのメールと、自動投稿で同じ書式を使うため。
 */

var SNS = {
  TZ: 'Asia/Tokyo',
  QUERY: 'subject:"【LINE原稿】" newer_than:14d',
  POST_HOUR: 20,           // 配信予定日の何時から投稿するか（JST）
  WINDOW_HOURS: 4,         // この時間を過ぎても承認がなければ見送る
  LINE_BROADCAST_URL: 'https://api.line.me/v2/bot/message/broadcast',
  LINE_INFO_URL: 'https://api.line.me/v2/bot/info',
  IG_API: 'https://graph.instagram.com/v21.0',
  IG_REFRESH_URL: 'https://graph.instagram.com/refresh_access_token',
  LINE_TEXT_MAX: 5000,
  IG_CAPTION_MAX: 2200,
  IG_HASHTAG_MAX: 30
};

/** トリガーから1時間おきに呼ぶ本番用エントリポイント。 */
function snsHourlyJob() {
  var cfg = snsConfig_();
  var store = PropertiesService.getScriptProperties();
  var now = new Date();

  snsRefreshIgTokenIfNeeded_(cfg, store, now);

  snsFindDrafts_(cfg).forEach(function (d) {
    var key = 'sns:' + d.date;
    var status = store.getProperty(key + ':status');
    if (status) return; // posted / rejected / skipped / dryrun は処理済み

    // Canva の書き出しURLは期限があるため、承認を待たずに先に Drive へ保存しておく。
    var fileId = snsEnsureImage_(d, cfg, store);

    var start = snsScheduledAt_(d.date);
    var end = new Date(start.getTime() + SNS.WINDOW_HOURS * 3600 * 1000);
    if (now < start) return;

    var approval = snsApproval_(d.thread, cfg.approvers);
    if (!approval && cfg.approvalMode === 'optout') approval = 'approved';
    if (approval === 'rejected') {
      store.setProperty(key + ':status', 'rejected');
      snsNotify_(cfg, d, '中止の返信があったため投稿しませんでした', '');
      return;
    }
    if (approval !== 'approved') {
      if (now >= end) {
        store.setProperty(key + ':status', 'skipped');
        snsNotify_(cfg, d, '承認（OK の返信）がなかったため投稿しませんでした',
          '投稿する場合は、原稿メールに「OK」と返信したうえで、手動で配信してください。');
      }
      return;
    }
    if (now >= end) {
      var lineDone = store.getProperty(key + ':line');
      var igDone = store.getProperty(key + ':ig');
      store.setProperty(key + ':status', lineDone || igDone ? 'partial' : 'skipped');
      snsNotify_(cfg, d, '投稿時間を過ぎたため、再試行を終了しました',
        'LINE：' + (lineDone ? '配信済み' : '未配信') + '\nInstagram：' + (igDone ? '投稿済み' : '未投稿') +
        '\n未完了の分は手動で投稿してください。');
      return;
    }

    var imageUrl = fileId ? snsPublicImageUrl_(fileId) : '';
    if (cfg.dryRun) {
      store.setProperty(key + ':status', 'dryrun');
      snsNotify_(cfg, d, '【DRY_RUN】投稿予定の内容です（実際には投稿していません）',
        '画像URL: ' + (imageUrl || '（なし）') + '\n\n--- LINE ---\n' + d.line + '\n\n--- Instagram ---\n' + d.ig);
      return;
    }
    snsPost_(d, cfg, store, key, imageUrl);
  });
}

/** 投稿はせず、直近の原稿の読み取り結果と承認状態をログに出す確認用。 */
function previewSnsDrafts() {
  var cfg = snsConfig_();
  var drafts = snsFindDrafts_(cfg);
  if (drafts.length === 0) {
    Logger.log('対象の原稿メールが見つかりません（検索: ' + SNS.QUERY + '）');
    return;
  }
  var store = PropertiesService.getScriptProperties();
  drafts.forEach(function (d) {
    Logger.log('==== 配信予定日: ' + d.date + '（' + Utilities.formatDate(snsScheduledAt_(d.date), SNS.TZ, 'M/d HH:mm') + ' から投稿）');
    Logger.log('件名: ' + d.thread.getFirstMessageSubject());
    Logger.log('承認状態: ' + (snsApproval_(d.thread, cfg.approvers) || '返信なし') + '（方式: ' + cfg.approvalMode + '）');
    Logger.log('処理状況: ' + (store.getProperty('sns:' + d.date + ':status') || '未処理'));
    Logger.log('画像URL（Canva）: ' + (d.imageUrl || '（なし）'));
    Logger.log('--- LINE（' + d.line.length + '字）---\n' + d.line);
    Logger.log('--- Instagram（' + d.ig.length + '字・タグ' + snsCountHashtags_(d.ig) + '個）---\n' + d.ig);
  });
}

/** LINE のトークンが有効か確認する（投稿はしない）。 */
function testLineConnection() {
  var cfg = snsConfig_();
  var info = snsFetchJson_(SNS.LINE_INFO_URL, {
    headers: { Authorization: 'Bearer ' + cfg.lineToken }
  });
  Logger.log('LINE 接続OK: ' + info.displayName + '（' + info.basicId + '）');
}

/** Instagram のトークンが有効か確認する（投稿はしない）。 */
function testInstagramConnection() {
  var cfg = snsConfig_();
  var me = snsFetchJson_(SNS.IG_API + '/me?fields=user_id,username&access_token=' + encodeURIComponent(cfg.igToken));
  Logger.log('Instagram 接続OK: @' + me.username + '（IG_USER_ID に設定する値: ' + me.user_id + '）');
}

/** 1時間おきのトリガーを登録する。重複登録はしない。 */
function setupSnsTrigger() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'snsHourlyJob';
  });
  if (exists) {
    Logger.log('トリガーは登録済みです。');
    return;
  }
  ScriptApp.newTrigger('snsHourlyJob').timeBased().everyHours(1).create();
  Logger.log('snsHourlyJob を1時間おきに実行するトリガーを登録しました。');
}

// ---------------------------------------------------------------------------

function snsConfig_() {
  var p = PropertiesService.getScriptProperties();
  var get = function (k) { return String(p.getProperty(k) || '').trim(); };
  var list = function (k) {
    return get(k).toLowerCase().split(',').map(function (s) { return s.trim(); }).filter(String);
  };
  var cfg = {
    lineToken: get('LINE_CHANNEL_ACCESS_TOKEN'),
    igUserId: get('IG_USER_ID'),
    igToken: get('IG_ACCESS_TOKEN'),
    approvers: list('APPROVER_EMAILS'),
    notifyTo: get('NOTIFY_TO'),
    folderId: get('IMAGE_FOLDER_ID'),
    lineWithImage: get('LINE_WITH_IMAGE').toLowerCase() === 'true',
    dryRun: get('DRY_RUN').toLowerCase() === 'true',
    approvalMode: get('APPROVAL_MODE').toLowerCase() === 'optout' ? 'optout' : 'optin'
  };
  if (cfg.approvers.length === 0) throw new Error('スクリプトプロパティ APPROVER_EMAILS が未設定です。');
  if (!cfg.notifyTo) throw new Error('スクリプトプロパティ NOTIFY_TO が未設定です。');
  return cfg;
}

/** 原稿メールを探し、配信予定日ごとに一番新しいものを返す。 */
function snsFindDrafts_(cfg) {
  var byDate = {};
  GmailApp.search(SNS.QUERY, 0, 30).forEach(function (thread) {
    var first = thread.getMessages()[0];
    if (!snsIsFrom_(first, cfg.approvers)) return; // 承認者以外が送った原稿は扱わない
    var d = snsParseDraft_(first.getPlainBody());
    if (!d.date || !d.line) return;
    d.thread = thread;
    d.messageId = first.getId();
    d.sentAt = first.getDate();
    if (!byDate[d.date] || byDate[d.date].sentAt < d.sentAt) byDate[d.date] = d;
  });
  return Object.keys(byDate).sort().map(function (k) { return byDate[k]; });
}

function snsParseDraft_(body) {
  var text = body.replace(/\r\n/g, '\n');
  var block = function (name) {
    var m = text.match(new RegExp('===' + name + '_START===[^\\n]*\\n([\\s\\S]*?)\\n[^\\n]*===' + name + '_END==='));
    return m ? m[1].trim() : '';
  };
  var date = (text.match(/POST_DATE:\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
  var imageUrl = (text.match(/IMAGE_URL:\s*(https:\/\/\S+)/) || [])[1] || '';
  var line = block('LINE');
  return { date: date, imageUrl: imageUrl, line: line, ig: block('IG') || line };
}

/**
 * スレッド内の返信から承認状態を判定する。最後の意思表示を採用。
 * 返信の1行目が「OK」「承認」「はい」だけなら approved（「OK、ただし〜」のような条件付きは承認扱いしない）。
 * 1行目が NG / 中止 / やめ で始まれば rejected。
 */
function snsApproval_(thread, approvers) {
  var result = null;
  var msgs = thread.getMessages();
  for (var i = 1; i < msgs.length; i++) {
    if (!snsIsFrom_(msgs[i], approvers)) continue;
    var first = snsFirstLine_(msgs[i].getPlainBody());
    if (/^(ok|承認|はい)[\s!！。.]*$/i.test(first)) result = 'approved';
    else if (/^(ng|中止|やめ|取りやめ|見送)/i.test(first)) result = 'rejected';
  }
  return result;
}

function snsFirstLine_(body) {
  var lines = String(body || '').normalize('NFKC').split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var s = lines[i].trim();
    if (s) return s;
  }
  return '';
}

function snsIsFrom_(message, approvers) {
  var from = String(message.getFrom() || '').toLowerCase();
  var m = from.match(/<([^>]+)>/);
  var addr = (m ? m[1] : from).trim();
  return approvers.indexOf(addr) !== -1;
}

function snsScheduledAt_(ymd) {
  return new Date(ymd + 'T' + ('0' + SNS.POST_HOUR).slice(-2) + ':00:00+09:00');
}

/** 原稿メールごとに画像を1回だけ Drive に保存し、ファイルIDを返す。 */
function snsEnsureImage_(d, cfg, store) {
  var key = 'sns:img:' + d.messageId;
  var saved = store.getProperty(key);
  if (saved) return saved === 'error' ? '' : saved;
  if (!d.imageUrl) return '';
  try {
    var res = UrlFetchApp.fetch(d.imageUrl, { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
    var blob = res.getBlob().setName('sns_' + d.date + '.png');
    var folder = cfg.folderId ? DriveApp.getFolderById(cfg.folderId) : DriveApp.getRootFolder();
    var file = folder.createFile(blob);
    // Instagram / LINE のサーバーが画像を取りに来られるよう、リンクを知っている人は閲覧可にする。
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    store.setProperty(key, file.getId());
    return file.getId();
  } catch (e) {
    store.setProperty(key, 'error');
    snsNotify_(cfg, d, '画像を保存できませんでした（Instagram は投稿できません）',
      '原因: ' + e.message + '\nCanva の書き出しURLの期限切れの可能性があります。原稿を作り直すよう Claude に依頼してください。');
    return '';
  }
}

function snsPublicImageUrl_(fileId) {
  return 'https://lh3.googleusercontent.com/d/' + fileId;
}

/** LINE と Instagram に投稿する。成功したチャネルは記録し、二重投稿しない。 */
function snsPost_(d, cfg, store, key, imageUrl) {
  var results = [];
  var errors = [];

  if (!store.getProperty(key + ':line')) {
    try {
      snsPostLine_(d, cfg, store, key, imageUrl);
      store.setProperty(key + ':line', 'done');
      results.push('LINE：配信しました');
    } catch (e) {
      errors.push('LINE：' + e.message);
    }
  }

  if (!store.getProperty(key + ':ig')) {
    try {
      if (!imageUrl) throw new Error('画像がないため投稿できません');
      var id = snsPostInstagram_(d, cfg, imageUrl);
      store.setProperty(key + ':ig', 'done');
      results.push('Instagram：投稿しました（メディアID ' + id + '）');
    } catch (e) {
      errors.push('Instagram：' + e.message);
    }
  }

  var done = store.getProperty(key + ':line') && store.getProperty(key + ':ig');
  if (done) store.setProperty(key + ':status', 'posted');
  var detail = results.concat(errors).join('\n') +
    (errors.length && !done ? '\n\n失敗した分は、投稿時間内（' + SNS.WINDOW_HOURS + '時間）であれば1時間後に再試行します。' : '');
  snsNotify_(cfg, d, errors.length ? '投稿でエラーがありました' : 'LINE・Instagram に投稿しました', detail);
}

function snsPostLine_(d, cfg, store, key, imageUrl) {
  if (!cfg.lineToken) throw new Error('LINE_CHANNEL_ACCESS_TOKEN が未設定です');
  if (d.line.length > SNS.LINE_TEXT_MAX) throw new Error('本文が ' + SNS.LINE_TEXT_MAX + ' 字を超えています');
  var messages = [{ type: 'text', text: d.line }];
  if (cfg.lineWithImage && imageUrl) {
    messages.unshift({ type: 'image', originalContentUrl: imageUrl, previewImageUrl: imageUrl });
  }
  // 同じ配信予定日には同じリトライキーを使い、再試行しても二重配信にならないようにする。
  var retryKey = store.getProperty(key + ':lineRetryKey');
  if (!retryKey) {
    retryKey = Utilities.getUuid();
    store.setProperty(key + ':lineRetryKey', retryKey);
  }
  var res = UrlFetchApp.fetch(SNS.LINE_BROADCAST_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + cfg.lineToken, 'X-Line-Retry-Key': retryKey },
    payload: JSON.stringify({ messages: messages }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code === 200 || code === 409) return; // 409 = 同じリトライキーで受付済み
  throw new Error('HTTP ' + code + ' ' + res.getContentText().slice(0, 300));
}

function snsPostInstagram_(d, cfg, imageUrl) {
  if (!cfg.igUserId || !cfg.igToken) throw new Error('IG_USER_ID / IG_ACCESS_TOKEN が未設定です');
  if (d.ig.length > SNS.IG_CAPTION_MAX) throw new Error('キャプションが ' + SNS.IG_CAPTION_MAX + ' 字を超えています');
  if (snsCountHashtags_(d.ig) > SNS.IG_HASHTAG_MAX) throw new Error('ハッシュタグが ' + SNS.IG_HASHTAG_MAX + ' 個を超えています');

  var base = SNS.IG_API + '/' + cfg.igUserId;
  var container = snsFetchJson_(base + '/media', {
    method: 'post',
    payload: { image_url: imageUrl, caption: d.ig, access_token: cfg.igToken }
  });
  // 画像の取り込みが終わるまで待つ
  for (var i = 0; i < 20; i++) {
    var st = snsFetchJson_(SNS.IG_API + '/' + container.id + '?fields=status_code&access_token=' + encodeURIComponent(cfg.igToken));
    if (st.status_code === 'FINISHED') break;
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error('画像の取り込みに失敗しました（' + st.status_code + '）');
    Utilities.sleep(3000);
  }
  var published = snsFetchJson_(base + '/media_publish', {
    method: 'post',
    payload: { creation_id: container.id, access_token: cfg.igToken }
  });
  return published.id;
}

/** Instagram の長期トークンは60日で切れるため、週1回更新する。 */
function snsRefreshIgTokenIfNeeded_(cfg, store, now) {
  if (!cfg.igToken) return;
  var last = Number(store.getProperty('sns:igTokenRefreshedAt') || 0);
  if (now.getTime() - last < 7 * 24 * 3600 * 1000) return;
  try {
    var r = snsFetchJson_(SNS.IG_REFRESH_URL + '?grant_type=ig_refresh_token&access_token=' + encodeURIComponent(cfg.igToken));
    if (r.access_token) {
      store.setProperty('IG_ACCESS_TOKEN', r.access_token);
      cfg.igToken = r.access_token;
    }
    store.setProperty('sns:igTokenRefreshedAt', String(now.getTime()));
  } catch (e) {
    MailApp.sendEmail(cfg.notifyTo, '【SNS自動投稿】Instagram のトークン更新に失敗しました',
      '原因: ' + e.message + '\nトークンの期限が切れると Instagram に投稿できなくなります。手順書に沿って再発行してください。');
    store.setProperty('sns:igTokenRefreshedAt', String(now.getTime()));
  }
}

function snsCountHashtags_(text) {
  return (String(text).match(/#[^\s#]+/g) || []).length;
}

function snsFetchJson_(url, options) {
  var opts = options || {};
  opts.muteHttpExceptions = true;
  var res = UrlFetchApp.fetch(url, opts);
  var body = res.getContentText();
  if (res.getResponseCode() >= 300) {
    throw new Error('HTTP ' + res.getResponseCode() + ' ' + body.slice(0, 300));
  }
  return JSON.parse(body);
}

function snsNotify_(cfg, d, headline, detail) {
  var subject = '【SNS自動投稿】' + d.date + ' 配信分：' + headline;
  var body = headline + '\n\n' +
    '原稿メール: ' + d.thread.getFirstMessageSubject() + '\n' +
    (detail ? '\n' + detail + '\n' : '') +
    '\n※ このメールは SNS 自動投稿スクリプトが送信しています。';
  MailApp.sendEmail(cfg.notifyTo, subject, body);
}
