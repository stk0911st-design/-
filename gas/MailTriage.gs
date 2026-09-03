/**
 * メール自動仕分け・予定登録・エスカレーション（MailTriage）
 *
 * 代表アドレスおよび指定メンバー宛のメールを走査し、
 *   1. 営業DM・メルマガ・自動応答を除外する
 *   2. 内容から「要対応 / 重要 / 予定候補」を判定する
 *   3. 日時が読み取れたものを Google カレンダーに仮予定として登録する
 *   4. 重要なものは代表（小林）宛のエスカレーション文を作る
 *   5. 要返信のものは返信下書きをスレッドに作る
 *   6. 処理結果を Backlog / kintone / ログシートに記録する
 * を行う。
 *
 * 送信・外部登録は既定で行わない（DRY_RUN=true、ESCALATE_MODE=draft）。
 * 実際に動かす前に必ず previewMailTriage() で内容を確認すること。
 *
 * スクリプトプロパティ: gas/README.md の「MailTriage」節を参照。
 */

var MT_TZ = 'Asia/Tokyo';

/** 付与するラベル。Gmail 側に無ければ自動作成する。 */
var MT_LABELS = {
  done: 'AI/処理済',
  excluded: 'AI/対象外',
  action: 'AI/要対応',
  important: 'AI/重要',
  scheduled: 'AI/予定登録',
  escalated: 'AI/エスカレーション'
};

/** 判定用キーワード。ここを直せば判定基準が変わる。 */
var MT_KEYWORDS = {
  // 至急・経営リスク。1つでも当たれば「重要」に上げ、即時エスカレーションの対象にする。
  urgent: [
    '至急', '緊急', '本日中', '今日中', '大至急', 'クレーム', '苦情',
    '解約', '違約', '契約解除', '訴訟', '差押', '仮差押', '督促', '内容証明',
    '事故', '漏水', '瑕疵', '契約不適合', '行政指導', '是正'
  ],
  // 返信・判断を求めている表現
  action: [
    'ご確認', 'ご回答', 'ご返答', 'お返事', 'ご返信', 'ご指示', 'ご判断',
    'ご検討', 'ご対応', 'お願いいたします', 'いただけますでしょうか',
    'いかがでしょうか', '折り返し', '期限', 'までに', '締切'
  ],
  // 案件性（実務のメールであることの手がかり）
  deal: [
    '物件', '査定', '買取', '買付', '売却', '仲介', '媒介', '重説', '重要事項',
    '決済', '契約', '内見', '現地', '融資', '謄本', '測量', '境界', '賃貸借',
    '立退', '底地', '共有持分', '再建築', '相続', '登記', 'レインズ'
  ],
  // 日程調整の手がかり
  schedule: [
    '日程', '打合せ', '打ち合わせ', '来社', '訪問', '内見', '立会', '立ち会い',
    '面談', 'ご都合', 'アポ', '面会', '会議', '説明会', '引渡', '決済', '契約',
    'MTG', 'ミーティング', '現地調査'
  ]
};

/**
 * 無条件で対象外にする送信元（一斉配信・システム通知）。
 *
 * backlog.com を含めているのは意図的。Backlog の通知メールに返信するとその課題に
 * コメントが投稿されるため、自動で返信下書きを作ると誤投稿の危険がある。
 * Backlog の内容は Backlog 上で確認する前提とする。
 */
var MT_BLOCK_SENDERS = [
  'indeedemail.com', 'facebookmail.com', 'e.suumo.jp', 'mail.yahoo.co.jp',
  'bmsend.com', 'moneyforward.com', 'camp-fire.jp',
  'backlog.com', 'backlog.jp',
  'mailer-daemon', 'postmaster'
];

/**
 * 送信専用アドレスの手がかり。
 *
 * 一律に除外してはいけない。取引先が業務システム経由で送ってくる重要書類
 * （重要事項調査報告書・管理規約の送付通知など）も送信専用アドレスから届くため、
 * 案件語が2つ以上あるか至急語を含む場合は対象として残す。
 * ただし返信しても届かないので、返信下書きは作らず、本文中の担当者アドレスを拾って報告する。
 */
var MT_NOREPLY_PATTERNS = [
  'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply', 'do_not_reply'
];

/** 件名がこれらに当たり、かつ案件性が無ければ「対象外」。 */
var MT_NOISE_SUBJECT = [
  'メルマガ', 'メールマガジン', '配信停止', 'キャンペーン', '新着', 'セミナー',
  'ウェビナー', '無料相談', '【PR】', 'アンケート', 'ご優待', '特別ご案内',
  'お知らせメール', '本日の新着', '買取強化', '仕入れ強化', '募集しております'
];

/** 自動応答・不在通知。返信も予定登録も不要。 */
var MT_AUTOREPLY_SUBJECT = [
  '自動応答', '自動返信', 'Automatic reply', 'Auto Reply', 'Out of Office',
  '不在のご連絡', '配信されませんでした', 'Undelivered', 'Delivery Status'
];

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------

