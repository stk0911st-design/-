/**
 * Googleドライブのミラー保存（共有ドライブへの自動コピー）
 *
 * 会社のフォルダ（例：02.SH書類）の中身を、Google Workspace の共有ドライブへ
 * フォルダの形のままコピーして保存しておく。保険（バックアップ）用。
 *   ・2回目からは、新しいファイルと更新されたファイルだけをコピーする
 *   ・更新されたファイルは、前のコピーの名前に「（旧版 日付）」を付けて残し、新しくコピーする
 *   ・コピー元で消されたファイルも、ミラー側には残す（Drive のファイルは一切削除しない）
 *   ・名前に「パスワード」などを含むもの、指定したフォルダはコピーしない
 *
 * Workspace のアカウントで作成し、時間主導型トリガー（15分ごと）で動かす。
 * 1回の実行は数分で区切り、続きは次の実行で行う。1周終わると翌日まで休み、報告メールを送る。
 * 導入手順は docs/drive-mirror-setup.md を参照。
 */

// ---- 設定（必要ならここを直す） ----
var DM_TZ = 'Asia/Tokyo';
var DM_START_HOUR = 1;                // 毎日この時刻（JST）以降に1周を始める
var DM_MAX_RUN_MS = 3.5 * 60 * 1000;  // 1回の実行で作業する時間（Apps Script の上限6分より短く）
var DM_TRIGGER_MINUTES = 15;          // トリガーの間隔
var DM_DEFAULT_EXCLUDE_KEYWORDS = 'パスワード,ログイン情報';
var DM_SKIP_MIME = [                  // コピーできない・意味がない種類
  'application/vnd.google-apps.shortcut',
  'application/vnd.google-apps.form',
  'application/vnd.google-apps.site'
];
var DM_LEDGER_NAME = 'ミラー台帳（ドライブ自動コピーの記録・消さないでください）';
var DM_SHEET_LEDGER = '台帳';
var DM_SHEET_QUEUE = 'キュー';
var DM_SHEET_RUNS = '実行記録';
var DM_LEDGER_HEADER = ['ジョブ', 'コピー元ID', 'ミラーID', '種類', '場所', '元の最終更新', 'コピー日時', '状態', 'メモ'];
var DM_QUEUE_HEADER = ['ジョブ', 'コピー元フォルダID', 'ミラーフォルダID', '場所'];
var DM_RUNS_HEADER = ['開始', '終了', '新規コピー', '更新コピー', 'フォルダ作成', '除外', 'エラー'];
var DM_OK = 'コピー済';
var DM_NG = 'エラー';

/** 初回だけ実行：設定の確認、台帳の作成、トリガーの登録 */
function setupMirror() {
  var cfg = loadConfig_();
  var ss = openLedger_(cfg);
  deleteMirrorTriggers_();
  ScriptApp.newTrigger('runMirror').timeBased().everyMinutes(DM_TRIGGER_MINUTES).create();
  console.log('準備できました。台帳：' + ss.getUrl());
  console.log('runMirror を ' + DM_TRIGGER_MINUTES + ' 分ごとに実行します（毎日 ' +
    DM_START_HOUR + ' 時以降に1周を開始）。');
}

/** 止めたいとき：トリガーを外す（台帳・ミラー側のファイルはそのまま） */
function stopMirror() {
  deleteMirrorTriggers_();
  console.log('自動コピーを止めました。再開するときは setupMirror を実行してください。');
}

/** 確認用：コピーはせず、設定と各ジョブの入口（直下の件数・除外されるもの）を表示する */
function previewMirror() {
  var cfg = loadConfig_();
  cfg.jobs.forEach(function (job) {
    var src = DriveApp.getFolderById(job.source);
    var dest = DriveApp.getFolderById(job.dest);
    console.log('■ ' + job.name + '：「' + src.getName() + '」→「' + dest.getName() + '」');
    var nFolders = 0, nFiles = 0, excluded = [];
    var folders = src.getFolders();
    while (folders.hasNext()) {
      var f = folders.next();
      if (isExcluded_(cfg, job, f)) excluded.push(f.getName()); else nFolders++;
    }
    var files = src.getFiles();
    while (files.hasNext()) {
      var file = files.next();
      if (isExcluded_(cfg, job, file)) excluded.push(file.getName()); else nFiles++;
    }
    console.log('  直下のフォルダ ' + nFolders + ' 件・ファイル ' + nFiles + ' 件がコピー対象です。');
    console.log('  直下でコピーしないもの：' + (excluded.length ? excluded.join(' / ') : 'なし'));
  });
  console.log('名前で除外するキーワード：' + cfg.keywords.join(', '));
  console.log('報告メールの宛先：' + (cfg.reportTo || '（未設定・送りません）'));
}

