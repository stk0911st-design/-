/**
 * 補助金ウォッチ まとめメール
 *
 * SUBSIDIES に登録した補助金・助成金から、締切までの残日数を計算し、
 * 至急のものを先頭に並べて指定アドレスへ HTML メールで送信する。
 *
 * プロフィール（対象事業者の条件）ごとに送り分ける。
 *   tokyo    … 東京都／従業員6〜20人／不動産業
 *   kanagawa … 神奈川県／従業員5人以下（小規模事業者）
 *
 * 想定トリガー: 時間主導型 / 週ベース / 毎週木曜 午前9時〜10時
 *
 * スクリプトプロパティ:
 *   SENDER              差出人アドレス（必須・Gmailのエイリアスに登録済みであること）
 *   SENDER_NAME         差出人表示名（任意）
 *   RECIPIENT_TOKYO     tokyo プロフィールの送信先（カンマ区切り可）
 *   RECIPIENT_KANAGAWA  kanagawa プロフィールの送信先（カンマ区切り可）
 *   CC                  CCアドレス（任意・カンマ区切り）
 *
 * ※ 公募情報が変わったら SUBSIDIES を更新すること。
 *    このスクリプトは Web 検索をしないため、内容の鮮度は手入力に依存する。
 */

var TZ = 'Asia/Tokyo';

/** 残日数がこの日数以下になったら「至急」として先頭に出す。 */
var URGENT_DAYS = 30;

/**
 * 補助金・助成金の一覧。
 *   profiles … 対象プロフィール（'tokyo' / 'kanagawa'）
 *   deadline … 'YYYY-MM-DD'。通年・未定は null
 *   closed   … true にすると「参考（今年度終了）」に回す
 */
