// 中古マンション市況トラッカーの単体テスト。実行: node gas/tests/mansion-tracker.test.js
const fs = require('fs');
let src = fs.readFileSync(require('path').join(__dirname, '..', 'MansionMarketTracker.gs'), 'utf8');

// GAS グローバルの最小スタブ
const props = { FIELD_ORDER: null };
global.PropertiesService = { getScriptProperties: () => ({ getProperty: k => props[k] || null }) };
global.Utilities = {
  formatString: (f, ...a) => { let i = 0; return f.replace(/%s/g, () => a[i++]); },
  formatDate: (d, tz, fmt) => {
    const p = n => String(n).padStart(2, '0');
    if (fmt === 'yyyy') return String(d.getFullYear());
    if (fmt === 'MM') return p(d.getMonth() + 1);
    if (fmt === 'M月d日') return `${d.getMonth() + 1}月${d.getDate()}日`;
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 18:00`;
  }
};
global.Logger = { log: () => {} };

eval(src);

let fail = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  → ' + JSON.stringify(extra)));
  if (!cond) fail++;
};

// --- recentMonths_ ---
ok('recentMonths_ 年跨ぎ',
  JSON.stringify(recentMonths_(new Date(2026, 1, 15), 4)) === JSON.stringify(['202602','202601','202512','202511']),
  recentMonths_(new Date(2026, 1, 15), 4));

// --- numbersAfter_ ---
ok('numbersAfter_ カンマ/小数/△',
  JSON.stringify(numbersAfter_('東京都区部 1,635 △ 2.1 137.46 5,200', '東京都区部', 4)) === JSON.stringify([1635, -2.1, 137.46, 5200]),
  numbersAfter_('東京都区部 1,635 △ 2.1 137.46 5,200', '東京都区部', 4));

ok('numbersAfter_ 改行区切り（PDF変換想定）',
  JSON.stringify(numbersAfter_('東京都区部\n1,635\n▲2.1\n15,234\n5.3', '東京都区部', 4)) === JSON.stringify([1635, -2.1, 15234, 5.3]),
  numbersAfter_('東京都区部\n1,635\n▲2.1\n15,234\n5.3', '東京都区部', 4));

ok('numbersAfter_ 見出し未検出は null', numbersAfter_('首都圏 100', '存在しない見出し', 3) === null);

ok('numbersAfter_ 別項目に入ったら打ち切り',
  JSON.stringify(numbersAfter_('東京都区部 1,635 2.1 中古戸建住宅 900 3.0', '東京都区部', 8)) === JSON.stringify([1635, 2.1]),
  numbersAfter_('東京都区部 1,635 2.1 中古戸建住宅 900 3.0', '東京都区部', 8));

// --- sliceUsedMansionSection_ ---
const doc = '首都圏概況\n中古マンション\n東京都区部 1,635 △2.1 15,234 5.3 45,678 12.4 137.46 5,200\n中古戸建住宅\n東京都区部 999 1.0 111 2.0';
const sec = sliceUsedMansionSection_(doc);
ok('sliceUsedMansionSection_ が戸建を除外', sec.indexOf('中古戸建住宅') < 0 && sec.indexOf('1,635') > 0, sec);

// --- parseMarketWatch_ ---
const sample = [
  '月例速報 Market Watch サマリーレポート 2026 年7 月度',
  '首都圏 中古住宅市場の概況',
  '中古マンション',
  '首都圏 3,542 △2.1 15,234 5.3 45,678 12.4 78.90 5,200',
  '東京都 1,850 1.2 7,100 4.0 20,300 10.5 105.20 6,100',
  '東京都区部 1,635 △2.1 6,200 3.8 17,900 11.2 137.46 7,050',
  '中古戸建住宅',
  '首都圏 1,200 0.5 3,000 1.0'
].join('\n');
const parsed = parseMarketWatch_(sample);
const ku = parsed.find(p => p.region === '東京都区部');
ok('parseMarketWatch_ 3地域すべて抽出', parsed.length === 3 && parsed.every(p => p.status === 'OK'), parsed.map(p => p.region + ':' + p.status));
ok('parseMarketWatch_ 都区部の値', JSON.stringify(ku.values) === JSON.stringify([1635, -2.1, 6200, 3.8, 17900, 11.2, 137.46, 7050]), ku.values);

// 「東京都」が「東京都区部」を先に拾ってしまわないか（indexOf の順序依存の確認）
const tokyo = parsed.find(p => p.region === '東京都');
ok('「東京都」行が都区部の値を拾っていない', tokyo.values[0] === 1850, tokyo.values);

// --- 抽出失敗時 ---
const bad = parseMarketWatch_('中古マンション\n地域別データなし');
ok('見出し無しは status に理由が残る', bad.every(p => p.status !== 'OK' && p.values.length === 0), bad.map(p => p.status));

// --- FIELD_ORDER ---
props.FIELD_ORDER = 'contracts,contractsYoY,unitPrice,unitPriceYoY,price,skip,skip,skip';
ok('FIELD_ORDER が反映される', JSON.stringify(fieldOrder_()) === JSON.stringify(['contracts','contractsYoY','unitPrice','unitPriceYoY','price','skip','skip','skip']), fieldOrder_());
props.FIELD_ORDER = null;

// --- 書式 ---
ok('fmtNum_ 空欄はダッシュ', fmtNum_('') === '—' && fmtNum_(1635) === '1,635', [fmtNum_(''), fmtNum_(1635)]);
ok('fmtPct_ 符号', fmtPct_(5.3) === '+5.3%' && fmtPct_(-2.1) === '-2.1%' && fmtPct_('') === '—', [fmtPct_(5.3), fmtPct_(-2.1)]);

// --- メール本文 ---
const rows = [
  { ym:'202607', region:'東京都区部', contracts:1635, contractsYoY:-2.1, newListings:6200, newListingsYoY:3.8, stock:17900, stockYoY:11.2, unitPrice:137.46, price:7050, url:'u', status:'OK' },
  { ym:'202606', region:'東京都区部', contracts:1700, contractsYoY:1.0, newListings:6000, newListingsYoY:2.0, stock:17500, stockYoY:9.0, unitPrice:136.0, price:6980, url:'u', status:'OK' },
  { ym:'202607', region:'首都圏', contracts:3542, contractsYoY:-2.1, newListings:15234, newListingsYoY:5.3, stock:45678, stockYoY:12.4, unitPrice:78.9, price:5200, url:'u', status:'OK' }
];
const subject = buildSubject_(new Date(2026, 8, 4), rows);
ok('件名', subject === '[中古マンション市況] 9月4日 — 東京都区部 2026年7月度 成約1,635件 / 新規登録6,200件', subject);

const html = buildHtml_(new Date(2026, 8, 4), rows, { added: ['202607'], latest: '202607', notes: [] });
ok('本文に都区部の値', html.includes('1,635') && html.includes('17,900'));
ok('本文に推移表', html.includes('推移（直近2か月）'), html.includes('推移'));
ok('区別が無い旨の注記', html.includes('区別の内訳は公表されていません'));

const empty = buildHtml_(new Date(2026, 8, 4), [], { added: [], latest: null, notes: ['202607: PDFのテキスト変換に失敗'] });
ok('データ0件でも本文が組める', empty.includes('まだデータがありません') && empty.includes('要確認'));

const plain = htmlToPlainText_(html);
ok('プレーンテキスト化でタグが残らない', !/<[a-z]/i.test(plain) && plain.includes('1,635'), plain.slice(0,120));


// --- 誤マッチ防止（都区部が先に出てくるレイアウト） ---
const reversed = [
  '中古マンション',
  '東京都区部 1,635 △2.1 6,200 3.8 17,900 11.2 137.46 7,050',
  '東京都下 300 0.5 900 1.0 2,000 3.0 60.00 3,900',
  '東京都 1,850 1.2 7,100 4.0 20,300 10.5 105.20 6,100'
].join('\n');
const rp = parseMarketWatch_(reversed);
ok('都区部が先でも「東京都」は自分の行を拾う',
  rp.find(p => p.region === '東京都').values[0] === 1850 &&
  rp.find(p => p.region === '東京都区部').values[0] === 1635,
  rp.map(p => p.region + '=' + p.values[0]));

console.log(fail === 0 ? '\n=== ALL PASS ===' : `\n=== ${fail} FAILED ===`);
process.exit(fail ? 1 : 0);
