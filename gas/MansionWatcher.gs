/**
 * 南万騎が原駅 中古マンション ウォッチャー
 *
 * ・成約事例：国土交通省「不動産情報ライブラリ」APIから四半期ごとに取得（自動）
 * ・売り出し事例：レインズ等からの週次エクスポートを取り込み、前週との差分を判定（半自動）
 * ・毎週1回、サマリーをメール送信
 *
 * 設定はスクリプトプロパティで管理します（このファイルに社内情報は書かない）:
 *   SHEET_ID        … 記録先スプレッドシートのID
 *   REINFOLIB_KEY   … 不動産情報ライブラリ APIキー（無料申請）
 *   NOTIFY_EMAIL    … 週次サマリーの宛先
 *   DISTRICTS       … 対象地区名をカンマ区切りで（省略時は下の DEFAULT_DISTRICTS）
 *
 * 注意：不動産ポータルサイトの自動巡回は各社の利用規約で禁止されている場合があります。
 *       売り出し情報は、業務で正規に閲覧できるレインズ等からのエクスポートを取り込む前提です。
 */

// 神奈川県 / 横浜市旭区
var AREA_CODE = '14';
var CITY_CODE = '14106';

// 南万騎が原駅を利用する範囲の町名（実情に合わせてプロパティ DISTRICTS で上書き可）
var DEFAULT_DISTRICTS = [
  '万騎が原', 'さちが丘', '柏町', '善部町', '今川町',
  '南希望が丘', '中希望が丘', '大池町'
];

var SHEET_LISTINGS  = '売り出し台帳';
var SHEET_SNAPSHOT  = '今週の売り出し';   // ここに週次エクスポートを貼る
var SHEET_EVENTS    = '更新履歴';
var SHEET_CONTRACTS = '成約事例';

var SNAPSHOT_HEADER = [
  'source', 'source_id', 'url', 'mansion_name', 'address', 'station', 'walk_min',
  'price_man', 'layout', 'area_m2', 'balcony_m2', 'floor', 'floors_total',
  'built_ym', 'units_total', 'management_fee', 'repair_fund', 'remarks'
];
var LISTING_HEADER = [
  'listing_id', 'status', 'first_seen', 'last_seen', 'closed_date', 'weeks_on_market',
  'source', 'source_id', 'url', 'mansion_name', 'address', 'station', 'walk_min',
  'price_initial_man', 'price_current_man', 'price_cut_count',
  'layout', 'area_m2', 'unit_price_man_tsubo', 'floor', 'built_ym', 'remarks'
];
var EVENT_HEADER = ['event_date', 'event_type', 'listing_id', 'mansion_name', 'layout', 'area_m2', 'detail'];
var CONTRACT_HEADER = [
  'contract_id', 'contract_period', 'source', 'mansion_name', 'area_name',
  'price_man', 'layout', 'area_m2', 'built_ym', 'floor', 'station', 'walk_min',
  'unit_price_man_tsubo', 'remarks'
];

var TSUBO = 3.30578;

// ---------------------------------------------------------------- 入口

/** 週次トリガーはこれを呼ぶ（例：毎週月曜 7:00）。 */
function weeklyRun() {
  var summary = ingestSnapshot_();
  var added = fetchContractsIfNewQuarter_();
  summary.contractsAdded = added;
  sendSummaryMail_(summary);
}

/** 初回に一度だけ実行：シートを作る。 */
function setupSheets() {
  var ss = book_();
  ensureSheet_(ss, SHEET_SNAPSHOT, SNAPSHOT_HEADER);
  ensureSheet_(ss, SHEET_LISTINGS, LISTING_HEADER);
  ensureSheet_(ss, SHEET_EVENTS, EVENT_HEADER);
  ensureSheet_(ss, SHEET_CONTRACTS, CONTRACT_HEADER);
  Logger.log('シートを用意しました: ' + [SHEET_SNAPSHOT, SHEET_LISTINGS, SHEET_EVENTS, SHEET_CONTRACTS].join(' / '));
}

/** 週次トリガーを登録する（重複登録しない）。 */
function installWeeklyTrigger() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'weeklyRun';
  });
  if (exists) { Logger.log('週次トリガーは登録済みです'); return; }
  ScriptApp.newTrigger('weeklyRun')
    .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7).create();
  Logger.log('毎週月曜 7時台の週次トリガーを登録しました');
}

// ------------------------------------------------- 売り出し：差分の取り込み

/**
 * 「今週の売り出し」シートの内容を台帳にマージし、
 * 新規掲載 / 価格改定 / 掲載終了 を判定して更新履歴に積む。
 */