var SUBSIDIES = [
  {
    name: '神奈川県小規模事業者デジタル化支援推進事業費補助金',
    agency: '神奈川県',
    profiles: ['kanagawa'],
    deadline: '2026-09-30',
    deadlineNote: '17:00締切',
    amount: '上限50万円',
    rate: '補助対象経費の2/3以内',
    requirements: [
      '令和7年4月1日までに創業した、神奈川県内に事業所を有する小規模事業者等',
      '過年度に本補助金の交付を受けた事業者は申請不可',
      '交付決定日より前に着手（発注・契約・申込）した経費は対象外'
    ],
    documents: [
      '対象経費は (1)ITサービス導入費 (2)ホームページ作成改修費 (3)機械装置等費',
      '(3)のみでの申請は不可。パソコン・タブレット等の周辺機器は合計10万円が上限',
      '登記簿、決算書、事業計画 ほか（公募要領を確認）'
    ],
    note: '事業実施期間は交付決定日〜令和9年1月31日。事前相談は神奈川産業振興センター（KIP）へ。',
    url: 'https://www.pref.kanagawa.jp/docs/m2w/shokibo_digital/r8.html'
  },
  {
    name: '業務改善助成金',
    agency: '厚生労働省',
    profiles: ['tokyo', 'kanagawa'],
    deadline: '2026-09-30',
    deadlineNote: '地域別最低賃金の発効日（10月1日）の前日',
    amount: '上限600万円',
    rate: '最大4/5',
    requirements: [
      '事業場内で最も低い賃金を50円以上引き上げ、あわせて生産性向上に資する設備投資等を行うこと',
      '50円・70円・90円の3コース（30円コースは令和8年度に廃止）',
      '事業場内最低賃金と地域別最低賃金の差額が規定内であること',
      '順序厳守：計画作成 → 交付申請 → 賃金引上げ → 交付決定 → 設備導入 → 実績報告'
    ],
    documents: [
      '交付申請書、事業実施計画書、賃金引上げ計画',
      '賃金台帳、労働者名簿、就業規則（賃金規程）',
      '見積書（原則相見積）、事業場の登記事項証明書'
    ],
    note: '2026年10月1日から東京都1,280円・神奈川県1,279円へ改定（ともに54円引上げ）。'
      + '交付決定前に設備を導入すると対象外になる。',
    url: 'https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/koyou_roudou/roudoukijun/zigyonushi/shienjigyou/03.html'
  },
  {
    name: '小規模事業者持続化補助金＜一般型・通常枠＞第20回',
    agency: '中小企業庁',
    profiles: ['kanagawa'],
    deadline: '2026-12-15',
    deadlineNote: '17:00締切／様式4の発行受付締切は12月4日（金）',
    amount: '上限50万円（インボイス特例+50万円／賃金引上げ特例+150万円＝最大250万円）',
    rate: '2/3（赤字事業者は3/4）',
    requirements: [
      '小規模事業者であること（商業・サービス業は従業員5人以下、製造業その他は20人以下）',
      'GビズIDプライムの取得',
      '商工会議所・商工会が発行する「事業支援計画書（様式4）」'
    ],
    documents: [
      '経営計画書・補助事業計画書',
      '事業支援計画書（様式4／商工会議所・商工会が発行）',
      '直近の確定申告書・決算書',
      '（特例利用時）インボイス登録通知、賃金引上げの誓約書・賃金台帳'
    ],
    note: '申請受付は2026年11月5日開始。様式4の発行締切が申請締切より前なので、'
      + '10月中には商工会議所への相談を始めること。GビズIDプライムは発行に2〜3週間かかる。',
    url: 'https://official.jizokukanb.com/'
  },
  {
    name: '中小企業省力化投資補助金（一般型）',
    agency: '中小企業庁',
    profiles: ['tokyo', 'kanagawa'],
    deadline: null,
    deadlineNote: '第8回は2026年9月中旬受付開始・10月中旬締切予定（要確認）',
    amount: '公募回次により異なる',
    rate: '公募要領を確認',
    requirements: [
      'GビズIDプライムの取得',
      '労働生産性の向上目標および賃上げ計画'
    ],
    documents: ['事業計画書、決算書、賃上げ表明書 ほか'],
    note: '人手不足解消のための省力化投資が対象。第8回の採択発表は2027年2月上旬予定。',
    url: 'https://shoryokuka.smrj.go.jp/'
  },
  {
    name: 'デジタル化・AI導入補助金2026（旧 IT導入補助金）',
    agency: '中小企業庁',
    profiles: ['tokyo', 'kanagawa'],
    deadline: null,
    deadlineNote: '公募回次ごとに締切あり（要確認）',
    amount: '枠により異なる',
    rate: '公募要領を確認',
    requirements: [
      'GビズIDプライムの取得',
      'SECURITY ACTION の自己宣言',
      'IT導入支援事業者（ベンダー）との共同申請'
    ],
    documents: ['交付申請書、登記事項証明書、納税証明書、決算書'],
    note: '令和7年度補正予算事業から名称変更。AIを含むITツールの導入が対象。',
    url: 'https://it-shien.smrj.go.jp/'
  },
  {
    name: '手取り時間創出・魅力ある職場づくり推進奨励金',
    agency: '東京しごと財団',
    profiles: ['tokyo'],
    deadline: null,
    deadlineNote: '事前エントリー制。各回140社・全10回（次回回次の開始日を要確認）',
    amount: '最大264万円',
    rate: '定額',
    requirements: [
      '都内で事業を営む中小企業等（常時雇用する労働者300人以下）',
      '就業規則の整備、柔軟な働き方に資する制度の導入、賃金引上げ等の取組'
    ],
    documents: [
      '事前エントリー → 支給申請書',
      '就業規則、賃金台帳、労働者名簿',
      '登記事項証明書、都税の納税証明書'
    ],
    note: '先着枠のため、次回エントリー開始日の把握が重要。',
    url: 'https://www.tokyo-engagement.jp/'
  },
  {
    name: 'キャリアアップ助成金 正社員化コース',
    agency: '厚生労働省',
    profiles: ['tokyo', 'kanagawa'],
    deadline: null,
    deadlineNote: '通年（転換後6か月分の賃金支払い後2か月以内に支給申請）',
    amount: '中小企業 1人40万円（重点支援対象者は2期で最大80万円）／情報公表加算20万円',
    rate: '定額・年間20人まで',
    requirements: [
      '雇用保険適用事業所であること',
      'キャリアアップ管理者を配置していること',
      '転換前にキャリアアップ計画書を労働局へ提出していること',
      '就業規則等に正社員転換制度を規定していること',
      '転換前後で賃金を3%以上増額していること'
    ],
    documents: [
      'キャリアアップ計画書、支給申請書',
      '就業規則（転換規定）、転換前後の雇用契約書',
      '賃金台帳、出勤簿、労働者名簿'
    ],
    note: '令和8年度から情報公表加算（自社サイトまたは「しょくばらぼ」で公表）が新設。'
      + '計画書を先に出していないと不支給になる点に注意。',
    url: 'https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/koyou_roudou/part_haken/jigyounushi/career.html'
  },
  {
    name: '東京都正規雇用転換安定化支援助成金',
    agency: '東京都',
    profiles: ['tokyo'],
    deadline: null,
    deadlineNote: '令和8年5月1日より受付中',
    amount: '1人20万円×最大5人＋加算（退職金制度10万円／結婚・出産支援10万円／介護支援10万円／賃上げ1人12万円×最大5人）＝最大190万円',
    rate: '定額',
    requirements: [
      '東京労働局管内の雇用保険適用事業所であること',
      '2023年4月1日以降の正社員転換で、キャリアアップ助成金（正社員化コース）の支給決定を受けていること',
      '3年間の指導・育成計画の作成、指定講習受講者による指導',
      '退職金制度・両立支援制度の整備、賃上げ等の取組'
    ],
    documents: [
      '申請書、育成計画書',
      'キャリアアップ助成金の支給決定通知書の写し',
      '就業規則・退職金規程、賃金台帳'
    ],
    note: 'キャリアアップ助成金への上乗せ制度。令和8年度に対象人数が3人→5人へ拡大、介護支援制度加算が新設。',
    url: 'https://www.hataraku.metro.tokyo.lg.jp/seiki-koyo/kigyou/anteika/'
  },
  {
    name: '人材開発支援助成金',
    agency: '厚生労働省',
    profiles: ['tokyo', 'kanagawa'],
    deadline: null,
    deadlineNote: '通年（訓練開始日の6か月前〜1か月前までに計画届の提出が必要）',
    amount: 'コースにより異なる（経費助成・賃金助成）',
    rate: '中小企業は経費助成 最大75%（事業展開等リスキリング支援コース）',
    requirements: [
      '職業能力開発推進者を選任していること',
      '事業内職業能力開発計画を作成し周知していること',
      '訓練開始日の6か月前〜1か月前までに「職業訓練実施計画届」を労働局へ提出すること'
    ],
    documents: [
      '職業訓練実施計画届、対象者一覧',
      '事業内職業能力開発計画、カリキュラム',
      '訓練委託契約書・見積書、支給申請書、賃金台帳、出勤簿'
    ],
    note: '資格取得支援・営業研修・DXリスキリング等が対象になり得る。計画届の提出時期に注意。',
    url: 'https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/koyou_roudou/koyou/kyufukin/d01-1.html'
  },
  {
    name: '神奈川県中小企業生産性向上促進事業費補助金',
    agency: '神奈川県',
    profiles: ['kanagawa'],
    deadline: null,
    closed: true,
    deadlineNote: '令和8年度は6月・7月・8月の3回公募で終了（8月公募は8月31日締切）',
    amount: '一般枠 上限500万円',
    rate: '1/2（小規模事業者は2/3）',
    requirements: [
      '6月・7月・8月公募のうちいずれか1回のみ申請可',
      '一般枠・グループ化支援枠・創業者成長支援枠のいずれか1つのみ申請可',
      '交付決定日（又は申請日）以降に着手した事業が対象'
    ],
    documents: ['事業計画書、見積書、決算書 ほか（公募要領を確認）'],
    note: '設備投資の予定があれば令和9年度の公募に向けて計画を準備しておく。',
    url: 'https://r8seisansei.pref.kanagawa.jp/'
  }
];