/** 送信・登録を一切せず、判定結果だけをログに出す。導入時はまずこれを実行する。 */
function previewMailTriage() {
  var report = runTriage_(true);
  Logger.log(report);
  return report;
}

/** 本番実行。定期トリガーからはこれを呼ぶ。 */
function runMailTriage() {
  var report = runTriage_(null);
  Logger.log(report);
  return report;
}

/** 当日分のまとめを代表宛に作る（既定は下書き）。夕方のトリガー用。 */
function sendMailTriageDigest() {
  var cfg = mtConfig_();
  var rows = readLogRows_(cfg, todayStr_());
  var subject = '【メール仕分け】' + todayLabel_() + ' の要対応まとめ';
  var html = buildDigestHtml_(rows);
  deliverToBoss_(cfg, subject, html, cfg.dryRun);
  return subject;
}

/** 定期トリガーをまとめて作る。二重登録を避けるため既存の同名トリガーは消す。 */
function installMailTriageTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runMailTriage' || t.getHandlerFunction() === 'sendMailTriageDigest') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('runMailTriage').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('sendMailTriageDigest').timeBased().atHour(18).everyDays(1).inTimezone(MT_TZ).create();
  Logger.log('トリガーを作成しました: runMailTriage（1時間ごと） / sendMailTriageDigest（毎日18時台）');
}

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

