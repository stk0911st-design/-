/**
 * 不動産株 値上がり率TOP3 日次メール
 *
 * 東証33業種区分「不動産業」の上場銘柄について、その日の値上がり率が高い上位3社を
 * 毎日 21:00（JST）にメール送信します。
 *
 * 株価は UrlFetchApp で stooq から取得し、取得できなかった銘柄だけ Yahoo Finance で補います。
 * Apps Script は Google のサーバー上で動くため、APIキーなしでそのまま取得できます。
 * （GOOGLEFINANCE 関数は東証銘柄に対応していないため使いません）
 *
 * 宛先などの情報はスクリプトプロパティで管理し、このファイルには持ちません。
 *
 * 主な関数:
 *   initUniverseSheet()            銘柄マスタを初期リストで作成する（最初に1回）
 *   importUniverseFromJpx()        JPXの上場銘柄一覧から不動産業の全銘柄を取り込む（推奨）
 *   validateUniverse()             銘柄マスタの各コードで株価が取れるか確認する
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
var RE_TOP_N = 3;
var RE_TZ = 'Asia/Tokyo';
var RE_FETCH_BATCH = 20; // UrlFetchApp.fetchAll の1回あたりの件数
var RE_TARGET_SECTOR = '不動産業';
var RE_JPX_LIST_URL =
  'https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls';

/**
 * 銘柄マスタの初期リスト。
 * JPX取り込み（importUniverseFromJpx）を実行するまでの暫定リストで、
 * 東証「不動産業」の全銘柄ではありません。恒久運用ではJPX取り込みを使ってください。
 */
