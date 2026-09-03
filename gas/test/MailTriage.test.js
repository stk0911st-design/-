const fs = require('fs');
// Apps Script の判定ロジックを Node 上で検証する。実行: TZ=Asia/Tokyo node gas/test/MailTriage.test.js
const src = fs.readFileSync('/home/user/-/gas/MailTriage.gs', 'utf8');

const WD = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const pad = (n, w=2) => String(n).padStart(w, '0');
const Utilities = {
  formatDate(d, tz, fmt) {
    return fmt
      .replace(/yyyy/g, d.getFullYear())
      .replace(/HH/g, pad(d.getHours()))
      .replace(/mm/g, pad(d.getMinutes()))
      .replace(/ss/g, pad(d.getSeconds()))
      .replace(/MM/g, pad(d.getMonth() + 1))
      .replace(/M/g, d.getMonth() + 1)
      .replace(/dd/g, pad(d.getDate()))
      .replace(/d/g, d.getDate())
      .replace(/\(E\)/g, '(' + WD[d.getDay()] + ')');
  }
};
const Logger = { log: (...a) => console.log('[log]', ...a) };

const ctx = { Utilities, Logger, console, Date, Number, String, JSON, isNaN, encodeURIComponent, Object };
const vm = require('vm');
vm.createContext(ctx);
vm.runInContext(src + '\nthis.__api = {extractDateTimes_, extractTime_, extractAmounts_, extractDeadline_, inferYear_, collectHits_, extractAddress_, extractName_, firstMeaningfulLines_, shortSubject_, isValidYmd_};', ctx);
const api = ctx.__api;

const base = new Date(2026, 8, 3, 15, 0, 0); // 2026-09-03 15:00 JST
let pass = 0, fail = 0;
function t(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok  ', name); }
  else { fail++; console.log('  FAIL', name, '\n     got :', g, '\n     want:', w); }
}
const labels = (text) => api.extractDateTimes_(text, base).map(c => c.label + (c.allDay ? '[allday]' : ''));

console.log('--- 日時抽出 ---');
t('9月4日 14:00', labels('打合せは9月4日 14:00からでお願いします'), ['2026/9/4(Fri) 14:00']);
t('9/7 10時半', labels('9/7 10時半に現地集合でいかがでしょうか'), ['2026/9/7(Mon) 10:30']);
t('2026年9月10日 午後3時', labels('2026年9月10日 午後3時に決済予定'), ['2026/9/10(Thu) 15:00']);
t('明日15時', labels('明日15時に内見の件'), ['2026/9/4(Fri) 15:00']);
t('日付のみ→終日', labels('9月18日に契約を予定しております'), ['2026/9/18(Fri)[allday]']);
t('過去日は除外', labels('8月20日にお伺いしました'), []);
t('翌年推定', labels('1月15日に決済予定です'), ['2027/1/15(Fri)[allday]']);
t('不正日は除外', labels('2月30日はいかがですか'), []);
t('電話番号を誤検知しない', labels('TEL 03-6758-3333 までご連絡ください'), []);
t('重複排除', labels('9/4 14:00 / 9月4日 14:00 に'), ['2026/9/4(Fri) 14:00']);

console.log('--- 金額・期限 ---');
t('金額', api.extractAmounts_('目線：1380万円、上限4.5億円'), ['1380万円','4.5億円']);
t('期限', api.extractDeadline_('今週中であれば幸いです'), '今週中');
t('期限2', api.extractDeadline_('9/10までにご回答ください'), '9/10までに');

console.log('--- その他 ---');
t('アドレス抽出', api.extractAddress_('東急リバブル原田 <sho-harada@example.jp>'), 'sho-harada@example.jp');
t('氏名抽出', api.extractName_('"原田 匠" <a@b.jp>'), '原田 匠');
t('件名短縮', api.shortSubject_('Re: 案件紹介／横浜市'), '案件紹介／横浜市');
t('本文冒頭', api.firstMeaningfulLines_('\n> 引用行\n小林様\n\nお世話になっております。\n----\n署名', 2), '小林様\nお世話になっております。');
t('キーワード', api.collectHits_('至急ご確認ください', ['至急','ご確認','決済']), ['至急','ご確認']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
