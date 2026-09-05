/**
 * 都心3区（千代田・中央・港）高級マンション ウォッチ
 *
 * 国土交通省「不動産情報ライブラリ」API から成約・取引価格を取り込み、
 * 坪単価を計算してスプレッドシートに蓄積する。あわせて手入力の売出ウォッチ表を
 * 再計算し、週次でダイジェストメールを送る。
 *
 * 作られるシート:
 *   物件マスタ   … 定点観測する物件（銘柄）の一覧。売出・成約の集計がぶら下がる
 *   成約データ   … APIから取り込んだ1件1行の明細（重複は取り込まない）
 *   売出ウォッチ … 現在売り出し中の物件の表。坪単価・経過日数・値下げ率は自動計算
 *   価格履歴     … 売出価格を書き換えるたびに自動で1行たまる改定履歴
 *   月次サマリ   … 区×月の件数・平均坪単価・中央値
 *   _watchlog    … 取り込みの実行記録
 *
 * スクリプトプロパティ:
 *   REINFOLIB_KEY   不動産情報ライブラリのAPIキー（必須）
 *   SPREADSHEET_ID  対象スプレッドシートID（コンテナバインドでない場合のみ必須）
 *   RECIPIENT       ダイジェストメールの宛先（メールを使う場合のみ必須）
 *   CC              （任意）CCアドレス。カンマ区切り
 *   MIN_PRICE       （任意）高級帯とみなす下限価格（円）。既定 100000000
 */

var TZ_MW = 'Asia/Tokyo';
var TSUBO = 3.305785;               // 1坪 = 3.305785 ㎡
var API_BASE = 'https://www.reinfolib.mlit.go.jp/ex-api/external/XIT001';
var AREA_CODE = '13';               // 東京都

/** 都心3区。市区町村コードは不動産情報ライブラリの XIT002 と同じ。 */
var CITIES = [
  ['13101', '千代田区'],
  ['13102', '中央区'],
  ['13103', '港区']
];

/** 取り込むのはマンションのみ。 */
var TARGET_TYPES = ['中古マンション等'];

var SHEET_BUILDING = '物件マスタ';
var SHEET_DEAL = '成約データ';
var SHEET_WATCH = '売出ウォッチ';
var SHEET_HISTORY = '価格履歴';
var SHEET_SUMMARY = '月次サマリ';
var SHEET_MWLOG = '_watchlog';

/**
 * 物件マスタ。定点観測したい物件を1棟1行で登録する。
 * 「地区名」「竣工年」は成約データとの照合キー。B_ 定数は0始まりの列位置。
 */
var HEAD_BUILDING = [
  '物件名', '区', '地区名', '竣工年', '総戸数', 'ウォッチ区分', 'メモ',
  '売出中(件)', '売出坪単価(万円)', '90日超(件)',
  '成約(件)', '成約坪単価(万円)', '成約レンジ(万円)', '直近成約', '更新日時'
];

var B_NAME = 0;
var B_WARD = 1;
var B_DISTRICT = 2;
var B_BUILT = 3;
var B_MODE = 5;
var B_ON_SALE = 7;
var B_ON_SALE_TSUBO = 8;
var B_STALE = 9;
var B_DEALS = 10;
var B_DEAL_TSUBO = 11;
var B_DEAL_RANGE = 12;
var B_LAST_DEAL = 13;
var B_UPDATED = 14;

/** 成約データとの照合で許す竣工年のズレ（年）。 */
var BUILT_TOLERANCE = 1;

var HEAD_DEAL = [
  '取込日時', '時期', '区', '地区名', '取引価格(円)', '専有面積(㎡)', '坪単価(万円)',
  '間取り', '築年', '築年数', '構造', '用途', 'リフォーム', '都市計画', '価格情報区分', '備考', 'キー'
];

/**
 * 売出ウォッチの列。C_ 定数は0始まりの列位置。
 * 自動計算：当初価格・坪単価・経過日数・値下げ率・乖離率。手で触らないこと。
 */
var HEAD_WATCH = [
  '登録日', '状態', '区', '所在', '物件名', '部屋番号', '売出価格(万円)', '当初価格(万円)',
  '専有面積(㎡)', '坪単価(万円)', '間取り', '階', '築年', '売出日', '経過日数',
  '値下げ率(%)', '成約価格(万円)', '成約日', '乖離率(%)', '情報元', 'メモ'
];

