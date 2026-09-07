/**
 * 世田谷区・杉並区・大田区・渋谷区の「土地」「戸建て」売り出し物件トラッカー
 *
 * SUUMOの一覧ページを毎日クロールし、
 *   - 新規掲載件数（前日になかった物件IDが増えた数）
 *   - 消失件数（前日にあった物件IDが消えた数＝成約または掲載終了の想定値）
 *   - 現在の掲載総数
 *   - 平均坪単価
 * を区・種別ごとに算出してスプレッドシートに蓄積し、毎日18:00に集計メールを送る。
 *
 * ★重要な注意（必ず導入前に読むこと）
 *   このスクリプトのHTML解析（parseListingsFromHtml_）は、SUUMOの実際のページを
 *   直接確認できない環境で書いたため「推測」が入っています。
 *   導入時は必ず selfTestOneCategory('setagaya', 'land') 等を実行し、
 *   ログに出る抽出件数・サンプルが実際のページの件数と近いかを目視確認してください。
 *   ズレている場合は parseListingsFromHtml_ の正規表現を、実際に取得できた
 *   HTML（Logger.logで出力される）を見ながら調整する必要があります。
 *
 * ★「成約件数」の限界
 *   SUUMOなど掲載サイトの情報からは「成約（売れた）」と「掲載終了（広告を
 *   取り下げただけ・他サイトに一本化・価格変更のための再掲載）」を区別できません。
 *   本スクリプトが出す「消失件数」はあくまで「掲載が消えた件数」であり、
 *   売れた件数そのものではない点をメール本文にも明記しています。
 *   正確な成約件数が必要な場合は、レインズ（指定流通機構）等、成約情報を
 *   持つデータソースへの接続が別途必要です。
 *
 * スクリプトプロパティ:
 *   RECIPIENT … 送信先メールアドレス（必須）
 *   CC        … （任意）CCアドレス。カンマ区切り
 */

var LT_WARDS = [
  { key: 'setagaya', name: '世田谷区' },
  { key: 'suginami', name: '杉並区' },
  { key: 'ota', name: '大田区' },
  { key: 'shibuya', name: '渋谷区' }
];

// pathPrefix は SUUMO の URL 中の種別セグメント。
// house_new / house_used は「戸建て」としてメールでは合算して報告する。
var LT_CATEGORIES = [
  { key: 'land', label: '土地', pathPrefix: 'tochi' },
  { key: 'house_new', label: '新築一戸建て', pathPrefix: 'ikkodate', group: '戸建て' },
  { key: 'house_used', label: '中古一戸建て', pathPrefix: 'chukoikkodate', group: '戸建て' }
];

var LT_SHEET_SNAPSHOT = '在庫スナップショット';
var LT_SHEET_DAILY = '日次サマリ';
var LT_SHEET_MONTHLY = '月次集計';

var LT_HEAD_SNAPSHOT = ['区', '種別', '物件ID', '価格(円)', '面積(㎡)', '坪単価(円)', 'URL', '取得日'];
var LT_HEAD_DAILY = ['日付', '区', '種別', '現在件数', '新規件数', '消失件数(成約想定)', '平均坪単価(円)'];
var LT_HEAD_MONTHLY = ['年月', '区', '種別', '新規件数累計', '消失件数累計(成約想定)', '月内平均坪単価(円)', '最終更新日'];

var LT_MAX_PAGES = 60; // 暴走防止の安全上限（1区・1種別あたり）
var LT_BATCH_SIZE = 6; // 並行取得するページ数

/** 毎日18:00のトリガーから呼ぶメイン処理。 */
function runDailyListingCheck() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var yearMonth = today.substring(0, 7);

  var results = []; // { wardName, categoryLabel, group, current, added, removed, avgTsubo }

  for (var w = 0; w < LT_WARDS.length; w++) {
    var ward = LT_WARDS[w];
    for (var c = 0; c < LT_CATEGORIES.length; c++) {
      var cat = LT_CATEGORIES[c];
      var listings = fetchCategoryListings_(cat.pathPrefix, ward.key);
      var prev = loadSnapshot_(ss, ward.name, cat.label);

      var prevIds = {};
      for (var i = 0; i < prev.length; i++) prevIds[prev[i].id] = true;
      var currIds = {};
      var addedCount = 0;
      for (var j = 0; j < listings.length; j++) {
        currIds[listings[j].id] = true;
        if (!prevIds[listings[j].id]) addedCount++;
      }
      var removedCount = 0;
      for (var id in prevIds) {
        if (!currIds[id]) removedCount++;
      }

      var avgTsubo = averageTsubo_(listings);

      saveSnapshot_(ss, ward.name, cat.label, listings, today);
      appendDailyRow_(ss, today, ward.name, cat.label, listings.length, addedCount, removedCount, avgTsubo);
      updateMonthlyRow_(ss, yearMonth, ward.name, cat.label, addedCount, removedCount, avgTsubo, today);

      results.push({
        wardName: ward.name,
        categoryLabel: cat.label,
        group: cat.group || cat.label,
        current: listings.length,
        added: addedCount,
        removed: removedCount,
        avgTsubo: avgTsubo
      });

      Utilities.sleep(300); // サイトへの連続アクセスを避ける
    }
  }

  sendDailyListingMail_(today, yearMonth, results, ss);
}