var RE_SEED_STOCKS = [
  ['2337', 'いちご'], ['3003', 'ヒューリック'], ['3230', 'スター・マイカ・ホールディングス'],
  ['3231', '野村不動産ホールディングス'], ['3241', 'ウィル'], ['3242', 'アーバネットコーポレーション'],
  ['3244', 'サムティ'], ['3245', 'ディア・ライフ'], ['3246', 'コーセーアールイー'],
  ['3248', 'アールエイジ'], ['3252', '地主'], ['3254', 'プレサンスコーポレーション'],
  ['3261', 'グランディーズ'], ['3276', '日本管理センター'], ['3277', 'サンセイランディック'],
  ['3284', 'フージャースホールディングス'], ['3288', 'オープンハウスグループ'],
  ['3289', '東急不動産ホールディングス'], ['3291', '飯田グループホールディングス'],
  ['3294', 'イーグランド'], ['3299', 'ムゲンエステート'], ['3300', 'AMBITION DX HOLDINGS'],
  ['3457', 'And Doo ホールディングス'], ['3458', 'シーアールイー'], ['3465', 'ケイアイスター不動産'],
  ['3475', 'グッドコムアセット'], ['3482', 'ロードスターキャピタル'], ['3484', 'テンポイノベーション'],
  ['3486', 'グローバル・リンク・マネジメント'], ['3491', 'GA technologies'], ['3496', 'アズーム'],
  ['3498', '霞ヶ関キャピタル'], ['8801', '三井不動産'], ['8802', '三菱地所'], ['8803', '平和不動産'],
  ['8804', '東京建物'], ['8830', '住友不動産'], ['8841', 'テーオーシー'], ['8842', '東京楽天地'],
  ['8844', 'コスモスイニシア'], ['8848', 'レオパレス21'], ['8850', 'スターツコーポレーション'],
  ['8860', 'フジ住宅'], ['8864', '空港施設'], ['8871', 'ゴールドクレスト'], ['8877', 'エスリード'],
  ['8892', '日本エスコン']
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

  // 「値上がり率」なので、値下がりした銘柄は上位に入れない。
  // 値上がりが3社に満たない日は、その社数だけを載せる。
  var gainers = evaluated.filter(function (s) { return s.rate > 0; });
  var top = gainers.slice(0, RE_TOP_N);

  var summary = {
    dataDate: dataDate,
    universeCount: universe.rows.length,
    evaluatedCount: evaluated.length,
    skippedCount: skipped,
    gainerCount: gainers.length,
    best: evaluated[0], // 値上がり銘柄が1社もない日の参考用
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
 * 各銘柄の終値・前営業日終値・出来高を取得する。
 *
 * 主データ源は stooq（日足CSV）。取得できなかった銘柄だけ Yahoo Finance（JSON）で補う。
 * 最終取引日を全銘柄の最大日付から決め、その日のデータがない銘柄は集計から外す。
 */
function fetchMarketData_(codes) {
  var byCode = fetchFromStooq_(codes);

  var missing = codes.filter(function (code) { return !byCode[code]; });
  if (missing.length) {
    Logger.log('stooqで取得できなかった ' + missing.length + '銘柄を Yahoo Finance で再取得します。');
    var fallback = fetchFromYahoo_(missing);
    Object.keys(fallback).forEach(function (code) { byCode[code] = fallback[code]; });
  }

  var latest = null;
  Object.keys(byCode).forEach(function (code) {
    var d = byCode[code].date;
    if (d && (!latest || d > latest)) latest = d;
  });

  var quotes = codes.map(function (code) {
    var q = byCode[code];
    // 最終取引日のデータがない銘柄（売買停止・上場廃止など）は空にして集計から外す
    if (!q || q.date !== latest) {
      return { code: code, name: '', price: '', prevClose: '', volume: '' };
    }
    return {
      code: code,
      name: '',
      price: q.close,
      prevClose: q.prevClose,
      volume: (q.volume === null || q.volume === undefined) ? '' : q.volume
    };
  });

  var got = quotes.filter(function (q) { return q.price !== ''; }).length;
  Logger.log('株価取得: ' + got + '/' + codes.length + '銘柄　最終取引日: ' + latest);

  return { quotes: quotes, latestTradingDate: latest };
}

/** stooq の日足CSVから取得する。 */
function fetchFromStooq_(codes) {
  var now = new Date();
  var d2 = Utilities.formatDate(now, RE_TZ, 'yyyyMMdd');
  var d1 = Utilities.formatDate(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), RE_TZ, 'yyyyMMdd');

  return fetchInBatches_(codes, function (code) {
    return {
      url: 'https://stooq.com/q/d/l/?s=' + code + '.jp&d1=' + d1 + '&d2=' + d2 + '&i=d',
      muteHttpExceptions: true
    };
  }, parseStooqCsv_, 'stooq');
}

/** Yahoo Finance のチャートAPI（JSON）から取得する。 */
function fetchFromYahoo_(codes) {
  return fetchInBatches_(codes, function (code) {
    return {
      url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + code +
        '.T?range=1mo&interval=1d',
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    };
  }, parseYahooChart_, 'Yahoo Finance');
}

/** リクエストをまとめて投げ、レスポンスを parser で解釈する共通処理。 */
function fetchInBatches_(codes, buildRequest, parser, sourceName) {
  var out = {};
  for (var i = 0; i < codes.length; i += RE_FETCH_BATCH) {
    var batch = codes.slice(i, i + RE_FETCH_BATCH);
    var responses;
    try {
      responses = UrlFetchApp.fetchAll(batch.map(buildRequest));
    } catch (e) {
      Logger.log(sourceName + ' の取得に失敗しました: ' + e);
      continue;
    }
    responses.forEach(function (res, j) {
      var body = res.getResponseCode() === 200 ? res.getContentText() : '';
      var parsed = parser(body);
      if (parsed) out[batch[j]] = parsed;
    });
    if (i + RE_FETCH_BATCH < codes.length) Utilities.sleep(500);
  }
  return out;
}

/**
 * stooq の日足CSVを解釈する。
 * 形式: Date,Open,High,Low,Close,Volume（日付の昇順）
 */
function parseStooqCsv_(text) {
  if (!text || text.indexOf('Date,') !== 0) return null;

  var lines = text.replace(/\r/g, '').split('\n').filter(function (l) { return l.trim(); });
  if (lines.length < 3) return null; // ヘッダー＋2営業日分が最低限必要

  var last = lines[lines.length - 1].split(',');
  var prev = lines[lines.length - 2].split(',');
  var close = Number(last[4]);
  var prevClose = Number(prev[4]);
  var volume = Number(last[5]);
  if (!isFinite(close) || !isFinite(prevClose) || close <= 0 || prevClose <= 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(last[0])) return null;

  return {
    date: last[0],
    close: close,
    prevClose: prevClose,
    volume: isFinite(volume) ? volume : null
  };
}

/** Yahoo Finance のチャートAPIのJSONを解釈する。 */
function parseYahooChart_(text) {
  if (!text) return null;

  var json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return null;
  }

  var result = json && json.chart && json.chart.result && json.chart.result[0];
  var quote = result && result.indicators && result.indicators.quote && result.indicators.quote[0];
  if (!result || !result.timestamp || !quote) return null;

  var closes = quote.close || [];
  var volumes = quote.volume || [];
  var filled = [];
  for (var i = 0; i < closes.length; i++) {
    if (closes[i] !== null && closes[i] !== undefined) filled.push(i);
  }
  if (filled.length < 2) return null;

  var last = filled[filled.length - 1];
  var prev = filled[filled.length - 2];
  var volume = volumes[last];

  return {
    date: Utilities.formatDate(new Date(result.timestamp[last] * 1000), RE_TZ, 'yyyy-MM-dd'),
    close: Number(closes[last]),
    prevClose: Number(closes[prev]),
    volume: (volume === null || volume === undefined) ? null : Number(volume)
  };
}

// =======================================================================
// 本文の組み立て
// =======================================================================

function buildSubject_(dataDate, top) {
  var label = formatDateLabel_(dataDate);
  if (!top.length) return '【不動産株 値上がり率TOP3】' + label + '　値上がりした銘柄はありません';
  return '【不動産株 値上がり率TOP3】' + label + '　' + top[0].name + ' ' + formatRate_(top[0].rate);
}

