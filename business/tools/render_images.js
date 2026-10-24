// Rendert das Etsy-Titelbild und Vorschau-Screenshots der Website.
// Aufruf (aus dem Ordner business/):  node tools/render_images.js
const path = require("path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const url = (p) => "file://" + path.join(root, p);

(async () => {
  const browser = await chromium.launch();

  const cover = await browser.newPage({ viewport: { width: 2400, height: 1800 } });
  await cover.goto(url("marketing/cover.html"));
  await cover.screenshot({ path: path.join(root, "marketing/produktbilder/01-titelbild.png") });

  const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await desktop.goto(url("website/index.html"));
  await desktop.screenshot({ path: path.join(root, "marketing/produktbilder/website-desktop.png"), fullPage: true });

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await phone.goto(url("website/index.html"));
  await phone.screenshot({ path: path.join(root, "marketing/produktbilder/website-handy.png"), fullPage: true });
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log("Handy: horizontales Scrollen?", overflow);

  await browser.close();
})();
