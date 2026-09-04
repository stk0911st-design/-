/**
 * 東京23区 中古マンション 市況トラッカー
 *
 * 東日本レインズ「月例速報 Market Watch サマリーレポート」(PDF) を毎日チェックし、
 * 新しい公表があればスプレッドシートに追記したうえで、毎日18時に現況をメール送信する。
 *
 * データ粒度の前提（重要）:
 *   レインズ月例速報は「月次 × 東京都区部（23区まとめ）」が最小粒度で、
 *   23区の区別内訳は公表されていない。したがって本スクリプトも区別は出力しない。
 *
 * 想定トリガー: 時間主導型 / 日付ベース / 午後6時〜7時
 *
 * スクリプトプロパティ:
 *   RECIPIENT       送信先メールアドレス（必須）
 *   CC              CCアドレス（任意・カンマ区切り）
 *   SPREADSHEET_ID  蓄積先スプレッドシートID（コンテナバインドでない場合のみ必須）
 *   SAVE_RAW_TEXT   'true' のとき抽出元テキストを raw_text シートに保存（パーサ調整用）
 *
 * 事前に有効化が必要なサービス:
 *   Apps Script の「サービス」から Drive API（Advanced Drive Service, v3）を追加する。
 */

var TZ = 'Asia/Tokyo';

/** レインズ月例速報サマリーレポートのURLパターン。%s は YYYYMM。 */
var REINS_MW_URL = 'https://www.reins.or.jp/pdf/trend/mw/mw_%s_summary.pdf';

/** 遡って公表有無を確認する月数（当月を含む）。 */
var LOOKBACK_MONTHS = 4;

/** 抽出対象の地域。label は PDF 中の見出し文字列、aliases は表記ゆれ。 */
var REGIONS = [
  { key: '東京都区部', aliases: ['東京都区部', '都区部'] },
  // 「東京都」は「東京都区部」「東京都下」の前方一致になるため、直後の語で除外する
  { key: '東京都', aliases: ['東京都'], notFollowedBy: ['区部', '下', '市部'] },
  { key: '首都圏', aliases: ['首都圏'] }
];

var SHEET_MONTHLY = 'monthly_reins';
var SHEET_DAILY = 'daily_log';
var SHEET_RAW = 'raw_text';

var MONTHLY_HEADER = [
  '公表年月', '取得日時', '地域',
  '成約件数', '成約件数前年比(%)',
  '新規登録件数', '新規登録前年比(%)',
  '在庫件数', '在庫前年比(%)',
  '成約㎡単価(万円)', '成約価格(万円)',
  '出典URL', '抽出結果', '抽出値(生)'
];

var DAILY_HEADER = ['実行日時', '状態', '最新公表年月', '新規取込', '備考'];

/**
 * 見出し語の直後に並ぶ数値を、どの項目として解釈するかの既定順。
 * レインズのPDFレイアウトが想定と違った場合は、スクリプトプロパティ FIELD_ORDER に
 * カンマ区切りで並べ替えたものを設定すれば、コードを触らずに補正できる。
 * 使えるキー: contracts / contractsYoY / newListings / newListingsYoY /
 *             stock / stockYoY / unitPrice / price / skip
 */
var DEFAULT_FIELD_ORDER =
  'contracts,contractsYoY,newListings,newListingsYoY,stock,stockYoY,unitPrice,price';

function fieldOrder_() {
  var p = PropertiesService.getScriptProperties().getProperty('FIELD_ORDER');
  var raw = (p || DEFAULT_FIELD_ORDER).split(',');
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    out.push(raw[i].replace(/\s/g, ''));
  }
  return out;
}

/** 定期トリガーから呼ぶ本番用エントリポイント。 */
function sendMansionMarketMail() {
  run_(false);
}

/** 送信せずに文面をログ出力する確認用エントリポイント。 */
function previewMansionMarketMail() {
  run_(true);
}

/** 取り込みだけを行う（メール送信なし）。初回の遡り取得などに使う。 */
function ingestOnly() {
  var ss = openSpreadsheet_();
  var result = ingestLatest_(ss);
  Logger.log(JSON.stringify(result, null, 2));
}