function ingestSnapshot_() {
  var ss = book_();
  var today = ymd_(new Date());
  var snap = readRows_(ensureSheet_(ss, SHEET_SNAPSHOT, SNAPSHOT_HEADER), SNAPSHOT_HEADER);
  var summary = { date: today, total: snap.length, added: 0, repriced: 0, closed: 0, events: [] };
  if (!snap.length) return summary;

  var lsheet = ensureSheet_(ss, SHEET_LISTINGS, LISTING_HEADER);
  var listings = readRows_(lsheet, LISTING_HEADER);
  var index = {};
  listings.forEach(function (r, i) { index[r.listing_id] = i; });

  var sources = {}, seen = {}, events = [];
  snap.forEach(function (row) { sources[String(row.source || '').trim()] = true; });

  snap.forEach(function (row) {
    var id = listingId_(row);
    seen[id] = true;
    var price = numOr_(row.price_man, '');
    var i = index[id];

    if (i === undefined) {
      listings.push({
        listing_id: id, status: '売出中', first_seen: today, last_seen: today, closed_date: '',
        weeks_on_market: 0, source: row.source, source_id: row.source_id, url: row.url,
        mansion_name: row.mansion_name, address: row.address, station: row.station,
        walk_min: row.walk_min, price_initial_man: price, price_current_man: price,
        price_cut_count: 0, layout: row.layout, area_m2: row.area_m2,
        unit_price_man_tsubo: unitPrice_(price, row.area_m2), floor: row.floor,
        built_ym: row.built_ym, remarks: row.remarks
      });
      index[id] = listings.length - 1;
      events.push([today, '新規掲載', id, row.mansion_name, row.layout, row.area_m2,
                   money_(price) + '万円 / ' + row.layout + ' / ' + row.area_m2 + 'm2']);
      summary.added++;
      return;
    }

    var cur = listings[i];
    var old = numOr_(cur.price_current_man, '');
    if (price !== '' && old !== '' && price !== old) {
      var diff = price - old;
      if (diff < 0) cur.price_cut_count = (Number(cur.price_cut_count) || 0) + 1;
      events.push([today, '価格改定', id, cur.mansion_name, cur.layout, cur.area_m2,
                   money_(old) + '万円 → ' + money_(price) + '万円 (' +
                   (diff > 0 ? '+' : '') + money_(diff) + '万円)']);
      summary.repriced++;
    }
    cur.status = '売出中';
    cur.closed_date = '';
    cur.last_seen = today;
    cur.price_current_man = price;
    cur.unit_price_man_tsubo = unitPrice_(price, row.area_m2);
    cur.url = row.url || cur.url;
    cur.weeks_on_market = weeksBetween_(cur.first_seen, today);
  });

  // 今回のスナップショットに現れなかった＝掲載終了（同じソースの範囲内でのみ判定）
  listings.forEach(function (r) {
    if (seen[r.listing_id] || r.status !== '売出中') return;
    if (!sources[String(r.source || '').trim()]) return;
    r.status = '掲載終了';
    r.closed_date = today;
    r.weeks_on_market = weeksBetween_(r.first_seen, today);
    events.push([today, '掲載終了', r.listing_id, r.mansion_name, r.layout, r.area_m2,
                 '最終 ' + money_(r.price_current_man) + '万円 / 掲載 ' + r.weeks_on_market + '週']);
    summary.closed++;
  });

  writeRows_(lsheet, LISTING_HEADER, listings);
  if (events.length) appendRows_(ensureSheet_(ss, SHEET_EVENTS, EVENT_HEADER), events);
  summary.events = events;
  return summary;
}

// ------------------------------------------- 成約：不動産情報ライブラリAPI

/**
 * 直近で未取得の四半期があれば取りに行く。
 * ※ エンドポイント・パラメータ名は公式ドキュメントで最新版を確認してください。
 *    APIキーは https://www.reinfolib.mlit.go.jp/ で無料申請できます。
 */
function fetchContractsIfNewQuarter_() {
  var key = prop_('REINFOLIB_KEY', '');
  if (!key) { Logger.log('REINFOLIB_KEY 未設定のため成約事例の取得をスキップしました'); return 0; }

  var ss = book_();
  var sheet = ensureSheet_(ss, SHEET_CONTRACTS, CONTRACT_HEADER);
  var have = {};
  readRows_(sheet, CONTRACT_HEADER).forEach(function (r) { have[r.contract_id] = true; });

  // 公表は数か月遅れるので、直近5四半期を毎回舐めて未取得分だけ足す
  var now = new Date();
  var y = now.getFullYear(), q = Math.floor(now.getMonth() / 3) + 1;
  var districts = prop_('DISTRICTS', '') ? prop_('DISTRICTS', '').split(',') : DEFAULT_DISTRICTS;
  var rows = [];

  for (var back = 1; back <= 5; back++) {
    var qq = q - back, yy = y;
    while (qq <= 0) { qq += 4; yy -= 1; }
    fetchQuarter_(key, yy, qq, districts).forEach(function (r) {
      if (!have[r[0]]) { have[r[0]] = true; rows.push(r); }
    });
  }
  if (rows.length) appendRows_(sheet, rows);
  Logger.log('成約事例 ' + rows.length + '件を追加しました');
  return rows.length;
}

