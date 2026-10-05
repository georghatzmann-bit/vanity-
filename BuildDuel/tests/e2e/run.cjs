#!/usr/bin/env node
// =============================================================================
// BuildDuel – Browser-Tests für Entwickler (nicht für Spieler nötig)
// =============================================================================
// Was passiert:
//   1. startet den Spiel-Server (tools/server.py) auf einem freien Port
//      (Standard 9150–9159) – oder benutzt eine schon laufende Adresse (--url)
//   2. öffnet das Spiel in Chromium ohne Fenster ("headless", Software-Grafik)
//   3. prüft: keine Fehler/Warnungen in der Konsole, keine fehlenden Dateien
//   4. steuert die Figur über window.buildDuel (laufen, drehen, springen, ducken,
//      Rampe, Turm-Sturz, Kamera an der Wand …) und prüft die Ergebnisse
//   5. macht Screenshots (Standard-Ordner: tests/e2e/out/ – steht in .gitignore)
//   6. öffnet tests/tests.html und meldet, wie viele Tests grün sind
//   Ende mit Fehler-Code 1, wenn etwas nicht stimmt (0 = alles gut).
//
// Voraussetzung: Node.js und Playwright (mit Chromium). Playwright wird NICHT
// mitgeliefert. Wenn es global installiert ist, so starten:
//   Linux/macOS:  NODE_PATH=$(npm root -g) node tests/e2e/run.cjs
//   Windows (cmd): for /f %i in ('npm root -g') do set NODE_PATH=%i
//                  node tests\e2e\run.cjs
//
// Optionen:
//   --url http://localhost:8000/   schon laufenden Server benutzen (kein eigener Start)
//   --out ordner                   Screenshots hierhin (Standard: tests/e2e/out)
//   --ports 9150-9159              Port-Bereich für den eigenen Server
//   --only game|tests              nur das Spiel oder nur die Test-Seite prüfen
//
// Für spätere Wellen: neue Prüfungen als Eintrag in GAME_CHECKS anhängen
// ({ name, run: async (ctx) => { … } }). ctx.page ist die Spiel-Seite,
// ctx.shot(name) macht einen Screenshot, ctx.assert(bedingung, text) prüft.
// =============================================================================
'use strict';

const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..'); // Ordner BuildDuel
const CHROMIUM_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

// --- Optionen lesen -------------------------------------------------------------
function parseArgs(argv) {
  const options = { url: null, out: path.join(ROOT, 'tests', 'e2e', 'out'), ports: [9150, 9159], only: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Option ${arg} braucht einen Wert`);
      return argv[++i];
    };
    if (arg === '--url') options.url = next().replace(/\/?$/, '/');
    else if (arg === '--out') options.out = path.resolve(next());
    else if (arg === '--ports') {
      const [a, b] = next().split('-').map(Number);
      if (!(a > 0 && b >= a)) throw new Error('--ports erwartet z. B. 9150-9159');
      options.ports = [a, b];
    } else if (arg === '--only') options.only = next();
    else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 30).join('\n'));
      process.exit(0);
    } else throw new Error(`Unbekannte Option: ${arg}`);
  }
  return options;
}

// --- Server -----------------------------------------------------------------------
function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Zeit abgelaufen')));
  });
}

async function startServer([first, last]) {
  let port = null;
  for (let p = first; p <= last; p++) {
    if (await portFree(p)) {
      port = p;
      break;
    }
  }
  if (port === null) throw new Error(`Kein freier Port zwischen ${first} und ${last}`);
  const candidates = process.platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
  let lastError = null;
  for (const [cmd, pre] of candidates) {
    try {
      return await launch(cmd, [...pre, '-u', path.join(ROOT, 'tools', 'server.py'), '--no-browser', '--port', String(port)], [first, last]);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('Python nicht gefunden');
}

function launch(cmd, args, [first, last]) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let done = false;
    const finish = (error, url) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(error);
      } else resolve({ child, url });
    };
    const timer = setTimeout(() => finish(new Error(`Server antwortet nicht:\n${output}`)), 15000);
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => finish(new Error(`Server beendet (Code ${code}):\n${output}`)));
    const onData = (data) => {
      output += data.toString();
      const match = output.match(/http:\/\/localhost:(\d+)\//);
      if (!match) return;
      const port = Number(match[1]);
      if (port < first || port > last) {
        finish(new Error(`Server wählte Port ${port} außerhalb von ${first}–${last}`));
        return;
      }
      const url = `http://localhost:${port}/`;
      get(url).then(() => finish(null, url), (error) => finish(error));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (data) => { output += data.toString(); });
  });
}

