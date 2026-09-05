/**
 * LandStock.gs のロジック確認（Apps Script の API はスタブで置き換え）
 *
 *   node test/landstock.test.js
 *
 * スプレッドシートを触らずに、価格や面積の読み取り・掲載終了の判定・
 * 日次／月次サマリの数え方が意図どおりかを確かめる。
 * LandStock.gs を直したら、まずこれを通してから Apps Script に貼ること。
 */
const fs = require('fs');
const crypto = require('crypto');

function jstParts(date) {
  const t = new Date(date.getTime() + 9 * 3600 * 1000);
  return {
    y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(),
    H: t.getUTCHours(), M: t.getUTCMinutes()
  };
}
const p2 = n => ('0' + n).slice(-2);

global.Utilities = {
  formatDate(date, tz, fmt) {
    const p = jstParts(date);
    if (fmt === 'yyyy-MM-dd') return `${p.y}-${p2(p.m)}-${p2(p.d)}`;
    if (fmt === 'yyyy-MM') return `${p.y}-${p2(p.m)}`;
    throw new Error('unsupported fmt ' + fmt);
  },
  computeDigest(alg, s) {
    const buf = crypto.createHash('md5').update(s, 'utf8').digest();
    return Array.from(buf).map(b => (b > 127 ? b - 256 : b));
  },
  DigestAlgorithm: { MD5: 'MD5' },
  Charset: { UTF_8: 'UTF-8' },
  parseCsv: s => s.trim().split('\n').map(l => l.split(','))
};

const props = {};
global.PropertiesService = {
  getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null) })
};
global.Logger = { log: () => {} };
global.SpreadsheetApp = {};
global.DriveApp = {};
global.MailApp = {};
global.UrlFetchApp = {};

const src = fs.readFileSync('/home/user/-/gas/LandStock.gs', 'utf8');
eval(src);

let fails = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { fails++; console.log(`  NG ${label}: ${a} != ${e}`); }
  else console.log(`  ok ${label}`);
}

console.log('--- 価格・面積のパース');
eq(lsParsePrice_('1億2,000万円'), 12000, '1億2000万円');
eq(lsParsePrice_('9,800万円'), 9800, '9800万円');
eq(lsParsePrice_('1.2億円'), 12000, '1.2億円');
eq(lsParsePrice_('3億円'), 30000, '3億円');
eq(lsParsePrice_(8500), 8500, '数値');
eq(lsParsePrice_(''), '', '空');
eq(lsParsePrice_('価格応談'), '', '数字なし');
eq(lsParseArea_('132.45㎡'), 132.45, '㎡');
eq(lsParseArea_('40坪'), 132.23, '坪→㎡');
eq(lsParseArea_(''), '', '空');

console.log('--- 種別の寄せ');
eq(lsNormalizeType_('売地'), '土地', '売地');
eq(lsNormalizeType_('中古一戸建'), '戸建', '中古一戸建');
eq(lsNormalizeType_('一棟アパート'), 'アパート', '一棟アパート');
eq(lsNormalizeType_('一棟マンション'), 'アパート', '一棟マンション');
eq(lsNormalizeType_('中古マンション'), 'マンション(区分)', '中古マンション');
eq(lsNormalizeType_('区分所有'), 'マンション(区分)', '区分所有');
eq(lsNormalizeType_('店舗・事務所ビル'), 'ビル', 'ビル');

console.log('--- エリア判定');
props.LS_AREA_KEYWORDS = '恵比寿';
eq(lsInArea_('東京都渋谷区恵比寿南1-2-3'), true, '恵比寿南');
eq(lsInArea_('東京都渋谷区広尾1-1'), false, '広尾は対象外');