var C_REGISTERED = 0;
var C_STATUS = 1;
var C_NAME = 4;
var C_PRICE = 6;
var C_FIRST_PRICE = 7;
var C_AREA = 8;
var C_TSUBO = 9;
var C_LISTED = 13;
var C_DAYS = 14;
var C_CUT = 15;
var C_DEAL_PRICE = 16;
var C_DEAL_DATE = 17;
var C_GAP = 18;

var HEAD_HISTORY = ['記録日時', '区', '物件名', '部屋番号', '変更前(万円)', '変更後(万円)', '増減(万円)', '増減率(%)'];

var HEAD_SUMMARY = ['集計月', '区', '件数', '平均坪単価(万円)', '中央値坪単価(万円)', '平均価格(万円)', '最高価格(万円)'];

var HEAD_MWLOG = ['実行日時', '処理', '対象', '取得件数', '追加件数', 'メモ'];

// ---------------------------------------------------------------- 入口

/** スプレッドシートを開いたときにメニューを出す。 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('マンションウォッチ')
    .addItem('集計を更新する', 'refreshAll')
    .addItem('地区名の一覧を見る', 'listDistrictNames')
    .addSeparator()
    .addItem('メール文面を確認する（送信しない）', 'previewMarketDigest')
    .addToUi();
}

/** 取り込みはせず、手元のデータだけで集計をやり直す。メニューから呼ぶ。 */
function refreshAll() {
  refreshWatchlist();
  rebuildSummary();
  rebuildBuildingStats();
}

/** 最初に1回だけ実行する。シートと見出しを作る。 */
function setupMarketWatch() {
  var ss = book_();
  sheet_(ss, SHEET_BUILDING, HEAD_BUILDING);
  sheet_(ss, SHEET_DEAL, HEAD_DEAL);
  sheet_(ss, SHEET_WATCH, HEAD_WATCH);
  sheet_(ss, SHEET_HISTORY, HEAD_HISTORY);
  sheet_(ss, SHEET_SUMMARY, HEAD_SUMMARY);
  sheet_(ss, SHEET_MWLOG, HEAD_MWLOG);
  Logger.log('シートを用意しました。次に importLatestTransactions を実行してください。');
}

/** 定期トリガーから呼ぶ本番用エントリポイント。直近8四半期を取り込み、集計まで行う。 */
function importLatestTransactions() {
  var periods = recentQuarters_(8);
  var total = 0;
  var added = 0;
  for (var i = 0; i < periods.length; i++) {
    var r = importQuarter_(periods[i][0], periods[i][1]);
    total += r.fetched;
    added += r.added;
  }
  rebuildSummary();
  refreshWatchlist();
  rebuildBuildingStats();
  log_('取込', periods.length + '四半期', total, added, '');
  Logger.log('取得 ' + total + '件 / 新規 ' + added + '件');
}

/** 期間を指定して取り込む。過去分をまとめて入れたいときに手で実行する。 */
function importTransactionsRange(fromYear, fromQuarter, toYear, toQuarter) {
  var total = 0;
  var added = 0;
  var y = fromYear;
  var q = fromQuarter;
  while (y < toYear || (y === toYear && q <= toQuarter)) {
    var r = importQuarter_(y, q);
    total += r.fetched;
    added += r.added;
    q++;
    if (q > 4) { q = 1; y++; }
  }
  rebuildSummary();
  log_('期間取込', fromYear + 'Q' + fromQuarter + '〜' + toYear + 'Q' + toQuarter, total, added, '');
  Logger.log('取得 ' + total + '件 / 新規 ' + added + '件');
}

// ---------------------------------------------------------------- 取り込み