function run_(isPreview) {
  var now = new Date();
  var ss = openSpreadsheet_();

  var ingest = ingestLatest_(ss);
  var rows = readMonthly_(ss);
  var subject = buildSubject_(now, rows);
  var html = buildHtml_(now, rows, ingest);

  appendDailyLog_(ss, now, ingest);

  if (isPreview) {
    Logger.log('件名: ' + subject);
    Logger.log(html);
    return;
  }

  var props = PropertiesService.getScriptProperties();
  var recipient = props.getProperty('RECIPIENT');
  if (!recipient) {
    throw new Error('スクリプトプロパティ RECIPIENT が未設定です。');
  }
  var options = { htmlBody: html, name: '中古マンション市況トラッカー' };
  var cc = props.getProperty('CC');
  if (cc) {
    options.cc = cc;
  }
  MailApp.sendEmail(recipient, subject, htmlToPlainText_(html), options);
  Logger.log('送信しました: ' + subject + ' → ' + recipient);
}

/* ------------------------------------------------------------------ *
 * 取り込み
 * ------------------------------------------------------------------ */

/**
 * 未取得の公表分があれば取り込む。既存行は書き換えず、追記のみ行う。
 * 戻り値: { added: [YYYYMM...], latest: YYYYMM|null, notes: [String...] }
 */
function ingestLatest_(ss) {
  var known = knownMonths_(ss);
  var added = [];
  var notes = [];
  var candidates = recentMonths_(new Date(), LOOKBACK_MONTHS);

  for (var i = 0; i < candidates.length; i++) {
    var ym = candidates[i];
    if (known[ym]) {
      continue;
    }
    var url = Utilities.formatString(REINS_MW_URL, ym);
    var blob = fetchPdf_(url);
    if (!blob) {
      continue; // 未公表。翌日以降に再挑戦する。
    }
    var text = '';
    try {
      text = pdfToText_(blob, ym);
    } catch (e) {
      notes.push(ym + ': PDFのテキスト変換に失敗（' + e.message + '）');
      continue;
    }
    if (shouldSaveRawText_()) {
      appendRawText_(ss, ym, url, text);
    }
    var parsed = parseMarketWatch_(text);
    appendMonthly_(ss, ym, url, parsed);
    added.push(ym);
    for (var j = 0; j < parsed.length; j++) {
      if (parsed[j].status !== 'OK') {
        notes.push(ym + ' / ' + parsed[j].region + ': ' + parsed[j].status);
      }
    }
  }

  var latest = latestMonth_(ss);
  return { added: added, latest: latest, notes: notes };
}

/** PDFを取得する。未公表(404等)なら null を返す。 */
function fetchPdf_(url) {
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() !== 200) {
    return null;
  }
  var blob = res.getBlob();
  if (blob.getBytes().length < 1024) {
    return null;
  }
  return blob.setContentType('application/pdf');
}

/**
 * PDFをGoogleドキュメントへ変換してテキストを取り出す。
 * 変換で作った一時ファイルは必ず削除する（蓄積データには触れない）。
 */
function pdfToText_(blob, ym) {
  var file = Drive.Files.create(
    { name: 'tmp_reins_' + ym, mimeType: 'application/vnd.google-apps.document' },
    blob
  );
  try {
    return DocumentApp.openById(file.id).getBody().getText();
  } finally {
    try {
      Drive.Files.update({ trashed: true }, file.id);
    } catch (e) {
      Logger.log('一時ファイルの削除に失敗: ' + file.id);
    }
  }
}

/**
 * 抽出したテキストから地域ごとの数値を拾う。
 *
 * PDF→ドキュメント変換では表のセルが改行で分割されることがあるため、
 * 行単位ではなく「見出し語の直後に現れる数値トークン列」を順に読む方式にしている。
 * 期待する並び: 成約件数 / 前年比 / 新規登録件数 / 前年比 / 在庫件数 / 前年比 / ㎡単価 / 価格
 * 想定と異なるレイアウトの場合は status に理由を残し、値は空欄のままにする。
 */
function parseMarketWatch_(text) {
  var section = sliceUsedMansionSection_(text);
  var out = [];

  for (var i = 0; i < REGIONS.length; i++) {
    var region = REGIONS[i];
    var nums = null;
    for (var a = 0; a < region.aliases.length && !nums; a++) {
      nums = numbersAfter_(section, region.aliases[a], 8, region.notFollowedBy);
    }
    if (!nums) {
      out.push({ region: region.key, status: '見出し「' + region.key + '」を検出できず', values: [] });
      continue;
    }
    out.push({
      region: region.key,
      status: nums.length >= 2 ? 'OK' : '数値の並びが想定と異なる（' + nums.length + '個）',
      values: nums
    });
  }
  return out;
}

/**
 * 「中古マンション」の節だけを切り出す。見つからない場合は全文を返す。
 * 中古戸建や土地の数値を拾ってしまうのを防ぐための絞り込み。
 */