/** トリガーから呼ばれる本体 */
function runMirror() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // 前の実行がまだ動いている
  try {
    var started = Date.now();
    var cfg = loadConfig_();
    var state = JSON.parse(cfg.props.getProperty('MIRROR_STATE') || '{}');
    var today = Utilities.formatDate(new Date(), DM_TZ, 'yyyy-MM-dd');

    if (state.status !== 'running') {
      var hour = Number(Utilities.formatDate(new Date(), DM_TZ, 'H'));
      if (state.lastFinished === today || hour < DM_START_HOUR) return;
    }

    var ss = openLedger_(cfg);
    if (state.status !== 'running') {
      state = startCycle_(cfg, ss);
      saveState_(cfg, state);
    }
    var ctx = newContext_(cfg, ss, state, started);
    var done = false;
    try {
      done = processQueue_(ctx);
    } finally {
      state.counts = ctx.counts; // 途中で止まっても件数は残す
      saveState_(cfg, state);
    }
    if (done) finishCycle_(cfg, ss, state, today);
  } finally {
    lock.releaseLock();
  }
}

// ---- 1周の開始・終了 ----

function startCycle_(cfg, ss) {
  var q = ss.getSheetByName(DM_SHEET_QUEUE);
  if (q.getLastRow() > 1) {
    q.getRange(2, 1, q.getLastRow() - 1, DM_QUEUE_HEADER.length).clearContent();
  }
  var rows = cfg.jobs.map(function (job) { return [job.name, job.source, job.dest, '']; });
  q.getRange(2, 1, rows.length, DM_QUEUE_HEADER.length).setValues(rows);
  return { status: 'running', startedAt: new Date().getTime(), counts: zeroCounts_() };
}

function finishCycle_(cfg, ss, state, today) {
  var c = state.counts;
  ss.getSheetByName(DM_SHEET_RUNS).appendRow([new Date(state.startedAt), new Date(),
    c.copied, c.updated, c.folders, c.excluded, c.errors]);
  sendReport_(cfg, ss, state);
  saveState_(cfg, { status: 'idle', lastFinished: today });
}

function sendReport_(cfg, ss, state) {
  if (!cfg.reportTo) return;
  var c = state.counts;
  var fmt = function (t) { return Utilities.formatDate(new Date(t), DM_TZ, 'yyyy/MM/dd HH:mm'); };
  var lines = [
    'Googleドライブのミラー保存（自動コピー）が1周終わりました。',
    '',
    '開始：' + fmt(state.startedAt),
    '終了：' + fmt(new Date().getTime()),
    '',
    '新しくコピー：' + c.copied + ' 件',
    '更新分をコピー：' + c.updated + ' 件（前のコピーは「旧版」として残しています）',
    'フォルダ作成：' + c.folders + ' 件',
    'コピーしなかったもの（除外）：' + c.excluded + ' 件',
    'エラー：' + c.errors + ' 件'
  ];
  var problems = listProblems_(ss, 30);
  if (problems.length) {
    lines.push('', '■ うまくコピーできていないもの（最大30件）');
    problems.forEach(function (p) { lines.push('・' + p); });
  }
  lines.push('', '台帳：' + ss.getUrl(), '', '※ このスクリプトはドライブのファイルを削除しません。');
  var subject = '【ドライブ自動コピー】1周完了 ' + Utilities.formatDate(new Date(), DM_TZ, 'M/d') +
    '（新規' + c.copied + '・更新' + c.updated + '・エラー' + c.errors + '）';
  MailApp.sendEmail(cfg.reportTo, subject, lines.join('\n'));
}

/** 台帳から「エラー」または「メモあり」の行を拾う */
function listProblems_(ss, max) {
  var sh = ss.getSheetByName(DM_SHEET_LEDGER);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var out = [];
  var vals = sh.getRange(2, 1, last - 1, DM_LEDGER_HEADER.length).getValues();
  for (var i = 0; i < vals.length && out.length < max; i++) {
    if (vals[i][7] === DM_NG || vals[i][8]) out.push(vals[i][4] + '：' + (vals[i][8] || vals[i][7]));
  }
  return out;
}

// ---- コピーの処理 ----

/** キューの最後のフォルダから順に処理する（全部終わったら true） */
function processQueue_(ctx) {
  var q = ctx.ss.getSheetByName(DM_SHEET_QUEUE);
  while (true) {
    var last = q.getLastRow();
    if (last < 2) return true;
    if (ctx.timeUp()) return false;
    var item = q.getRange(last, 1, 1, DM_QUEUE_HEADER.length).getValues()[0];
    var job = ctx.cfg.jobsByName[item[0]];
    if (!job) { q.deleteRow(last); continue; } // 設定から外したジョブの残り
    if (!processFolder_(ctx, job, String(item[1]), String(item[2]), String(item[3]), q, last)) {
      return false;
    }
  }
}