console.log('--- 物件キー');
const a = { type: '土地', address: '渋谷区恵比寿1丁目2番3号', landArea: 100.0, bldgArea: '', layout: '', built: '', source: '', sourceId: '' };
const b = { type: '土地', address: '渋谷区恵比寿1-2-3', landArea: 100.0, bldgArea: '', layout: '', built: '', source: '', sourceId: '' };
eq(lsPropertyKey_(a) === lsPropertyKey_(b), true, '丁目表記ゆれでも同一キー');
const c = Object.assign({}, a, { source: 'reins', sourceId: 'X123' });
eq(lsPropertyKey_(c), 'reins:X123', '元IDがあればそれを使う');

console.log('--- 日付ヘルパ');
eq(lsShiftYmd_('2026-03-01', -1), '2026-02-28', '前日（月またぎ）');
eq(lsShiftYmd_('2026-01-31', 1), '2026-02-01', '翌日');
eq(lsShiftMonth_('2026-01', -1), '2025-12', '前月');
eq(lsMonthEnd_('2026-02'), '2026-02-28', '2月末');
eq(lsMonthEnd_('2024-02'), '2024-02-29', 'うるう年2月末');
eq(lsDiffDays_('2026-01-01', '2026-01-31'), 30, '日数差');
eq(lsParseYmd_('2026/9/5'), '2026-09-05', 'スラッシュ日付');
eq(lsParseYmd_('2026年9月5日'), '2026-09-05', '和文日付');

console.log('--- 中央値・平均');
eq(lsMedian_([100, 300, 200]), 200, '中央値(奇数)');
eq(lsMedian_([100, 200, 300, 400]), 250, '中央値(偶数)');
eq(lsMedian_(['', 0, 500]), 500, '空と0は除外');
eq(lsAverage_([10, 20, 31]), 20.3, '平均');

console.log('--- 取込→マスタ反映');
const master = { rows: [], byKey: {} };
const rec = k => ({ key: k, type: '土地', address: '渋谷区恵比寿1-2-3', station: 'JR恵比寿', walk: '5',
  price: 20000, landArea: 100, bldgArea: '', layout: '', built: '', floors: '', source: 'test', sourceId: k, url: '', note: '' });

let r1 = lsApplyIntake_(master, [rec('A'), rec('B'), rec('A')], '2026-09-01');
eq([r1.added, r1.kept], [2, 0], '初日は2件新規・同日重複は1件扱い');

let day2 = [rec('A'), rec('B')];
day2[0].price = 18000;
let r2 = lsApplyIntake_(master, day2, '2026-09-02');
eq([r2.added, r2.kept, r2.priceChanges.length], [0, 2, 1], '2日目は継続2件・値下げ1件');
eq(master.byKey['A'].cuts, 1, '値下げ回数');
eq(master.byKey['A'].price, 18000, '現在価格');
eq(master.byKey['A'].firstPrice, 20000, '初回価格は据え置き');

// 3〜5日目は B だけ掲載（A が消える）
['2026-09-03', '2026-09-04', '2026-09-05'].forEach(d => {
  lsApplyIntake_(master, [rec('B')], d);
});
props.LS_GRACE_DAYS = '3';
let closed = lsCloseMissing_(master, '2026-09-05');
eq(closed.count, 0, '猶予内はまだ掲載中');
lsApplyIntake_(master, [rec('B')], '2026-09-06');
closed = lsCloseMissing_(master, '2026-09-06');
eq(closed.count, 1, '猶予を過ぎたら掲載終了');
eq(master.byKey['A'].closedAt, '2026-09-02', '掲載終了日は最後に見た日');

lsRecalcMaster_(master, '2026-09-06');
eq(master.byKey['A'].days, 1, '掲載日数(終了分)');
eq(master.byKey['B'].days, 5, '掲載日数(掲載中)');
eq(master.byKey['B'].tsubo, 661.2, '坪単価');
eq(master.byKey['A'].cutRate, -10, '値下げ率%');