function sliceUsedMansionSection_(text) {
  var start = text.indexOf('中古マンション');
  if (start < 0) {
    return text;
  }
  var rest = text.substring(start + 1);
  var endMarkers = ['中古戸建', '中古一戸建', '新築戸建', '土地（'];
  var end = -1;
  for (var i = 0; i < endMarkers.length; i++) {
    var idx = rest.indexOf(endMarkers[i]);
    if (idx >= 0 && (end < 0 || idx < end)) {
      end = idx;
    }
  }
  return end < 0 ? text.substring(start) : text.substring(start, start + 1 + end);
}

/**
 * label の出現位置を探す。notFollowedBy に挙げた語が直後に続く場合は、
 * より長い別の見出し（例:「東京都区部」）への誤マッチとみなして読み飛ばす。
 */
function findLabel_(text, label, notFollowedBy) {
  var from = 0;
  while (true) {
    var at = text.indexOf(label, from);
    if (at < 0) {
      return -1;
    }
    var after = text.substring(at + label.length);
    var skip = false;
    for (var i = 0; notFollowedBy && i < notFollowedBy.length; i++) {
      if (after.indexOf(notFollowedBy[i]) === 0) {
        skip = true;
        break;
      }
    }
    if (!skip) {
      return at;
    }
    from = at + label.length;
  }
}

/**
 * label の直後から数値トークンを最大 count 個拾う。
 * 「1,635」「△2.1」「▲ 2.1」「137.46」に対応。次の見出しらしき語に当たったら打ち切る。
 */
function numbersAfter_(text, label, count, notFollowedBy) {
  var at = findLabel_(text, label, notFollowedBy);
  if (at < 0) {
    return null;
  }
  var tail = text.substring(at + label.length);
  var token = /(△|▲|-)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g;
  var stop = /[一-龥ぁ-んァ-ヶ]{2,}/;
  var values = [];
  var m;
  var cursor = 0;
  while (values.length < count && (m = token.exec(tail)) !== null) {
    var between = tail.substring(cursor, m.index);
    if (values.length > 0 && stop.test(between.replace(/[件%万円㎡年月比前同]/g, ''))) {
      break; // 別項目に移ったとみなす
    }
    var n = Number(m[2].replace(/,/g, ''));
    if (m[1]) {
      n = -n;
    }
    values.push(n);
    cursor = token.lastIndex;
  }
  return values.length ? values : null;
}

/* ------------------------------------------------------------------ *
 * スプレッドシート入出力（追記のみ・既存行は変更しない）
 * ------------------------------------------------------------------ */

function openSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) {
    return SpreadsheetApp.openById(id);
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('対象スプレッドシートを特定できません。スクリプトプロパティ SPREADSHEET_ID を設定してください。');
  }
  return ss;
}

function ensureSheet_(ss, name, header) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  if (header && sheet.getLastRow() === 0) {
    sheet.appendRow(header);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function knownMonths_(ss) {
  var sheet = ensureSheet_(ss, SHEET_MONTHLY, MONTHLY_HEADER);
  var map = {};
  if (sheet.getLastRow() < 2) {
    return map;
  }
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    var ym = String(values[i][0]).trim();
    if (ym) {
      map[ym] = true;
    }
  }
  return map;
}

function latestMonth_(ss) {
  var months = Object.keys(knownMonths_(ss)).sort();
  return months.length ? months[months.length - 1] : null;
}

function appendMonthly_(ss, ym, url, parsed) {
  var sheet = ensureSheet_(ss, SHEET_MONTHLY, MONTHLY_HEADER);
  var stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
  var order = fieldOrder_();
  var rows = [];

  for (var i = 0; i < parsed.length; i++) {
    var p = parsed[i];
    var v = p.values || [];
    var f = {};
    for (var k = 0; k < order.length; k++) {
      if (order[k] && order[k] !== 'skip' && k < v.length) {
        f[order[k]] = v[k];
      }
    }
    rows.push([
      ym, stamp, p.region,
      val_(f, 'contracts'), val_(f, 'contractsYoY'),
      val_(f, 'newListings'), val_(f, 'newListingsYoY'),
      val_(f, 'stock'), val_(f, 'stockYoY'),
      val_(f, 'unitPrice'), val_(f, 'price'),
      url, p.status, v.join(' | ')
    ]);
  }
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, MONTHLY_HEADER.length).setValues(rows);
  }
}

function val_(f, key) {
  return Object.prototype.hasOwnProperty.call(f, key) ? f[key] : '';
}