function importQuarter_(year, quarter) {
  var ss = book_();
  var sh = sheet_(ss, SHEET_DEAL, HEAD_DEAL);
  var known = existingKeys_(sh);
  var rows = [];
  var fetched = 0;
  var now = new Date();

  for (var i = 0; i < CITIES.length; i++) {
    var code = CITIES[i][0];
    var name = CITIES[i][1];
    var data = callApi_(year, quarter, code);
    fetched += data.length;

    for (var j = 0; j < data.length; j++) {
      var d = data[j];
      if (TARGET_TYPES.indexOf(String(d.Type || '')) < 0) continue;

      var price = num_(d.TradePrice);
      var area = num_(d.Area);
      if (!price || !area) continue;

      var key = [d.Period, name, d.DistrictName, area, price, d.FloorPlan, d.BuildingYear].join('|');
      if (known[key]) continue;
      known[key] = true;

      var built = year_(d.BuildingYear);
      rows.push([
        now,
        String(d.Period || (year + '年第' + quarter + '四半期')),
        name,
        String(d.DistrictName || ''),
        price,
        area,
        round_(price / (area / TSUBO) / 10000, 1),
        String(d.FloorPlan || ''),
        String(d.BuildingYear || ''),
        built ? (year - built) : '',
        String(d.Structure || ''),
        String(d.Use || ''),
        String(d.Renovation || ''),
        String(d.CityPlanning || ''),
        String(d.PriceCategory || ''),
        String(d.Remarks || ''),
        key
      ]);
    }
    Utilities.sleep(1200);  // 連続実行しないよう間隔を空ける（API側の要請）
  }

  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEAD_DEAL.length).setValues(rows);
  }
  log_('四半期取込', year + 'Q' + quarter, fetched, rows.length, '');
  return { fetched: fetched, added: rows.length };
}

function callApi_(year, quarter, city) {
  var key = prop_('REINFOLIB_KEY');
  if (!key) throw new Error('スクリプトプロパティ REINFOLIB_KEY が未設定です。');

  var url = API_BASE +
    '?year=' + encodeURIComponent(year) +
    '&quarter=' + encodeURIComponent(quarter) +
    '&area=' + AREA_CODE +
    '&city=' + encodeURIComponent(city);

  var res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'Ocp-Apim-Subscription-Key': key },
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  if (code !== 200) {
    log_('APIエラー', city + ' ' + year + 'Q' + quarter, 0, 0, 'HTTP ' + code);
    throw new Error('APIが HTTP ' + code + ' を返しました（' + city + ' ' + year + 'Q' + quarter + '）: ' +
      res.getContentText().slice(0, 200));
  }

  var body = res.getContentText();
  var parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    // gzip で返ってきた場合の保険
    var blob = res.getBlob().setContentType('application/x-gzip');
    parsed = JSON.parse(Utilities.ungzip(blob).getDataAsString('UTF-8'));
  }
  if (!parsed || parsed.status !== 'OK' || !parsed.data) return [];
  return parsed.data;
}

// ---------------------------------------------------------------- 集計

/** 成約データを 月×区 で集計し直す。 */
function rebuildSummary() {
  var ss = book_();
  var deal = sheet_(ss, SHEET_DEAL, HEAD_DEAL);
  var last = deal.getLastRow();
  if (last < 2) return;

  var values = deal.getRange(2, 1, last - 1, HEAD_DEAL.length).getValues();
  var minPrice = Number(prop_('MIN_PRICE') || 100000000);
  var buckets = {};

  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    var period = String(v[1]);
    var ward = String(v[2]);
    var price = Number(v[4]);
    var tsubo = Number(v[6]);
    if (!price || price < minPrice) continue;   // 高級帯のみ

    var k = period + '|' + ward;
    if (!buckets[k]) buckets[k] = { period: period, ward: ward, tsubo: [], price: [] };
    buckets[k].tsubo.push(tsubo);
    buckets[k].price.push(price / 10000);
  }

  var rows = [];
  Object.keys(buckets).sort().forEach(function (k) {
    var b = buckets[k];
    rows.push([
      b.period, b.ward, b.tsubo.length,
      round_(avg_(b.tsubo), 1),
      round_(median_(b.tsubo), 1),
      round_(avg_(b.price), 0),
      round_(Math.max.apply(null, b.price), 0)
    ]);
  });

  var sh = sheet_(ss, SHEET_SUMMARY, HEAD_SUMMARY);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, HEAD_SUMMARY.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, HEAD_SUMMARY.length).setValues(rows);
}

/**
 * 物件マスタの集計をやり直す。
 *
 * 売出中の数字は `売出ウォッチ` の物件名を突き合わせて出す（完全一致）。
 * 成約の数字は `成約データ`（国交省API）から拾うが、APIには建物名が入っていないため
 * 「区 ＋ 地区名 ＋ 竣工年（±BUILT_TOLERANCE年）」が一致する取引を候補として集める。
 * 同じ町丁目に同年竣工の別のマンションがあれば、それも混ざる。
 * あくまで目安であり、1件1件が確実にその物件のものだとは言えない。
 */
