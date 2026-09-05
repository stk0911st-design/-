/**
 * 不動産株 値上がり率TOP3 日次メール
 *
 * 東証33業種区分「不動産業」の上場銘柄について、その日の値上がり率が高い上位3社を
 * 毎日 21:00（JST）にメール送信します。
 *
 * 株価はスプレッドシート上の GOOGLEFINANCE 関数から取得します。
 * 外部APIキーや株価サイトのスクレイピングは不要で、Google内部だけで完結します。
 *
 * 宛先などの情報はスクリプトプロパティで管理し、このファイルには持ちません。
 *
 * 主な関数:
 *   initUniverseSheet()            銘柄マスタを初期リストで作成する（最初に1回）
 *   importUniverseFromJpx()        JPXの上場銘柄一覧から不動産業の全銘柄を取り込む（推奨）
 *   refreshUniverseNames()         銘柄マスタの銘柄名を GOOGLEFINANCE で埋め直す（コード確認用）
 *   previewRealEstateTop3()        送信せずに下書きを作成して内容を確認する
 *   sendRealEstateTop3()           集計してメール送信する（トリガーから呼ばれる）
 *   setupRealEstateTop3Trigger()   毎日21時のトリガーを設定する
 */

// ---- 設定（スクリプトプロパティのキー） --------------------------------
var RE_PROP_RECIPIENT = 'RE_TOP3_RECIPIENT';   // 宛先。カンマ区切りで複数可（必須）
var RE_PROP_CC = 'RE_TOP3_CC';                 // CC。省略可
var RE_PROP_MIN_VOLUME = 'RE_TOP3_MIN_VOLUME'; // 出来高の下限。省略時は0（＝出来高0の銘柄だけ除外）
var RE_PROP_LAST_SENT = 'RE_TOP3_LAST_SENT_DATE'; // 最後に送信した取引日。二重送信の防止に使う

// ---- 定数 --------------------------------------------------------------
var RE_SHEET_UNIVERSE = '銘柄マスタ';
var RE_SHEET_CALC = '_株価計算用';
var RE_TOP_N = 3;
var RE_BENCHMARK_CODE = '8801'; // 最終取引日の判定に使う代表銘柄（三井不動産）
var RE_TZ = 'Asia/Tokyo';
var RE_TARGET_SECTOR = '不動産業';
var RE_JPX_LIST_URL =
  'https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls';

/**
 * 銘柄マスタの初期リスト。
 * JPX取り込み（importUniverseFromJpx）を実行するまでの暫定リストで、
 * 東証「不動産業」の全銘柄ではありません。恒久運用ではJPX取り込みを使ってください。
 */
var RE_SEED_CODES = [
  '2337', '3003', '3230', '3231', '3241', '3242', '3244', '3245', '3246', '3248',
  '3252', '3254', '3261', '3276', '3277', '3284', '3288', '3289', '3291', '3294',
  '3299', '3300', '3457', '3458', '3465', '3475', '3482', '3484', '3486', '3491',
  '3496', '3498', '8801', '8802', '8803', '8804', '8830', '8841', '8842', '8844',
  '8848', '8850', '8860', '8864', '8871', '8877', '8892'
];

// =======================================================================
// メール送信
// =======================================================================

/** 集計してメールを送信する（時間主導トリガーの入口）。 */
function sendRealEstateTop3() {
  var props = PropertiesService.getScriptProperties();
  var to = (props.getProperty(RE_PROP_RECIPIENT) || '').trim();
  if (!to) {
    throw new Error(
      'スクリプトプロパティ ' + RE_PROP_RECIPIENT + ' に宛先メールアドレスを設定してください。');
  }

  var report = buildRealEstateTop3_();
  if (!report) {
    // 非取引日、または当日分をすでに送信済み。何もしない。
    return;
  }

  var options = { htmlBody: report.htmlBody };
  var cc = (props.getProperty(RE_PROP_CC) || '').trim();
  if (cc) options.cc = cc;

  GmailApp.sendEmail(to, report.subject, report.textBody, options);
  props.setProperty(RE_PROP_LAST_SENT, report.dataDate);
}

/** 送信せずにGmailの下書きを作成する（内容確認用）。 */
function previewRealEstateTop3() {
  var props = PropertiesService.getScriptProperties();
  var to = (props.getProperty(RE_PROP_RECIPIENT) || '').trim();
  var report = buildRealEstateTop3_({ ignoreLastSent: true });
  if (!report) {
    Logger.log('直近の取引日データが取得できませんでした。');
    return;
  }
  GmailApp.createDraft(to, '[下書き] ' + report.subject, report.textBody, {
    htmlBody: report.htmlBody
  });
  Logger.log(report.textBody);
}