/** プロフィールの定義。 */
var PROFILES = {
  tokyo: {
    label: '東京都／従業員6〜20人',
    recipientProp: 'RECIPIENT_TOKYO',
    greeting: 'おはようございます。今週の補助金・助成金の状況です。',
    excluded: '小規模事業者持続化補助金は「商業・サービス業は従業員5人以下」要件のため対象外です。'
  },
  kanagawa: {
    label: '神奈川県／従業員5人以下（小規模事業者）',
    recipientProp: 'RECIPIENT_KANAGAWA',
    greeting: 'おはようございます。今週の補助金・助成金の状況をお送りします。',
    excluded: ''
  }
};

/** 定期トリガーから呼ぶ本番用エントリポイント。全プロフィールへ送信する。 */
function sendSubsidyMail() {
  Object.keys(PROFILES).forEach(function (key) {
    runProfile_(key, false);
  });
}

/** 送信せずに文面をログ出力する確認用エントリポイント。 */
function previewSubsidyMail() {
  Object.keys(PROFILES).forEach(function (key) {
    runProfile_(key, true);
  });
}

/** 東京都プロフィールのみ送信する。 */
function sendSubsidyMailTokyo() {
  runProfile_('tokyo', false);
}

/** 神奈川プロフィールのみ送信する。 */
function sendSubsidyMailKanagawa() {
  runProfile_('kanagawa', false);
}