function readMonthly_(ss) {
  var sheet = ensureSheet_(ss, SHEET_MONTHLY, MONTHLY_HEADER);
  if (sheet.getLastRow() < 2) {
    return [];
  }
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, MONTHLY_HEADER.length).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    rows.push({
      ym: String(values[i][0]).trim(),
      region: String(values[i][2]).trim(),
      contracts: values[i][3],
      contractsYoY: values[i][4],
      newListings: values[i][5],
      newListingsYoY: values[i][6],
      stock: values[i][7],
      stockYoY: values[i][8],
      unitPrice: values[i][9],
      price: values[i][10],
      url: String(values[i][11]).trim(),
      status: String(values[i][12]).trim()
    });
  }
  return rows;
}

function appendDailyLog_(ss, now, ingest) {
  var sheet = ensureSheet_(ss, SHEET_DAILY, DAILY_HEADER);
  sheet.appendRow([
    Utilities.formatDate(now, TZ, 'yyyy-MM-dd HH:mm'),
    ingest.notes.length ? '要確認' : '正常',
    ingest.latest || '(なし)',
    ingest.added.length ? ingest.added.join(', ') : 'なし',
    ingest.notes.join(' / ')
  ]);
}

function shouldSaveRawText_() {
  return PropertiesService.getScriptProperties().getProperty('SAVE_RAW_TEXT') === 'true';
}

function appendRawText_(ss, ym, url, text) {
  var sheet = ensureSheet_(ss, SHEET_RAW, ['公表年月', '取得日時', '出典URL', '抽出テキスト']);
  sheet.appendRow([
    ym,
    Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'),
    url,
    text.substring(0, 45000) // セル上限に収める
  ]);
}

/* ------------------------------------------------------------------ *
 * メール本文
 * ------------------------------------------------------------------ */

function buildSubject_(now, rows) {
  var latest = latestOf_(rows, '東京都区部');
  var today = Utilities.formatDate(now, TZ, 'M月d日');
  if (!latest) {
    return '[中古マンション市況] ' + today + ' — 未取得';
  }
  return Utilities.formatString(
    '[中古マンション市況] %s — 東京都区部 %s年%s月度 成約%s件 / 新規登録%s件',
    today, latest.ym.substring(0, 4), Number(latest.ym.substring(4, 6)),
    fmtNum_(latest.contracts), fmtNum_(latest.newListings)
  );
}

function buildHtml_(now, rows, ingest) {
  var h = [];
  h.push('<div style="font-family:sans-serif;font-size:14px;color:#222;line-height:1.7">');
  h.push('<h2 style="margin:0 0 4px">東京23区 中古マンション 市況</h2>');
  h.push('<div style="color:#666;font-size:12px">' +
    Utilities.formatDate(now, TZ, 'yyyy年M月d日(E) HH:mm') + ' 時点 / 出典: 東日本レインズ 月例速報 Market Watch</div>');

  if (ingest.added.length) {
    h.push('<p style="background:#e8f5e9;padding:8px 12px;border-radius:4px;margin:12px 0">' +
      '<b>新しい公表を取り込みました:</b> ' + escapeHtml_(ingest.added.join(', ')) + '</p>');
  }

  var latestYm = latestYm_(rows);
  if (!latestYm) {
    h.push('<p style="background:#fff3e0;padding:8px 12px;border-radius:4px">' +
      'まだデータがありません。レインズの月例速報が未公表か、取得に失敗しています。</p>');
  } else {
    h.push(buildLatestTable_(rows, latestYm));
    h.push(buildTrendTable_(rows, '東京都区部'));
  }

  h.push('<h3 style="margin:20px 0 6px;font-size:14px">補足</h3>');
  h.push('<ul style="margin:0;padding-left:18px;color:#444">');
  h.push('<li>レインズ月例速報は<b>月1回</b>の公表（前月分を翌月中旬）です。日次では数値は変動しません。</li>');
  h.push('<li>最小の地域粒度は<b>「東京都区部」（23区まとめ）</b>で、区別の内訳は公表されていません。</li>');
  h.push('<li>「新規登録件数」＝その月に新たに売り出された件数、「在庫件数」＝月末時点の売出中件数です。</li>');
  h.push('</ul>');

  if (ingest.notes.length) {
    h.push('<p style="background:#fff3e0;padding:8px 12px;border-radius:4px;margin-top:12px">' +
      '<b>要確認:</b><br>' + escapeHtml_(ingest.notes.join('\n')).replace(/\n/g, '<br>') + '</p>');
  }

  h.push('</div>');
  return h.join('');
}

