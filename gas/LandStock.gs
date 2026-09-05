/**
 * 恵比寿（渋谷区）土地・建物 在庫蓄積
 *
 * 毎日集めた物件情報を「取込」シートにためて、物件マスタに差分反映する。
 * そこから日次の在庫件数と、月次の「新規／掲載終了（＝売れた・取下げ）」を集計し、
 * 傾向が追えるように蓄積していく。
 *
 * 想定トリガー: 時間主導型 / 日付ベース / 深夜〜早朝（毎日）
 *
 * 集計対象の種別: 土地 / 戸建 / アパート / ビル / マンション(区分)
 *
 * スクリプトプロパティ:
 *   LS_SPREADSHEET_ID  対象スプレッドシートID（コンテナバインドでない場合のみ必須）
 *   LS_AREA_KEYWORDS   対象エリアの判定語。カンマ区切り。既定 '恵比寿'
 *   LS_GRACE_DAYS      何日連続で見つからなければ掲載終了とみなすか。既定 '3'
 *   LS_CSV_FOLDER_ID   日次CSVを置く Google ドライブのフォルダID（任意）
 *   LS_CSV_CHARSET     CSVの文字コード。既定 'UTF-8'（レインズ等は 'Shift_JIS'）
 *   LS_DAILY_REBUILD_DAYS 日次サマリを作り直す日数。既定 '21'
 *
 * データの入れ方は3通り。どれを使ってもこの先の集計は同じ。
 *   A) 「取込」シートに直接貼る（手作業・少量向き）
 *   B) LS_CSV_FOLDER_ID のフォルダにCSVを置く（レインズ等の書き出し向き）
 *   C) Receiver.gs のウェブアプリへ type:'land' でPOSTする（アプリ連携向き）
 */

var LS_TZ = 'Asia/Tokyo';

var LS_SHEET = {
  intake: '取込',
  master: '物件マスタ',
  price: '価格履歴',
  daily: '日次サマリ',
  monthly: '月次サマリ',
  log: '取込ログ'
};

/** 集計に使う種別。表の並び順もこの順。 */
var LS_TYPES = ['土地', '戸建', 'アパート', 'ビル', 'マンション(区分)'];

var LS_HEAD_INTAKE = ['取得日', '情報元', '元物件ID', '種別', '所在地', '最寄駅', '徒歩分',
  '価格', '土地面積', '建物面積', '間取り', '築年月', '階数', '掲載URL', '備考'];

var LS_HEAD_MASTER = ['物件キー', '種別', '所在地', '最寄駅', '徒歩分',
  '初回確認日', '最終確認日', '掲載日数', '状態', '掲載終了日',
  '初回価格万円', '現在価格万円', '最安価格万円', '値下げ回数', '値下げ率%',
  '土地面積㎡', '建物面積㎡', '坪単価万円', '間取り', '築年月', '階数',
  '情報元', '元物件ID', '掲載URL', '備考'];

var LS_HEAD_PRICE = ['記録日', '物件キー', '種別', '所在地', '変更前万円', '変更後万円', '増減万円', '増減率%'];

var LS_HEAD_DAILY = ['日付', '種別', '在庫件数', '新規', '掲載終了', '値下げ', '中央値価格万円', '中央値坪単価万円'];

var LS_HEAD_MONTHLY = ['年月', '種別', '月初在庫', '新規', '掲載終了', '月末在庫',
  '平均掲載日数', '値下げなしで終了', '中央値価格万円', '中央値坪単価万円'];

var LS_HEAD_LOG = ['実行日時', '対象日', '取込行数', 'エリア対象外', '新規', '継続', '価格変更', '掲載終了', 'メモ'];

/** 日次サマリを作り直す日数の既定値（掲載終了の判定が後ろにずれる分をまかなう）。 */
var LS_DAILY_REBUILD_DAYS = 21;

var LS_TSUBO = 3.305785;

// ---------------------------------------------------------------- エントリポイント

/** 毎日のトリガーから呼ぶ本番用エントリポイント。 */
function runDailyLandStock() {
  var ss = lsOpenSpreadsheet_();
  var today = lsToday_();
  var result = lsRunFor_(ss, today);
  Logger.log(JSON.stringify(result));
  return result;
}

