/**
 * 恵比寿 物件在庫 まとめメール
 *
 * LandStock.gs が貯めた日次サマリ・月次サマリから、
 * 「今日の在庫件数」「当日の動き」「今月の動き」「月次の推移」を1通にまとめて送る。
 *
 * 想定トリガー: 時間主導型 / 日付ベース / 午前7時〜8時（毎日）
 *
 * スクリプトプロパティ:
 *   LS_RECIPIENT      送信先メールアドレス（必須）
 *   LS_CC             CCアドレス（任意・カンマ区切り）
 *   LS_RUN_BEFORE_MAIL 'false' にすると、メール前の集計実行をやめる。既定は実行する
 *   LS_TREND_MONTHS   月次推移に載せる月数。既定 '6'
 */

/** 定期トリガーから呼ぶ本番用エントリポイント。 */
function sendLandStockMail() {
  lsmRun_(false);
}

/** 送信せずに文面をログ出力する確認用エントリポイント。 */
function previewLandStockMail() {
  lsmRun_(true);
}

function lsmRun_(isPreview) {
  if (lsProp_('LS_RUN_BEFORE_MAIL', 'true') !== 'false') {
    runDailyLandStock();
  }

  var ss = lsOpenSpreadsheet_();
  var today = lsToday_();
  var daily = lsmReadDaily_(ss);
  var monthly = lsmReadMonthly_(ss);

  var subject = '【恵比寿 物件在庫】' + lsmDateLabel_(today) + '時点';
  var html = lsmBuildHtml_(today, daily, monthly);

  if (isPreview) {
    Logger.log('件名: ' + subject);
    Logger.log(html);
    return;
  }

  var recipient = lsProp_('LS_RECIPIENT', '');
  if (!recipient) {
    throw new Error('スクリプトプロパティ LS_RECIPIENT が未設定です。');
  }
  var options = { htmlBody: html, name: '恵比寿 物件在庫' };
  var cc = lsProp_('LS_CC', '');
  if (cc) options.cc = cc;

  MailApp.sendEmail(recipient, subject, lsmToPlainText_(html), options);
  Logger.log('送信しました: ' + subject + ' → ' + recipient);
}

// ---------------------------------------------------------------- 読み込み

function lsmReadDaily_(ss) {
  var sh = lsSheet_(ss, LS_SHEET.daily, LS_HEAD_DAILY);
  var last = sh.getLastRow();
  var byDate = {};
  if (last < 2) return byDate;
  sh.getRange(2, 1, last - 1, LS_HEAD_DAILY.length).getValues().forEach(function (v) {
    var date = (v[0] instanceof Date) ? lsFmt_(v[0]) : lsText_(v[0]);
    if (!date) return;
    if (!byDate[date]) byDate[date] = {};
    byDate[date][lsText_(v[1])] = {
      stock: lsNum_(v[2]), added: lsNum_(v[3]), closed: lsNum_(v[4]), cuts: lsNum_(v[5]),
      medianPrice: lsNumOrBlank_(v[6]), medianTsubo: lsNumOrBlank_(v[7])
    };
  });
  return byDate;
}

function lsmReadMonthly_(ss) {
  var sh = lsSheet_(ss, LS_SHEET.monthly, LS_HEAD_MONTHLY);
  var last = sh.getLastRow();
  var byMonth = {};
  if (last < 2) return byMonth;
  sh.getRange(2, 1, last - 1, LS_HEAD_MONTHLY.length).getValues().forEach(function (v) {
    var ym = (v[0] instanceof Date) ? Utilities.formatDate(v[0], LS_TZ, 'yyyy-MM') : lsText_(v[0]);
    if (!ym) return;
    if (!byMonth[ym]) byMonth[ym] = {};
    byMonth[ym][lsText_(v[1])] = {
      opening: lsNum_(v[2]), added: lsNum_(v[3]), closed: lsNum_(v[4]), closing: lsNum_(v[5]),
      avgDays: lsNumOrBlank_(v[6]), noCut: lsNum_(v[7]),
      medianPrice: lsNumOrBlank_(v[8]), medianTsubo: lsNumOrBlank_(v[9])
    };
  });
  return byMonth;
}

// ---------------------------------------------------------------- 文面

