/**
 * 実際の成約価格の裏取り（国土交通省「不動産情報ライブラリ」API）
 *
 * 「取込」から積み上げる在庫データでは、掲載が消えた理由（成約か取下げか）までは分からない。
 * そこで、国交省が公表している実際の取引価格情報を四半期ごとに取り込み、
 * 恵比寿エリアで実際に何件・いくらで成約したかを別途ためておく。
 *
 * 注意:
 *   - 公表は取引時期から4〜5か月ほど遅れる。当月の答え合わせには使えない。
 *   - 集計単位は「四半期 × 地区名（恵比寿／恵比寿南／恵比寿西）」で、個別物件とは紐づかない。
 *   - アパート・ビルなど事業用の一棟物は、この統計では「宅地(土地と建物)」に含まれる。
 *
 * 事前準備:
 *   不動産情報ライブラリ（https://www.reinfolib.mlit.go.jp/）でAPIキーを発行し、
 *   スクリプトプロパティ REINFOLIB_API_KEY に登録する。
 *
 * スクリプトプロパティ:
 *   REINFOLIB_API_KEY  APIキー（必須）
 *   RL_CITY_CODE       市区町村コード。既定 '13113'（渋谷区）
 *   RL_YEARS_BACK      さかのぼる年数。既定 '3'
 *
 * 想定トリガー: 時間主導型 / 月1回（公表が四半期ごとのため毎日は不要）
 */

var RL_ENDPOINT = 'https://www.reinfolib.mlit.go.jp/ex-api/external/XIT001';
var RL_PREF_CODE = '13';           // 東京都

var RL_SHEET_TRADES = '成約実績';
var RL_SHEET_SUMMARY = '成約実績・四半期';

var RL_HEAD_TRADES = ['取込日', '取引時期', '年', '四半期', '種別', '地区名',
  '取引価格万円', '面積㎡', '坪単価万円', '延床面積㎡', '間取り', '建築年', '構造', '用途',
  '最寄駅', '駅徒歩分', '都市計画', '建ぺい率', '容積率', '取引キー'];

var RL_HEAD_SUMMARY = ['年四半期', '種別', '成約件数', '中央値価格万円', '中央値坪単価万円', '平均面積㎡'];

/** 手動またはトリガーから呼ぶエントリポイント。 */
function fetchEbisuTrades() {
  var ss = lsOpenSpreadsheet_();
  var key = lsProp_('REINFOLIB_API_KEY', '');
  if (!key) {
    throw new Error('スクリプトプロパティ REINFOLIB_API_KEY が未設定です。');
  }

  var city = lsProp_('RL_CITY_CODE', '13113');
  var yearsBack = lsNum_(lsProp_('RL_YEARS_BACK', '3')) || 3;
  var thisYear = Number(lsToday_().slice(0, 4));

  var existing = rlExistingKeys_(ss);
  var rows = [];
  var today = lsToday_();
  var fetched = 0;

  for (var year = thisYear - yearsBack; year <= thisYear; year++) {
    for (var q = 1; q <= 4; q++) {
      var records = rlFetch_(key, year, q, city);
      fetched += records.length;
      records.forEach(function (r) {
        var rec = rlNormalize_(r, year, q);
        if (!rec) return;
        if (!lsInArea_(rec.district)) return;
        if (existing[rec.key]) return;
        existing[rec.key] = true;
        rows.push([today, rec.period, rec.year, rec.quarter, rec.type, rec.district,
          rec.price, rec.area, rec.tsubo, rec.floorArea, rec.layout, rec.built, rec.structure,
          rec.use, rec.station, rec.walk, rec.cityPlanning, rec.coverage, rec.floorRatio, rec.key]);
      });
    }
  }

  if (rows.length) {
    var sh = lsSheet_(ss, RL_SHEET_TRADES, RL_HEAD_TRADES);
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, RL_HEAD_TRADES.length).setValues(rows);
  }
  rlRebuildSummary_(ss);

  Logger.log('APIから ' + fetched + '件取得、うち新規 ' + rows.length + '件を追加しました。');
  return { fetched: fetched, added: rows.length };
}

/** APIを1四半期ぶん叩く。取れなければ空配列を返して次に進む。 */
function rlFetch_(key, year, quarter, city) {
  var url = RL_ENDPOINT
    + '?year=' + encodeURIComponent(year)
    + '&quarter=' + encodeURIComponent(quarter)
    + '&area=' + encodeURIComponent(RL_PREF_CODE)
    + '&city=' + encodeURIComponent(city);

  var res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'Ocp-Apim-Subscription-Key': key },
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log(year + 'Q' + quarter + ' の取得に失敗しました: ' + err);
    return [];
  }

  if (res.getResponseCode() !== 200) {
    Logger.log(year + 'Q' + quarter + ' の応答が ' + res.getResponseCode() + ' でした: '
      + res.getContentText().slice(0, 200));
    return [];
  }
  var body;
  try {
    body = JSON.parse(res.getContentText());
  } catch (err) {
    Logger.log(year + 'Q' + quarter + ' の応答を解釈できませんでした。');
    return [];
  }
  return (body && body.data) ? body.data : [];
}