/** シートだけ先に作りたいとき用。 */
function setupLandStockSheets() {
  var ss = lsOpenSpreadsheet_();
  lsSheet_(ss, LS_SHEET.intake, LS_HEAD_INTAKE);
  lsSheet_(ss, LS_SHEET.master, LS_HEAD_MASTER);
  lsSheet_(ss, LS_SHEET.price, LS_HEAD_PRICE);
  lsSheet_(ss, LS_SHEET.daily, LS_HEAD_DAILY);
  lsSheet_(ss, LS_SHEET.monthly, LS_HEAD_MONTHLY);
  lsSheet_(ss, LS_SHEET.log, LS_HEAD_LOG);
  Logger.log('シートを用意しました。「取込」シートに物件を貼り付けてから runDailyLandStock を実行してください。');
}

/** 集計だけやり直したいとき用（取込・CSV読み込みはしない）。 */
function rebuildLandStockSummaries() {
  var ss = lsOpenSpreadsheet_();
  var master = lsReadMaster_(ss);
  var priceLog = lsReadPriceLog_(ss);
  lsRebuildDaily_(ss, master, priceLog, lsToday_());
  lsRebuildMonthly_(ss, master);
  Logger.log('日次サマリ・月次サマリを作り直しました。');
}

function lsRunFor_(ss, ymd) {
  var startedAt = new Date();
  var imported = lsImportCsvFolder_(ss);

  var intake = lsReadIntake_(ss, ymd);
  var master = lsReadMaster_(ss);

  var applied = lsApplyIntake_(master, intake.rows, ymd);
  var closed = { count: 0 };
  if (intake.rows.length > 0) {
    closed = lsCloseMissing_(master, ymd);
  }
  lsRecalcMaster_(master, ymd);

  lsWriteMaster_(ss, master);
  lsAppendPriceLog_(ss, applied.priceChanges);

  var priceLog = lsReadPriceLog_(ss);
  lsRebuildDaily_(ss, master, priceLog, ymd);
  lsRebuildMonthly_(ss, master);

  var memo = [];
  if (imported.files > 0) memo.push('CSV ' + imported.files + '件読込');
  if (intake.rows.length === 0) memo.push('取込0件のため掲載終了判定はスキップ');
  if (intake.skipped > 0) memo.push('エリア対象外 ' + intake.skipped + '行は集計から除外（取込シートには残しています）');

  lsSheet_(ss, LS_SHEET.log, LS_HEAD_LOG).appendRow([
    startedAt, ymd, intake.rows.length, intake.skipped,
    applied.added, applied.kept, applied.priceChanges.length, closed.count, memo.join(' / ')
  ]);

  return {
    date: ymd,
    intake: intake.rows.length,
    skipped: intake.skipped,
    added: applied.added,
    kept: applied.kept,
    priceChanged: applied.priceChanges.length,
    closed: closed.count,
    active: lsCountActive_(master)
  };
}

// ---------------------------------------------------------------- 取込

/**
 * 「取込」シートから対象日の行を読む。
 * 取得日が空の行は当日ぶんとして扱い、翌日以降に二重計上しないよう日付を書き戻す。
 */
function lsReadIntake_(ss, ymd) {
  var sh = lsSheet_(ss, LS_SHEET.intake, LS_HEAD_INTAKE);
  var last = sh.getLastRow();
  if (last < 2) {
    return { rows: [], skipped: 0 };
  }
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
  var values = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  var idx = lsHeaderIndex_(header);
  var dateCol = (idx['取得日'] === undefined) ? -1 : idx['取得日'];

  var rows = [];
  var skipped = 0;
  var stamped = [];
  values.forEach(function (row, i) {
    var rec = lsBuildRecord_(row, idx, ymd);
    if (!rec) return;
    if (dateCol !== -1 && !lsText_(row[dateCol])) {
      stamped.push(i + 2);
    }
    if (rec.date !== ymd) return;
    if (!lsInArea_(rec.address)) {
      skipped++;
      return;
    }
    rows.push(rec);
  });

  stamped.forEach(function (rowNumber) {
    sh.getRange(rowNumber, dateCol + 1).setValue(ymd);
  });

  return { rows: rows, skipped: skipped };
}