/* ===================== 取得・解析 ===================== */

function buildListUrl_(pathPrefix, wardKey, page) {
  var base = 'https://suumo.jp/' + pathPrefix + '/tokyo/sc_' + wardKey + '/';
  return page > 1 ? base + '?page=' + page : base;
}

/**
 * 1区・1種別の全ページを巡回し、物件一覧を返す。
 * 「新しく取得したIDが1件も増えないページが出たら終了」という方式で
 * ページ数を自動判定するため、総件数の表示テキストには依存しない。
 */
function fetchCategoryListings_(pathPrefix, wardKey) {
  var byId = {};
  var page = 1;
  var keepGoing = true;

  while (keepGoing && page <= LT_MAX_PAGES) {
    var batchUrls = [];
    for (var p = page; p < page + LT_BATCH_SIZE && p <= LT_MAX_PAGES; p++) {
      batchUrls.push(buildListUrl_(pathPrefix, wardKey, p));
    }

    var requests = batchUrls.map(function (u) {
      return { url: u, muteHttpExceptions: true };
    });
    var responses = UrlFetchApp.fetchAll(requests);

    var addedInBatch = 0;
    for (var r = 0; r < responses.length; r++) {
      var res = responses[r];
      if (res.getResponseCode() !== 200) continue;
      var html = res.getContentText();
      var found = parseListingsFromHtml_(html, pathPrefix);
      for (var f = 0; f < found.length; f++) {
        if (!byId[found[f].id]) {
          byId[found[f].id] = found[f];
          addedInBatch++;
        }
      }
    }

    if (addedInBatch === 0) {
      keepGoing = false;
    } else {
      page += LT_BATCH_SIZE;
    }
  }

  var out = [];
  for (var id in byId) out.push(byId[id]);
  return out;
}

/**
 * 一覧ページのHTMLから物件を抽出する。
 * 物件詳細へのリンク（/<種別>/bukken/<数字ID>/）の出現位置でHTMLを分割し、
 * 各ブロックから価格（万円）と面積（㎡）を正規表現で拾う方式。
 * SUUMOのクラス名変更に影響されにくいが、価格・面積が正しく物件と
 * 対応しているかは selfTestOneCategory() で必ず確認すること。
 */
function parseListingsFromHtml_(html, pathPrefix) {
  var linkPattern = new RegExp('/' + pathPrefix + '/bukken/(\\d+)/', 'g');

  var matches = [];
  var m;
  while ((m = linkPattern.exec(html)) !== null) {
    matches.push({ id: m[1], index: m.index });
  }
  if (matches.length === 0) return [];

  // 重複ID（同じ物件への複数リンク）は最初の出現のみ残す
  var seen = {};
  var uniqueMatches = [];
  for (var i = 0; i < matches.length; i++) {
    if (!seen[matches[i].id]) {
      seen[matches[i].id] = true;
      uniqueMatches.push(matches[i]);
    }
  }

  var listings = [];
  for (var u = 0; u < uniqueMatches.length; u++) {
    var start = uniqueMatches[u].index;
    var end = (u + 1 < uniqueMatches.length) ? uniqueMatches[u + 1].index : Math.min(html.length, start + 4000);
    var block = html.substring(start, end);

    var price = extractPriceYen_(block);
    var area = extractAreaM2_(block);
    if (!price || !area) continue; // 価格か面積が拾えない物件は坪単価計算から除外

    var tsubo = Math.round(price / (area * 0.3025));
    listings.push({
      id: uniqueMatches[u].id,
      priceYen: price,
      areaM2: area,
      tsuboPrice: tsubo,
      url: 'https://suumo.jp/' + pathPrefix + '/bukken/' + uniqueMatches[u].id + '/'
    });
  }
  return listings;
}

/** 「5,980万円」「1億2000万円」のような表記を円に変換する。 */
function extractPriceYen_(block) {
  var oku = block.match(/([\d,]+(?:\.\d+)?)\s*億/);
  var man = block.match(/([\d,]+(?:\.\d+)?)\s*万円/);
  var yen = 0;
  if (oku) yen += parseFloat(oku[1].replace(/,/g, '')) * 100000000;
  if (man) yen += parseFloat(man[1].replace(/,/g, '')) * 10000;
  return yen || 0;
}

