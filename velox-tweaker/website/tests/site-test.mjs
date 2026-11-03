// VELOX website tests (Playwright + Chromium, no install needed - uses the global module).
//   node website/tests/site-test.mjs            all checks + screenshots in website/tests/screenshots/
//   node website/tests/site-test.mjs --no-shots checks only
// Serves website/ like GitHub Pages does (under /vanity-/, 404.html for unknown paths).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadPlaywright, startServer, site, app, here, BASE, SAMPLE_FRAGMENT } from './lib.mjs';

const SHOTS = !process.argv.includes('--no-shots');
const shotDir = path.join(here, 'screenshots');
if (SHOTS) { fs.rmSync(shotDir, { recursive: true, force: true }); fs.mkdirSync(shotDir, { recursive: true }); }

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, info = '') {
  if (ok) { pass++; console.log('  ok    ' + name); }
  else { fail++; failures.push(name + (info ? ' - ' + info : '')); console.log('  FAIL  ' + name + (info ? ' - ' + info : '')); }
}
const read = (p) => fs.readFileSync(p, 'utf8');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ------------------------------------------------------------------ static checks (no browser)
console.log('\nStatic checks');
const PAGES = ['index.html', 'bios.html', 'impressum.html', 'datenschutz.html', '404.html'];
for (const p of PAGES) {
  const html = read(path.join(site, p));
  check(`${p}: CSP meta present`, /http-equiv="Content-Security-Policy"/.test(html));
  check(`${p}: no inline <script> code`, !/<script(?![^>]*\bsrc=)[^>]*>\s*\S/.test(html));
  check(`${p}: no style attributes or <style> blocks`, !/\sstyle="/.test(html) && !/<style[\s>]/.test(html));
  check(`${p}: no inline event handlers`, !/\son[a-z]+="/.test(html));
  check(`${p}: no external stylesheet/script/font hosts`, !/<(link(?![^>]*rel="canonical")|script)[^>]+(href|src)="https?:\/\//.test(html));
  check(`${p}: lang="de" and viewport`, /<html lang="de"/.test(html) && /name="viewport"/.test(html));
}

// brand copies are byte-identical to velox-tweaker/brand
const brandFiles = fs.readdirSync(path.join(site, 'brand'));
const brandDiff = brandFiles.filter((f) => sha(path.join(site, 'brand', f)) !== sha(path.join(app, 'brand', f)));
check(`brand/ copies identical to velox-tweaker/brand (${brandFiles.length} files)`, brandDiff.length === 0, brandDiff.join(', '));
for (const f of ['intro.js', 'light-worker.js', 'sound.js', 'glyphs.js', 'intro.css', 'tokens.css']) check(`brand runtime file present: ${f}`, brandFiles.includes(f));

// BIOS texts are a copy of data/bios/recommendations.json
const recSrc = path.join(app, 'data/bios/recommendations.json'), recDst = path.join(site, 'assets/data/bios/recommendations.json');
check('assets/data/bios/recommendations.json is a copy of data/bios/recommendations.json',
  fs.existsSync(recSrc) && fs.existsSync(recDst) && sha(recSrc) === sha(recDst), 'copy it again: cp data/bios/recommendations.json website/assets/data/bios/');

// version, download link: config.js = VERSION file = HTML fallbacks
const cfgSrc = read(path.join(site, 'assets/js/config.js'));
const cfgVersion = (cfgSrc.match(/version:\s*'([^']+)'/) || [])[1];
const cfgDownload = (cfgSrc.match(/download:\s*'([^']+)'/) || [])[1];
const appVersion = read(path.join(app, 'VERSION')).trim();
check(`config.js version (${cfgVersion}) = velox-tweaker/VERSION (${appVersion})`, cfgVersion === appVersion);
const index = read(path.join(site, 'index.html'));
const fallbackVersions = [...index.matchAll(/data-velox="version">([^<]+)</g)].map((m) => m[1]);
check('index.html version fallbacks match config.js', fallbackVersions.length > 0 && fallbackVersions.every((v) => v === cfgVersion), fallbackVersions.join(','));
const fallbackLinks = [...index.matchAll(/href="([^"]+)" data-velox="download"/g)].map((m) => m[1]);
check('index.html download links match config.js', fallbackLinks.length >= 3 && fallbackLinks.every((h) => h === cfgDownload), fallbackLinks.length + ' links');
check('download link points at dist/VeloxSetup.exe of this repo', /github\.com\/georghatzmann-bit\/vanity-\/raw\/.+\/velox-tweaker\/dist\/VeloxSetup\.exe$/.test(cfgDownload || ''));
const changelogTop = (index.match(/class="release latest[^"]*">\s*<div class="release-meta"><span class="ver">([^<]+)</) || [])[1];
check(`changelog's newest entry (${changelogTop}) = current version`, changelogTop === cfgVersion);

// the numbers on the page come from data/
const tweaks = []; for (const f of fs.readdirSync(path.join(app, 'data/tweaks'))) { const j = JSON.parse(read(path.join(app, 'data/tweaks', f))); tweaks.push(...(Array.isArray(j) ? j : j.tweaks || [])); }
const risk = (r) => tweaks.filter((t) => t.risk === r).length;
const presets = JSON.parse(read(path.join(app, 'data/presets.json'))); const presetList = Array.isArray(presets) ? presets : presets.presets;
const dt = JSON.parse(read(path.join(app, 'data/detweak.json'))); const detweak = Object.values(dt).filter(Array.isArray).reduce((a, b) => a + b.length, 0);
const cats = JSON.parse(read(path.join(app, 'data/categories.json'))).categories.length;
const catalogFile = (f) => { const j = JSON.parse(read(path.join(app, 'data/tweaks', f))); return (Array.isArray(j) ? j : j.tweaks).length; };
const truth = { tweaks: tweaks.length, presets: presetList.length, detweak, safe: risk('safe'), moderate: risk('moderate'), risky: risk('risky'), cleanup: catalogFile('cleanup.json'), repair: catalogFile('repair.json') };
for (const [key, val] of Object.entries(truth)) {
  const shown = [...index.matchAll(new RegExp(`data-count="${key}">(\\d+)<`, 'g'))].map((m) => +m[1]);
  check(`number "${key}" on the page = data/ (${val})`, shown.length > 0 && shown.every((n) => n === val), 'page shows ' + shown.join(','));
}
check(`"16 Kategorien" = data/categories.json (${cats})`, index.includes(cats + ' Kategorien'));
const css = read(path.join(site, 'assets/css/site.css'));
check('risk bar shares in site.css = data/', css.includes(`.s { flex: ${truth.safe} `) && css.includes(`.m { flex: ${truth.moderate} `) && css.includes(`.r { flex: ${truth.risky} `));
check('every preset name appears on the page', presetList.every((p) => index.includes(p.name.replace(/&/g, '&amp;'))), presetList.map((p) => p.name).join(', '));

// no made-up social proof
const lower = index.toLowerCase();
check('no testimonials, ratings, follower counts or prices', !/(bewertung|sterne|★|follower|kunden sagen|testimonial|€\s*\d|\d+[,.]\d\d\s*€|trustpilot|paypal)/.test(lower));
check('no FPS promises (no "+NN% FPS" or "NN FPS mehr")', !/\+\s*\d+\s*%?\s*fps|\d+\s*fps\s*mehr/i.test(index));

// image weight
const imgDir = path.join(site, 'assets/img');
const imgBytes = fs.readdirSync(imgDir).reduce((a, f) => a + fs.statSync(path.join(imgDir, f)).size, 0);
check(`images stay small (${Math.round(imgBytes / 1024)} KB in assets/img, budget 1200 KB)`, imgBytes < 1200 * 1024);
const bigImg = fs.readdirSync(imgDir).filter((f) => fs.statSync(path.join(imgDir, f)).size > 150 * 1024);
check('no single image over 150 KB', bigImg.length === 0, bigImg.join(', '));

// ------------------------------------------------------------------ browser checks
const { chromium } = loadPlaywright();
const server = await startServer();
const browser = await chromium.launch();

function watch(page, bucket) {
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    if (/status of 404/.test(m.text()) && /does-not-exist|gibt\/es\/nicht/.test((m.location() || {}).url || '')) return;   // the 404 page itself
    bucket.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => bucket.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => { if (!/favicon/.test(r.url())) bucket.push('requestfailed: ' + r.url() + ' ' + (r.failure() || {}).errorText); });
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/does-not-exist')) bucket.push('HTTP ' + r.status() + ' ' + r.url()); });
}
async function newPage({ width, height, theme = 'dark', reduced = false, dpr = 1 }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await ctx.addInitScript((t) => { try { if (!sessionStorage.getItem('__t')) { localStorage.setItem('velox.site.theme', t); sessionStorage.setItem('__t', '1'); } } catch (e) { /* ignore */ } }, theme);
  const page = await ctx.newPage();
  const errors = [];
  watch(page, errors);
  return { ctx, page, errors };
}
async function settle(page) {
  // scroll through once (instant) so lazy images load and reveals fire, then back to top
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += 500) { window.scrollTo({ top: y, behavior: 'instant' }); await new Promise((r) => setTimeout(r, 30)); }
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  await page.waitForTimeout(800);
}

// ---- every page x 2 viewports x 2 themes: no console errors, no horizontal scroll, screenshots
console.log('\nPages (1440x900 and 390x844, dark and light)');
const VIEWS = [{ width: 1440, height: 900, tag: '1440' }, { width: 390, height: 844, tag: '390' }];
const PAGE_URLS = [
  ['index', 'index.html'], ['bios', 'bios.html#' + SAMPLE_FRAGMENT], ['bios-empty', 'bios.html'],
  ['impressum', 'impressum.html'], ['datenschutz', 'datenschutz.html'], ['404', 'does-not-exist'],
];
for (const [name, url] of PAGE_URLS) for (const v of VIEWS) for (const theme of ['dark', 'light']) {
  const { ctx, page, errors } = await newPage({ ...v, theme });
  await page.goto(server.url + url, { waitUntil: 'load' });
  if (name === 'index') await page.waitForTimeout(3600);     // the long intro settles at 3.0 s
  if (name.startsWith('bios')) await page.waitForSelector(name === 'bios' ? '#bios-app:not([hidden])' : '#bios-empty:not([hidden])');
  await settle(page);
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  const label = `${name} ${v.tag} ${theme}`;
  check(`${label}: no console errors`, errors.length === 0, errors.slice(0, 4).join(' | '));
  check(`${label}: no horizontal scroll (${sw} <= ${v.width})`, sw <= v.width);
  check(`${label}: theme applied`, (await page.getAttribute('html', 'data-theme')) === theme);
  if (SHOTS) {
    await page.screenshot({ path: path.join(shotDir, `${name}-${v.tag}-${theme}.png`) });
    await page.screenshot({ path: path.join(shotDir, `${name}-${v.tag}-${theme}-full.png`), fullPage: true });
  }
  await ctx.close();
}
{ // 360 px, the smallest supported width
  const { ctx, page, errors } = await newPage({ width: 360, height: 740 });
  for (const url of ['index.html', 'bios.html#' + SAMPLE_FRAGMENT]) {
    await page.goto(server.url + url); await page.waitForTimeout(url === 'index.html' ? 3600 : 600); await settle(page);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    check(`${url.split('#')[0]} at 360 px: no horizontal scroll (${sw})`, sw <= 360);
  }
  check('360 px: no console errors', errors.length === 0, errors.join(' | '));
  if (SHOTS) await page.screenshot({ path: path.join(shotDir, 'bios-360-dark.png') });
  await ctx.close();
}

// ---- links: every internal link, image and script resolves; every #anchor exists
console.log('\nLinks');
{
  const { ctx, page } = await newPage({ width: 1440, height: 900 });
  const seen = new Set(), external = new Set();
  let bad = [];
  for (const p of ['index.html', 'bios.html', 'impressum.html', 'datenschutz.html', 'does-not-exist']) {
    await page.goto(server.url + p);
    const refs = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('a[href]').forEach((a) => out.push(['a', a.getAttribute('href'), a.href]));
      document.querySelectorAll('link[href]').forEach((l) => out.push(['link', l.getAttribute('href'), l.href]));
      document.querySelectorAll('img[src], script[src]').forEach((e) => out.push(['src', e.getAttribute('src'), e.src]));
      document.querySelectorAll('img[srcset]').forEach((e) => e.getAttribute('srcset').split(',').forEach((s) => { const u = s.trim().split(/\s+/)[0]; out.push(['srcset', u, new URL(u, document.baseURI).href]); }));
      document.querySelectorAll('[data-full]').forEach((e) => out.push(['full', e.dataset.full, new URL(e.dataset.full, document.baseURI).href]));
      return out;
    });
    for (const [kind, raw, abs] of refs) {
      if (/^https?:/.test(raw) && !abs.startsWith(server.origin)) { external.add(abs); continue; }
      if (raw.startsWith('data:') || raw.startsWith('mailto:')) continue;
      const u = new URL(abs); const key = u.origin + u.pathname + '#' + (kind === 'a' ? u.hash : '');
      if (seen.has(key)) continue; seen.add(key);
      const res = await page.request.get(u.origin + u.pathname);
      if (res.status() !== 200) { bad.push(`${p}: ${raw} -> ${res.status()}`); continue; }
      if (kind === 'a' && u.hash && u.hash.length > 1 && !u.hash.includes('=')) {
        const html = await res.text();
        if (!new RegExp(`id="${u.hash.slice(1)}"`).test(html)) bad.push(`${p}: ${raw} -> anchor missing`);
      }
    }
  }
  check(`all internal links, images, scripts and anchors resolve (${seen.size} checked)`, bad.length === 0, bad.join(' | '));
  const ext = [...external];
  check('external links only go to GitHub (download, source, canonical site URL)', ext.every((u) => /^https:\/\/(github\.com\/georghatzmann-bit\/vanity-\/|georghatzmann-bit\.github\.io\/vanity-\/)/.test(u)), ext.join(', '));
  console.log('        external (not fetched): ' + ext.join(', '));
  await ctx.close();
}