function fetchQuarter_(key, year, quarter, districts) {
  var url = 'https://www.reinfolib.mlit.go.jp/ex-api/external/XIT001'
    + '?year=' + year + '&quarter=' + quarter
    + '&area=' + AREA_CODE + '&city=' + CITY_CODE
    + '&priceClassification=02';  // 02 = 成約価格情報

  var res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'Ocp-Apim-Subscription-Key': key },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    Logger.log('API ' + year + 'Q' + quarter + ' 失敗: ' + res.getResponseCode() + ' ' +
               res.getContentText().slice(0, 200));
    return [];
  }

  var data = JSON.parse(res.getContentText()).data || [];
  return data.filter(function (d) {
    if (String(d.Type || '').indexOf('マンション') < 0) return false;
    return districts.some(function (n) { return String(d.DistrictName || '').indexOf(n.trim()) >= 0; });
  }).map(function (d) {
    var priceMan = Math.round((Number(d.TradePrice) || 0) / 10000);
    var area = Number(d.Area) || '';
    var period = d.Period || (year + '年第' + quarter + '四半期');
    var id = [period, d.DistrictName, d.FloorPlan, area, priceMan].join('|');
    return [
      id, period, '不動産情報ライブラリ（成約価格）', '', d.DistrictName || '',
      priceMan, d.FloorPlan || '', area, d.BuildingYear || '', '',
      d.NearestStation || '', d.TimeToNearestStation || '',
      unitPrice_(priceMan, area), d.Structure || ''
    ];
  });
}

// ---------------------------------------------------------------- メール

function sendSummaryMail_(s) {
  var to = prop_('NOTIFY_EMAIL', '');
  if (!to) { Logger.log('NOTIFY_EMAIL 未設定のためメールを送信しませんでした'); return; }

  var byType = { '新規掲載': [], '価格改定': [], '掲載終了': [] };
  (s.events || []).forEach(function (e) { if (byType[e[1]]) byType[e[1]].push(e); });

  var L = [];
  L.push('南万騎が原駅 中古マンション 週次レポート（' + s.date + '）');
  L.push('');
  L.push('売り出し中の取込件数： ' + s.total + '件');
  L.push('新規掲載： ' + s.added + '件 ／ 価格改定： ' + s.repriced + '件 ／ 掲載終了： ' + s.closed + '件');
  L.push('成約事例の追加： ' + (s.contractsAdded || 0) + '件');
  L.push('');

  ['新規掲載', '価格改定', '掲載終了'].forEach(function (t) {
    L.push('■ ' + t + '（' + byType[t].length + '件）');
    if (!byType[t].length) { L.push('　該当なし'); }
    else {
      byType[t].forEach(function (e) {
        L.push('　・' + e[3] + '　' + e[4] + ' ' + e[5] + 'm2　' + e[6]);
      });
    }
    L.push('');
  });

  L.push('※ 掲載終了＝成約とは限りません（売主都合の取下げ・媒介先の変更を含む）。');
  L.push('※ 全件の一覧はスプレッドシート「' + SHEET_LISTINGS + '」を参照してください。');
  L.push(book_().getUrl());

  MailApp.sendEmail(to, '【南万騎が原】中古マンション週次レポート ' + s.date, L.join('\n'));
  Logger.log('週次レポートを送信しました');
}

// ---------------------------------------------------------------- 小道具

function prop_(k, d) {
  var v = PropertiesService.getScriptProperties().getProperty(k);
  return (v === null || v === '') ? d : v;
}

function book_() {
  var id = prop_('SHEET_ID', '');
  if (!id) throw new Error('スクリプトプロパティ SHEET_ID が未設定です');
  return SpreadsheetApp.openById(id);
}

function ensureSheet_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readRows_(sheet, header) {
  if (sheet.getLastRow() < 2) return [];
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, header.length).getValues();
  return values.filter(function (row) {
    return row.some(function (c) { return c !== '' && c !== null; });
  }).map(function (row) {
    var o = {};
    header.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  });
}

function writeRows_(sheet, header, objs) {
  var body = objs.map(function (o) {
    return header.map(function (h) { return o[h] === undefined || o[h] === null ? '' : o[h]; });
  });
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, header.length).clearContent();
  }
  if (body.length) sheet.getRange(2, 1, body.length, header.length).setValues(body);
}

function appendRows_(sheet, rows) {
  if (!rows.length) return;
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function listingId_(row) {
  var src = String(row.source || '').trim();
  var sid = String(row.source_id || '').trim();
  var key = sid ? (src + '|' + sid)
                : [src, row.mansion_name, row.layout, row.area_m2, row.floor].join('|');
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, key, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); })
    .join('').slice(0, 12);
}

function numOr_(v, d) {
  var n = parseFloat(String(v === null || v === undefined ? '' : v).replace(/,/g, ''));
  return isNaN(n) ? d : n;
}

function money_(v) {
  var n = numOr_(v, null);
  return n === null ? '' : n.toLocaleString('ja-JP');
}

function unitPrice_(priceMan, areaM2) {
  var p = numOr_(priceMan, null), a = numOr_(areaM2, null);
  if (!p || !a) return '';
  return Math.round(p / (a / TSUBO) * 10) / 10;
}

function weeksBetween_(from, to) {
  var a = new Date(from), b = new Date(to);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return '';
  return Math.max(Math.floor((b - a) / (7 * 24 * 3600 * 1000)), 0);
}

function ymd_(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
}