function lsmBuildHtml_(today, daily, monthly) {
  var out = [];
  out.push('<div style="font-family:sans-serif;font-size:14px;line-height:1.7;color:#222">');
  out.push('<p>' + lsmEsc_(lsmDateLabel_(today)) + '時点の、恵比寿エリアの売り物件の状況です。</p>');

  var todayRow = daily[today];
  if (!todayRow) {
    out.push('<p style="color:#b00">本日ぶんの集計がありません。取込データが入っているか確認してください。</p>');
  } else {
    out.push('<p><b>いまの在庫：合計 ' + lsNum_((todayRow['合計'] || {}).stock) + '件</b></p>');
    out.push(lsmStockTable_(today, daily));
    out.push(lsmMonthTable_(today, monthly));
    out.push(lsmTrendTable_(today, monthly));
  }

  out.push('<p style="color:#666;font-size:12px;margin-top:24px">');
  out.push('※「掲載終了」は掲載が消えた件数です。成約と売止め・取下げの両方を含みます。<br>');
  out.push('※ 掲載終了日は最後に掲載を確認できた日で記録しているため、直近数日の数字は後から増えることがあります。<br>');
  out.push('※ 価格は万円、坪単価は土地（区分マンションは専有面積）基準の中央値です。<br>');
  out.push('※ 本メールは物件在庫シートの蓄積データを自動集計したものです。');
  out.push('</p>');
  out.push('</div>');
  return out.join('');
}

/** 種別ごとの在庫と、当日の動き。 */
function lsmStockTable_(today, daily) {
  var yesterday = lsShiftYmd_(today, -1);
  var cur = daily[today] || {};
  var prev = daily[yesterday] || {};

  var html = [lsmTableOpen_(), '<thead><tr>'];
  ['種別', '在庫', '前日比', '新規', '掲載終了', '値下げ', '中央値価格', '中央値坪単価'].forEach(function (h) {
    html.push('<th ' + lsmTh_() + '>' + lsmEsc_(h) + '</th>');
  });
  html.push('</tr></thead><tbody>');

  LS_TYPES.concat(['合計']).forEach(function (type) {
    var c = cur[type] || { stock: 0, added: 0, closed: 0, cuts: 0, medianPrice: '', medianTsubo: '' };
    var p = prev[type];
    var diff = p ? (c.stock - p.stock) : '';
    var bold = (type === '合計');
    html.push('<tr' + (bold ? ' style="background:#fafafa"' : '') + '>');
    html.push('<td ' + lsmTdLeft_() + '>' + (bold ? '<b>' : '') + lsmEsc_(type) + (bold ? '</b>' : '') + '</td>');
    html.push('<td ' + lsmTd_() + '>' + (bold ? '<b>' : '') + c.stock + (bold ? '</b>' : '') + '</td>');
    html.push('<td ' + lsmTd_() + '>' + lsmSigned_(diff) + '</td>');
    html.push('<td ' + lsmTd_() + '>' + c.added + '</td>');
    html.push('<td ' + lsmTd_() + '>' + c.closed + '</td>');
    html.push('<td ' + lsmTd_() + '>' + c.cuts + '</td>');
    html.push('<td ' + lsmTd_() + '>' + lsmMan_(c.medianPrice) + '</td>');
    html.push('<td ' + lsmTd_() + '>' + lsmMan_(c.medianTsubo) + '</td>');
    html.push('</tr>');
  });
  html.push('</tbody></table>');
  return html.join('');
}

/** 今月の動き。 */
function lsmMonthTable_(today, monthly) {
  var ym = today.slice(0, 7);
  var m = monthly[ym];
  if (!m) return '';

  var html = ['<p style="margin-top:22px"><b>今月（' + lsmEsc_(lsmMonthLabel_(ym)) + '）の動き</b></p>'];
  html.push(lsmTableOpen_());
  html.push('<thead><tr>');
  ['種別', '月初在庫', '新規', '掲載終了', '現在', '平均掲載日数', 'うち値下げなし'].forEach(function (h) {
    html.push('<th ' + lsmTh_() + '>' + lsmEsc_(h) + '</th>');
  });
  html.push('</tr></thead><tbody>');

  LS_TYPES.concat(['合計']).forEach(function (type) {
    var r = m[type];
    if (!r) return;
    var bold = (type === '合計');
    html.push('<tr' + (bold ? ' style="background:#fafafa"' : '') + '>');
    html.push('<td ' + lsmTdLeft_() + '>' + (bold ? '<b>' : '') + lsmEsc_(type) + (bold ? '</b>' : '') + '</td>');
    html.push('<td ' + lsmTd_() + '>' + r.opening + '</td>');
    html.push('<td ' + lsmTd_() + '>' + r.added + '</td>');
    html.push('<td ' + lsmTd_() + '>' + (bold ? '<b>' : '') + r.closed + (bold ? '</b>' : '') + '</td>');
    html.push('<td ' + lsmTd_() + '>' + r.closing + '</td>');
    html.push('<td ' + lsmTd_() + '>' + (r.avgDays === '' ? '-' : r.avgDays + '日') + '</td>');
    html.push('<td ' + lsmTd_() + '>' + r.noCut + '</td>');
    html.push('</tr>');
  });
  html.push('</tbody></table>');
  return html.join('');
}