// ---- home page behaviour
console.log('\nHome page');
{
  const { ctx, page, errors } = await newPage({ width: 1440, height: 900 });
  await page.goto(server.url);
  await page.waitForFunction(() => window.__veloxHero && document.querySelector('#hero-stage .vx'), null, { timeout: 5000 });
  check('intro is mounted in the hero', true);
  check('first run has no sound (autoplay is never attempted)', (await page.evaluate(() => window.__veloxHero.audible)) === false);
  await page.waitForTimeout(3400);
  const gap = await page.evaluate(() => getComputedStyle(document.querySelector('.hero')).getPropertyValue('--word-gap').trim());
  check(`headline is pulled up under the word (--word-gap ${gap})`, /^\d+px$/.test(gap) && parseInt(gap, 10) > 40);
  const overlap = await page.evaluate(() => {
    const L = window.__veloxHero.layout(), stage = document.getElementById('hero-stage').getBoundingClientRect();
    const eyebrow = document.querySelector('.hero .eyebrow').getBoundingClientRect();
    return eyebrow.top - (stage.top + L.top + L.cap);
  });
  check(`copy starts below the word (${Math.round(overlap)} px gap)`, overlap >= 12);
  const ctaTop = await page.evaluate(() => document.querySelector('.hero .btn-primary').getBoundingClientRect().bottom);
  check(`primary CTA visible without scrolling at 1440x900 (bottom ${Math.round(ctaTop)})`, ctaTop <= 900);
  // sound: one click replays the intro with sound
  await page.click('#intro-sound');
  await page.waitForTimeout(600);
  const s = await page.evaluate(() => ({ on: document.getElementById('intro-sound').dataset.on, label: document.querySelector('#intro-sound [data-label]').textContent, blocked: window.__veloxHero.blocked, muted: window.__veloxHero.muted }));
  check('"Mit Ton abspielen" replays the intro unmuted', s.on === 'true' && s.muted === false && s.label === 'Ton ausschalten', JSON.stringify(s));
  await page.click('#intro-sound');
  check('second click mutes', (await page.evaluate(() => window.__veloxHero.muted)) === true);
  await page.click('#intro-replay');
  await page.waitForTimeout(300);
  check('"Nochmal" restarts the intro', await page.evaluate(() => !!document.querySelector('#hero-stage .vx')));
  // keyboard: Enter on a link still follows it during the intro
  await page.focus('.cta-row a[href="#funktionen"]');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  check('Enter on "Was VELOX kann" follows the link while the intro runs', page.url().endsWith('#funktionen'));
  // theme toggle is remembered
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.click('.theme-btn');
  check('theme toggle switches to light', (await page.getAttribute('html', 'data-theme')) === 'light');
  await page.reload(); await page.waitForTimeout(300);
  check('theme is remembered after reload', (await page.getAttribute('html', 'data-theme')) === 'light');
  await page.click('.theme-btn');
  // lightbox
  await page.locator('#tweaks .shot-frame').click();
  check('screenshot opens in the lightbox', await page.evaluate(() => document.getElementById('lightbox').open));
  await page.keyboard.press('Escape');
  check('Esc closes the lightbox', !(await page.evaluate(() => document.getElementById('lightbox').open)));
  // FAQ by keyboard
  await page.locator('#faq summary').first().focus();
  await page.keyboard.press('Enter');
  check('FAQ opens with the keyboard', await page.evaluate(() => document.querySelector('#faq details').open));
  // skip link first in tab order
  await page.evaluate(() => { window.scrollTo(0, 0); document.activeElement && document.activeElement.blur(); });
  await page.goto(server.url); await page.keyboard.press('Tab');
  check('first Tab lands on "Zum Inhalt springen"', (await page.evaluate(() => document.activeElement.className)) === 'skip-link');
  check('home page interactions: no console errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}
{ // mobile menu
  const { ctx, page } = await newPage({ width: 390, height: 844 });
  await page.goto(server.url);
  await page.click('.menu-btn');
  check('mobile menu opens (aria-expanded=true, nav visible)', (await page.getAttribute('.menu-btn', 'aria-expanded')) === 'true' && await page.isVisible('#site-nav'));
  if (SHOTS) await page.screenshot({ path: path.join(shotDir, 'index-390-dark-menu.png') });
  await page.keyboard.press('Escape');
  check('Esc closes the mobile menu', (await page.getAttribute('.menu-btn', 'aria-expanded')) === 'false' && !(await page.isVisible('#site-nav')));
  await ctx.close();
}
{ // reduced motion: intro fades only, reveal content visible at once
  const { ctx, page, errors } = await newPage({ width: 1440, height: 900, reduced: true });
  await page.goto(server.url); await page.waitForTimeout(1500);
  check('reduced motion: intro plays its reduced variant', (await page.evaluate(() => window.__veloxHero && window.__veloxHero.variant)) === 'reduced');
  const op = await page.evaluate(() => getComputedStyle(document.querySelector('#tweaks .feature-text')).opacity);
  check('reduced motion: content is not hidden by scroll reveal', op === '1');
  check('reduced motion: no console errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ---- BIOS checklist (the QR code page)
console.log('\nBIOS checklist');
{
  const { ctx, page, errors } = await newPage({ width: 390, height: 844, dpr: 2 });
  const sent = [];
  page.on('request', (r) => sent.push(r.url()));
  await page.goto(server.url + 'bios.html#' + SAMPLE_FRAGMENT);
  await page.waitForSelector('#bios-app:not([hidden])');
  const t = (sel) => page.$eval(sel, (e) => e.textContent.trim().replace(/\u2011/g, '-'));
  check('board name from the fragment', (await t('#pc-board')) === 'ROG STRIX B550-F GAMING');
  check('BIOS version and date', (await t('#pc-bios')) === '2803 · 12.03.2022');
  check('vendor and CPU', (await t('#pc-vendor')) === 'ASUS' && (await t('#pc-cpu')) === 'AMD');
  check('"2 von 6 passen schon" (core items, o counts)', (await t('#ok-count')) === '2 von 6');
  const core = await page.$$eval('#core-list > .item', (els) => els.map((e) => e.dataset.code + e.dataset.status).join('.'));
  check(`core list in link order (${core})`, core === 'rpt.dcu.rbo.csu.sbt.tpo');
  const opt = await page.$$eval('#optional-list > .item', (els) => els.map((e) => e.dataset.code).join('.'));
  check(`optional list (${opt})`, opt === 'xl.vt.fc');
  check('warnings in link order', (await page.$$eval('#warning-list h3', (els) => els.length)) === 3);
  check('PC card points to the warnings first', /3 Hinweise/.test(await t('#warn-jump')) && await page.isVisible('#warn-jump'));
  check('games line names Valorant and FACEIT', /Valorant und FACEIT/.test(await t('#games-line')));
  check('Secure Boot item says it matters for the games', /Wichtig für Valorant und FACEIT/.test(await t('.item[data-code="sb"]')));
  const steps = await page.$$eval('.item[data-code="rp"] .steps-list li', (els) => els.map((e) => e.textContent));
  check('ASUS + AMD steps for the RAM profile', steps.length === 3 && /EXPO I/.test(steps[1]), steps.join(' / '));
  check('path note shown where the vendor path is not verified', await page.isVisible('.item[data-code="rp"] .path-note'));
  check('no path note where the vendor path is verified (TPM on ASUS)', !(await page.$('.item[data-code="tp"] .path-note')));
  check('"passt schon" items start collapsed', (await page.getAttribute('.item[data-code="rb"] .steps-toggle', 'aria-expanded')) === 'false');
  // tick one off: progress moves and survives a reload
  await page.click('.item[data-code="rp"] .tick');
  check('ticking moves the progress (3 / 6)', (await t('#tick-count')) === '3 / 6 erledigt');
  await page.reload(); await page.waitForSelector('#bios-app:not([hidden])');
  check('tick is remembered after reload (localStorage)', await page.isChecked('.item[data-code="rp"] .tick-input'));
  await page.click('#reset-btn');
  check('"Häkchen zurücksetzen" clears it', !(await page.isChecked('.item[data-code="rp"] .tick-input')));
  // touch targets
  const small = await page.$$eval('.tick, .steps-toggle, #reset-btn, .theme-btn', (els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height < 44; }).length);
  check('touch targets are at least 44 px high', small === 0, small + ' too small');
  // privacy: the fragment never leaves the phone
  const leaked = sent.filter((u) => /STRIX|rpt|s=|b=ROG/.test(u) || !u.startsWith(server.origin));
  check(`no request carries the fragment or leaves the site (${sent.length} requests)`, leaked.length === 0, leaked.join(' | '));
  check('server never saw the PC data', !server.requests.some((u) => /STRIX|rpt\./.test(u)));
  // wake lock UI is there or explains itself
  const wake = await page.evaluate(() => ({ supported: 'wakeLock' in navigator, btn: !document.getElementById('wake-btn').hidden, hint: document.getElementById('wake-hint').textContent }));
  check('screen wake lock: button when supported, tip otherwise', wake.supported ? wake.btn : wake.hint.length > 0, JSON.stringify(wake));
  if (SHOTS) {
    await page.screenshot({ path: path.join(shotDir, 'bios-390-dark-checklist.png') });
    await page.locator('#warnings').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shotDir, 'bios-390-dark-warnings.png') });
  }
  check('bios page: no console errors', errors.length === 0, errors.join(' | '));

  // hostile / odd links
  await page.goto(server.url + 'bios.html#v=1&p=evil&c=zzz&s=rpt.zzt.sbx.tpo&b=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&w=xx');
  await page.waitForSelector('#bios-app:not([hidden])');
  check('board text is rendered as text, never as HTML', (await t('#pc-board')) === '<img src=x onerror=alert(1)>' && !(await page.$('#pc-board img')));
  check('unknown vendor falls back to the generic texts', /allgemeine Anleitung/.test(await t('#pc-vendor')));
  check('unknown codes and statuses are skipped', (await page.$$eval('#core-list > .item', (els) => els.map((e) => e.dataset.code).join('.'))) === 'rp.tp');
  await page.goto(server.url + 'bios.html#v=2&p=msi&c=intel&s=rpt');
  await page.waitForSelector('#bios-app:not([hidden])');
  check('newer link version shows the banner and still works', await page.isVisible('#version-banner') && (await page.$$('#core-list > .item')).length === 1);
  check('MSI + Intel steps', /XMP/.test(await t('.item[data-code="rp"] .steps-list')));
  await page.goto(server.url + 'bios.html');
  await page.waitForSelector('#bios-empty:not([hidden])');
  check('without a fragment the page explains itself and offers the example', await page.isVisible('#demo-link'));
  await page.click('#demo-link');
  await page.waitForSelector('#bios-app:not([hidden])');
  check('the example link opens the sample checklist', (await t('#pc-board')) === 'ROG STRIX B550-F GAMING');

  // offline once loaded (service worker)
  await page.goto(server.url + 'bios.html#' + SAMPLE_FRAGMENT);
  await page.waitForSelector('#bios-app:not([hidden])');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.waitForTimeout(800);
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'load' }).catch(() => null);
  let offlineOk = false;
  try { await page.waitForSelector('#bios-app:not([hidden])', { timeout: 4000 }); offlineOk = (await t('#pc-board')) === 'ROG STRIX B550-F GAMING'; } catch { /* stays false */ }
  check('works offline once loaded (service worker)', offlineOk);
  await ctx.setOffline(false);
  await ctx.close();
}

// ---- 404 like GitHub Pages
{
  const { ctx, page } = await newPage({ width: 1440, height: 900 });
  const res = await page.goto(server.url + 'gibt/es/nicht');
  check('unknown address answers 404 with the 404 page', res.status() === 404 && /Diese Seite gibt es nicht/.test(await page.textContent('h1')));
  const href = await page.$eval('.notfound .btn-primary', (a) => a.href);
  check('404 page links back to the site root', href === server.url);
  await ctx.close();
}

await browser.close();
await server.close();
console.log(`\n${pass} passed, ${fail} failed` + (SHOTS ? `\nScreenshots: ${path.relative(process.cwd(), shotDir) || shotDir}` : ''));
if (fail) { console.log('Failures:\n  - ' + failures.join('\n  - ')); process.exit(1); }