function rebuildBuildingStats() {
  var ss = book_();
  var bs = sheet_(ss, SHEET_BUILDING, HEAD_BUILDING);
  var last = bs.getLastRow();
  if (last < 2) return;

  var range = bs.getRange(2, 1, last - 1, HEAD_BUILDING.length);
  var buildings = range.getValues();
  var deals = readSheet_(ss, SHEET_DEAL, HEAD_DEAL);
  var watch = readSheet_(ss, SHEET_WATCH, HEAD_WATCH);
  var now = new Date();

  for (var i = 0; i < buildings.length; i++) {
    var b = buildings[i];
    if (!b[B_NAME]) continue;
    if (String(b[B_MODE]) === '停止') continue;

    // --- 売出中（物件名の完全一致） ---
    var mine = watch.filter(function (r) {
      return String(r[C_NAME]) === String(b[B_NAME]);
    });
    var live = mine.filter(function (r) {
      var st = String(r[C_STATUS]);
      return st !== '成約' && st !== '取下';
    });
    b[B_ON_SALE] = live.length;
    b[B_ON_SALE_TSUBO] = live.length
      ? round_(avg_(live.map(function (r) { return Number(r[C_TSUBO]); }).filter(Boolean)), 1)
      : '';
    b[B_STALE] = live.filter(function (r) { return Number(r[C_DAYS]) >= 90; }).length;

    // --- 成約（区＋地区名＋竣工年で照合） ---
    var built = Number(b[B_BUILT]);
    var hits = deals.filter(function (r) {
      if (String(r[2]) !== String(b[B_WARD])) return false;
      if (String(r[3]) !== String(b[B_DISTRICT])) return false;
      if (!built) return true;
      var y = year_(r[8]);
      return y && Math.abs(y - built) <= BUILT_TOLERANCE;
    });

    b[B_DEALS] = hits.length;
    if (hits.length) {
      var tsubos = hits.map(function (r) { return Number(r[6]); }).filter(Boolean);
      var prices = hits.map(function (r) { return Number(r[4]) / 10000; }).filter(Boolean);
      b[B_DEAL_TSUBO] = round_(median_(tsubos), 1);
      b[B_DEAL_RANGE] = prices.length
        ? round_(Math.min.apply(null, prices), 0) + '〜' + round_(Math.max.apply(null, prices), 0)
        : '';
      b[B_LAST_DEAL] = hits.map(function (r) { return String(r[1]); }).sort().pop();
    } else {
      b[B_DEAL_TSUBO] = '';
      b[B_DEAL_RANGE] = '';
      b[B_LAST_DEAL] = '';
    }
    b[B_UPDATED] = now;
  }
  range.setValues(buildings);
}

/**
 * 成約データに実際に入っている「区 ＋ 地区名」を一覧でログに出す。
 * 物件マスタの「地区名」は、この表記と1文字も違わないよう合わせること
 * （例：港区の「南麻布」。丁目は入らない）。
 */
function listDistrictNames() {
  var deals = readSheet_(book_(), SHEET_DEAL, HEAD_DEAL);
  var seen = {};
  for (var i = 0; i < deals.length; i++) {
    var k = deals[i][2] + '\t' + deals[i][3];
    seen[k] = (seen[k] || 0) + 1;
  }
  var lines = Object.keys(seen).sort().map(function (k) {
    return k.replace('\t', ' / ') + '  (' + seen[k] + '件)';
  });
  Logger.log('成約データにある地区名 ' + lines.length + '種\n' + lines.join('\n'));
  return lines;
}

/** 売出ウォッチ表の自動列を、全行まとめて計算し直す。 */
function refreshWatchlist() {
  var ss = book_();
  var sh = sheet_(ss, SHEET_WATCH, HEAD_WATCH);
  var last = sh.getLastRow();
  if (last < 2) return;

  var range = sh.getRange(2, 1, last - 1, HEAD_WATCH.length);
  var values = range.getValues();
  for (var i = 0; i < values.length; i++) recalc_(values[i]);
  range.setValues(values);
}

/**
 * 1行ぶんの自動列を計算する。行の配列を直接書き換える。
 *   当初価格 … 空なら現在の売出価格で埋める（初回登録ぶん）
 *   坪単価   … 売出価格 ÷（面積 ÷ 3.305785）。成約後は成約価格で計算する
 *   経過日数 … 売出日から今日（成約済みなら成約日）まで
 *   値下げ率 … （当初価格 − 現売出価格）÷ 当初価格
 *   乖離率   … （成約価格 − 当初価格）÷ 当初価格。査定と結果のズレ
 */