// =======================================================================
// 集計
// =======================================================================

/**
 * 値上がり率上位を集計してメール本文を組み立てる。
 * 送信すべきでない場合（非取引日／送信済み）は null を返す。
 */
function buildRealEstateTop3_(opts) {
  opts = opts || {};
  var universe = readUniverse_();
  if (!universe.rows.length) {
    throw new Error(
      '「' + RE_SHEET_UNIVERSE + '」シートに銘柄がありません。' +
      'initUniverseSheet() または importUniverseFromJpx() を先に実行してください。');
  }

  var market = fetchMarketData_(universe.rows.map(function (r) { return r.code; }));

  var dataDate = market.latestTradingDate;
  if (!dataDate) {
    Logger.log('最終取引日を判定できませんでした。処理を中止します。');
    return null;
  }

  var props = PropertiesService.getScriptProperties();
  if (!opts.ignoreLastSent && dataDate === props.getProperty(RE_PROP_LAST_SENT)) {
    // 土日祝など、前回送信した取引日から更新がない日は送らない。
    Logger.log('取引日 ' + dataDate + ' は送信済みのためスキップします。');
    return null;
  }

  var minVolume = Number(props.getProperty(RE_PROP_MIN_VOLUME) || 0);
  var nameByCode = {};
  universe.rows.forEach(function (r) { nameByCode[r.code] = r.name; });

  var evaluated = [];
  var skipped = 0;
  market.quotes.forEach(function (q) {
    var price = Number(q.price);
    var prev = Number(q.prevClose);
    var volume = q.volume === '' ? null : Number(q.volume);
    if (!isFinite(price) || !isFinite(prev) || price <= 0 || prev <= 0) { skipped++; return; }
    if (volume !== null && isFinite(volume) && volume <= minVolume) { skipped++; return; }
    evaluated.push({
      code: q.code,
      name: nameByCode[q.code] || q.name || q.code,
      price: price,
      prevClose: prev,
      diff: price - prev,
      rate: (price - prev) / prev * 100
    });
  });

  if (!evaluated.length) {
    Logger.log('株価を取得できた銘柄がありませんでした。');
    return null;
  }

  evaluated.sort(function (a, b) { return b.rate - a.rate; });
  var top = evaluated.slice(0, RE_TOP_N);

  var summary = {
    dataDate: dataDate,
    universeCount: universe.rows.length,
    evaluatedCount: evaluated.length,
    skippedCount: skipped,
    minVolume: minVolume,
    isSeedUniverse: universe.isSeed
  };

  return {
    dataDate: dataDate,
    subject: buildSubject_(dataDate, top),
    textBody: buildTextBody_(top, summary),
    htmlBody: buildHtmlBody_(top, summary)
  };
}

/** 銘柄マスタを読み込む。 */
function readUniverse_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(RE_SHEET_UNIVERSE);
  if (!sh || sh.getLastRow() < 2) return { rows: [], isSeed: false };

  var values = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
  var rows = [];
  var seen = {};
  values.forEach(function (v) {
    var code = String(v[0]).trim();
    if (!code) return;
    if (seen[code]) return;
    seen[code] = true;
    rows.push({ code: code, name: String(v[1] || '').trim(), market: String(v[2] || '').trim() });
  });

  var isSeed = sh.getRange('E1').getValue() === 'SEED';
  return { rows: rows, isSeed: isSeed };
}

/**
 * GOOGLEFINANCE で株価と最終取引日を取得する。
 * 計算用シートに数式を書き込み、評価が終わるのを待ってから値を読み取る。
 */
function fetchMarketData_(codes) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(RE_SHEET_CALC);
  if (!sh) {
    sh = ss.insertSheet(RE_SHEET_CALC);
    sh.hideSheet();
  }
  sh.clear();

  var rows = codes.map(function (code) {
    var t = '"TYO:' + code + '"';
    return [
      "'" + code,
      '=IFERROR(GOOGLEFINANCE(' + t + ',"name"),"")',
      '=IFERROR(GOOGLEFINANCE(' + t + ',"price"),"")',
      '=IFERROR(GOOGLEFINANCE(' + t + ',"closeyest"),"")',
      '=IFERROR(GOOGLEFINANCE(' + t + ',"volume"),"")'
    ];
  });
  sh.getRange(1, 1, rows.length, 5).setValues(rows);

  // 最終取引日の判定用に、代表銘柄の直近終値履歴を取得する。
  sh.getRange('H1').setFormula(
    '=IFERROR(GOOGLEFINANCE("TYO:' + RE_BENCHMARK_CODE + '","close",TODAY()-14,TODAY()),"")');

  SpreadsheetApp.flush();
  waitForGoogleFinance_(sh, rows.length);

  var values = sh.getRange(1, 1, rows.length, 5).getValues();
  var history = sh.getRange(1, 8, 25, 2).getValues();

  var quotes = values.map(function (v) {
    return {
      code: String(v[0]).trim(),
      name: String(v[1] || '').trim(),
      price: v[2],
      prevClose: v[3],
      volume: v[4]
    };
  });

  return {
    quotes: quotes,
    latestTradingDate: latestTradingDateFrom_(history)
  };
}