/** APIの1レコードを、蓄積用の形に直す。 */
function rlNormalize_(r, year, quarter) {
  var type = rlType_(r.Type);
  if (!type) return null;   // 農地・林地などは対象外

  var price = lsIsNum_(Number(r.TradePrice)) ? lsRound_(Number(r.TradePrice) / 10000, 0) : '';
  var area = lsIsNum_(Number(r.Area)) ? lsRound_(Number(r.Area), 2) : '';
  var floorArea = lsIsNum_(Number(r.TotalFloorArea)) ? lsRound_(Number(r.TotalFloorArea), 2) : '';
  var base = (type === 'マンション(区分)' && lsIsNum_(floorArea) && floorArea > 0) ? floorArea : area;

  return {
    period: lsText_(r.Period) || (year + '年第' + quarter + '四半期'),
    year: year,
    quarter: quarter,
    type: type,
    district: lsText_(r.DistrictName),
    price: price,
    area: area,
    tsubo: (lsIsNum_(price) && lsIsNum_(base) && base > 0) ? lsRound_(price / (base / LS_TSUBO), 1) : '',
    floorArea: floorArea,
    layout: lsText_(r.FloorPlan),
    built: lsText_(r.BuildingYear),
    structure: lsText_(r.Structure),
    use: lsText_(r.Use),
    station: lsText_(r.NearestStation),
    walk: lsText_(r.TimeToNearestStation),
    cityPlanning: lsText_(r.CityPlanning),
    coverage: lsText_(r.CoverageRatio),
    floorRatio: lsText_(r.FloorAreaRatio),
    key: 'rl:' + lsHash_([year, quarter, r.Type, r.DistrictName, r.TradePrice, r.Area,
      r.TotalFloorArea, r.BuildingYear, r.FloorPlan].join('|'))
  };
}

/** 統計上の種別を、在庫側と同じ呼び方に寄せる。 */
function rlType_(raw) {
  var s = lsText_(raw);
  if (/中古マンション/.test(s)) return 'マンション(区分)';
  if (/土地と建物/.test(s)) return '戸建';
  if (/宅地\(土地\)|^宅地$/.test(s)) return '土地';
  return '';
}

function rlExistingKeys_(ss) {
  var sh = lsSheet_(ss, RL_SHEET_TRADES, RL_HEAD_TRADES);
  var last = sh.getLastRow();
  var keys = {};
  if (last < 2) return keys;
  var col = RL_HEAD_TRADES.indexOf('取引キー') + 1;
  sh.getRange(2, col, last - 1, 1).getValues().forEach(function (v) {
    var k = lsText_(v[0]);
    if (k) keys[k] = true;
  });
  return keys;
}

/** 四半期 × 種別の件数・中央値をまとめ直す。 */
function rlRebuildSummary_(ss) {
  var sh = lsSheet_(ss, RL_SHEET_TRADES, RL_HEAD_TRADES);
  var last = sh.getLastRow();
  if (last < 2) return;

  var values = sh.getRange(2, 1, last - 1, RL_HEAD_TRADES.length).getValues();
  var buckets = {};
  var order = [];

  values.forEach(function (v) {
    var label = lsText_(v[2]) + '-Q' + lsText_(v[3]);
    var type = lsText_(v[4]);
    if (!lsText_(v[2]) || !type) return;
    [type, '合計'].forEach(function (t) {
      var id = label + '|' + t;
      if (!buckets[id]) {
        buckets[id] = { label: label, type: t, prices: [], tsubos: [], areas: [] };
        order.push(id);
      }
      buckets[id].prices.push(lsNumOrBlank_(v[6]));
      buckets[id].tsubos.push(lsNumOrBlank_(v[8]));
      buckets[id].areas.push(lsNumOrBlank_(v[7]));
    });
  });

  order.sort();
  var rows = order.map(function (id) {
    var b = buckets[id];
    return [b.label, b.type, b.prices.length,
      lsMedian_(b.prices), lsMedian_(b.tsubos), lsAverage_(b.areas.filter(lsIsNum_))];
  });

  lsReplaceRange_(ss, RL_SHEET_SUMMARY, RL_HEAD_SUMMARY, rows, function () { return true; });
}