/**
 * 1フォルダ分：ファイルをコピーし、サブフォルダをミラー側に作ってキューに積む。
 * 時間切れのときは false を返し、このフォルダは次の実行でやり直す
 * （コピー済みのファイルは台帳で飛ばすので二重にはならない）。
 */
function processFolder_(ctx, job, srcId, mirrorId, path, q, row) {
  var src, dest;
  try {
    src = DriveApp.getFolderById(srcId);
    dest = DriveApp.getFolderById(mirrorId);
  } catch (err) {
    recordError_(ctx, job, srcId, path || job.name, 'フォルダ', 'フォルダを開けません：' + err.message);
    q.deleteRow(row);
    return true;
  }

  var files = src.getFiles();
  while (files.hasNext()) {
    if (ctx.timeUp()) return false;
    var file = files.next();
    if (isExcluded_(ctx.cfg, job, file) || DM_SKIP_MIME.indexOf(file.getMimeType()) !== -1) {
      ctx.counts.excluded++;
      continue;
    }
    try {
      mirrorFile_(ctx, job, file, dest, path);
    } catch (err) {
      if (isQuotaError_(err)) { ctx.stopNow = true; return false; }
      recordError_(ctx, job, file.getId(), joinPath_(path, file.getName()), 'ファイル', err.message);
    }
  }

  var children = [];
  var folders = src.getFolders();
  while (folders.hasNext()) {
    var sub = folders.next();
    if (isExcluded_(ctx.cfg, job, sub)) { ctx.counts.excluded++; continue; }
    var subPath = joinPath_(path, sub.getName());
    try {
      children.push([job.name, sub.getId(), ensureMirrorFolder_(ctx, job, sub, dest, subPath), subPath]);
    } catch (err) {
      if (isQuotaError_(err)) { ctx.stopNow = true; return false; }
      recordError_(ctx, job, sub.getId(), subPath, 'フォルダ', err.message);
    }
  }
  if (children.length) {
    q.getRange(q.getLastRow() + 1, 1, children.length, DM_QUEUE_HEADER.length).setValues(children);
  }
  q.deleteRow(row);
  return true;
}

function mirrorFile_(ctx, job, file, dest, path) {
  var key = job.name + '|' + file.getId();
  var rec = ctx.ledger[key];
  var updated = file.getLastUpdated().getTime();
  var hasCopy = rec && rec.status === DM_OK && rec.mirrorId;
  if (hasCopy && updated - rec.srcUpdated <= 1000) return; // 変わっていない

  var name = file.getName();
  var copy = file.makeCopy(name, dest);
  if (hasCopy) {
    // 前のコピーは消さずに「旧版」として残す
    try {
      DriveApp.getFileById(rec.mirrorId).setName(name + '（旧版 ' +
        Utilities.formatDate(new Date(rec.srcUpdated), DM_TZ, 'yyyy-MM-dd') + '）');
    } catch (ignore) {} // ミラー側で見つからなくても、新しいコピーはできている
  }
  ctx.counts[hasCopy ? 'updated' : 'copied']++;
  writeLedger_(ctx, key, [job.name, file.getId(), copy.getId(), 'ファイル', joinPath_(path, name),
    new Date(updated), new Date(), DM_OK, '']);
}

/** ミラー側のフォルダIDを返す（なければ作る） */
function ensureMirrorFolder_(ctx, job, sub, dest, subPath) {
  var key = job.name + '|' + sub.getId();
  var rec = ctx.ledger[key];
  if (rec && rec.status === DM_OK && rec.mirrorId) return rec.mirrorId;
  var created = dest.createFolder(sub.getName());
  ctx.counts.folders++;
  writeLedger_(ctx, key, [job.name, sub.getId(), created.getId(), 'フォルダ', subPath,
    sub.getLastUpdated(), new Date(), DM_OK, '']);
  return created.getId();
}

// ---- 台帳 ----

function openLedger_(cfg) {
  var id = cfg.props.getProperty('LEDGER_ID');
  var ss;
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    // 台帳は実行アカウントのマイドライブに作る（共有ドライブに置くと社員が触れてしまうため）
    ss = SpreadsheetApp.create(DM_LEDGER_NAME);
    cfg.props.setProperty('LEDGER_ID', ss.getId());
  }
  ensureSheet_(ss, DM_SHEET_LEDGER, DM_LEDGER_HEADER);
  ensureSheet_(ss, DM_SHEET_QUEUE, DM_QUEUE_HEADER);
  ensureSheet_(ss, DM_SHEET_RUNS, DM_RUNS_HEADER);
  return ss;
}