function buildLatestTable_(rows, ym) {
  var h = [];
  h.push('<h3 style="margin:18px 0 6px;font-size:14px">' +
    ym.substring(0, 4) + '年' + Number(ym.substring(4, 6)) + '月度</h3>');
  h.push('<table style="border-collapse:collapse;font-size:13px">');
  h.push(tr_(['地域', '成約件数', '前年比', '新規登録', '前年比', '在庫件数', '前年比', '㎡単価(万円)', '成約価格(万円)'], true));
  for (var i = 0; i < REGIONS.length; i++) {
    var r = findRow_(rows, ym, REGIONS[i].key);
    if (!r) {
      continue;
    }
    h.push(tr_([
      r.region, fmtNum_(r.contracts), fmtPct_(r.contractsYoY),
      fmtNum_(r.newListings), fmtPct_(r.newListingsYoY),
      fmtNum_(r.stock), fmtPct_(r.stockYoY),
      fmtNum_(r.unitPrice), fmtNum_(r.price)
    ], false));
  }
  h.push('</table>');
  return h.join('');
}

function buildTrendTable_(rows, region) {
  var series = [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].region === region && rows[i].ym) {
      series.push(rows[i]);
    }
  }
  if (series.length < 2) {
    return '';
  }
  series.sort(function (a, b) { return a.ym < b.ym ? 1 : -1; });
  series = series.slice(0, 12);

  var h = [];
  h.push('<h3 style="margin:18px 0 6px;font-size:14px">' + region + ' 推移（直近' + series.length + 'か月）</h3>');
  h.push('<table style="border-collapse:collapse;font-size:13px">');
  h.push(tr_(['年月', '成約件数', '新規登録', '在庫件数', '成約価格(万円)'], true));
  for (var j = 0; j < series.length; j++) {
    var s = series[j];
    h.push(tr_([
      s.ym.substring(0, 4) + '/' + s.ym.substring(4, 6),
      fmtNum_(s.contracts), fmtNum_(s.newListings), fmtNum_(s.stock), fmtNum_(s.price)
    ], false));
  }
  h.push('</table>');
  return h.join('');
}

function tr_(cells, isHeader) {
  var tag = isHeader ? 'th' : 'td';
  var base = 'border:1px solid #ddd;padding:5px 10px;';
  var style = isHeader ? base + 'background:#f5f5f5;text-align:center' : base + 'text-align:right';
  var out = ['<tr>'];
  for (var i = 0; i < cells.length; i++) {
    var s = (!isHeader && i === 0) ? base + 'text-align:left' : style;
    out.push('<' + tag + ' style="' + s + '">' + escapeHtml_(String(cells[i])) + '</' + tag + '>');
  }
  out.push('</tr>');
  return out.join('');
}

/* ------------------------------------------------------------------ *
 * ユーティリティ
 * ------------------------------------------------------------------ */

/** 当月から count か月分の YYYYMM を新しい順で返す。 */
function recentMonths_(now, count) {
  var out = [];
  var y = Number(Utilities.formatDate(now, TZ, 'yyyy'));
  var m = Number(Utilities.formatDate(now, TZ, 'MM'));
  for (var i = 0; i < count; i++) {
    var mm = m - i;
    var yy = y;
    while (mm <= 0) {
      mm += 12;
      yy -= 1;
    }
    out.push(yy + ('0' + mm).slice(-2));
  }
  return out;
}

function latestYm_(rows) {
  var ym = null;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].ym && (!ym || rows[i].ym > ym)) {
      ym = rows[i].ym;
    }
  }
  return ym;
}

function latestOf_(rows, region) {
  var ym = null;
  var found = null;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].region === region && rows[i].ym && (!ym || rows[i].ym > ym)) {
      ym = rows[i].ym;
      found = rows[i];
    }
  }
  return found;
}

function findRow_(rows, ym, region) {
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].ym === ym && rows[i].region === region) {
      return rows[i];
    }
  }
  return null;
}

function fmtNum_(v) {
  if (v === '' || v === null || v === undefined || isNaN(Number(v))) {
    return '—';
  }
  return Number(v).toLocaleString('ja-JP');
}

function fmtPct_(v) {
  if (v === '' || v === null || v === undefined || isNaN(Number(v))) {
    return '—';
  }
  var n = Number(v);
  return (n > 0 ? '+' : '') + n + '%';
}

function escapeHtml_(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlToPlainText_(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(tr|p|h2|h3|li|table|div)>/gi, '\n')
    .replace(/<\/(th|td)>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