console.log('--- 在庫判定');
eq(lsListedOn_(master.byKey['A'], '2026-09-01'), true, 'A: 初日は在庫');
eq(lsListedOn_(master.byKey['A'], '2026-09-02'), true, 'A: 最終確認日は在庫');
eq(lsListedOn_(master.byKey['A'], '2026-09-03'), false, 'A: 翌日は在庫外');
eq(lsListedOn_(master.byKey['A'], '2026-08-31'), false, 'A: 掲載前は在庫外');
eq(lsListedOn_(master.byKey['B'], '2026-09-06'), true, 'B: 掲載中');

console.log('--- 再掲載');
lsApplyIntake_(master, [rec('A')], '2026-09-10');
eq(master.byKey['A'].status, '掲載中', '再掲載で掲載中に戻る');
eq(master.byKey['A'].closedAt, '', '掲載終了日はクリア');


console.log('--- 日次サマリ／月次サマリの投影');
// シート書き込みを差し替えて、出来上がる行だけ取り出す
const captured = {};
lsReplaceRange_ = function (ss, name, header, rows) { captured[name] = rows; };
lsSheet_ = function () { throw new Error('not used'); };

const m2 = { rows: [], byKey: {} };
const mk = (k, type) => ({ key: k, type, address: '渋谷区恵比寿1-2-3', station: '', walk: '',
  price: 10000, landArea: 100, bldgArea: '', layout: '', built: '', floors: '',
  source: 't', sourceId: k, url: '', note: '' });

// 8/10 に土地2件・マンション1件が載り、土地1件が8/20で消える。9/1に新規1件。
lsApplyIntake_(m2, [mk('L1','土地'), mk('L2','土地'), mk('M1','マンション(区分)')], '2026-08-10');
lsApplyIntake_(m2, [mk('L1','土地'), mk('L2','土地'), mk('M1','マンション(区分)')], '2026-08-20');
lsApplyIntake_(m2, [mk('L1','土地'), mk('M1','マンション(区分)')], '2026-08-25');
lsCloseMissing_(m2, '2026-08-25');
lsApplyIntake_(m2, [mk('L1','土地'), mk('M1','マンション(区分)'), mk('L3','土地')], '2026-09-01');
lsApplyIntake_(m2, [mk('L1','土地'), mk('M1','マンション(区分)'), mk('L3','土地')], '2026-09-05');
lsRecalcMaster_(m2, '2026-09-05');
eq(m2.byKey['L2'].closedAt, '2026-08-20', 'L2は8/20で掲載終了');

lsRebuildDaily_(null, m2, [], '2026-09-05');
const daily = captured['日次サマリ'];
const dRow = (d, t) => daily.find(r => r[0] === d && r[1] === t);
eq(dRow('2026-08-20', '土地').slice(2, 5), [2, 0, 1], '8/20 土地: 在庫2・新規0・終了1');
eq(dRow('2026-08-21', '土地').slice(2, 5), [1, 0, 0], '8/21 土地: 在庫1');
eq(dRow('2026-09-01', '土地').slice(2, 5), [2, 1, 0], '9/1 土地: 在庫2・新規1');
eq(dRow('2026-09-05', '合計').slice(2, 5), [3, 0, 0], '9/5 合計: 在庫3');

lsRebuildMonthly_(null, m2);
const monthly = captured['月次サマリ'];
const mRow = (ym, t) => monthly.find(r => r[0] === ym && r[1] === t);
eq(mRow('2026-08', '土地').slice(2, 6), [0, 2, 1, 1], '8月 土地: 月初0・新規2・終了1・月末1');
eq(mRow('2026-08', '合計').slice(2, 6), [0, 3, 1, 2], '8月 合計: 月初0・新規3・終了1・月末2');
eq(mRow('2026-09', '合計').slice(2, 6), [2, 1, 0, 3], '9月 合計: 月初2・新規1・終了0・月末3');
eq(mRow('2026-08', '土地')[6], 10, '8月 土地: 平均掲載日数10日');
eq(mRow('2026-08', '土地')[7], 1, '8月 土地: 値下げなしで終了1件');

console.log(fails === 0 ? '\nすべて通りました' : `\n${fails}件 失敗`);
process.exit(fails === 0 ? 0 : 1);