function recalc_(v) {
  var price = Number(v[C_PRICE]);
  var area = Number(v[C_AREA]);
  var deal = Number(v[C_DEAL_PRICE]);

  if (!v[C_FIRST_PRICE] && price) v[C_FIRST_PRICE] = price;
  var first = Number(v[C_FIRST_PRICE]);

  var basis = deal || price;
  v[C_TSUBO] = (basis && area) ? round_(basis / (area / TSUBO), 1) : '';

  var from = v[C_LISTED];
  var to = (v[C_DEAL_DATE] instanceof Date) ? v[C_DEAL_DATE] : new Date();
  v[C_DAYS] = (from instanceof Date) ? Math.floor((to - from) / 86400000) : '';

  v[C_CUT] = (first > 0 && price) ? round_((first - price) / first * 100, 1) : '';
  v[C_GAP] = (first > 0 && deal) ? round_((deal - first) / first * 100, 1) : '';
}

/**
 * 売出ウォッチを手で編集したときに走る。インストール型トリガーで登録すること
 * （価格履歴シートへの書き込みがあるため、単純トリガーでは権限が足りない）。
 *
 *   売出価格を書き換えた → 価格履歴に1行残す
 *   状態を「成約」にした → 成約日が空なら今日を入れる
 *   物件名を入れた       → 登録日・状態・売出日の空欄を埋める
 * いずれの場合もその行の自動列を計算し直す。
 */
function onEditMarketWatch(e) {
  if (!e || !e.range) return;
  var sh = e.range.getSheet();
  if (sh.getName() !== SHEET_WATCH) return;

  var row = e.range.getRow();
  var col = e.range.getColumn();
  if (row < 2 || col > HEAD_WATCH.length) return;

  var range = sh.getRange(row, 1, 1, HEAD_WATCH.length);
  var v = range.getValues()[0];
  var today = new Date();

  if (col - 1 === C_PRICE) {
    var before = Number(String(e.oldValue == null ? '' : e.oldValue).replace(/[^0-9.\-]/g, ''));
    var after = Number(v[C_PRICE]);
    if (before && after && before !== after) {
      sheet_(book_(), SHEET_HISTORY, HEAD_HISTORY).appendRow([
        today, v[2], v[C_NAME], v[5], before, after,
        round_(after - before, 1), round_((after - before) / before * 100, 1)
      ]);
    }
  }

  if (col - 1 === C_STATUS && String(v[C_STATUS]) === '成約' && !v[C_DEAL_DATE]) {
    v[C_DEAL_DATE] = today;
  }

  if (v[C_NAME]) {
    if (!v[C_REGISTERED]) v[C_REGISTERED] = today;
    if (!v[C_STATUS]) v[C_STATUS] = '売出中';
    if (!v[C_LISTED]) v[C_LISTED] = v[C_REGISTERED];
  }

  recalc_(v);
  range.setValues([v]);
}

// ---------------------------------------------------------------- メール

/** 送信せずに文面をログ出力する確認用。 */
function previewMarketDigest() {
  digest_(true);
}

/** 週次トリガーから呼ぶ本番用。 */
function sendMarketDigest() {
  digest_(false);
}

function digest_(isPreview) {
  var ss = book_();
  var html = buildDigestHtml_(ss);
  var subject = '【都心3区マンション ウォッチ】' +
    Utilities.formatDate(new Date(), TZ_MW, 'yyyy年M月d日') + '時点';

  if (isPreview) {
    Logger.log(subject);
    Logger.log(html);
    return;
  }
  var to = prop_('RECIPIENT');
  if (!to) throw new Error('スクリプトプロパティ RECIPIENT が未設定です。');
  var opts = { htmlBody: html };
  var cc = prop_('CC');
  if (cc) opts.cc = cc;
  GmailApp.sendEmail(to, subject, html.replace(/<[^>]+>/g, ''), opts);
  log_('メール送信', to, 0, 0, subject);
}