function lsBuildRecord_(row, idx, defaultYmd) {
  var address = lsText_(lsPick_(row, idx, '所在地'));
  var type = lsNormalizeType_(lsPick_(row, idx, '種別'));
  if (!address && !lsText_(lsPick_(row, idx, '元物件ID'))) {
    return null;
  }
  var price = lsParsePrice_(lsPick_(row, idx, '価格'));
  var landArea = lsParseArea_(lsPick_(row, idx, '土地面積'));
  var bldgArea = lsParseArea_(lsPick_(row, idx, '建物面積'));

  var rec = {
    date: lsParseYmd_(lsPick_(row, idx, '取得日')) || defaultYmd,
    source: lsText_(lsPick_(row, idx, '情報元')),
    sourceId: lsText_(lsPick_(row, idx, '元物件ID')),
    type: type,
    address: address,
    station: lsText_(lsPick_(row, idx, '最寄駅')),
    walk: lsText_(lsPick_(row, idx, '徒歩分')),
    price: price,
    landArea: landArea,
    bldgArea: bldgArea,
    layout: lsText_(lsPick_(row, idx, '間取り')),
    built: lsText_(lsPick_(row, idx, '築年月')),
    floors: lsText_(lsPick_(row, idx, '階数')),
    url: lsText_(lsPick_(row, idx, '掲載URL')),
    note: lsText_(lsPick_(row, idx, '備考'))
  };
  rec.key = lsPropertyKey_(rec);
  return rec;
}

/**
 * 物件を一意に識別するキー。
 * 情報元＋元物件IDがあればそれを使い、無ければ内容から作る。
 * 値下げしても同じ物件と判定したいので、価格はキーに含めない。
 */
function lsPropertyKey_(rec) {
  if (rec.sourceId) {
    return lsSlug_((rec.source || 'src') + ':' + rec.sourceId);
  }
  var seed = [rec.type, lsNormalizeAddress_(rec.address), lsRound_(rec.landArea, 1),
    lsRound_(rec.bldgArea, 1), rec.layout, rec.built].join('|');
  return 'h:' + lsHash_(seed);
}

/** 取込内容を物件マスタへ反映する。 */
function lsApplyIntake_(master, rows, ymd) {
  var added = 0;
  var kept = 0;
  var priceChanges = [];
  var seen = {};

  rows.forEach(function (rec) {
    if (seen[rec.key]) return;   // 同じ日に同じ物件が重複して入っていても1件として扱う
    seen[rec.key] = true;

    var row = master.byKey[rec.key];
    if (!row) {
      row = {
        key: rec.key,
        type: rec.type,
        address: rec.address,
        station: rec.station,
        walk: rec.walk,
        firstSeen: ymd,
        lastSeen: ymd,
        days: 0,
        status: '掲載中',
        closedAt: '',
        firstPrice: rec.price,
        price: rec.price,
        minPrice: rec.price,
        cuts: 0,
        cutRate: '',
        landArea: rec.landArea,
        bldgArea: rec.bldgArea,
        tsubo: '',
        layout: rec.layout,
        built: rec.built,
        floors: rec.floors,
        source: rec.source,
        sourceId: rec.sourceId,
        url: rec.url,
        note: rec.note
      };
      master.byKey[rec.key] = row;
      master.rows.push(row);
      added++;
      return;
    }

    kept++;
    if (row.status !== '掲載中') {
      // いったん消えた物件が再掲載された。掲載終了は取り消し、再掲載として記録する。
      row.status = '掲載中';
      row.closedAt = '';
      row.note = lsAppendNote_(row.note, ymd + ' 再掲載');
    }
    row.lastSeen = ymd;

    if (lsIsNum_(rec.price) && lsIsNum_(row.price) && Math.abs(rec.price - row.price) >= 1) {
      var before = row.price;
      priceChanges.push({
        date: ymd, key: row.key, type: row.type, address: row.address,
        before: before, after: rec.price,
        diff: lsRound_(rec.price - before, 0),
        rate: lsRound_((rec.price - before) / before * 100, 1)
      });
      if (rec.price < before) {
        row.cuts = lsNum_(row.cuts) + 1;
      }
      row.price = rec.price;
      if (!lsIsNum_(row.minPrice) || rec.price < row.minPrice) {
        row.minPrice = rec.price;
      }
    } else if (!lsIsNum_(row.price) && lsIsNum_(rec.price)) {
      row.price = rec.price;
      if (!lsIsNum_(row.firstPrice)) row.firstPrice = rec.price;
      if (!lsIsNum_(row.minPrice)) row.minPrice = rec.price;
    }

    // 後から埋まった項目は上書きする（消さない）
    row.station = rec.station || row.station;
    row.walk = rec.walk || row.walk;
    row.landArea = lsIsNum_(rec.landArea) ? rec.landArea : row.landArea;
    row.bldgArea = lsIsNum_(rec.bldgArea) ? rec.bldgArea : row.bldgArea;
    row.layout = rec.layout || row.layout;
    row.built = rec.built || row.built;
    row.floors = rec.floors || row.floors;
    row.url = rec.url || row.url;
    row.type = rec.type || row.type;
  });

  return { added: added, kept: kept, priceChanges: priceChanges };
}