/** 「123.45m2」「123.45㎡」のような表記を数値(㎡)に変換する。土地・建物が併記される場合は最初の1つを採用。 */
function extractAreaM2_(block) {
  var m = block.match(/([\d,]+(?:\.\d+)?)\s*(?:m2|m²|㎡)/);
  if (!m) return 0;
  return parseFloat(m[1].replace(/,/g, ''));
}

function averageTsubo_(listings) {
  var valid = listings.filter(function (l) { return l.tsuboPrice > 0; });
  if (valid.length === 0) return 0;
  var sum = 0;
  for (var i = 0; i < valid.length; i++) sum += valid[i].tsuboPrice;
  return Math.round(sum / valid.length);
}

/* ===================== スプレッドシート ===================== */

function lt_sheet_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 指定の区・種別の現在スナップショット（＝前回実行時点の在庫）を読む。 */
function loadSnapshot_(ss, wardName, categoryLabel) {
  var sh = lt_sheet_(ss, LT_SHEET_SNAPSHOT, LT_HEAD_SNAPSHOT);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, LT_HEAD_SNAPSHOT.length).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    if (vals[i][0] === wardName && vals[i][1] === categoryLabel) {
      out.push({ id: String(vals[i][2]), priceYen: vals[i][3], areaM2: vals[i][4], tsuboPrice: vals[i][5] });
    }
  }
  return out;
}

/** 指定の区・種別の行を最新の内容で置き換える。 */
function saveSnapshot_(ss, wardName, categoryLabel, listings, today) {
  var sh = lt_sheet_(ss, LT_SHEET_SNAPSHOT, LT_HEAD_SNAPSHOT);
  var last = sh.getLastRow();
  var kept = [];
  if (last > 1) {
    var vals = sh.getRange(2, 1, last - 1, LT_HEAD_SNAPSHOT.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (!(vals[i][0] === wardName && vals[i][1] === categoryLabel)) kept.push(vals[i]);
    }
  }
  var incoming = listings.map(function (l) {
    return [wardName, categoryLabel, l.id, l.priceYen, l.areaM2, l.tsuboPrice, l.url, today];
  });
  var out = kept.concat(incoming);
  if (last > 1) sh.getRange(2, 1, last - 1, LT_HEAD_SNAPSHOT.length).clearContent();
  if (out.length) sh.getRange(2, 1, out.length, LT_HEAD_SNAPSHOT.length).setValues(out);
}

function appendDailyRow_(ss, today, wardName, categoryLabel, current, added, removed, avgTsubo) {
  var sh = lt_sheet_(ss, LT_SHEET_DAILY, LT_HEAD_DAILY);
  sh.appendRow([today, wardName, categoryLabel, current, added, removed, avgTsubo]);
}