function buildDigestHtml_(ss) {
  var minPrice = Number(prop_('MIN_PRICE') || 100000000);
  var out = [];
  out.push('<p>都心3区（千代田・中央・港）の高級マンション（' +
    (minPrice / 100000000) + '億円以上）のウォッチ結果です。</p>');

  // 銘柄別（物件マスタ）。定点観測している物件を先頭に出す
  var bs = readSheet_(ss, SHEET_BUILDING, HEAD_BUILDING).filter(function (b) {
    return b[B_NAME] && String(b[B_MODE]) !== '停止';
  });
  if (bs.length) {
    bs.sort(function (x, y) {
      var rank = function (b) { return String(b[B_MODE]) === '重点' ? 0 : 1; };
      return rank(x) - rank(y) || String(x[B_WARD]).localeCompare(String(y[B_WARD]));
    });
    out.push('<h3>定点観測している物件 ' + bs.length + '棟</h3>');
    out.push(table_(
      ['物件名', '区', '売出中', '売出坪単価', '90日超', '成約', '成約坪単価', '成約レンジ(万円)', '直近成約'],
      bs.map(function (b) {
        return [
          b[B_NAME], b[B_WARD], b[B_ON_SALE], b[B_ON_SALE_TSUBO], b[B_STALE],
          b[B_DEALS], b[B_DEAL_TSUBO], b[B_DEAL_RANGE], b[B_LAST_DEAL]
        ];
      })));

    // 売出坪単価が成約坪単価をはっきり上回っている＝強気に出ている銘柄
    var rich = bs.filter(function (b) {
      var a = Number(b[B_ON_SALE_TSUBO]);
      var d = Number(b[B_DEAL_TSUBO]);
      return a && d && (a - d) / d >= 0.10;
    });
    if (rich.length) {
      out.push('<p>売出坪単価が成約実績を <b>10%以上</b> 上回っている銘柄：' +
        rich.map(function (b) {
          return esc_(b[B_NAME]) + '（+' +
            round_((Number(b[B_ON_SALE_TSUBO]) - Number(b[B_DEAL_TSUBO])) /
              Number(b[B_DEAL_TSUBO]) * 100, 0) + '%）';
        }).join('、') + '</p>');
    }
  }

  // 直近の成約サマリ
  var sum = ss.getSheetByName(SHEET_SUMMARY);
  if (sum && sum.getLastRow() > 1) {
    var rows = sum.getRange(2, 1, sum.getLastRow() - 1, HEAD_SUMMARY.length).getValues();
    var recent = rows.slice(-9);
    out.push('<h3>成約（直近）</h3>');
    out.push(table_(HEAD_SUMMARY, recent));
  } else {
    out.push('<p>成約データはまだありません。</p>');
  }

  // 売出ウォッチ
  var w = ss.getSheetByName(SHEET_WATCH);
  if (w && w.getLastRow() > 1) {
    var wv = w.getRange(2, 1, w.getLastRow() - 1, HEAD_WATCH.length).getValues();
    var active = wv.filter(function (r) {
      var st = String(r[C_STATUS]);
      return st !== '成約' && st !== '取下';
    });
    var stale = active.filter(function (r) { return Number(r[C_DAYS]) >= 90; });
    var cut = active.filter(function (r) { return Number(r[C_CUT]) > 0; });

    out.push('<h3>売出中 ' + active.length + '件</h3>');
    out.push('<ul>');
    out.push('<li>90日以上 売れ残り：<b>' + stale.length + '件</b></li>');
    out.push('<li>値下げあり：<b>' + cut.length + '件</b></li>');
    out.push('</ul>');

    if (cut.length) {
      out.push('<h4>値下げがあった物件</h4>');
      out.push(table_(
        ['区', '物件名', '売出価格(万円)', '坪単価(万円)', '経過日数', '値下げ率(%)'],
        cut.map(function (r) {
          return [r[2], r[C_NAME], r[C_PRICE], r[C_TSUBO], r[C_DAYS], r[C_CUT]];
        })));
    }

    if (stale.length) {
      out.push('<h4>90日以上動いていない物件</h4>');
      out.push(table_(
        ['区', '物件名', '売出価格(万円)', '坪単価(万円)', '経過日数'],
        stale.map(function (r) {
          return [r[2], r[C_NAME], r[C_PRICE], r[C_TSUBO], r[C_DAYS]];
        })));
    }

    // 直近30日に成約した物件。当初売出価格からどれだけ動いたかを見る
    var since = new Date(new Date().getTime() - 30 * 86400000);
    var done = wv.filter(function (r) {
      return String(r[C_STATUS]) === '成約' && (r[C_DEAL_DATE] instanceof Date) && r[C_DEAL_DATE] >= since;
    });
    if (done.length) {
      out.push('<h4>直近30日の成約 ' + done.length + '件</h4>');
      out.push(table_(
        ['区', '物件名', '当初価格(万円)', '成約価格(万円)', '坪単価(万円)', '売出〜成約(日)', '乖離率(%)'],
        done.map(function (r) {
          return [r[2], r[C_NAME], r[C_FIRST_PRICE], r[C_DEAL_PRICE], r[C_TSUBO], r[C_DAYS], r[C_GAP]];
        })));
    }
  } else {
    out.push('<p>売出ウォッチ表は空です。</p>');
  }

  out.push('<p style="color:#666;font-size:12px">' +
    '※ 成約データは国土交通省「不動産情報ライブラリ」の取引価格・成約価格情報です。' +
    '公表は四半期ごとで、直近の取引が反映されるまで数カ月かかります。<br>' +
    '※ 売出ウォッチは手入力の表です。数値はそのまま集計しています。<br>' +
    '※ 銘柄別の成約は「区＋地区名＋竣工年」で拾った候補です。APIに建物名が' +
    '入らないため、同じ町丁目に同年竣工の別棟があると混ざります。目安としてご覧ください。<br>' +
    '※ 乖離率は「成約価格が当初の売出価格からどれだけ動いたか」です。' +
    'マイナスが大きいほど、最初の売出価格が強気だったことを示します。</p>');
  return out.join('\n');
}

