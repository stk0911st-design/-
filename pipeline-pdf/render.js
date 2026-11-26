#!/usr/bin/env node
// 営業パイプラインの PDF を作る。
//   node pipeline-pdf/render.js <data.json> <出力.pdf>
// data.json の形は pipeline-pdf/sample-data.json を参照。
// 金額は data.json に入れない（割合と件数だけ）。入っていたら止める。
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

async function main() {
  const [dataPath, outPath] = process.argv.slice(2);
  if (!dataPath || !outPath) {
    console.error("使い方: node pipeline-pdf/render.js <data.json> <出力.pdf>");
    process.exit(2);
  }
  const raw = fs.readFileSync(dataPath, "utf8");
  const data = JSON.parse(raw);

  // 金額らしき記述（¥、円、万円、億円など）が入っていたら PDF を作らない
  const money = /[¥￥]|\d[\d,，.]*\s*(万円|億円|千円|円|万|億)/;
  const hit = JSON.stringify(data).match(money);
  if (hit) {
    console.error(`金額らしき記述があるため止めました: 「${hit[0]}」`);
    process.exit(3);
  }

  const template = fs.readFileSync(path.join(__dirname, "template.html"), "utf8");
  const html = template.replace("<script>", `<script>window.DATA = ${JSON.stringify(data).replace(/</g, "\\u003c")};</script>\n<script>`);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 20000 }).catch(() => {});
    await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
    await page.pdf({ path: outPath, format: "A4", printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
  console.log(`作成しました: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
