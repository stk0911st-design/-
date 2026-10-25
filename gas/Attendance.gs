/**
 * 勤怠打刻の受け取りと即時メール通知
 *
 * 日報カウンターの画面で「出勤」「退勤」を押すと、Receiver.gs の doPost へ
 * type='punch' で届く。その打刻をこのファイルで処理する。
 *
 *   1. 勤怠シートに1行追記する（追記のみ・既存行は書き換えない）
 *   2. 代表へ即時メールを送る
 *
 * メール送信に失敗しても打刻は残す。応答の mailed で送信できたか判別できる。
 *
 * スクリプトプロパティ:
 *   ATTENDANCE_RECIPIENT  通知先メールアドレス。未設定なら RECIPIENT を使う
 *   ATTENDANCE_CC         （任意）CCアドレス。カンマ区切り
 */

var ATT_TZ = 'Asia/Tokyo';
var SHEET_ATTENDANCE = '勤怠';
var HEAD_ATTENDANCE = ['日付', '担当者ID', '担当者', '種別', '打刻時刻', '備考', '受信日時'];

/**
 * 打刻を1件受け取る。Receiver.gs の doPost から呼ばれる。
 * 打刻の保存とメール送信は分けてあり、メールが落ちても保存は確定させる。
 */
function handlePunch_(ss, body) {
  var kind = normalizePunchKind_(body.kind);
  if (!kind) {
    throw new Error('kind は in / out（または 出勤 / 退勤）を指定してください: ' + body.kind);
  }
  var member = String(body.member || '').trim();
  if (!member) {
    throw new Error('member is empty');
  }

  var now = new Date();
  var rec = {
    date: String(body.date || '').trim() || Utilities.formatDate(now, ATT_TZ, 'yyyy-MM-dd'),
    member: member,
    name: String(body.name || '').trim() || member,
    kind: kind,
    at: now,
    timeLabel: Utilities.formatDate(now, ATT_TZ, 'HH:mm'),
    note: String(body.note || '').trim()
  };

  var sh = sheet_(ss, SHEET_ATTENDANCE, HEAD_ATTENDANCE);
  appendPunch_(sh, rec);
  writeLog_(ss, 'punch', body.from, rec.name + ' / ' + rec.kind + ' / ' + rec.date + ' ' + rec.timeLabel);

  var punches = readPunchesOfDay_(sh, rec.date, rec.member);
  var mailed = false;
  var mailError = '';
  try {
    sendPunchMail_(rec, punches);
    mailed = true;
  } catch (err) {
    // 打刻は保存済み。通知だけ落ちたことを記録して、応答で呼び出し側に伝える。
    mailError = String(err);
    writeLog_(ss, 'punch-mail-failed', body.from, rec.name + ' / ' + rec.kind + ' / ' + mailError);
  }

  return {
    ok: true,
    type: 'punch',
    kind: rec.kind,
    at: rec.timeLabel,
    count: punches.length,
    mailed: mailed,
    mailError: mailError
  };
}

function normalizePunchKind_(raw) {
  var v = String(raw || '').trim();
  if (v === 'in' || v === '出勤') return '出勤';
  if (v === 'out' || v === '退勤') return '退勤';
  return '';
}

/** 追記のみ。勤怠は記録として残すため、過去行の削除・上書きはしない。 */
function appendPunch_(sh, rec) {
  sh.appendRow([rec.date, rec.member, rec.name, rec.kind, rec.at, rec.note, new Date()]);
  var row = sh.getLastRow();
  sh.getRange(row, 5).setNumberFormat('yyyy-MM-dd HH:mm:ss');
  sh.getRange(row, 7).setNumberFormat('yyyy-MM-dd HH:mm:ss');
}

/** 同じ日・同じ担当者の打刻を時刻順に返す。 */
function readPunchesOfDay_(sh, date, member) {
  var last = sh.getLastRow();
  if (last < 2) {
    return [];
  }
  var vals = sh.getRange(2, 1, last - 1, HEAD_ATTENDANCE.length).getValues();
  var out = [];
  vals.forEach(function (row) {
    if (attYmd_(row[0]) !== date || String(row[1]).trim() !== member) {
      return;
    }
    var at = row[4];
    var atDate = (at instanceof Date) ? at : null;
    out.push({
      kind: String(row[3]).trim(),
      at: atDate,
      timeLabel: atDate ? Utilities.formatDate(atDate, ATT_TZ, 'HH:mm') : String(at),
      note: String(row[5] || '')
    });
  });
  out.sort(function (a, b) {
    return (a.at ? a.at.getTime() : 0) - (b.at ? b.at.getTime() : 0);
  });
  return out;
}

/** 日付セルは文字列で入る場合と Date に変換される場合があるため両方を受ける。 */
function attYmd_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, ATT_TZ, 'yyyy-MM-dd');
  }
  return String(value || '').trim();
}

/** その日の最初の出勤と最後の退勤から拘束時間を出す。休憩は差し引かない。 */
function workSpanLabel_(punches) {
  var first = null;
  var last = null;
  punches.forEach(function (p) {
    if (!p.at) {
      return;
    }
    if (p.kind === '出勤' && (!first || p.at < first)) {
      first = p.at;
    }
    if (p.kind === '退勤' && (!last || p.at > last)) {
      last = p.at;
    }
  });
  if (!first || !last || last <= first) {
    return '';
  }
  var mins = Math.round((last - first) / 60000);
  return Math.floor(mins / 60) + '時間' + ('0' + (mins % 60)).slice(-2) + '分';
}