function runProfile_(profileKey, isPreview) {
  var profile = PROFILES[profileKey];
  if (!profile) {
    throw new Error('未知のプロフィールです: ' + profileKey);
  }

  var today = todayInTz_();
  var items = collectItems_(profileKey, today);
  var subject = buildSubject_(today, items);
  var html = buildHtml_(profile, today, items);

  if (isPreview) {
    Logger.log('--- ' + profile.label + ' ---');
    Logger.log('件名: ' + subject);
    Logger.log(htmlToPlainText_(html));
    return;
  }

  var props = PropertiesService.getScriptProperties();
  var recipient = props.getProperty(profile.recipientProp);
  if (!recipient) {
    Logger.log('スクリプトプロパティ ' + profile.recipientProp + ' が未設定のため、'
      + profile.label + ' はスキップしました。');
    return;
  }

  var options = { htmlBody: html };
  var sender = resolveSender_(props);
  if (sender) {
    options.from = sender;
  }
  var senderName = props.getProperty('SENDER_NAME');
  if (senderName) {
    options.name = senderName;
  }
  var cc = props.getProperty('CC');
  if (cc) {
    options.cc = cc;
  }

  GmailApp.sendEmail(recipient, subject, htmlToPlainText_(html), options);
  Logger.log('送信しました: ' + subject + ' → ' + recipient
    + '（' + profile.label + ' / ' + items.all.length + '件'
    + (sender ? ' / 差出人 ' + sender : '') + '）');
}

/**
 * 差出人アドレスを決める。
 * Gmail のエイリアスに登録されていないアドレスは指定できないため、事前に検証する。
 */
function resolveSender_(props) {
  var sender = props.getProperty('SENDER');
  if (!sender) {
    return null;
  }
  var aliases = GmailApp.getAliases();
  if (aliases.indexOf(sender) === -1) {
    throw new Error('差出人 ' + sender + ' は Gmail のエイリアスに登録されていません。'
      + 'Gmail の「設定 → アカウントとインポート → 他のメールアドレスを追加」で登録してください。'
      + '（現在利用できるエイリアス: ' + (aliases.length ? aliases.join(', ') : 'なし') + '）');
  }
  return sender;
}

/** プロフィールに該当する制度を集め、締切の状態ごとに仕分ける。 */
function collectItems_(profileKey, today) {
  var urgent = [];
  var scheduled = [];
  var anytime = [];
  var closed = [];

  SUBSIDIES.forEach(function (item) {
    if (item.profiles.indexOf(profileKey) === -1) {
      return;
    }
    var entry = {
      data: item,
      daysLeft: item.deadline ? daysBetween_(today, item.deadline) : null
    };
    if (item.closed) {
      closed.push(entry);
    } else if (entry.daysLeft === null) {
      anytime.push(entry);
    } else if (entry.daysLeft < 0) {
      closed.push(entry);
    } else if (entry.daysLeft <= URGENT_DAYS) {
      urgent.push(entry);
    } else {
      scheduled.push(entry);
    }
  });

  urgent.sort(byDaysLeft_);
  scheduled.sort(byDaysLeft_);

  return {
    urgent: urgent,
    scheduled: scheduled,
    anytime: anytime,
    closed: closed,
    all: urgent.concat(scheduled, anytime, closed)
  };
}

function byDaysLeft_(a, b) {
  return a.daysLeft - b.daysLeft;
}

function buildSubject_(today, items) {
  return '【補助金ウォッチ】' + formatDateLabel_(today)
    + '｜至急' + items.urgent.length + '件・受付中' + items.scheduled.length + '件';
}

function buildHtml_(profile, today, items) {
  var out = [];
  out.push('<div style="font-family:sans-serif;font-size:14px;line-height:1.75;color:#1f2328;max-width:720px">');
  out.push('<p>' + esc_(profile.greeting) + '</p>');
  out.push('<p style="color:#57606a;font-size:13px">対象条件：' + esc_(profile.label) + '</p>');

  if (items.urgent.length > 0) {
    out.push(sectionHeading_('至急（締切まで' + URGENT_DAYS + '日以内）', '#cf222e'));
    items.urgent.forEach(function (entry) {
      out.push(buildCard_(entry, true));
    });
  } else {
    out.push('<p>締切が' + URGENT_DAYS + '日以内に迫っている制度はありません。</p>');
  }

  if (items.scheduled.length > 0) {
    out.push(sectionHeading_('受付中・今後の締切', '#bf8700'));
    items.scheduled.forEach(function (entry) {
      out.push(buildCard_(entry, false));
    });
  }

  if (items.anytime.length > 0) {
    out.push(sectionHeading_('通年・随時', '#0969da'));
    items.anytime.forEach(function (entry) {
      out.push(buildCard_(entry, false));
    });
  }

  if (items.closed.length > 0) {
    out.push(sectionHeading_('参考（今年度の受付は終了）', '#57606a'));
    items.closed.forEach(function (entry) {
      out.push(buildCard_(entry, false));
    });
  }

  if (profile.excluded) {
    out.push('<p style="margin-top:20px"><b>対象外</b>：' + esc_(profile.excluded) + '</p>');
  }

  out.push('<p style="color:#57606a;font-size:12px;border-top:1px solid #d0d7de;padding-top:10px;margin-top:24px">');
  out.push('※ 本メールは登録済みの制度情報から自動作成しています。');
  out.push('申請前に必ず各制度の最新の公募要領をご確認ください。');
  out.push('</p>');
  out.push('</div>');
  return out.join('');
}