/** GOOGLEFINANCE の "Loading..." が消えるまで待つ。 */
function waitForGoogleFinance_(sh, numRows) {
  var deadline = Date.now() + 120 * 1000;
  while (Date.now() < deadline) {
    SpreadsheetApp.flush();
    var priceCells = sh.getRange(1, 3, numRows, 1).getDisplayValues();
    var histCells = sh.getRange(1, 8, 25, 2).getDisplayValues();
    var pending = priceCells.concat(histCells).some(function (row) {
      return row.some(function (cell) { return String(cell).indexOf('Loading') >= 0; });
    });
    if (!pending) return;
    Utilities.sleep(3000);
  }
  Logger.log('GOOGLEFINANCE の計算完了を待ちきれませんでした。取得できた分で集計します。');
}

/** 終値履歴の配列から最終取引日（yyyy-MM-dd）を取り出す。 */
function latestTradingDateFrom_(history) {
  var latest = null;
  history.forEach(function (row) {
    var d = row[0];
    if (d instanceof Date && !isNaN(d.getTime())) {
      if (!latest || d.getTime() > latest.getTime()) latest = d;
    }
  });
  return latest ? Utilities.formatDate(latest, RE_TZ, 'yyyy-MM-dd') : null;
}

// =======================================================================
// 本文の組み立て
// =======================================================================

function buildSubject_(dataDate, top) {
  var label = formatDateLabel_(dataDate);
  var head = top.length ? top[0].name + ' ' + formatRate_(top[0].rate) : '';
  return '【不動産株 値上がり率TOP3】' + label + '　' + head;
}

function buildTextBody_(top, summary) {
  var lines = [];
  lines.push('小林様');
  lines.push('');
  lines.push('お世話になっております。');
  lines.push(formatDateLabel_(summary.dataDate) +
    ' の東証「不動産業」上場銘柄のうち、値上がり率が高い上位' + RE_TOP_N + '社をお届けします。');
  lines.push('');

  top.forEach(function (s, i) {
    lines.push((i + 1) + '位　' + s.name + '（' + s.code + '）　' + formatRate_(s.rate));
    lines.push('　　終値 ' + formatPrice_(s.price) + '円' +
      '（前日終値 ' + formatPrice_(s.prevClose) + '円 / 前日比 ' + formatDiff_(s.diff) + '円）');
    lines.push('');
  });

  lines.push('■ 集計条件');
  lines.push('・対象：東証33業種区分「' + RE_TARGET_SECTOR + '」の上場銘柄');
  lines.push('・対象銘柄数：' + summary.universeCount + '社' +
    '（うち株価を取得できたもの ' + summary.evaluatedCount + '社' +
    (summary.skippedCount ? ' / 除外 ' + summary.skippedCount + '社' : '') + '）');
  lines.push('・基準：' + formatDateLabel_(summary.dataDate) + ' の終値と前営業日終値の比較');
  lines.push('・除外：出来高が' + summary.minVolume + '以下の銘柄、株価を取得できなかった銘柄');
  lines.push('・出所：GOOGLEFINANCE（Google Finance）');
  if (summary.isSeedUniverse) {
    lines.push('');
    lines.push('※ 銘柄マスタが初期リストのままです。importUniverseFromJpx() を実行すると');
    lines.push('　 東証「' + RE_TARGET_SECTOR + '」の全銘柄が対象になります。');
  }
  lines.push('');
  lines.push('※ 本メールは自動送信です。投資判断はご自身の責任でお願いいたします。');

  return lines.join('\n');
}