// --- Konsole überwachen -----------------------------------------------------------------
function watchPage(page, label, problems) {
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning' || type === 'assert') problems.push(`[${label} ${type}] ${msg.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`[${label} Seiten-Fehler] ${error.message}`));
  page.on('requestfailed', (req) => problems.push(`[${label} Datei fehlt] ${req.url()} – ${req.failure()?.errorText}`));
  page.on('response', (res) => {
    if (res.status() >= 400) problems.push(`[${label} HTTP ${res.status()}] ${res.url()}`);
  });
}

// =============================================================================
// Prüfungen im Spiel (spätere Wellen hängen hier ihre an)
// =============================================================================
const GAME_CHECKS = [
  {
    name: 'Start: Ladebildschirm weg, "Klicken zum Spielen" sichtbar',
    async run(ctx) {
      const state = await ctx.page.evaluate(() => ({
        ready: document.body.classList.contains('ready'),
        overlay: !document.getElementById('play-overlay').hidden,
        button: document.getElementById('play-button').textContent,
        mode: window.buildDuel?.modeId,
        characters: window.buildDuel?.game.characters.length,
      }));
      ctx.assert(state.ready, 'Spiel ist bereit');
      ctx.assert(state.overlay && /Klicken zum Spielen/.test(state.button), `Start-Knopf: "${state.button}"`);
      ctx.assert(state.mode === 'practice', `Modus: ${state.mode}`);
      ctx.assert(state.characters >= 2, `Figuren: ${state.characters}`);
      await ctx.shot('01-start');
    },
  },
  {
    name: 'Klick auf "Spielen" (Maus-Sperre oder Hinweis), dann spielen',
    async run(ctx) {
      await ctx.page.click('#play-button');
      await ctx.page.waitForTimeout(600);
      const after = await ctx.page.evaluate(() => ({ state: buildDuel.state, hint: document.getElementById('play-hint').textContent }));
      ctx.log(`nach dem Klick: ${after.state}${after.hint ? ` (Hinweis: ${after.hint})` : ''}`);
      ctx.assert(after.state === 'playing' || after.hint.length > 0, 'Klick führt zum Spiel oder zeigt einen Hinweis');
      await ctx.page.evaluate(() => {
        buildDuel.play();
        buildDuel.manualStep(true);
      });
      const playing = await ctx.page.evaluate(() => ({
        state: buildDuel.state,
        overlay: !document.getElementById('play-overlay').hidden,
        crosshair: !document.getElementById('crosshair').hidden,
      }));
      ctx.assert(playing.state === 'playing' && !playing.overlay && playing.crosshair, 'spielt, Fadenkreuz sichtbar');
    },
  },
  {
    name: 'Laufen (W): 1 Sekunde ≈ 6 m',
    async run(ctx) {
      const d = await ctx.page.evaluate(() => {
        const g = buildDuel.game;
        const p = g.player;
        p.spawnAt({ x: 0, y: 0, z: 22 }, 0);
        buildDuel.input.setVirtual('moveForward', true);
        buildDuel.simulate(1);
        buildDuel.input.setVirtual('moveForward', false);
        buildDuel.simulate(0.2);
        return 22 - p.position.z;
      });
      ctx.assert(d > 5.4 && d < 6.4, `gelaufen: ${d.toFixed(2)} m`);
      await ctx.page.waitForTimeout(500);
      await ctx.shot('02-gelaufen');
    },
  },
  {
    name: 'Umschauen (Maus): 90° nach rechts',
    async run(ctx) {
      const yaw = await ctx.page.evaluate(() => {
        const px = (Math.PI / 2) / buildDuel.CONFIG.sensitivity.baseRadiansPerPixel;
        buildDuel.input.addLook(px, 0);
        buildDuel.simulate(1 / 60);
        return buildDuel.game.player.yaw;
      });
      ctx.assert(Math.abs(yaw + Math.PI / 2) < 1e-3, `yaw: ${yaw.toFixed(3)}`);
    },
  },
  {
    name: 'Springen (Leertaste): ≈ 1,4 m hoch',
    async run(ctx) {
      const max = await ctx.page.evaluate(() => {
        const p = buildDuel.game.player;
        buildDuel.input.setVirtual('jump', true);
        buildDuel.simulate(1 / 60);
        buildDuel.input.setVirtual('jump', false);
        let top = p.position.y;
        for (let i = 0; i < 70; i++) {
          buildDuel.simulate(1 / 60);
          top = Math.max(top, p.position.y);
        }
        return top;
      });
      ctx.assert(Math.abs(max - 1.4) < 0.06, `Sprunghöhe: ${max.toFixed(3)} m`);
    },
  },
  {
    name: 'Ducken (Shift halten): kleiner, aufstehen nach dem Loslassen',
    async run(ctx) {
      const r = await ctx.page.evaluate(() => {
        const p = buildDuel.game.player;
        buildDuel.input.setVirtual('crouch', true);
        buildDuel.simulate(0.1);
        const crouched = { crouching: p.crouching, height: p.height };
        buildDuel.input.setVirtual('crouch', false);
        buildDuel.simulate(0.1);
        return { crouched, after: p.crouching };
      });
      ctx.assert(r.crouched.crouching && r.crouched.height < 1.5, 'geduckt');
      ctx.assert(!r.after, 'wieder aufgestanden');
    },
  },
  {
    name: 'Rampe 45° hoch auf die 4-m-Plattform (ohne Springen)',
    async run(ctx) {
      const y = await ctx.page.evaluate(() => {
        const p = buildDuel.game.player;
        p.spawnAt({ x: -22, y: 0, z: 4 }, 0);
        buildDuel.input.setVirtual('moveForward', true);
        buildDuel.simulate(1.6);
        buildDuel.input.setVirtual('moveForward', false);
        buildDuel.simulate(0.3);
        return p.position.y;
      });
      ctx.assert(Math.abs(y - 4) < 1e-3, `Höhe: ${y.toFixed(3)} m`);
      await ctx.page.waitForTimeout(500);
      await ctx.shot('03-plattform');
    },
  },
  {
    name: 'Turm 12 m: Sturz macht 50 Schaden (zuerst Schild)',
    async run(ctx) {
      await ctx.page.evaluate(() => {
        const p = buildDuel.game.player;
        p.resetForRound({ health: 100, shield: 100, position: { x: -22, y: 12, z: -24 }, yaw: Math.PI / 2 });
      });
      await ctx.page.waitForTimeout(500);
      await ctx.shot('04-turm-oben');
      const r = await ctx.page.evaluate(() => {
        const p = buildDuel.game.player;
        buildDuel.input.setVirtual('moveForward', true);
        buildDuel.simulate(0.9);
        buildDuel.input.setVirtual('moveForward', false);
        buildDuel.simulate(2);
        return { health: p.health, shield: p.shield, y: p.position.y };
      });
      ctx.assert(r.y === 0 && r.health === 100 && Math.abs(r.shield - 50) < 1e-6, `Leben ${r.health}, Schild ${r.shield}`);
    },
  },
  {
    name: 'Niedrige Decke (1,5 m): nur geduckt hinein',
    async run(ctx) {
      const r = await ctx.page.evaluate(() => {
        const p = buildDuel.game.player;
        p.spawnAt({ x: 8, y: 0, z: -3 }, 0);
        buildDuel.input.setVirtual('moveForward', true);
        buildDuel.simulate(1);
        const standingZ = p.position.z;
        buildDuel.input.setVirtual('crouch', true);
        buildDuel.simulate(1);
        buildDuel.input.setVirtual('moveForward', false);
        buildDuel.input.setVirtual('crouch', false);
        buildDuel.simulate(0.3);
        return { standingZ, z: p.position.z, crouching: p.crouching };
      });
      ctx.assert(r.standingZ > -6 + 0.3, `stehend aufgehalten bei z=${r.standingZ.toFixed(2)}`);
      ctx.assert(r.z < -7 && r.crouching, `geduckt drin (z=${r.z.toFixed(2)}), Aufstehen geht nicht`);
      await ctx.page.waitForTimeout(500);
      await ctx.shot('05-decke');
    },
  },
  {
    name: 'Kamera an der 4-m-Wand: geht nicht hindurch',
    async run(ctx) {
      await ctx.page.evaluate(() => {
        const p = buildDuel.game.player;
        p.spawnAt({ x: 29, y: 0, z: 2.8 }, Math.PI); // Rücken zur Wand
      });
      await ctx.page.waitForTimeout(800);
      const camZ = await ctx.page.evaluate(() => buildDuel.camera.position.z);
      ctx.assert(camZ > 2.15 + 0.1, `Kamera bei z=${camZ.toFixed(2)} (Wand endet bei 2,15)`);
      await ctx.shot('06-wand');
    },
  },
  {
    name: 'Zielen (rechte Maustaste): Sichtfeld wird enger',
    async run(ctx) {
      await ctx.page.evaluate(() => {
        const p = buildDuel.game.player;
        p.spawnAt({ x: 0, y: 0, z: 22 }, 0);
        buildDuel.input.setVirtual('secondary', true);
        buildDuel.simulate(1 / 60);
      });
      await ctx.page.waitForTimeout(1200);
      const fov = await ctx.page.evaluate(() => buildDuel.camera.fov);
      await ctx.shot('07-zielen');
      await ctx.page.evaluate(() => {
        buildDuel.input.setVirtual('secondary', false);
        buildDuel.simulate(1 / 60);
      });
      ctx.assert(fov < 60, `Sichtfeld beim Zielen: ${fov.toFixed(1)}°`);
    },
  },
  {
    name: 'Übungs-Figuren aus der Nähe, Tanz (B)',
    async run(ctx) {
      await ctx.page.evaluate(() => {
        const p = buildDuel.game.player;
        p.spawnAt({ x: 1.2, y: 0, z: 17 }, 0.25);
        buildDuel.input.setVirtual('emote', true);
        buildDuel.simulate(1 / 60);
        buildDuel.input.setVirtual('emote', false);
      });
      await ctx.page.waitForTimeout(700);
      await ctx.shot('08-figuren-tanz');
    },
  },
  {
    name: 'Echte Spielschleife: Logik läuft, Figur bewegt sich',
    async run(ctx) {
      const before = await ctx.page.evaluate(() => {
        const p = buildDuel.game.player;
        p.spawnAt({ x: 0, y: 0, z: 22 }, 0);
        buildDuel.manualStep(false);
        buildDuel.input.setVirtual('moveForward', true);
        return { tick: buildDuel.ticks, frames: buildDuel.frames };
      });
      await ctx.page.waitForTimeout(1500);
      const after = await ctx.page.evaluate(() => {
        buildDuel.input.setVirtual('moveForward', false);
        buildDuel.manualStep(true);
        return { tick: buildDuel.ticks, frames: buildDuel.frames, z: buildDuel.game.player.position.z };
      });
      ctx.log(`${after.frames - before.frames} Bilder, ${after.tick - before.tick} Logik-Schritte in 1,5 s`);
      ctx.assert(after.tick - before.tick >= 30, 'Logik-Schritte laufen');
      ctx.assert(after.frames > before.frames, 'Bilder werden gemalt');
      ctx.assert(22 - after.z > 1, `bewegt: ${(22 - after.z).toFixed(2)} m`);
    },
  },
  {
    name: 'Esc-Ersatz: Pause zeigt "Pausiert – Klicken zum Weiterspielen"',
    async run(ctx) {
      await ctx.page.keyboard.press('Escape');
      await ctx.page.waitForTimeout(300);
      const r = await ctx.page.evaluate(() => ({
        state: buildDuel.state,
        title: document.getElementById('play-title').textContent,
        button: document.getElementById('play-button').textContent,
      }));
      ctx.assert(r.state === 'paused' && r.title === 'Pausiert' && /Weiterspielen/.test(r.button), `Pause: ${JSON.stringify(r)}`);
      await ctx.shot('09-pause');
    },
  },
  {
    name: 'Handy-Größe: nichts ragt aus dem Bild',
    async run(ctx) {
      await ctx.page.setViewportSize({ width: 360, height: 640 });
      await ctx.page.waitForTimeout(600);
      const overflow = await ctx.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      ctx.assert(!overflow, 'keine waagerechte Scroll-Leiste');
      await ctx.shot('10-handy');
      await ctx.page.setViewportSize({ width: 1280, height: 720 });
    },
  },
];

