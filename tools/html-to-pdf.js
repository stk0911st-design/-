// HTML ファイルを A4 の PDF に変換する（事務パイプラインの日次PDF用）。
// 使い方: node tools/html-to-pdf.js <入力.html> <出力.pdf>
// クラウド環境に入っている Chromium と Playwright をそのまま使う（追加のインストール不要）。
// 日本語は IPAゴシック（ipafont-gothic）で表示される。
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const [, , input, output] = process.argv;
  if (!input || !output) {
    console.error('使い方: node tools/html-to-pdf.js <入力.html> <出力.pdf>');
    process.exit(1);
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.resolve(input), { waitUntil: 'load' });
    await page.pdf({
      path: output,
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
    });
    console.log('PDF を作成しました: ' + output);
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