/** その月・区・種別の行を、今日までの累計で上書きする。 */
function updateMonthlyRow_(ss, yearMonth, wardName, categoryLabel, added, removed, avgTsubo, today) {
  var sh = lt_sheet_(ss, LT_SHEET_MONTHLY, LT_HEAD_MONTHLY);
  var last = sh.getLastRow();
  var at = 0;
  var vals = [];
  if (last > 1) {
    vals = sh.getRange(2, 1, last - 1, LT_HEAD_MONTHLY.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (vals[i][0] === yearMonth && vals[i][1] === wardName && vals[i][2] === categoryLabel) { at = i + 2; break; }
    }
  }
  var prevAdded = at ? vals[at - 2][3] : 0;
  var prevRemoved = at ? vals[at - 2][4] : 0;
  var row = [yearMonth, wardName, categoryLabel, prevAdded + added, prevRemoved + removed, avgTsubo, today];
  if (at) sh.getRange(at, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
}

/* ===================== メール ===================== */

function sendDailyListingMail_(today, yearMonth, results, ss) {
  var recipient = PropertiesService.getScriptProperties().getProperty('RECIPIENT');
  if (!recipient) {
    Logger.log('RECIPIENT が未設定のため送信しませんでした。');
    return;
  }
  var cc = PropertiesService.getScriptProperties().getProperty('CC') || '';

  var dow = ['日', '月', '火', '水', '木', '金', '土'][new Date().getDay()];
  var subject = '【売り出し物件レポート】' + today.replace(/-/g, '/') + '(' + dow + ')分';

  var byWard = {};
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (!byWard[r.wardName]) byWard[r.wardName] = [];
    byWard[r.wardName].push(r);
  }

  var html = '<p>小林様　お世話になっております。</p>';
  html += '<p>世田谷区・杉並区・大田区・渋谷区の「土地」「戸建て」売り出し物件について、本日時点の状況をまとめました。</p>';

  for (var w = 0; w < LT_WARDS.length; w++) {
    var wardName = LT_WARDS[w].name;
    var rows = byWard[wardName] || [];
    html += '<h3>' + wardName + '</h3>';
    html += '<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse">';
    html += '<tr><th>種別</th><th>現在の掲載件数</th><th>本日の新規件数</th><th>本日の消失件数(成約想定)</th><th>平均坪単価</th></tr>';
    for (var j = 0; j < rows.length; j++) {
      var r2 = rows[j];
      html += '<tr><td>' + r2.categoryLabel + '</td><td>' + r2.current + '</td><td>' + r2.added + '</td><td>' + r2.removed + '</td><td>' +
        (r2.avgTsubo ? Math.round(r2.avgTsubo / 10000).toLocaleString() + '万円' : '算出不可') + '</td></tr>';
    }
    html += '</table>';
  }

  html += '<p>※「消失件数」は前日まで掲載されていた物件が本日見当たらなくなった件数です。成約（売れた）だけでなく、' +
    '掲載終了・広告切り替え・価格変更に伴う再掲載なども含まれるため、実際の成約件数とは一致しない場合があります。</p>';
  html += '<p>※平均坪単価は、価格・面積の両方が一覧ページから取得できた物件のみで算出した単純平均です。</p>';
  html += '<p>※本メールはSUUMO掲載情報をもとに自動集計したものです。' + yearMonth + 'の月次累計はスプレッドシートの「' + LT_SHEET_MONTHLY + '」タブをご確認ください。</p>';

  var options = { htmlBody: html };
  if (cc) options.cc = cc;
  GmailApp.sendEmail(recipient, subject, 'HTML形式でご覧ください。', options);
}

/* ===================== 動作確認用 ===================== */

/**
 * 導入時にまずこれを実行する。1区・1種別だけ取得して、
 * 抽出できた件数とサンプル3件をログに出す。
 * 例: selfTestOneCategory('setagaya', 'land')
 *     selfTestOneCategory('setagaya', 'house_used')
 */
function selfTestOneCategory(wardKey, categoryKey) {
  var cat = LT_CATEGORIES.filter(function (c) { return c.key === categoryKey; })[0];
  if (!cat) throw new Error('unknown categoryKey: ' + categoryKey + '（land / house_new / house_used のいずれか）');

  var url = buildListUrl_(cat.pathPrefix, wardKey, 1);
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log('URL: ' + url);
  Logger.log('HTTPステータス: ' + res.getResponseCode());
  var html = res.getContentText();
  Logger.log('HTML長: ' + html.length);

  var listings = parseListingsFromHtml_(html, cat.pathPrefix);
  Logger.log('1ページ目で抽出できた物件数: ' + listings.length);
  Logger.log('サンプル: ' + JSON.stringify(listings.slice(0, 3), null, 2));

  if (listings.length === 0) {
    Logger.log('抽出0件です。実際のページをブラウザで開いて件数を確認し、' +
      'HTML長がおかしい場合はブロック（bot判定）の可能性があります。');
  }
}

/** 全区・全種別を対象に、1ページ目だけの簡易チェックを行う（本番実行前の全体確認用）。 */
function selfTestAllCategories() {
  for (var w = 0; w < LT_WARDS.length; w++) {
    for (var c = 0; c < LT_CATEGORIES.length; c++) {
      Logger.log('=== ' + LT_WARDS[w].name + ' / ' + LT_CATEGORIES[c].label + ' ===');
      selfTestOneCategory(LT_WARDS[w].key, LT_CATEGORIES[c].key);
      Utilities.sleep(300);
    }
  }
}

/** 送信テスト（実際の集計は行わず、ダミー数値でメール文面だけ確認する）。 */
function previewListingMail() {
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var dummy = [];
  for (var w = 0; w < LT_WARDS.length; w++) {
    for (var c = 0; c < LT_CATEGORIES.length; c++) {
      dummy.push({
        wardName: LT_WARDS[w].name, categoryLabel: LT_CATEGORIES[c].label, group: LT_CATEGORIES[c].group || LT_CATEGORIES[c].label,
        current: 0, added: 0, removed: 0, avgTsubo: 0
      });
    }
  }
  sendDailyListingMail_(today, today.substring(0, 7), dummy, SpreadsheetApp.getActiveSpreadsheet());
  Logger.log('送信しました（ダミー数値）。文面を確認してください。');
}