function buildHtmlBody_(top, summary) {
  var h = [];
  h.push('<div style="font-family:\'Hiragino Sans\',\'Yu Gothic\',sans-serif;font-size:14px;color:#222;line-height:1.7">');
  h.push('<p>小林様</p>');
  h.push('<p>お世話になっております。<br>' + escapeHtml_(formatDateLabel_(summary.dataDate)) +
    ' の東証「' + RE_TARGET_SECTOR + '」上場銘柄のうち、値上がり率が高い上位' + RE_TOP_N + '社をお届けします。</p>');

  h.push('<table style="border-collapse:collapse;margin:16px 0">');
  h.push('<tr style="background:#f2f4f7">' +
    ['順位', '銘柄', 'コード', '終値', '前日比', '騰落率'].map(function (t) {
      return '<th style="border:1px solid #d6dae0;padding:6px 10px;text-align:left;white-space:nowrap">' + t + '</th>';
    }).join('') + '</tr>');

  top.forEach(function (s, i) {
    h.push('<tr>' +
      td_(String(i + 1) + '位') +
      td_(escapeHtml_(s.name)) +
      td_(s.code) +
      td_(formatPrice_(s.price) + '円', 'right') +
      td_(formatDiff_(s.diff) + '円', 'right') +
      '<td style="border:1px solid #d6dae0;padding:6px 10px;text-align:right;white-space:nowrap;color:#c00;font-weight:bold">' +
      formatRate_(s.rate) + '</td>' +
      '</tr>');
  });
  h.push('</table>');

  h.push('<p style="font-size:12px;color:#555">');
  h.push('■ 集計条件<br>');
  h.push('・対象：東証33業種区分「' + RE_TARGET_SECTOR + '」の上場銘柄<br>');
  h.push('・対象銘柄数：' + summary.universeCount + '社（うち株価を取得できたもの ' +
    summary.evaluatedCount + '社' +
    (summary.skippedCount ? ' / 除外 ' + summary.skippedCount + '社' : '') + '）<br>');
  h.push('・基準：' + escapeHtml_(formatDateLabel_(summary.dataDate)) + ' の終値と前営業日終値の比較<br>');
  h.push('・除外：出来高が' + summary.minVolume + '以下の銘柄、株価を取得できなかった銘柄<br>');
  h.push('・出所：GOOGLEFINANCE（Google Finance）');
  h.push('</p>');

  if (summary.isSeedUniverse) {
    h.push('<p style="font-size:12px;color:#a15c00">※ 銘柄マスタが初期リストのままです。' +
      'importUniverseFromJpx() を実行すると東証「' + RE_TARGET_SECTOR + '」の全銘柄が対象になります。</p>');
  }
  h.push('<p style="font-size:12px;color:#888">※ 本メールは自動送信です。投資判断はご自身の責任でお願いいたします。</p>');
  h.push('</div>');
  return h.join('');
}

function td_(value, align) {
  return '<td style="border:1px solid #d6dae0;padding:6px 10px;white-space:nowrap;text-align:' +
    (align || 'left') + '">' + value + '</td>';
}

function formatDateLabel_(dataDate) {
  var parts = dataDate.split('-');
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  var week = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return Number(parts[0]) + '年' + Number(parts[1]) + '月' + Number(parts[2]) + '日(' + week + ')';
}

function formatRate_(rate) {
  return (rate >= 0 ? '+' : '') + rate.toFixed(2) + '%';
}

function formatDiff_(diff) {
  return (diff >= 0 ? '+' : '') + formatPrice_(diff);
}

function formatPrice_(value) {
  var rounded = Math.round(value * 10) / 10;
  return rounded.toLocaleString('ja-JP', { maximumFractionDigits: 1 });
}