function sendPunchMail_(rec, punches) {
  var props = PropertiesService.getScriptProperties();
  var to = props.getProperty('ATTENDANCE_RECIPIENT') || props.getProperty('RECIPIENT');
  if (!to) {
    throw new Error('スクリプトプロパティ ATTENDANCE_RECIPIENT（または RECIPIENT）が未設定です。');
  }
  var subject = buildPunchSubject_(rec);
  var html = buildPunchHtml_(rec, punches);
  var options = { htmlBody: html, name: '勤怠通知' };
  var cc = props.getProperty('ATTENDANCE_CC');
  if (cc) {
    options.cc = cc;
  }
  MailApp.sendEmail(to, subject, attPlainText_(html), options);
}

function buildPunchSubject_(rec) {
  return '【勤怠】' + rec.name + ' ' + rec.kind + ' ' + attDateLabel_(rec.date) + ' ' + rec.timeLabel;
}

function attDateLabel_(ymd) {
  var parts = String(ymd).split('-');
  if (parts.length !== 3) {
    return String(ymd);
  }
  var date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  var wd = ['日', '月', '火', '水', '木', '金', '土'][date.getDay()];
  return Number(parts[1]) + '/' + Number(parts[2]) + '(' + wd + ')';
}

function buildPunchHtml_(rec, punches) {
  var sameKind = punches.filter(function (p) {
    return p.kind === rec.kind;
  }).length;

  var out = [];
  out.push('<div style="font-family:sans-serif;font-size:14px;line-height:1.7;color:#222">');
  out.push('<p>小林様<br>お世話になっております。</p>');
  out.push('<p><b>' + attEsc_(rec.name) + '</b> さんが <b>' + attEsc_(rec.kind) + '</b> の打刻をしました。</p>');

  var th = 'style="border:1px solid #ccc;padding:6px 10px;background:#f2f2f2;white-space:nowrap;text-align:left"';
  var td = 'style="border:1px solid #ccc;padding:6px 10px"';
  out.push('<table style="border-collapse:collapse;font-size:13px">');
  out.push('<tr><th ' + th + '>日付</th><td ' + td + '>' + attEsc_(attDateLabel_(rec.date)) + '</td></tr>');
  out.push('<tr><th ' + th + '>担当者</th><td ' + td + '>' + attEsc_(rec.name) + '</td></tr>');
  out.push('<tr><th ' + th + '>種別</th><td ' + td + '>' + attEsc_(rec.kind) + '</td></tr>');
  out.push('<tr><th ' + th + '>打刻時刻</th><td ' + td + '>' + attEsc_(rec.timeLabel) + '</td></tr>');
  if (rec.note) {
    out.push('<tr><th ' + th + '>備考</th><td ' + td + '>' + attEsc_(rec.note) + '</td></tr>');
  }
  out.push('</table>');

  if (punches.length > 1) {
    out.push('<p style="margin-top:20px"><b>本日の打刻</b></p><ul style="margin:0;padding-left:20px">');
    punches.forEach(function (p) {
      out.push('<li>' + attEsc_(p.timeLabel) + '　' + attEsc_(p.kind) +
               (p.note ? '（' + attEsc_(p.note) + '）' : '') + '</li>');
    });
    out.push('</ul>');
  }

  var span = workSpanLabel_(punches);
  if (rec.kind === '退勤' && span) {
    out.push('<p style="margin-top:16px">出勤から退勤まで：<b>' + attEsc_(span) + '</b>' +
             '<span style="color:#666">（休憩を差し引いていない拘束時間です）</span></p>');
  }

  if (sameKind > 1) {
    out.push('<p style="color:#b00;margin-top:16px">※ 本日 ' + sameKind + ' 回目の' +
             attEsc_(rec.kind) + '打刻です。打ち間違いの可能性がありますのでご確認ください。</p>');
  }

  out.push('<p style="color:#666;font-size:12px;margin-top:24px">');
  out.push('※ 本メールは日報カウンターの打刻操作を受けて自動送信しています。<br>');
  out.push('※ 記録は「' + attEsc_(SHEET_ATTENDANCE) + '」シートに追記されています。');
  out.push('</p>');
  out.push('</div>');
  return out.join('');
}

function attEsc_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attPlainText_(html) {
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

/**
 * 直近の打刻から文面を作ってログに出す（送信はしない）。
 * 設置後の文面確認用。
 */
function previewPunchMail() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_ATTENDANCE);
  if (!sh || sh.getLastRow() < 2) {
    Logger.log('勤怠シートに打刻がまだありません。先に打刻を1件入れてください。');
    return;
  }
  var row = sh.getRange(sh.getLastRow(), 1, 1, HEAD_ATTENDANCE.length).getValues()[0];
  var at = (row[4] instanceof Date) ? row[4] : new Date();
  var rec = {
    date: attYmd_(row[0]),
    member: String(row[1]).trim(),
    name: String(row[2]).trim(),
    kind: String(row[3]).trim(),
    at: at,
    timeLabel: Utilities.formatDate(at, ATT_TZ, 'HH:mm'),
    note: String(row[5] || '')
  };
  var punches = readPunchesOfDay_(sh, rec.date, rec.member);
  var props = PropertiesService.getScriptProperties();
  var to = props.getProperty('ATTENDANCE_RECIPIENT') || props.getProperty('RECIPIENT');
  Logger.log('送信先: ' + (to || '(未設定)'));
  Logger.log('件名: ' + buildPunchSubject_(rec));
  Logger.log(buildPunchHtml_(rec, punches));
}