function ensureSheet_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    // 新規作成した直後の空シートがあれば、それを使う
    var blank = ss.getSheets().filter(function (s) {
      return s.getLastRow() === 0 && [DM_SHEET_LEDGER, DM_SHEET_QUEUE, DM_SHEET_RUNS].indexOf(s.getName()) === -1;
    })[0];
    sh = blank ? blank.setName(name) : ss.insertSheet(name);
  }
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function loadLedger_(ss) {
  var sh = ss.getSheetByName(DM_SHEET_LEDGER);
  var last = sh.getLastRow();
  var map = {};
  if (last < 2) return map;
  var vals = sh.getRange(2, 1, last - 1, DM_LEDGER_HEADER.length).getValues();
  vals.forEach(function (v, i) {
    map[v[0] + '|' + v[1]] = {
      row: i + 2,
      mirrorId: String(v[2]),
      srcUpdated: v[5] instanceof Date ? v[5].getTime() : 0,
      status: String(v[7])
    };
  });
  return map;
}

function writeLedger_(ctx, key, values) {
  var sh = ctx.ledgerSheet;
  var rec = ctx.ledger[key];
  if (rec) {
    sh.getRange(rec.row, 1, 1, values.length).setValues([values]);
  } else {
    sh.appendRow(values);
    rec = { row: sh.getLastRow() };
  }
  rec.mirrorId = String(values[2]);
  rec.srcUpdated = values[5] instanceof Date ? values[5].getTime() : 0;
  rec.status = values[7];
  ctx.ledger[key] = rec;
}

/** コピー済みの行は残したまま（前のコピーは有効）メモだけ付け、未コピーならエラー行を作る */
function recordError_(ctx, job, id, path, kind, message) {
  ctx.counts.errors++;
  var key = job.name + '|' + id;
  var rec = ctx.ledger[key];
  var memo = String(message).slice(0, 200);
  if (rec && rec.status === DM_OK) {
    ctx.ledgerSheet.getRange(rec.row, 9).setValue('更新分のコピーに失敗：' + memo);
  } else {
    writeLedger_(ctx, key, [job.name, id, '', kind, path, '', new Date(), DM_NG, memo]);
  }
}

// ---- 設定・小物 ----

function loadConfig_() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty('MIRROR_JOBS');
  if (!raw) throw new Error('スクリプトプロパティ MIRROR_JOBS が未設定です（docs/drive-mirror-setup.md 参照）');
  var jobs = JSON.parse(raw);
  var byName = {};
  jobs.forEach(function (job) {
    if (!job.name || !job.source || !job.dest) {
      throw new Error('MIRROR_JOBS の各ジョブには name・source・dest が必要です');
    }
    job.excludeIds = {};
    (job.exclude || []).forEach(function (id) { job.excludeIds[id] = true; });
    byName[job.name] = job;
  });
  var keywords = (props.getProperty('EXCLUDE_KEYWORDS') || DM_DEFAULT_EXCLUDE_KEYWORDS)
    .split(',').map(function (s) { return s.trim(); }).filter(String);
  return { props: props, jobs: jobs, jobsByName: byName, keywords: keywords,
    reportTo: props.getProperty('REPORT_TO') || '' };
}

function newContext_(cfg, ss, state, started) {
  var ctx = {
    cfg: cfg,
    ss: ss,
    counts: state.counts || zeroCounts_(),
    ledgerSheet: ss.getSheetByName(DM_SHEET_LEDGER),
    ledger: loadLedger_(ss),
    stopNow: false
  };
  ctx.timeUp = function () { return ctx.stopNow || Date.now() - started > DM_MAX_RUN_MS; };
  return ctx;
}

function isExcluded_(cfg, job, item) {
  if (job.excludeIds[item.getId()]) return true;
  var name = item.getName();
  return cfg.keywords.some(function (k) { return name.indexOf(k) !== -1; });
}

function isQuotaError_(err) {
  return /too many times|limit exceeded|rate limit|quota/i.test(String(err && err.message));
}

function joinPath_(path, name) {
  return path ? path + '/' + name : name;
}

function zeroCounts_() {
  return { copied: 0, updated: 0, folders: 0, excluded: 0, errors: 0 };
}

function saveState_(cfg, state) {
  cfg.props.setProperty('MIRROR_STATE', JSON.stringify(state));
}

function deleteMirrorTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runMirror') ScriptApp.deleteTrigger(t);
  });
}