function mtConfig_() {
  var p = PropertiesService.getScriptProperties();
  function str(key, def) {
    var v = p.getProperty(key);
    return (v === null || v === '') ? def : String(v).trim();
  }
  function list(key) {
    return str(key, '').split(',').map(function (s) { return s.trim().toLowerCase(); })
      .filter(function (s) { return s !== ''; });
  }
  function bool(key, def) {
    var v = str(key, null);
    if (v === null) { return def; }
    return String(v).toLowerCase() === 'true';
  }
  function num(key, def) {
    var v = Number(str(key, ''));
    return isNaN(v) || v <= 0 ? def : v;
  }

  var cfg = {
    repAddresses: list('REP_ADDRESSES'),
    memberAddresses: list('MEMBER_ADDRESSES'),
    bossEmail: str('BOSS_EMAIL', ''),
    senderName: str('SENDER_NAME', ''),
    calendarId: str('CALENDAR_ID', 'primary'),
    lookbackDays: num('LOOKBACK_DAYS', 2),
    maxThreads: num('MAX_THREADS', 50),
    escalateMode: str('ESCALATE_MODE', 'draft').toLowerCase(),
    replyDraft: bool('REPLY_DRAFT', true),
    createEvents: bool('CREATE_EVENTS', true),
    dryRun: bool('DRY_RUN', true),
    logSpreadsheetId: str('LOG_SPREADSHEET_ID', ''),
    blockSenders: MT_BLOCK_SENDERS.concat(list('NOISE_SENDERS')),
    backlog: {
      spaceUrl: str('BACKLOG_SPACE_URL', '').replace(/\/+$/, ''),
      apiKey: str('BACKLOG_API_KEY', ''),
      projectKey: str('BACKLOG_PROJECT_KEY', ''),
      issueTypeName: str('BACKLOG_ISSUE_TYPE_NAME', ''),
      priorityId: num('BACKLOG_PRIORITY_ID', 3)
    },
    kintone: {
      domain: str('KINTONE_DOMAIN', '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
      appId: str('KINTONE_APP_ID', ''),
      apiToken: str('KINTONE_API_TOKEN', ''),
      fieldMap: parseJson_(str('KINTONE_FIELD_MAP', ''))
    }
  };

  if (cfg.repAddresses.length === 0 && cfg.memberAddresses.length === 0) {
    throw new Error('REP_ADDRESSES / MEMBER_ADDRESSES のいずれかを設定してください。');
  }
  if (!cfg.bossEmail) {
    throw new Error('BOSS_EMAIL（エスカレーション先）を設定してください。');
  }
  return cfg;
}

function parseJson_(raw) {
  if (!raw) { return null; }
  try {
    return JSON.parse(raw);
  } catch (e) {
    Logger.log('JSON の解析に失敗しました: ' + raw);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

function runTriage_(isDryRun) {
  var cfg = mtConfig_();
  if (isDryRun === null) { isDryRun = cfg.dryRun; }
  var labels = ensureLabels_();
  var threads = fetchThreads_(cfg);
  var lines = [];
  var counts = { total: 0, excluded: 0, action: 0, important: 0, events: 0, escalated: 0, drafts: 0 };

  lines.push('=== MailTriage ' + nowLabel_() + (isDryRun ? '（DRY RUN：送信・登録なし）' : '') + ' ===');
  lines.push('対象スレッド: ' + threads.length + '件');

  threads.forEach(function (thread) {
    var message = lastInboundMessage_(thread, cfg);
    if (!message) { return; }
    counts.total++;

    var item = analyzeMessage_(message, thread, cfg);
    lines.push('');
    lines.push('[' + item.verdict + '] ' + item.subject);
    lines.push('  差出人: ' + item.fromAddress + ' / 受信: ' + item.dateLabel);
    lines.push('  判定理由: ' + (item.reasons.join('、') || 'なし'));

    if (item.verdict === '対象外') {
      counts.excluded++;
      if (!isDryRun) {
        thread.addLabel(labels[MT_LABELS.excluded]);
        thread.addLabel(labels[MT_LABELS.done]);
      }
      return;
    }

    if (item.isImportant) { counts.important++; }
    if (item.needsAction) { counts.action++; }

    // 1. 予定候補をカレンダーへ
    if (cfg.createEvents && item.schedule.length > 0) {
      item.schedule.forEach(function (cand) {
        lines.push('  予定候補: ' + cand.label + (cand.allDay ? '（終日／時刻要確認）' : ''));
        if (!isDryRun) {
          if (createCalendarEvent_(cfg, item, cand)) {
            counts.events++;
            thread.addLabel(labels[MT_LABELS.scheduled]);
          }
        } else {
          counts.events++;
        }
      });
    }

    // 2. 返信下書き
    if (cfg.replyDraft && item.needsAction && !item.noReply && !hasDraftOnThread_(thread)) {
      lines.push('  返信下書き: 作成');
      if (!isDryRun) {
        thread.createDraftReply(buildReplyBody_(cfg, item));
      }
      counts.drafts++;
    }

    // 3. エスカレーション（至急系のみ即時。それ以外は夕方のダイジェストで報告）
    if (item.isUrgent) {
      lines.push('  エスカレーション: ' + (cfg.escalateMode === 'send' ? '送信' : '下書き作成'));
      if (!isDryRun) {
        var subject = '【要判断/至急】' + item.subject;
        deliverToBoss_(cfg, subject, buildEscalationHtml_(item), false);
        thread.addLabel(labels[MT_LABELS.escalated]);
      }
      counts.escalated++;
    }

    // 4. 記録
    if (!isDryRun) {
      thread.addLabel(labels[MT_LABELS.done]);
      if (item.needsAction) { thread.addLabel(labels[MT_LABELS.action]); }
      if (item.isImportant) { thread.addLabel(labels[MT_LABELS.important]); }
      appendLog_(cfg, item);
      if (item.isImportant) {
        recordToBacklog_(cfg, item);
        recordToKintone_(cfg, item);
      }
    }
  });

  lines.push('');
  lines.push('--- 集計 ---');
  lines.push('処理: ' + counts.total + ' / 対象外: ' + counts.excluded +
    ' / 要対応: ' + counts.action + ' / 重要: ' + counts.important);
  lines.push('予定登録: ' + counts.events + ' / 返信下書き: ' + counts.drafts +
    ' / エスカレーション: ' + counts.escalated);
  return lines.join('\n');
}

/** 走査対象スレッドを Gmail 検索で取る。処理済みラベルが付いたものは除く。 */
function fetchThreads_(cfg) {
  var addresses = cfg.repAddresses.concat(cfg.memberAddresses);
  var addressQuery = addresses.map(function (a) {
    return '(to:' + a + ' OR cc:' + a + ' OR from:' + a + ')';
  }).join(' OR ');
  var query = 'newer_than:' + cfg.lookbackDays + 'd -in:chats -in:trash -in:spam' +
    ' -label:' + quoteLabel_(MT_LABELS.done) +
    (addressQuery ? ' (' + addressQuery + ')' : '');
  return GmailApp.search(query, 0, cfg.maxThreads);
}

function quoteLabel_(name) {
  return '"' + name + '"';
}

/** スレッドのうち、社外から届いた最新のメッセージを返す。自社発信のみのスレッドは対象外。 */
function lastInboundMessage_(thread, cfg) {
  var messages = thread.getMessages();
  var own = cfg.repAddresses.concat(cfg.memberAddresses);
  for (var i = messages.length - 1; i >= 0; i--) {
    var addr = extractAddress_(messages[i].getFrom()).toLowerCase();
    if (own.indexOf(addr) === -1) {
      return messages[i];
    }
  }
  return null;
}

function analyzeMessage_(message, thread, cfg) {
  var subject = message.getSubject() || '(件名なし)';
  var from = message.getFrom();
  var fromAddress = extractAddress_(from);
  var body = truncate_(message.getPlainBody() || '', 8000);
  var haystack = subject + '\n' + body;
  var received = message.getDate();

  var item = {
    threadId: thread.getId(),
    messageId: message.getId(),
    subject: subject,
    from: from,
    fromAddress: fromAddress,
    fromName: extractName_(from),
    dateLabel: Utilities.formatDate(received, MT_TZ, 'M/d HH:mm'),
    received: received,
    permalink: thread.getPermalink(),
    reasons: [],
    hits: {},
    needsAction: false,
    isImportant: false,
    noReply: false,
    contactEmail: '',
    isUrgent: false,
    schedule: [],
    amounts: [],
    deadline: '',
    verdict: '情報共有',
    summary: firstMeaningfulLines_(body, 3)
  };

  // 除外判定
  if (matchAny_(subject, MT_AUTOREPLY_SUBJECT)) {
    item.verdict = '対象外';
    item.reasons.push('自動応答・不在通知');
    return item;
  }
  if (isBlockedSender_(fromAddress, cfg)) {
    item.verdict = '対象外';
    item.reasons.push('一斉配信・システム通知の送信元');
    return item;
  }

  item.noReply = isNoReplySender_(fromAddress);

  item.hits.urgent = collectHits_(haystack, MT_KEYWORDS.urgent);
  item.hits.action = collectHits_(haystack, MT_KEYWORDS.action);
  item.hits.deal = collectHits_(haystack, MT_KEYWORDS.deal);
  item.hits.schedule = collectHits_(haystack, MT_KEYWORDS.schedule);

  var hasSubstance = item.hits.deal.length >= 2 || item.hits.urgent.length > 0;

  if (matchAny_(subject, MT_NOISE_SUBJECT) && !hasSubstance) {
    item.verdict = '対象外';
    item.reasons.push('営業DM・案内メール（案件性なし）');
    return item;
  }
  if (item.noReply && !hasSubstance) {
    item.verdict = '対象外';
    item.reasons.push('送信専用アドレスからの通知（案件性なし）');
    return item;
  }
  if (item.noReply) {
    // 返信しても届かないため、本文の署名から担当者のアドレスを拾っておく
    item.contactEmail = extractContactEmail_(body, fromAddress);
    item.reasons.push('送信専用アドレス（返信不可）');
  }

  item.needsAction = item.hits.action.length > 0;
  item.isUrgent = item.hits.urgent.length > 0;
  item.isImportant = item.isUrgent ||
    (item.hits.action.length > 0 && item.hits.deal.length >= 2);

  if (item.hits.urgent.length) { item.reasons.push('至急語: ' + item.hits.urgent.join('/')); }
  if (item.hits.action.length) { item.reasons.push('要対応語: ' + item.hits.action.slice(0, 3).join('/')); }
  if (item.hits.deal.length) { item.reasons.push('案件語: ' + item.hits.deal.slice(0, 3).join('/')); }

  if (item.hits.schedule.length > 0) {
    item.schedule = extractDateTimes_(haystack, received);
    if (item.schedule.length > 0) {
      item.reasons.push('日程表現あり');
    }
  }
  item.amounts = extractAmounts_(haystack);
  item.deadline = extractDeadline_(haystack);

  item.verdict = item.isUrgent ? '至急' : (item.isImportant ? '重要' : (item.needsAction ? '要対応' : '情報共有'));
  return item;
}

function isBlockedSender_(address, cfg) {
  var lower = String(address).toLowerCase();
  return cfg.blockSenders.some(function (n) {
    return n && lower.indexOf(n) !== -1;
  });
}

function isNoReplySender_(address) {
  var lower = String(address).toLowerCase();
  return MT_NOREPLY_PATTERNS.some(function (n) {
    return lower.indexOf(n) !== -1;
  });
}

/** 送信専用アドレスのメールから、署名などに書かれた担当者のアドレスを拾う。 */
function extractContactEmail_(body, fromAddress) {
  var re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  var from = String(fromAddress).toLowerCase();
  var match;
  while ((match = re.exec(String(body))) !== null) {
    var addr = match[0];
    var lower = addr.toLowerCase();
    if (lower === from) { continue; }
    if (isNoReplySender_(lower)) { continue; }
    if (/\.(png|jpg|jpeg|gif)$/i.test(lower)) { continue; }
    return addr;
  }
  return '';
}

// ---------------------------------------------------------------------------
// 抽出
// ---------------------------------------------------------------------------

/**
 * 本文から日時候補を取り出す。
 * 「9月4日 14:00」「2026/9/4 10時」「明日15時」などに対応する。
 * 時刻が読めない場合は終日予定の候補として返す（時刻は人が確認する前提）。
 */
function extractDateTimes_(text, baseDate) {
  var found = [];
  var seen = {};
  var normalized = String(text).replace(/[０-９]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  });

  var patterns = [
    // 2026年9月4日 / 2026/9/4
    { re: /(\d{4})\s*[年\/\-]\s*(\d{1,2})\s*[月\/\-]\s*(\d{1,2})\s*日?/g, y: 1, m: 2, d: 3 },
    // 9月4日 / 9/4
    { re: /(?:^|[^\d\/\-])(\d{1,2})\s*[月\/]\s*(\d{1,2})\s*日?/g, m: 1, d: 2 }
  ];

  patterns.forEach(function (p) {
    var match;
    p.re.lastIndex = 0;
    while ((match = p.re.exec(normalized)) !== null) {
      var year = p.y ? Number(match[p.y]) : inferYear_(Number(match[p.m]), baseDate);
      var month = Number(match[p.m]);
      var day = Number(match[p.d]);
      if (!isValidYmd_(year, month, day)) { continue; }
      var tail = normalized.substr(match.index + match[0].length, 24);
      pushCandidate_(found, seen, year, month, day, extractTime_(tail));
    }
  });

  // 相対日付
  [['本日', 0], ['今日', 0], ['明日', 1], ['明後日', 2]].forEach(function (pair) {
    var idx = normalized.indexOf(pair[0]);
    if (idx === -1) { return; }
    var d = new Date(baseDate.getTime() + pair[1] * 86400000);
    var tail = normalized.substr(idx + pair[0].length, 24);
    pushCandidate_(found, seen,
      Number(Utilities.formatDate(d, MT_TZ, 'yyyy')),
      Number(Utilities.formatDate(d, MT_TZ, 'M')),
      Number(Utilities.formatDate(d, MT_TZ, 'd')),
      extractTime_(tail));
  });

  // 過去日は日程調整ではないので落とす
  var floor = new Date(baseDate.getTime() - 86400000);
  return found.filter(function (c) { return c.start >= floor; }).slice(0, 5);
}

function pushCandidate_(found, seen, year, month, day, time) {
  var key = year + '-' + month + '-' + day + '-' + (time ? time.hour + ':' + time.minute : 'allday');
  if (seen[key]) { return; }
  seen[key] = true;
  var start, end, allDay;
  if (time) {
    start = new Date(year, month - 1, day, time.hour, time.minute, 0);
    end = new Date(start.getTime() + 60 * 60000);
    allDay = false;
  } else {
    start = new Date(year, month - 1, day, 0, 0, 0);
    end = new Date(year, month - 1, day, 23, 59, 0);
    allDay = true;
  }
  found.push({
    start: start,
    end: end,
    allDay: allDay,
    label: Utilities.formatDate(start, MT_TZ, 'yyyy/M/d(E)') + (allDay ? '' : ' ' + Utilities.formatDate(start, MT_TZ, 'HH:mm'))
  });
}

/** 日付直後の文字列から時刻を読む。読めなければ null。 */
function extractTime_(tail) {
  var ampm = /午前|午後/.exec(tail);
  var m = /(\d{1,2})\s*[:：]\s*(\d{2})/.exec(tail);
  var hour, minute;
  if (m) {
    hour = Number(m[1]);
    minute = Number(m[2]);
  } else {
    m = /(\d{1,2})\s*時\s*(半|(\d{1,2})\s*分)?/.exec(tail);
    if (!m) { return null; }
    hour = Number(m[1]);
    minute = m[2] === '半' ? 30 : (m[3] ? Number(m[3]) : 0);
  }
  if (ampm && ampm[0] === '午後' && hour < 12) { hour += 12; }
  if (hour > 23 || minute > 59) { return null; }
  return { hour: hour, minute: minute };
}

/** 月だけ書かれている場合の年の推定。半年以上前の月なら翌年とみなす。 */
function inferYear_(month, baseDate) {
  var baseYear = Number(Utilities.formatDate(baseDate, MT_TZ, 'yyyy'));
  var baseMonth = Number(Utilities.formatDate(baseDate, MT_TZ, 'M'));
  if (month < baseMonth - 6) { return baseYear + 1; }
  if (month > baseMonth + 6) { return baseYear - 1; }
  return baseYear;
}

function isValidYmd_(y, m, d) {
  if (!y || !m || !d) { return false; }
  if (m < 1 || m > 12 || d < 1 || d > 31) { return false; }
  var date = new Date(y, m - 1, d);
  return date.getMonth() === m - 1 && date.getDate() === d;
}

/** 金額表現を拾う（億・万・円）。判断材料として報告に載せる。 */
function extractAmounts_(text) {
  var out = [];
  var re = /([0-9,\.]+)\s*(億円|億|万円|万|円)/g;
  var m;
  while ((m = re.exec(text)) !== null && out.length < 5) {
    out.push(m[0].replace(/\s+/g, ''));
  }
  return out;
}

/** 期限表現を1つ拾う。 */
function extractDeadline_(text) {
  var re = /((?:\d{1,2}\s*[月\/]\s*\d{1,2}\s*日?|今週|来週|本日|明日|月内|月末)\s*(?:まで|中)(?:に)?)/;
  var m = re.exec(text);
  return m ? m[1].replace(/\s+/g, '') : '';
}

// ---------------------------------------------------------------------------
// カレンダー
// ---------------------------------------------------------------------------

function createCalendarEvent_(cfg, item, cand) {
  var calendar = cfg.calendarId === 'primary'
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(cfg.calendarId);
  if (!calendar) {
    Logger.log('カレンダーが見つかりません: ' + cfg.calendarId);
    return false;
  }

  var marker = '[mail-triage:' + item.messageId + ']';
  if (hasEventWithMarker_(calendar, cand.start, marker)) {
    return false;
  }

  var title = (cand.allDay ? '【要確認・時刻未定】' : '【要確認】') + shortSubject_(item.subject);
  var description = [
    'メールから自動作成した仮予定です。日時・出席可否を確認してください。',
    '',
    '差出人: ' + item.from,
    '受信: ' + item.dateLabel,
    item.deadline ? '期限表現: ' + item.deadline : '',
    item.amounts.length ? '金額表現: ' + item.amounts.join(' / ') : '',
    '',
    'メール: ' + item.permalink,
    marker
  ].filter(function (s) { return s !== ''; }).join('\n');

  var options = { description: description };
  if (cand.allDay) {
    calendar.createAllDayEvent(title, cand.start, options);
  } else {
    calendar.createEvent(title, cand.start, cand.end, options);
  }
  return true;
}

function hasEventWithMarker_(calendar, day, marker) {
  var from = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0);
  var to = new Date(from.getTime() + 86400000);
  return calendar.getEvents(from, to).some(function (ev) {
    return String(ev.getDescription() || '').indexOf(marker) !== -1;
  });
}

// ---------------------------------------------------------------------------
// メール文面
// ---------------------------------------------------------------------------

/** 返信下書きの本文。骨組みだけ作り、判断が必要な部分は空欄にして人が埋める。 */
function buildReplyBody_(cfg, item) {
  var lines = [];
  lines.push((item.fromName || 'ご担当者') + ' 様');
  lines.push('');
  lines.push('お世話になっております。' + (cfg.senderName || '') );
  lines.push('ご連絡いただきありがとうございます。');
  lines.push('');
  lines.push('＜ここに回答を記入してください＞');
  lines.push('');

  if (item.schedule.length > 0) {
    lines.push('【メール内の日程表現】');
    item.schedule.forEach(function (c) {
      lines.push('・' + c.label + (c.allDay ? '（時刻の記載なし）' : ''));
    });
    lines.push('');
  }
  if (item.deadline) {
    lines.push('【期限】' + item.deadline);
    lines.push('');
  }
  if (item.amounts.length > 0) {
    lines.push('【金額】' + item.amounts.join(' / '));
    lines.push('');
  }

  lines.push('引き続きよろしくお願いいたします。');
  lines.push('');
  lines.push('---');
  lines.push('※この下書きは受信メールから自動生成したものです。送信前に必ず内容を確認してください。');
  return lines.join('\n');
}

function buildEscalationHtml_(item) {
  var out = [];
  out.push('<div style="font-family:sans-serif;font-size:14px;line-height:1.7;color:#222">');
  out.push('<p>小林様<br>お世話になっております。至急のご判断が必要なメールを受信しました。</p>');
  out.push('<table style="border-collapse:collapse;font-size:13px">');
  out.push(row_('件名', item.subject));
  out.push(row_('差出人', item.from));
  out.push(row_('受信', item.dateLabel));
  out.push(row_('判定理由', item.reasons.join('、')));
  if (item.contactEmail) { out.push(row_('担当者の連絡先', item.contactEmail + '（差出人は送信専用アドレス）')); }
  if (item.deadline) { out.push(row_('期限', item.deadline)); }
  if (item.amounts.length) { out.push(row_('金額', item.amounts.join(' / '))); }
  if (item.schedule.length) {
    out.push(row_('日程', item.schedule.map(function (c) { return c.label; }).join(' / ')));
  }
  out.push('</table>');
  out.push('<p style="margin-top:16px"><b>本文冒頭</b></p>');
  out.push('<pre style="background:#f7f7f7;padding:10px;white-space:pre-wrap;font-size:12px">' +
    esc2_(item.summary) + '</pre>');
  out.push('<p><b>ご指示ください</b>：この件、①こちらで返信案を作って進める ②小林様が直接対応 ' +
    '③保留 のいずれかをご返信ください。</p>');
  out.push('<p><a href="' + esc2_(item.permalink) + '">Gmail で開く</a></p>');
  out.push('<p style="color:#666;font-size:12px;margin-top:20px">' +
    '※ 本メールは受信メールの自動判定によるものです。判定は完全ではありません。</p>');
  out.push('</div>');
  return out.join('');
}

function buildDigestHtml_(rows) {
  var out = [];
  out.push('<div style="font-family:sans-serif;font-size:14px;line-height:1.7;color:#222">');
  out.push('<p>小林様<br>お世話になっております。本日の要対応メールをまとめました。</p>');
  if (rows.length === 0) {
    out.push('<p>本日、要対応と判定したメールはありませんでした。</p>');
  } else {
    out.push('<table style="border-collapse:collapse;font-size:13px"><thead><tr>');
    ['判定', '受信', '差出人', '件名', '期限', '日程'].forEach(function (h) {
      out.push('<th style="border:1px solid #ccc;padding:6px 10px;background:#f2f2f2">' + esc2_(h) + '</th>');
    });
    out.push('</tr></thead><tbody>');
    rows.forEach(function (r) {
      out.push('<tr>');
      [r.verdict, r.dateLabel, r.fromAddress, r.subject, r.deadline, r.scheduleLabel].forEach(function (v) {
        out.push('<td style="border:1px solid #ccc;padding:6px 10px">' + esc2_(v || '') + '</td>');
      });
      out.push('</tr>');
    });
    out.push('</tbody></table>');
  }
  out.push('<p style="color:#666;font-size:12px;margin-top:20px">' +
    '※ 返信下書きは各スレッドに作成済みです。送信前に必ず内容を確認してください。</p>');
  out.push('</div>');
  return out.join('');
}

function row_(label, value) {
  return '<tr><th style="border:1px solid #ccc;padding:6px 10px;background:#f2f2f2;text-align:left;white-space:nowrap">' +
    esc2_(label) + '</th><td style="border:1px solid #ccc;padding:6px 10px">' + esc2_(value) + '</td></tr>';
}

/** 代表宛に届ける。ESCALATE_MODE=send かつ dryRun でないときだけ送信し、それ以外は下書きにする。 */
function deliverToBoss_(cfg, subject, html, forceDraft) {
  var options = { htmlBody: html, name: 'メール仕分け' };
  if (!forceDraft && cfg.escalateMode === 'send') {
    GmailApp.sendEmail(cfg.bossEmail, subject, htmlToText_(html), options);
    Logger.log('送信しました: ' + subject);
  } else {
    GmailApp.createDraft(cfg.bossEmail, subject, htmlToText_(html), options);
    Logger.log('下書きを作成しました: ' + subject);
  }
}

// ---------------------------------------------------------------------------
// 記録（ログシート / Backlog / kintone）
// ---------------------------------------------------------------------------

function appendLog_(cfg, item) {
  if (!cfg.logSpreadsheetId) { return; }
  var sheet = logSheet_(cfg);
  sheet.appendRow([
    Utilities.formatDate(new Date(), MT_TZ, 'yyyy-MM-dd HH:mm:ss'),
    Utilities.formatDate(item.received, MT_TZ, 'yyyy-MM-dd'),
    item.dateLabel,
    item.verdict,
    item.fromAddress,
    item.subject,
    item.reasons.join('、'),
    item.deadline,
    item.amounts.join(' / '),
    item.schedule.map(function (c) { return c.label; }).join(' / '),
    item.permalink
  ]);
}

function logSheet_(cfg) {
  var ss = SpreadsheetApp.openById(cfg.logSpreadsheetId);
  var sheet = ss.getSheetByName('mail_triage_log');
  if (!sheet) {
    sheet = ss.insertSheet('mail_triage_log');
    sheet.appendRow(['処理日時', '受信日', '受信時刻', '判定', '差出人', '件名',
      '判定理由', '期限', '金額', '日程候補', 'メールリンク']);
  }
  return sheet;
}

function readLogRows_(cfg, ymd) {
  if (!cfg.logSpreadsheetId) { return []; }
  var sheet = logSheet_(cfg);
  var last = sheet.getLastRow();
  if (last < 2) { return []; }
  var values = sheet.getRange(2, 1, last - 1, 11).getDisplayValues();
  return values.filter(function (r) {
    return r[1] === ymd && r[3] !== '情報共有' && r[3] !== '対象外';
  }).map(function (r) {
    return {
      verdict: r[3], dateLabel: r[2], fromAddress: r[4], subject: r[5],
      deadline: r[7], scheduleLabel: r[9]
    };
  });
}

/** Backlog に課題を作る。設定が無ければ何もしない。 */
function recordToBacklog_(cfg, item) {
  var b = cfg.backlog;
  if (!b.spaceUrl || !b.apiKey || !b.projectKey) { return; }
  try {
    var project = backlogGet_(b, '/api/v2/projects/' + encodeURIComponent(b.projectKey));
    if (!project) { return; }
    var issueTypes = backlogGet_(b, '/api/v2/projects/' + encodeURIComponent(b.projectKey) + '/issueTypes') || [];
    var issueType = issueTypes.filter(function (t) {
      return !b.issueTypeName || t.name === b.issueTypeName;
    })[0] || issueTypes[0];
    if (!issueType) {
      Logger.log('Backlog の課題種別が取得できませんでした。');
      return;
    }
    var payload = {
      projectId: project.id,
      summary: '[メール] ' + shortSubject_(item.subject),
      issueTypeId: issueType.id,
      priorityId: b.priorityId,
      description: [
        '受信メールから自動登録しました。',
        '',
        '差出人: ' + item.from,
        '受信: ' + item.dateLabel,
        '判定: ' + item.verdict + '（' + item.reasons.join('、') + '）',
        item.deadline ? '期限: ' + item.deadline : '',
        item.amounts.length ? '金額: ' + item.amounts.join(' / ') : '',
        item.schedule.length ? '日程候補: ' + item.schedule.map(function (c) { return c.label; }).join(' / ') : '',
        '',
        'メール: ' + item.permalink,
        '',
        '--- 本文冒頭 ---',
        item.summary
      ].filter(function (s) { return s !== ''; }).join('\n')
    };
    var res = UrlFetchApp.fetch(b.spaceUrl + '/api/v2/issues?apiKey=' + encodeURIComponent(b.apiKey), {
      method: 'post',
      payload: payload,
      muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 300) {
      Logger.log('Backlog 登録に失敗: ' + res.getResponseCode() + ' ' + res.getContentText());
    }
  } catch (e) {
    Logger.log('Backlog 登録でエラー: ' + e);
  }
}

function backlogGet_(b, path) {
  var res = UrlFetchApp.fetch(b.spaceUrl + path + '?apiKey=' + encodeURIComponent(b.apiKey), {
    method: 'get',
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) {
    Logger.log('Backlog 取得に失敗: ' + path + ' ' + res.getResponseCode() + ' ' + res.getContentText());
    return null;
  }
  return JSON.parse(res.getContentText());
}

/** kintone にレコードを作る。設定が無ければ何もしない。 */
function recordToKintone_(cfg, item) {
  var k = cfg.kintone;
  if (!k.domain || !k.appId || !k.apiToken) { return; }
  var map = k.fieldMap || {
    subject: '件名', from: '差出人', received: '受信日時', verdict: '判定',
    reasons: '判定理由', deadline: '期限', amounts: '金額', schedule: '日程候補', link: 'メールリンク'
  };
  var values = {
    subject: item.subject,
    from: item.from,
    received: Utilities.formatDate(item.received, MT_TZ, 'yyyy-MM-dd HH:mm'),
    verdict: item.verdict,
    reasons: item.reasons.join('、'),
    deadline: item.deadline,
    amounts: item.amounts.join(' / '),
    schedule: item.schedule.map(function (c) { return c.label; }).join(' / '),
    link: item.permalink
  };
  var record = {};
  Object.keys(map).forEach(function (key) {
    if (map[key] && values[key] !== undefined && values[key] !== '') {
      record[map[key]] = { value: values[key] };
    }
  });

  try {
    var res = UrlFetchApp.fetch('https://' + k.domain + '/k/v1/record.json', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Cybozu-API-Token': k.apiToken },
      payload: JSON.stringify({ app: Number(k.appId), record: record }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 300) {
      Logger.log('kintone 登録に失敗: ' + res.getResponseCode() + ' ' + res.getContentText());
    }
  } catch (e) {
    Logger.log('kintone 登録でエラー: ' + e);
  }
}

// ---------------------------------------------------------------------------
// 小物
// ---------------------------------------------------------------------------

function ensureLabels_() {
  var map = {};
  Object.keys(MT_LABELS).forEach(function (key) {
    var name = MT_LABELS[key];
    map[name] = GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
  });
  return map;
}

function hasDraftOnThread_(thread) {
  var id = thread.getId();
  return GmailApp.getDrafts().some(function (d) {
    try {
      return d.getMessage().getThread().getId() === id;
    } catch (e) {
      return false;
    }
  });
}

function collectHits_(text, words) {
  var hits = [];
  words.forEach(function (w) {
    if (text.indexOf(w) !== -1) { hits.push(w); }
  });
  return hits;
}

function matchAny_(text, words) {
  return words.some(function (w) {
    return String(text).toLowerCase().indexOf(String(w).toLowerCase()) !== -1;
  });
}

function extractAddress_(from) {
  var m = /<([^>]+)>/.exec(String(from));
  return (m ? m[1] : String(from)).trim();
}

function extractName_(from) {
  var s = String(from);
  var m = /^\s*"?([^"<]+?)"?\s*</.exec(s);
  return m ? m[1].trim() : '';
}

function shortSubject_(subject) {
  var s = String(subject).replace(/^(Re:|RE:|Fwd:|FW:)\s*/gi, '').trim();
  return s.length > 60 ? s.substring(0, 60) + '…' : s;
}

function truncate_(text, max) {
  var s = String(text);
  return s.length > max ? s.substring(0, max) : s;
}

/** 署名や引用を避け、本文の頭から意味のある行を数行取る。 */
function firstMeaningfulLines_(body, count) {
  var lines = String(body).split('\n');
  var out = [];
  for (var i = 0; i < lines.length && out.length < count; i++) {
    var line = lines[i].trim();
    if (line === '' || /^[>＞]/.test(line) || /^[-=＿_※*＊]{3,}$/.test(line)) { continue; }
    out.push(line);
  }
  return out.join('\n');
}

function todayStr_() {
  return Utilities.formatDate(new Date(), MT_TZ, 'yyyy-MM-dd');
}

function todayLabel_() {
  return Utilities.formatDate(new Date(), MT_TZ, 'yyyy年M月d日(E)');
}

function nowLabel_() {
  return Utilities.formatDate(new Date(), MT_TZ, 'yyyy-MM-dd HH:mm');
}

function esc2_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlToText_(html) {
  return String(html)
    .replace(/<\/(p|tr|li|div|pre)>/g, '\n')
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