function buildTextBody_(top, summary) {
  var lines = [];
  lines.push('小林様');
  lines.push('');
  lines.push('お世話になっております。');
  lines.push(formatDateLabel_(summary.dataDate) +
    ' の東証「不動産業」上場銘柄のうち、値上がり率が高い上位' + RE_TOP_N + '社をお届けします。');
  lines.push('');

  if (!top.length) {
    lines.push('本日は値上がりした銘柄がありませんでした。');
    if (summary.best) {
      lines.push('');
      lines.push('（参考）下落率が最も小さかった銘柄');
      lines.push('　　' + summary.best.name + '（' + summary.best.code + '）　' +
        formatRate_(summary.best.rate));
      lines.push('　　終値 ' + formatPrice_(summary.best.price) + '円' +
        '（前日終値 ' + formatPrice_(summary.best.prevClose) + '円 / 前日比 ' +
        formatDiff_(summary.best.diff) + '円）');
    }
    lines.push('');
  } else {
    if (top.length < RE_TOP_N) {
      lines.push('※ 本日値上がりした銘柄は' + summary.gainerCount + '社のみでした。');
      lines.push('');
    }
    top.forEach(function (s, i) {
      lines.push((i + 1) + '位　' + s.name + '（' + s.code + '）　' + formatRate_(s.rate));
      lines.push('　　終値 ' + formatPrice_(s.price) + '円' +
        '（前日終値 ' + formatPrice_(s.prevClose) + '円 / 前日比 ' + formatDiff_(s.diff) + '円）');
      lines.push('');
    });
  }

  lines.push('■ 集計条件');
  lines.push('・対象：東証33業種区分「' + RE_TARGET_SECTOR + '」の上場銘柄');
  lines.push('・対象銘柄数：' + summary.universeCount + '社' +
    '（うち株価を取得できたもの ' + summary.evaluatedCount + '社' +
    (summary.skippedCount ? ' / 除外 ' + summary.skippedCount + '社' : '') + '）');
  lines.push('・基準：' + formatDateLabel_(summary.dataDate) + ' の終値と前営業日終値の比較');
  lines.push('・除外：出来高が' + summary.minVolume + '以下の銘柄、株価を取得できなかった銘柄');
  lines.push('・出所：stooq（取得できない銘柄は Yahoo Finance で補完）');
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

  if (!top.length) {
    h.push('<p><strong>本日は値上がりした銘柄がありませんでした。</strong></p>');
    if (summary.best) {
      h.push('<p style="font-size:13px;color:#555">（参考）下落率が最も小さかった銘柄：' +
        escapeHtml_(summary.best.name) + '（' + summary.best.code + '）　' +
        formatRate_(summary.best.rate) + '　終値 ' + formatPrice_(summary.best.price) + '円</p>');
    }
  }
  if (top.length < RE_TOP_N && top.length > 0) {
    h.push('<p style="font-size:13px;color:#a15c00">※ 本日値上がりした銘柄は' +
      summary.gainerCount + '社のみでした。</p>');
  }
  if (top.length) {
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
  }

  h.push('<p style="font-size:12px;color:#555">');
  h.push('■ 集計条件<br>');
  h.push('・対象：東証33業種区分「' + RE_TARGET_SECTOR + '」の上場銘柄<br>');
  h.push('・対象銘柄数：' + summary.universeCount + '社（うち株価を取得できたもの ' +
    summary.evaluatedCount + '社' +
    (summary.skippedCount ? ' / 除外 ' + summary.skippedCount + '社' : '') + '）<br>');
  h.push('・基準：' + escapeHtml_(formatDateLabel_(summary.dataDate)) + ' の終値と前営業日終値の比較<br>');
  h.push('・除外：出来高が' + summary.minVolume + '以下の銘柄、株価を取得できなかった銘柄<br>');
  h.push('・出所：stooq（取得できない銘柄は Yahoo Finance で補完）');
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
  var rows = RE_SEED_STOCKS.map(function (s) { return [s[0], s[1], '']; });
  writeUniverse_(rows, true);
  Logger.log('初期リスト ' + rows.length + '銘柄で「' + RE_SHEET_UNIVERSE + '」を作成しました。' +
    ' 全銘柄を対象にするには importUniverseFromJpx を実行してください。');
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

/**
 * 銘柄マスタの各コードで株価が取れるかを確認する（コードの誤りの確認に使う）。
 * 取得できなかったコードを実行ログに出します。
 */
function validateUniverse() {
  var universe = readUniverse_();
  if (!universe.rows.length) throw new Error('「' + RE_SHEET_UNIVERSE + '」シートに銘柄がありません。');

  var market = fetchMarketData_(universe.rows.map(function (r) { return r.code; }));
  var unavailable = market.quotes
    .filter(function (q) { return q.price === ''; })
    .map(function (q) { return q.code; });

  if (unavailable.length) {
    Logger.log('株価を取得できなかったコード（要確認）: ' + unavailable.join(', '));
  } else {
    Logger.log('全 ' + universe.rows.length + '銘柄で株価を取得できました。');
  }
  return unavailable;
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