/** 一定日数見つからなくなった物件を掲載終了にする。掲載終了日は最後に確認できた日。 */
function lsCloseMissing_(master, ymd) {
  var grace = lsNum_(lsProp_('LS_GRACE_DAYS', '3')) || 3;
  var limit = lsShiftYmd_(ymd, -grace);
  var count = 0;
  master.rows.forEach(function (row) {
    if (row.status !== '掲載中') return;
    if (!row.lastSeen || row.lastSeen >= limit) return;
    row.status = '掲載終了';
    row.closedAt = row.lastSeen;
    count++;
  });
  return { count: count };
}

/** 掲載日数・坪単価・値下げ率など、他の値から決まる列を計算し直す。 */
function lsRecalcMaster_(master, ymd) {
  master.rows.forEach(function (row) {
    var end = (row.status === '掲載中') ? ymd : (row.closedAt || row.lastSeen);
    row.days = lsDiffDays_(row.firstSeen, end);

    var area = (row.type === 'マンション(区分)') ? row.bldgArea : row.landArea;
    if (!lsIsNum_(area) || area <= 0) area = row.landArea;
    row.tsubo = (lsIsNum_(row.price) && lsIsNum_(area) && area > 0)
      ? lsRound_(row.price / (area / LS_TSUBO), 1) : '';

    row.cutRate = (lsIsNum_(row.firstPrice) && lsIsNum_(row.price) && row.firstPrice > 0)
      ? lsRound_((row.price - row.firstPrice) / row.firstPrice * 100, 1) : '';
  });
}

// ---------------------------------------------------------------- 集計

/**
 * 日次サマリを直近ぶんだけ作り直す。
 * 掲載終了は「最後に確認できた日」に記録するので、後から過去日の数字が動く。
 * そのため毎回作り直して自動的に整合させる。
 */
function lsRebuildDaily_(ss, master, priceLog, ymd) {
  var span = lsNum_(lsProp_('LS_DAILY_REBUILD_DAYS', String(LS_DAILY_REBUILD_DAYS))) || LS_DAILY_REBUILD_DAYS;
  var from = lsShiftYmd_(ymd, -(span - 1));
  var dates = [];
  for (var d = from; d <= ymd; d = lsShiftYmd_(d, 1)) {
    dates.push(d);
  }

  var rows = [];
  dates.forEach(function (date) {
    LS_TYPES.concat(['合計']).forEach(function (type) {
      var listed = master.rows.filter(function (r) {
        return (type === '合計' || r.type === type) && lsListedOn_(r, date);
      });
      var added = master.rows.filter(function (r) {
        return (type === '合計' || r.type === type) && r.firstSeen === date;
      }).length;
      var closed = master.rows.filter(function (r) {
        return (type === '合計' || r.type === type) && r.status === '掲載終了' && r.closedAt === date;
      }).length;
      var cuts = priceLog.filter(function (p) {
        return p.date === date && (type === '合計' || p.type === type) && lsNum_(p.diff) < 0;
      }).length;

      if (listed.length === 0 && added === 0 && closed === 0 && cuts === 0) return;

      rows.push([date, type, listed.length, added, closed, cuts,
        lsMedian_(listed.map(function (r) { return r.price; })),
        lsMedian_(listed.map(function (r) { return r.tsubo; }))]);
    });
  });

  lsReplaceRange_(ss, LS_SHEET.daily, LS_HEAD_DAILY, rows, function (row) {
    return String(row[0]) >= from;   // 作り直す範囲の行だけ差し替える
  });
}

/** 月次サマリは毎回まるごと作り直す（元データは物件マスタなので何度やっても同じ）。 */
function lsRebuildMonthly_(ss, master) {
  var months = lsMonthRange_(master);
  var rows = [];

  months.forEach(function (ym) {
    var start = ym + '-01';
    var end = lsMonthEnd_(ym);
    var prevEnd = lsShiftYmd_(start, -1);

    LS_TYPES.concat(['合計']).forEach(function (type) {
      var target = master.rows.filter(function (r) {
        return type === '合計' || r.type === type;
      });
      var opening = target.filter(function (r) { return lsListedOn_(r, prevEnd); }).length;
      var added = target.filter(function (r) {
        return r.firstSeen >= start && r.firstSeen <= end;
      }).length;
      var closedRows = target.filter(function (r) {
        return r.status === '掲載終了' && r.closedAt >= start && r.closedAt <= end;
      });
      var closing = target.filter(function (r) { return lsListedOn_(r, end); });

      if (opening === 0 && added === 0 && closedRows.length === 0 && closing.length === 0) return;

      var noCut = closedRows.filter(function (r) { return lsNum_(r.cuts) === 0; }).length;

      rows.push([ym, type, opening, added, closedRows.length, closing.length,
        lsAverage_(closedRows.map(function (r) { return r.days; })),
        noCut,
        lsMedian_(closing.map(function (r) { return r.price; })),
        lsMedian_(closing.map(function (r) { return r.tsubo; }))]);
    });
  });

  lsReplaceRange_(ss, LS_SHEET.monthly, LS_HEAD_MONTHLY, rows, function () { return true; });
}