function escapeHtml_(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// =======================================================================
// 銘柄マスタの整備
// =======================================================================

/** 初期リストで銘柄マスタを作成する。 */
function initUniverseSheet() {
  var rows = RE_SEED_CODES.map(function (code) { return [code, '', ''] ; });
  writeUniverse_(rows, true);
  refreshUniverseNames();
  Logger.log('初期リスト ' + rows.length + '銘柄で「' + RE_SHEET_UNIVERSE + '」を作成しました。');
}

/**
 * JPXの上場銘柄一覧から、33業種区分「不動産業」の全銘柄を取り込む。
 * Apps Scriptの「サービス」でDrive APIを追加しておく必要があります。
 */
function importUniverseFromJpx() {
  var res = UrlFetchApp.fetch(RE_JPX_LIST_URL, { muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() !== 200) {
    throw new Error('JPXの上場銘柄一覧を取得できませんでした（HTTP ' + res.getResponseCode() + '）。');
  }

  var fileId = convertToSheet_(res.getBlob().setName('jpx_data_j.xls'));
  try {
    var sheet = SpreadsheetApp.openById(fileId).getSheets()[0];
    var values = sheet.getDataRange().getValues();
    var header = values[0].map(function (v) { return String(v).trim(); });
    var iCode = header.indexOf('コード');
    var iName = header.indexOf('銘柄名');
    var iMarket = header.indexOf('市場・商品区分');
    var iSector = header.indexOf('33業種区分');
    if (iCode < 0 || iName < 0 || iSector < 0) {
      throw new Error('JPXの一覧の列構成が想定と異なります（コード／銘柄名／33業種区分が見つかりません）。');
    }

    var rows = [];
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][iSector]).trim() !== RE_TARGET_SECTOR) continue;
      var code = String(values[i][iCode]).trim();
      if (!/^[0-9A-Z]{4}$/.test(code)) continue;
      rows.push([
        code,
        String(values[i][iName]).trim(),
        iMarket >= 0 ? String(values[i][iMarket]).trim() : ''
      ]);
    }
    if (!rows.length) throw new Error('「' + RE_TARGET_SECTOR + '」の銘柄が1件も見つかりませんでした。');

    rows.sort(function (a, b) { return a[0] < b[0] ? -1 : 1; });
    writeUniverse_(rows, false);
    Logger.log('JPXの一覧から ' + rows.length + '銘柄を取り込みました。');
  } finally {
    try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) { /* 後始末なので握りつぶす */ }
  }
}

/** xls形式のBlobをGoogleスプレッドシートに変換し、そのファイルIDを返す。 */
function convertToSheet_(blob) {
  if (typeof Drive === 'undefined') {
    throw new Error('Apps Scriptの「サービス」からDrive APIを追加してください（xlsの変換に使います）。');
  }
  if (Drive.Files && typeof Drive.Files.insert === 'function') {
    // 拡張Driveサービス v2
    return Drive.Files.insert(
      { title: 'jpx_temp_' + Date.now(), mimeType: MimeType.GOOGLE_SHEETS },
      blob, { convert: true }).id;
  }
  // 拡張Driveサービス v3
  return Drive.Files.create(
    { name: 'jpx_temp_' + Date.now(), mimeType: MimeType.GOOGLE_SHEETS }, blob).id;
}

/** 銘柄マスタの銘柄名を GOOGLEFINANCE で埋め直す（コードの誤りの確認に使う）。 */
function refreshUniverseNames() {
  var universe = readUniverse_();
  if (!universe.rows.length) throw new Error('「' + RE_SHEET_UNIVERSE + '」シートに銘柄がありません。');

  var market = fetchMarketData_(universe.rows.map(function (r) { return r.code; }));
  var sh = SpreadsheetApp.getActive().getSheetByName(RE_SHEET_UNIVERSE);
  var unknown = [];

  var names = market.quotes.map(function (q, i) {
    var existing = universe.rows[i].name;
    if (!q.name) unknown.push(q.code);
    return [q.name || existing];
  });
  sh.getRange(2, 2, names.length, 1).setValues(names);

  if (unknown.length) {
    Logger.log('株価を取得できなかったコード（要確認）: ' + unknown.join(', '));
  } else {
    Logger.log('全 ' + names.length + '銘柄の銘柄名を確認しました。');
  }
}

function writeUniverse_(rows, isSeed) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(RE_SHEET_UNIVERSE) || ss.insertSheet(RE_SHEET_UNIVERSE);
  sh.clear();
  sh.getRange(1, 1, 1, 3).setValues([['コード', '銘柄名', '市場区分']]).setFontWeight('bold');
  sh.getRange(2, 1, rows.length, 3).setValues(rows);
  sh.getRange(2, 1, rows.length, 1).setNumberFormat('@'); // コードは文字列として扱う
  sh.getRange('E1').setValue(isSeed ? 'SEED' : 'JPX');
  sh.hideColumns(5);
  sh.setFrozenRows(1);
}

// =======================================================================
// トリガー
// =======================================================================

/**
 * 毎日21時（JST）のトリガーを設定する。
 * GASの時間主導トリガーは指定時刻ちょうどではなく前後に幅があるため、
 * 21時台と22時台の2本を登録し、同じ取引日を二重送信しないよう送信済み判定で制御します。
 */
function setupRealEstateTop3Trigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendRealEstateTop3') ScriptApp.deleteTrigger(t);
  });
  [21, 22].forEach(function (hour) {
    ScriptApp.newTrigger('sendRealEstateTop3')
      .timeBased()
      .everyDays(1)
      .atHour(hour)
      .nearMinute(0)
      .inTimezone(RE_TZ)
      .create();
  });
  Logger.log('毎日21時・22時（JST）のトリガーを設定しました。');
}