function sectionHeading_(text, color) {
  return '<h3 style="font-size:15px;margin:24px 0 10px;padding-bottom:6px;'
    + 'border-bottom:2px solid ' + color + ';color:' + color + '">' + esc_(text) + '</h3>';
}

function buildCard_(entry, isUrgent) {
  var item = entry.data;
  var border = isUrgent ? '2px solid #cf222e' : '1px solid #d0d7de';
  var background = isUrgent ? '#fff5f5' : '#ffffff';

  var out = [];
  out.push('<div style="border:' + border + ';border-radius:8px;padding:12px 16px;'
    + 'margin:0 0 14px;background:' + background + '">');
  out.push('<p style="margin:0 0 4px;font-weight:700;font-size:15px">' + esc_(item.name) + '</p>');
  out.push('<p style="margin:0 0 8px;color:#57606a;font-size:12px">' + esc_(item.agency) + '</p>');
  out.push('<p style="margin:0 0 8px"><b>' + esc_(deadlineLabel_(entry)) + '</b></p>');
  out.push('<p style="margin:0 0 8px">' + esc_(item.amount) + '／補助率：' + esc_(item.rate) + '</p>');
  out.push(bulletBlock_('主な要件', item.requirements));
  out.push(bulletBlock_('必要書類・対象経費', item.documents));
  if (item.note) {
    out.push('<p style="margin:8px 0 0;padding:8px 10px;background:#f6f8fa;border-left:3px solid #d0d7de">'
      + esc_(item.note) + '</p>');
  }
  if (item.url) {
    out.push('<p style="margin:8px 0 0;font-size:13px">公式：<a href="' + esc_(item.url) + '">'
      + esc_(item.url) + '</a></p>');
  }
  out.push('</div>');
  return out.join('');
}

function bulletBlock_(title, list) {
  if (!list || list.length === 0) {
    return '';
  }
  var out = ['<p style="margin:8px 0 4px"><b>' + esc_(title) + '</b></p><ul style="margin:0;padding-left:20px">'];
  list.forEach(function (text) {
    out.push('<li>' + esc_(text) + '</li>');
  });
  out.push('</ul>');
  return out.join('');
}

function deadlineLabel_(entry) {
  var item = entry.data;
  if (entry.daysLeft === null) {
    return item.deadlineNote || '通年・随時';
  }
  var label = '締切 ' + formatDateLabel_(item.deadline);
  if (entry.daysLeft < 0) {
    label += '（受付終了）';
  } else if (entry.daysLeft === 0) {
    label += '（本日締切）';
  } else {
    label += '（残り' + entry.daysLeft + '日）';
  }
  if (item.deadlineNote) {
    label += ' ' + item.deadlineNote;
  }
  return label;
}

/** 実行日（JST）を 'YYYY-MM-DD' で返す。 */
function todayInTz_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

/** 'YYYY-MM-DD' 同士の日数差を返す。タイムゾーンの影響を受けないよう UTC で計算する。 */
function daysBetween_(fromYmd, toYmd) {
  var from = parseYmd_(fromYmd);
  var to = parseYmd_(toYmd);
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

function parseYmd_(ymd) {
  var parts = String(ymd).split('-');
  return Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

function formatDateLabel_(ymd) {
  var parts = String(ymd).split('-');
  var wd = ['日', '月', '火', '水', '木', '金', '土'][new Date(parseYmd_(ymd)).getUTCDay()];
  return parts[0] + '年' + Number(parts[1]) + '月' + Number(parts[2]) + '日(' + wd + ')';
}

function esc_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlToPlainText_(html) {
  return html
    .replace(/<\/(p|tr|li|div|h3|ul)>/g, '\n')
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