/** その日に掲載されていたかどうか。掲載終了日は「最後に確認できた日」なので当日は掲載中扱い。 */
function lsListedOn_(row, ymd) {
  if (!row.firstSeen || row.firstSeen > ymd) return false;
  if (row.status === '掲載中') return true;
  return !!row.closedAt && row.closedAt >= ymd;
}

function lsMonthRange_(master) {
  var first = null;
  master.rows.forEach(function (r) {
    if (r.firstSeen && (!first || r.firstSeen < first)) first = r.firstSeen;
  });
  if (!first) return [];
  var months = [];
  var ym = first.slice(0, 7);
  var lastYm = lsToday_().slice(0, 7);
  while (ym <= lastYm) {
    months.push(ym);
    ym = lsShiftMonth_(ym, 1);
  }
  return months;
}

function lsCountActive_(master) {
  var out = { 合計: 0 };
  LS_TYPES.forEach(function (t) { out[t] = 0; });
  master.rows.forEach(function (r) {
    if (r.status !== '掲載中') return;
    out['合計']++;
    if (out[r.type] === undefined) out[r.type] = 0;
    out[r.type]++;
  });
  return out;
}

// ---------------------------------------------------------------- シート読み書き

function lsReadMaster_(ss) {
  var sh = lsSheet_(ss, LS_SHEET.master, LS_HEAD_MASTER);
  var last = sh.getLastRow();
  var master = { rows: [], byKey: {} };
  if (last < 2) return master;

  var values = sh.getRange(2, 1, last - 1, LS_HEAD_MASTER.length).getValues();
  values.forEach(function (v) {
    var key = lsText_(v[0]);
    if (!key) return;
    var row = {
      key: key, type: lsText_(v[1]), address: lsText_(v[2]), station: lsText_(v[3]), walk: lsText_(v[4]),
      firstSeen: lsParseYmd_(v[5]), lastSeen: lsParseYmd_(v[6]), days: lsNum_(v[7]),
      status: lsText_(v[8]) || '掲載中', closedAt: lsParseYmd_(v[9]),
      firstPrice: lsNumOrBlank_(v[10]), price: lsNumOrBlank_(v[11]), minPrice: lsNumOrBlank_(v[12]),
      cuts: lsNum_(v[13]), cutRate: v[14],
      landArea: lsNumOrBlank_(v[15]), bldgArea: lsNumOrBlank_(v[16]), tsubo: lsNumOrBlank_(v[17]),
      layout: lsText_(v[18]), built: lsText_(v[19]), floors: lsText_(v[20]),
      source: lsText_(v[21]), sourceId: lsText_(v[22]), url: lsText_(v[23]), note: lsText_(v[24])
    };
    master.rows.push(row);
    master.byKey[key] = row;
  });
  return master;
}

function lsWriteMaster_(ss, master) {
  var sh = lsSheet_(ss, LS_SHEET.master, LS_HEAD_MASTER);
  var out = master.rows.map(function (r) {
    return [r.key, r.type, r.address, r.station, r.walk,
      r.firstSeen, r.lastSeen, r.days, r.status, r.closedAt,
      r.firstPrice, r.price, r.minPrice, r.cuts, r.cutRate,
      r.landArea, r.bldgArea, r.tsubo, r.layout, r.built, r.floors,
      r.source, r.sourceId, r.url, r.note];
  });
  var last = sh.getLastRow();
  if (last > 1) {
    sh.getRange(2, 1, last - 1, LS_HEAD_MASTER.length).clearContent();
  }
  if (out.length) {
    sh.getRange(2, 1, out.length, LS_HEAD_MASTER.length).setValues(out);
  }
}