/** 月次の推移（種別ごとの掲載終了件数と、月末在庫）。 */
function lsmTrendTable_(today, monthly) {
  var months = lsmRecentMonths_(today, lsNum_(lsProp_('LS_TREND_MONTHS', '6')) || 6);
  var available = months.filter(function (ym) { return monthly[ym]; });
  if (available.length < 2) return '';

  var html = ['<p style="margin-top:22px"><b>月次の推移（掲載終了＝売れた・取下げの合計）</b></p>'];
  html.push(lsmTableOpen_());
  html.push('<thead><tr><th ' + lsmTh_() + '>年月</th>');
  LS_TYPES.forEach(function (t) {
    html.push('<th ' + lsmTh_() + '>' + lsmEsc_(t) + '</th>');
  });
  html.push('<th ' + lsmTh_() + '>合計</th><th ' + lsmTh_() + '>月末在庫</th></tr></thead><tbody>');

  available.forEach(function (ym) {
    var m = monthly[ym];
    html.push('<tr>');
    html.push('<td ' + lsmTdLeft_() + '>' + lsmEsc_(lsmMonthLabel_(ym)) + '</td>');
    LS_TYPES.forEach(function (t) {
      html.push('<td ' + lsmTd_() + '>' + ((m[t] && m[t].closed) || 0) + '</td>');
    });
    html.push('<td ' + lsmTd_() + '><b>' + ((m['合計'] && m['合計'].closed) || 0) + '</b></td>');
    html.push('<td ' + lsmTd_() + '>' + ((m['合計'] && m['合計'].closing) || 0) + '</td>');
    html.push('</tr>');
  });
  html.push('</tbody></table>');
  return html.join('');
}

function lsmRecentMonths_(today, count) {
  var ym = today.slice(0, 7);
  var out = [];
  for (var i = count - 1; i >= 0; i--) {
    out.push(lsShiftMonth_(ym, -i));
  }
  return out;
}

// ---------------------------------------------------------------- 小物

function lsmTableOpen_() {
  return '<table style="border-collapse:collapse;font-size:13px">';
}

function lsmTh_() {
  return 'style="border:1px solid #ccc;padding:6px 10px;background:#f2f2f2;white-space:nowrap"';
}

function lsmTd_() {
  return 'style="border:1px solid #ccc;padding:6px 10px;text-align:right;white-space:nowrap"';
}

function lsmTdLeft_() {
  return 'style="border:1px solid #ccc;padding:6px 10px;white-space:nowrap"';
}

function lsmSigned_(n) {
  if (n === '' || n === null || n === undefined) return '-';
  if (n === 0) return '±0';
  return (n > 0 ? '+' : '') + n;
}

function lsmMan_(n) {
  if (n === '' || n === null || n === undefined) return '-';
  return Number(n).toLocaleString('ja-JP');
}

function lsmDateLabel_(ymd) {
  var p = ymd.split('-');
  var wd = ['日', '月', '火', '水', '木', '金', '土'][lsYmdToDate_(ymd).getDay()];
  return p[0] + '年' + Number(p[1]) + '月' + Number(p[2]) + '日(' + wd + ')';
}

function lsmMonthLabel_(ym) {
  var p = ym.split('-');
  return p[0] + '年' + Number(p[1]) + '月';
}

function lsmEsc_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function lsmToPlainText_(html) {
  return html
    .replace(/<\/(p|tr|li|div)>/g, '\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/t[dh]>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