function table_(head, rows) {
  var s = '<table border="1" cellpadding="6" cellspacing="0" ' +
    'style="border-collapse:collapse;font-size:13px"><tr>';
  head.forEach(function (h) { s += '<th style="background:#f2f2f2">' + esc_(h) + '</th>'; });
  s += '</tr>';
  rows.forEach(function (r) {
    s += '<tr>';
    r.forEach(function (c) { s += '<td>' + esc_(c) + '</td>'; });
    s += '</tr>';
  });
  return s + '</table>';
}

// ---------------------------------------------------------------- 小物

function book_() {
  var id = prop_('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('スプレッドシートが特定できません。SPREADSHEET_ID を設定してください。');
  return ss;
}

function sheet_(ss, name, head) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** シートの2行目以降を配列で返す。空なら空配列。 */
function readSheet_(ss, name, head) {
  var sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, head.length).getValues();
}

function existingKeys_(sh) {
  var map = {};
  var last = sh.getLastRow();
  if (last < 2) return map;
  var col = HEAD_DEAL.length;   // キーは最終列
  var vals = sh.getRange(2, col, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) map[String(vals[i][0])] = true;
  return map;
}

function log_(action, target, fetched, added, note) {
  try {
    var sh = sheet_(book_(), SHEET_MWLOG, HEAD_MWLOG);
    sh.appendRow([new Date(), action, target, fetched, added, note]);
  } catch (e) { /* ログで落とさない */ }
}

/** 直近 n 四半期を新しい順で返す。公表が遅れるため2四半期ぶん手前から数える。 */
function recentQuarters_(n) {
  var now = new Date();
  var y = Number(Utilities.formatDate(now, TZ_MW, 'yyyy'));
  var q = Math.floor(Number(Utilities.formatDate(now, TZ_MW, 'M')) / 3.001) + 1;
  q -= 2;
  while (q < 1) { q += 4; y -= 1; }

  var out = [];
  for (var i = 0; i < n; i++) {
    out.push([y, q]);
    q--;
    if (q < 1) { q = 4; y--; }
  }
  return out;
}

function prop_(k) {
  return PropertiesService.getScriptProperties().getProperty(k);
}

function num_(v) {
  var n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

/** "1998年" / "平成10年" のどちらでも西暦を返す。 */
function year_(s) {
  s = String(s || '');
  var m = s.match(/(\d{4})年/);
  if (m) return Number(m[1]);
  var e = s.match(/(明治|大正|昭和|平成|令和)\s*(\d+|元)年/);
  if (!e) return 0;
  var base = { '明治': 1867, '大正': 1911, '昭和': 1925, '平成': 1988, '令和': 2018 }[e[1]];
  var yy = e[2] === '元' ? 1 : Number(e[2]);
  return base + yy;
}

function avg_(a) {
  if (!a.length) return 0;
  var s = 0;
  for (var i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
}

function median_(a) {
  if (!a.length) return 0;
  var b = a.slice().sort(function (x, y) { return x - y; });
  var m = Math.floor(b.length / 2);
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}

function round_(n, d) {
  var p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

function esc_(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