function lsReadPriceLog_(ss) {
  var sh = lsSheet_(ss, LS_SHEET.price, LS_HEAD_PRICE);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, LS_HEAD_PRICE.length).getValues().map(function (v) {
    return { date: lsParseYmd_(v[0]), key: lsText_(v[1]), type: lsText_(v[2]),
      before: lsNumOrBlank_(v[4]), after: lsNumOrBlank_(v[5]), diff: lsNum_(v[6]) };
  });
}

function lsAppendPriceLog_(ss, changes) {
  if (!changes.length) return;
  var sh = lsSheet_(ss, LS_SHEET.price, LS_HEAD_PRICE);
  var out = changes.map(function (c) {
    return [c.date, c.key, c.type, c.address, c.before, c.after, c.diff, c.rate];
  });
  sh.getRange(sh.getLastRow() + 1, 1, out.length, LS_HEAD_PRICE.length).setValues(out);
}

/** 条件に合う既存行だけ捨てて、新しい行に差し替える。条件外の行はそのまま残す。 */
function lsReplaceRange_(ss, name, header, rows, shouldReplace) {
  var sh = lsSheet_(ss, name, header);
  var last = sh.getLastRow();
  var kept = [];
  if (last > 1) {
    var values = sh.getRange(2, 1, last - 1, header.length).getValues();
    values.forEach(function (v) {
      var norm = v.slice();
      norm[0] = (norm[0] instanceof Date) ? lsFmt_(norm[0]) : String(norm[0]);
      if (!shouldReplace(norm)) kept.push(norm);
    });
    sh.getRange(2, 1, last - 1, header.length).clearContent();
  }
  var out = kept.concat(rows);
  if (out.length) {
    sh.getRange(2, 1, out.length, header.length).setValues(out);
  }
}

function lsSheet_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function lsOpenSpreadsheet_() {
  var id = lsProp_('LS_SPREADSHEET_ID', '');
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw new Error('スプレッドシートを特定できません。スクリプトプロパティ LS_SPREADSHEET_ID を設定してください。');
  }
  return active;
}

// ---------------------------------------------------------------- CSV取込（任意）

/**
 * LS_CSV_FOLDER_ID のフォルダにあるCSVを「取込」シートへ追記する。
 * 読み終えたファイルは同フォルダ内の「済」へ移す（消さない）。
 */
function lsImportCsvFolder_(ss) {
  var folderId = lsProp_('LS_CSV_FOLDER_ID', '');
  if (!folderId) return { files: 0, rows: 0 };

  var folder = DriveApp.getFolderById(folderId);
  var done = lsSubFolder_(folder, '済');
  var charset = lsProp_('LS_CSV_CHARSET', 'UTF-8');
  var sh = lsSheet_(ss, LS_SHEET.intake, LS_HEAD_INTAKE);
  var today = lsToday_();

  var files = folder.getFiles();
  var fileCount = 0;
  var rowCount = 0;

  while (files.hasNext()) {
    var file = files.next();
    var name = file.getName();
    if (!/\.csv$/i.test(name)) continue;

    var table;
    try {
      table = Utilities.parseCsv(file.getBlob().getDataAsString(charset));
    } catch (err) {
      Logger.log('CSVを読めませんでした: ' + name + ' / ' + err);
      continue;
    }
    if (!table || table.length < 2) {
      file.moveTo(done);
      continue;
    }

    var idx = lsHeaderIndex_(table[0]);
    var out = [];
    for (var i = 1; i < table.length; i++) {
      var row = table[i];
      if (!row.join('').trim()) continue;
      out.push(LS_HEAD_INTAKE.map(function (h) {
        if (h === '取得日') {
          return lsParseYmd_(lsPick_(row, idx, '取得日')) || today;
        }
        if (h === '情報元') {
          return lsText_(lsPick_(row, idx, '情報元')) || name.replace(/\.csv$/i, '');
        }
        return lsText_(lsPick_(row, idx, h));
      }));
    }
    if (out.length) {
      sh.getRange(sh.getLastRow() + 1, 1, out.length, LS_HEAD_INTAKE.length).setValues(out);
      rowCount += out.length;
    }
    file.moveTo(done);
    fileCount++;
  }
  return { files: fileCount, rows: rowCount };
}

function lsSubFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** Receiver.gs のウェブアプリから type:'land' で受け取った行を「取込」シートへ入れる。 */
function lsIntakeFromPost_(ss, body) {
  var sh = lsSheet_(ss, LS_SHEET.intake, LS_HEAD_INTAKE);
  var today = lsToday_();
  var rows = (body.rows || []).map(function (r) {
    return [r['取得日'] || r.date || today, r['情報元'] || r.source || String(body.from || ''),
      r['元物件ID'] || r.id || '', r['種別'] || r.type || '', r['所在地'] || r.address || '',
      r['最寄駅'] || r.station || '', r['徒歩分'] || r.walk || '', r['価格'] || r.price || '',
      r['土地面積'] || r.landArea || '', r['建物面積'] || r.bldgArea || '',
      r['間取り'] || r.layout || '', r['築年月'] || r.built || '', r['階数'] || r.floors || '',
      r['掲載URL'] || r.url || '', r['備考'] || r.note || ''];
  });
  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, LS_HEAD_INTAKE.length).setValues(rows);
  }
  return rows.length;
}

// ---------------------------------------------------------------- 値の解釈

/** ヘッダー名（表記ゆれ込み）から列位置を引けるようにする。 */
function lsHeaderIndex_(header) {
  var synonyms = {
    '取得日': ['取得日', '日付', '確認日', '掲載日', 'date'],
    '情報元': ['情報元', '媒体', 'ソース', '出所', 'source'],
    '元物件ID': ['元物件ID', '物件番号', '物件ID', '管理番号', 'ID', 'id'],
    '種別': ['種別', '物件種別', '種目', '種類', 'type'],
    '所在地': ['所在地', '住所', '所在', '物件所在地', 'address'],
    '最寄駅': ['最寄駅', '沿線・駅', '沿線駅', '駅', 'station'],
    '徒歩分': ['徒歩分', '徒歩', '駅徒歩', 'walk'],
    '価格': ['価格', '販売価格', '売出価格', '金額', 'price'],
    '土地面積': ['土地面積', 'land', '土地', '敷地面積'],
    '建物面積': ['建物面積', '専有面積', '延床面積', '建物', 'building'],
    '間取り': ['間取り', '間取', 'layout'],
    '築年月': ['築年月', '築年', '建築年月', '完成時期', 'built'],
    '階数': ['階数', '所在階', '階建', 'floor', 'floors'],
    '掲載URL': ['掲載URL', 'URL', 'url', 'リンク'],
    '備考': ['備考', 'メモ', '摘要', 'note']
  };
  var normalized = header.map(function (h) { return String(h).replace(/\s|　/g, '').toLowerCase(); });
  var idx = {};
  Object.keys(synonyms).forEach(function (canon) {
    for (var i = 0; i < synonyms[canon].length; i++) {
      var want = synonyms[canon][i].replace(/\s|　/g, '').toLowerCase();
      var at = normalized.indexOf(want);
      if (at !== -1) { idx[canon] = at; return; }
    }
  });
  return idx;
}

function lsPick_(row, idx, canon) {
  var at = idx[canon];
  return (at === undefined) ? '' : row[at];
}

/** 表記ゆれを、集計に使う5種別に寄せる。 */
function lsNormalizeType_(raw) {
  var s = String(raw || '').replace(/\s|　/g, '');
  if (!s) return '土地';
  if (/一棟マンション|一棟アパート|アパート|共同住宅|一棟収益|収益マンション/.test(s)) return 'アパート';
  if (/ビル|事務所|オフィス|店舗|倉庫|工場|事業用/.test(s)) return 'ビル';
  if (/区分|マンション/.test(s)) return 'マンション(区分)';
  if (/戸建|一戸建|テラスハウス/.test(s)) return '戸建';
  if (/土地|売地|宅地|更地/.test(s)) return '土地';
  return '土地';
}

/** 「1億2,000万円」「12000」「1.2億」→ 万円単位の数値。 */
function lsParsePrice_(raw) {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'number') return lsRound_(raw, 0);
  var s = String(raw).replace(/[,，\s　円]/g, '');
  if (!s) return '';

  var oku = s.match(/([0-9.]+)億/);
  var man = s.match(/([0-9.]+)万/);
  if (oku || man) {
    var total = (oku ? parseFloat(oku[1]) * 10000 : 0) + (man ? parseFloat(man[1]) : 0);
    return isNaN(total) ? '' : lsRound_(total, 0);
  }
  var n = parseFloat(s.replace(/[^0-9.]/g, ''));
  return isNaN(n) ? '' : lsRound_(n, 0);
}

/** 「132.45㎡」「40坪」→ ㎡ の数値。 */
function lsParseArea_(raw) {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'number') return lsRound_(raw, 2);
  var s = String(raw).replace(/[,，\s　]/g, '');
  if (!s) return '';
  var tsubo = s.match(/([0-9.]+)坪/);
  if (tsubo) {
    var t = parseFloat(tsubo[1]);
    return isNaN(t) ? '' : lsRound_(t * LS_TSUBO, 2);
  }
  var n = parseFloat(s.replace(/[^0-9.]/g, ''));
  return isNaN(n) ? '' : lsRound_(n, 2);
}