// =============================================================================
// Ablauf
// =============================================================================
async function main() {
  const options = parseArgs(process.argv.slice(2));
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    console.error('Playwright fehlt. Starte so: NODE_PATH=$(npm root -g) node tests/e2e/run.cjs');
    process.exit(2);
  }
  fs.mkdirSync(options.out, { recursive: true });

  let server = null;
  let baseUrl = options.url;
  if (!baseUrl) {
    server = await startServer(options.ports);
    baseUrl = server.url;
  }
  console.log(`Server: ${baseUrl}${server ? ` (eigener Server, PID ${server.child.pid})` : ''}`);
  console.log(`Screenshots: ${options.out}`);

  const browser = await playwright.chromium.launch({ args: CHROMIUM_ARGS });
  const problems = [];
  const results = [];
  let testSummary = null;
  try {
    if (options.only !== 'tests') {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      watchPage(page, 'Spiel', problems);
      await page.goto(baseUrl + '?seed=1', { waitUntil: 'load' });
      await page.waitForFunction(
        () => document.body.classList.contains('ready') || document.body.classList.contains('has-error'),
        null, { timeout: 60000 },
      );
      const error = await page.evaluate(() => (document.body.classList.contains('has-error')
        ? `${document.getElementById('error-title').textContent}: ${document.getElementById('error-text').textContent}`
        : null));
      if (error) {
        results.push({ name: 'Spiel startet', ok: false, messages: [error] });
        await page.screenshot({ path: path.join(options.out, '00-fehler.png') });
      } else {
        await page.waitForTimeout(1000);
        for (const check of GAME_CHECKS) {
          const messages = [];
          let ok = true;
          const ctx = {
            page,
            baseUrl,
            log: (text) => messages.push(text),
            assert: (condition, text) => {
              if (!condition) {
                ok = false;
                messages.push(`FEHLER: ${text}`);
              } else messages.push(`ok: ${text}`);
            },
            shot: (name) => page.screenshot({ path: path.join(options.out, `${name}.png`) }),
          };
          try {
            await check.run(ctx);
          } catch (e) {
            ok = false;
            messages.push(`FEHLER: ${e.message}`);
          }
          results.push({ name: check.name, ok, messages });
        }
      }
      await page.close();
    }

    if (options.only !== 'game') {
      const tpage = await browser.newPage({ viewport: { width: 1000, height: 800 } });
      watchPage(tpage, 'Tests', problems);
      await tpage.goto(baseUrl + 'tests/tests.html', { waitUntil: 'load' });
      await tpage.waitForFunction(() => window.__TEST_RESULTS__?.done, null, { timeout: 180000 });
      testSummary = await tpage.evaluate(() => window.__TEST_RESULTS__);
      await tpage.screenshot({ path: path.join(options.out, 'tests.png'), fullPage: true });
      results.push({
        name: `tests.html: ${testSummary.passed} von ${testSummary.total} grün`,
        ok: testSummary.failed === 0,
        messages: testSummary.failures.map((f) => `FEHLER: ${f.group} › ${f.test}: ${f.message}`),
      });
      await tpage.close();
    }
  } finally {
    await browser.close();
    if (server) server.child.kill();
  }

  // --- Bericht --------------------------------------------------------------------
  console.log('');
  for (const r of results) {
    console.log(`${r.ok ? 'OK    ' : 'FEHLER'}  ${r.name}`);
    for (const m of r.messages) if (!r.ok || !m.startsWith('ok:')) console.log(`          ${m}`);
  }
  if (problems.length) {
    console.log('\nKonsole/Netzwerk (jede Meldung zählt als Fehler):');
    for (const p of problems) console.log(`  ${p}`);
  }
  const failed = results.filter((r) => !r.ok).length + problems.length;
  console.log(`\n${failed === 0 ? 'ALLES GRÜN' : `${failed} PROBLEM(E)`} – ${results.length} Prüfungen` +
    (testSummary ? `, tests.html: ${testSummary.passed}/${testSummary.total}` : ''));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Browser-Test abgebrochen:', error.message);
  process.exit(2);
});