/** 対象エリアかどうか。判定語は LS_AREA_KEYWORDS で変えられる。 */
function lsInArea_(address) {
  var keywords = lsProp_('LS_AREA_KEYWORDS', '恵比寿').split(/[,、]/).map(function (s) {
    return s.trim();
  }).filter(function (s) { return s; });
  if (!keywords.length) return true;
  var s = String(address || '');
  return keywords.some(function (k) { return s.indexOf(k) !== -1; });
}

/** 丁目・番地の表記ゆれでキーがぶれないように整える。 */
function lsNormalizeAddress_(address) {
  return String(address || '')
    .replace(/[\s　]/g, '')
    .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/丁目|番地|番|号/g, '-')
    .replace(/-+/g, '-')
    .replace(/-$/, '')
    .replace(/^東京都/, '');
}

// ---------------------------------------------------------------- 小物

function lsProp_(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === undefined || v === '') ? fallback : v;
}

function lsToday_() {
  return Utilities.formatDate(new Date(), LS_TZ, 'yyyy-MM-dd');
}

function lsFmt_(date) {
  return Utilities.formatDate(date, LS_TZ, 'yyyy-MM-dd');
}

function lsParseYmd_(value) {
  if (!value && value !== 0) return '';
  if (value instanceof Date) return lsFmt_(value);
  var s = String(value).trim();
  var m = s.match(/(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})/);
  if (!m) return '';
  return m[1] + '-' + lsPad2_(m[2]) + '-' + lsPad2_(m[3]);
}

function lsPad2_(n) {
  return ('0' + Number(n)).slice(-2);
}

function lsYmdToDate_(ymd) {
  var p = String(ymd).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function lsShiftYmd_(ymd, days) {
  var d = lsYmdToDate_(ymd);
  d.setDate(d.getDate() + days);
  return Utilities.formatDate(d, LS_TZ, 'yyyy-MM-dd');
}

function lsShiftMonth_(ym, months) {
  var p = ym.split('-');
  var d = new Date(Number(p[0]), Number(p[1]) - 1 + months, 1);
  return Utilities.formatDate(d, LS_TZ, 'yyyy-MM');
}

function lsMonthEnd_(ym) {
  var p = ym.split('-');
  var d = new Date(Number(p[0]), Number(p[1]), 0);
  return Utilities.formatDate(d, LS_TZ, 'yyyy-MM-dd');
}

function lsDiffDays_(fromYmd, toYmd) {
  if (!fromYmd || !toYmd) return '';
  var ms = lsYmdToDate_(toYmd).getTime() - lsYmdToDate_(fromYmd).getTime();
  return Math.max(0, Math.round(ms / 86400000));
}

function lsText_(v) {
  return (v === null || v === undefined) ? '' : String(v).trim();
}

function lsNum_(v) {
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

function lsNumOrBlank_(v) {
  if (v === '' || v === null || v === undefined) return '';
  var n = Number(v);
  return isNaN(n) ? '' : n;
}

function lsIsNum_(v) {
  return typeof v === 'number' && !isNaN(v);
}

function lsRound_(n, digits) {
  if (!lsIsNum_(Number(n)) || n === '' || n === null) return '';
  var f = Math.pow(10, digits);
  return Math.round(Number(n) * f) / f;
}

function lsMedian_(values) {
  var nums = values.filter(function (v) { return lsIsNum_(v) && v > 0; })
    .sort(function (a, b) { return a - b; });
  if (!nums.length) return '';
  var mid = Math.floor(nums.length / 2);
  return (nums.length % 2) ? nums[mid] : lsRound_((nums[mid - 1] + nums[mid]) / 2, 1);
}

function lsAverage_(values) {
  var nums = values.filter(function (v) { return lsIsNum_(v); });
  if (!nums.length) return '';
  var sum = nums.reduce(function (a, b) { return a + b; }, 0);
  return lsRound_(sum / nums.length, 1);
}

function lsAppendNote_(note, add) {
  var s = lsText_(note);
  return s ? (s + ' / ' + add) : add;
}

function lsSlug_(s) {
  return String(s).replace(/[\s　]/g, '').slice(0, 120);
}

function lsHash_(seed) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(seed), Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2);
  }).join('').slice(0, 16);
}
