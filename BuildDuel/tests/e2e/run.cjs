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
//   --grep text                    nur Spiel-Prüfungen, deren Name den Text enthält (Regex, z. B. "Bau|Edit")
//
// Für spätere Wellen: neue Prüfungen als Eintrag in GAME_CHECKS anhängen
// ({ name, run: async (ctx) => { … } }). ctx.page ist die Spiel-Seite,
// ctx.shot(name) macht einen Screenshot, ctx.assert(bedingung, text) prüft,
// ctx.openPage(initScript) öffnet eine zweite Spiel-Seite (selbst schließen).
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
  const options = { url: null, out: path.join(ROOT, 'tests', 'e2e', 'out'), ports: [9150, 9159], only: null, grep: null };
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
    else if (arg === '--grep') options.grep = new RegExp(next(), 'i');
    else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 31).join('\n'));
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
    name: 'Rampen-Kette (Rampe an Rampe): mit W ohne Springen bis oben',
    async run(ctx) {
      const r = await ctx.page.evaluate(() => {
        const g = buildDuel.game;
        const p = g.player;
        const T = buildDuel.CONFIG.building.pieceThickness;
        // zwei 45°-Rampen hintereinander (steigen nach +X), oben eine Plattform in 8 m Höhe
        g.map.addSlope({ minX: -36, maxX: -32, minZ: 8, maxZ: 12, baseY: 0, rise: 4, dir: 0, thickness: T }, { color: '#4FC3C7' });
        g.map.addSlope({ minX: -32, maxX: -28, minZ: 8, maxZ: 12, baseY: 4, rise: 4, dir: 0, thickness: T }, { color: '#B39DDB' });
        g.map.addBox({ x: -28, y: 0, z: 8 }, { x: -24, y: 8, z: 12 }, { color: '#C9D3E0' });
        p.spawnAt({ x: -38.5, y: 0, z: 10 }, -Math.PI / 2);
        let jumps = 0;
        const off = g.events.on('jump', () => jumps++);
        buildDuel.input.setVirtual('moveForward', true);
        buildDuel.simulate(2);
        const y2 = p.position.y;
        buildDuel.simulate(0.4);
        buildDuel.input.setVirtual('moveForward', false);
        buildDuel.simulate(0.2);
        off();
        return { y2, y: p.position.y, x: p.position.x, jumps };
      });
      ctx.assert(r.y2 > 6, `nach 2 s auf ${r.y2.toFixed(2)} m (nicht an der Naht hängen geblieben)`);
      ctx.assert(Math.abs(r.y - 8) < 1e-6 && r.jumps === 0, `oben auf 8 m ohne Springen: y=${r.y.toFixed(2)}, Sprünge ${r.jumps}`);
      await ctx.page.waitForTimeout(500);
      await ctx.shot('11-rampen-kette');
    },
  },
  {
    name: 'Ducken mit der RECHTEN Shift-Taste (echte Tasten)',
    async run(ctx) {
      await ctx.page.evaluate(() => buildDuel.game.player.spawnAt({ x: 0, y: 0, z: 22 }, 0));
      await ctx.page.keyboard.down('ShiftRight');
      const down = await ctx.page.evaluate(() => {
        buildDuel.simulate(0.1);
        return buildDuel.game.player.crouching;
      });
      await ctx.page.keyboard.up('ShiftRight');
      const up = await ctx.page.evaluate(() => {
        buildDuel.simulate(0.1);
        return buildDuel.game.player.crouching;
      });
      ctx.assert(down && !up, `rechte Shift: geduckt ${down}, nach dem Loslassen ${up}`);
      const help = await ctx.page.evaluate(() => document.getElementById('help').textContent);
      ctx.assert(/DuckenShift \(halten\)/.test(help), 'Hilfe zeigt "Shift" nur einmal');
    },
  },
  {
    name: 'Kamera: Bild-Nahgrenze nie in einer Wand (Hindernisse, Ecken, parallel an Wänden)',
    async run(ctx) {
      const r = await ctx.page.evaluate(async () => {
        const THREE = await import('three');
        const g = buildDuel.game;
        const p = g.player;
        const rig = g.cameraRig;
        const cam = buildDuel.camera;
        const world = g.world;
        const pt = new THREE.Vector3();
        const lo = new THREE.Vector3();
        const hi = new THREE.Vector3();
        function clipping() {
          cam.updateMatrixWorld(true);
          let worst = 0;
          for (const sx of [-1, 0, 1]) {
            for (const sy of [-1, 0, 1]) {
              pt.set(sx, sy, -1).unproject(cam);
              lo.set(pt.x - 1e-4, pt.y - 1e-4, pt.z - 1e-4);
              hi.set(pt.x + 1e-4, pt.y + 1e-4, pt.z + 1e-4);
              if (world.boxBlocked(lo, hi) || pt.y < 0) worst++;
            }
          }
          return worst;
        }
        function pose(x, z, yaw, pitch, aiming, crouch) {
          const y = Math.max(0, world.surfaceHeight(x, z, 30));
          p.spawnAt({ x, y, z }, yaw, pitch);
          p.aiming = aiming;
          p.crouching = crouch;
          p.height = crouch ? buildDuel.CONFIG.player.hitbox.crouchHeight : buildDuel.CONFIG.player.hitbox.height;
          rig.snap();
          rig.fixedUpdate(p, 1 / 60, world);
          g.frameUpdate(1 / 60, 1);
          return clipping();
        }
        // feste Lagen aus den Befunden (Arena-Ecke, Plattform beim Zielen, Brücken-Stütze, parallel an der 4-m-Wand)
        const fixed = [
          [-39.58, 39.6, 3.068, 0, false, false], [-29, -4, 1.178, -0.6, true, false],
          [15.75, -10.75, 2.88, 0, false, false], [23.5, 2.2, Math.atan2(3.2, 0.6), 0, false, false],
          [39.5, -39.5, -0.8, 0.4, false, true],
        ];
        let bad = 0;
        let n = 0;
        const examples = [];
        for (const f of fixed) {
          n++;
          if (pose(...f)) { bad++; examples.push(f); }
        }
        // Zufall: dicht an allen Collidern
        let seed = 7;
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        for (const c of world.colliders) {
          if (c.type !== 'box' || c.max.x - c.min.x > 70 || c.max.z - c.min.z > 70) continue;
          for (let i = 0; i < 25; i++) {
            const side = Math.floor(rnd() * 4);
            const t = rnd();
            const gap = 0.41 + rnd() * 1.2;
            const x = side === 0 ? c.min.x - gap : side === 1 ? c.max.x + gap : c.min.x + (c.max.x - c.min.x) * t;
            const z = side === 2 ? c.min.z - gap : side === 3 ? c.max.z + gap : c.min.z + (c.max.z - c.min.z) * t;
            if (Math.abs(x) > 39.5 || Math.abs(z) > 39.5) continue;
            const yaw = rnd() * Math.PI * 2;
            const pitch = (rnd() * 2 - 1) * 1.3;
            n++;
            if (pose(x, z, yaw, pitch, rnd() < 0.3, rnd() < 0.3)) {
              bad++;
              if (examples.length < 5) examples.push([x, z, yaw, pitch]);
            }
          }
        }
        return { n, bad, examples };
      });
      ctx.assert(r.bad === 0, `${r.bad} von ${r.n} Lagen sehen durch eine Wand ${JSON.stringify(r.examples)}`);
      // Bilder zum Anschauen: Arena-Ecke und Zielen an der Plattform
      await ctx.page.evaluate(() => {
        const p = buildDuel.game.player;
        p.crouching = false;
        p.height = buildDuel.CONFIG.player.hitbox.height;
        p.aiming = false;
        p.spawnAt({ x: -39.58, y: 0, z: 39.6 }, 3.068, 0);
        buildDuel.game.cameraRig.snap();
        buildDuel.simulate(1 / 60);
      });
      await ctx.page.waitForTimeout(500);
      await ctx.shot('12-kamera-ecke');
      await ctx.page.evaluate(() => {
        const p = buildDuel.game.player;
        p.spawnAt({ x: -29, y: 0, z: -4 }, 1.178, -0.6);
        buildDuel.input.setVirtual('secondary', true);
        buildDuel.simulate(1 / 60);
        buildDuel.game.cameraRig.snap();
      });
      await ctx.page.waitForTimeout(500);
      await ctx.shot('13-kamera-zielen-plattform');
      await ctx.page.evaluate(() => {
        buildDuel.input.setVirtual('secondary', false);
        buildDuel.simulate(1 / 60);
      });
    },
  },
  {
    name: 'Kamera: eigene Figur verdeckt das Fadenkreuz nicht (Rücken zur Wand, Blick nach oben)',
    async run(ctx) {
      const r = await ctx.page.evaluate(async () => {
        const THREE = await import('three');
        const g = buildDuel.game;
        const p = g.player;
        const cam = buildDuel.camera;
        const rc = new THREE.Raycaster();
        const v2 = new THREE.Vector2();
        const out = [];
        function covered() {
          cam.updateMatrixWorld(true);
          p.view.root.updateMatrixWorld(true);
          let hits = 0;
          for (let dx = -0.04; dx <= 0.041; dx += 0.02) {
            for (let dy = -0.04; dy <= 0.041; dy += 0.02) {
              rc.setFromCamera(v2.set(dx, dy), cam);
              if (p.view.root.visible && rc.intersectObject(p.view.root, true).length) hits++;
            }
          }
          return hits;
        }
        function pose(x, z, yaw, pitch) {
          p.spawnAt({ x, y: 0, z }, yaw, pitch);
          g.cameraRig.snap();
          g.cameraRig.fixedUpdate(p, 1 / 60, g.world);
          g.frameUpdate(1 / 60, 1);
          g.frameUpdate(1 / 60, 1);
          return covered();
        }
        for (let gap = 0.15; gap <= 2.6; gap += 0.2) out.push([`Rücken ${gap.toFixed(2)} m`, pose(29, 2.15 + 0.4 + gap, Math.PI, 0)]);
        for (const pitch of [0.75, 1.05, 1.35]) out.push([`Blick hoch ${pitch}`, pose(0, 22, 0, pitch)]);
        return out;
      });
      const bad = r.filter(([, hits]) => hits > 0);
      ctx.assert(bad.length === 0, `Fadenkreuz verdeckt: ${JSON.stringify(bad)}`);
      await ctx.page.evaluate(() => {
        buildDuel.game.player.spawnAt({ x: 29, y: 0, z: 2.15 + 0.4 + 0.75 }, Math.PI, 0);
        buildDuel.game.cameraRig.snap();
        buildDuel.simulate(1 / 60);
      });
      await ctx.page.waitForTimeout(500);
      await ctx.shot('14-ruecken-zur-wand');
    },
  },
  {
    name: 'Pause: im Pause-Bildschirm gedrückte Tasten zählen nach dem Weiterspielen nicht',
    async run(ctx) {
      await ctx.page.evaluate(() => {
        buildDuel.game.player.spawnAt({ x: 0, y: 0, z: 22 }, 0);
        buildDuel.simulate(0.1);
        buildDuel.pause();
      });
      await ctx.page.keyboard.press('Space');
      await ctx.page.keyboard.press('KeyC');
      const r = await ctx.page.evaluate(() => {
        buildDuel.play();
        buildDuel.simulate(1 / 60);
        const p = buildDuel.game.player;
        return { vy: p.velocity.y, y: p.position.y, mode: p.mode, state: buildDuel.state };
      });
      ctx.assert(r.state === 'playing' && r.vy <= 0 && r.y === 0, `kein Sprung nach dem Weiterspielen: ${JSON.stringify(r)}`);
      ctx.assert(r.mode !== 'build', `kein Baumodus: ${r.mode}`);
    },
  },
  {
    name: 'Controller: Start pausiert und spielt wieder weiter',
    async run(ctx) {
      const states = [];
      await ctx.page.evaluate(() => {
        const buttons = [];
        for (let i = 0; i < 17; i++) buttons.push({ pressed: false, value: 0 });
        window.__pad = { id: 'Test-Controller', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons, timestamp: 0 };
        window.__origGetGamepads = navigator.getGamepads;
        navigator.getGamepads = () => [window.__pad];
        buildDuel.manualStep(false); // echte Spielschleife fragt den Controller ab
      });
      const setStart = (down) => ctx.page.evaluate((d) => {
        window.__pad.buttons[buildDuel.CONFIG.controls.gamepad.pause] = { pressed: d, value: d ? 1 : 0 };
      }, down);
      const state = () => ctx.page.evaluate(() => buildDuel.state);
      await ctx.page.waitForTimeout(300);
      states.push(await state());
      await setStart(true);
      await ctx.page.waitForTimeout(500);
      states.push(await state());
      await ctx.page.waitForTimeout(300);
      states.push(await state()); // Start noch gehalten: bleibt pausiert
      await setStart(false);
      await ctx.page.waitForTimeout(300);
      await setStart(true);
      await ctx.page.waitForTimeout(500);
      states.push(await state());
      await ctx.page.waitForTimeout(300);
      states.push(await state()); // Start noch gehalten: pausiert NICHT sofort wieder
      await setStart(false);
      await ctx.page.evaluate(() => {
        delete navigator.getGamepads;
        if (navigator.getGamepads !== window.__origGetGamepads) navigator.getGamepads = window.__origGetGamepads;
        buildDuel.manualStep(true);
        buildDuel.play();
      });
      ctx.assert(JSON.stringify(states) === JSON.stringify(['playing', 'paused', 'paused', 'playing', 'playing']),
        `Zustände: ${states.join(' → ')}`);
    },
  },
  {
    name: 'Hilfe-Leiste einzeilig; bei 800 x 600 nicht über der Figur; Schilder von weitem lesbar, nah nie riesig',
    async run(ctx) {
      const rows = await ctx.page.evaluate(() => [...document.querySelectorAll('#help .help-row')].map((r) => r.getBoundingClientRect().height));
      const one = Math.min(...rows);
      ctx.assert(rows.every((h) => h < one * 1.5), `Zeilen-Höhen: ${rows.map((h) => h.toFixed(0)).join(', ')}`);
      // Schilder vom Startpunkt aus: mindestens ~20 Pixel hoch
      const labels = await ctx.page.evaluate(async () => {
        const THREE = await import('three');
        const g = buildDuel.game;
        g.player.spawnAt({ x: 0, y: 0, z: 22 }, 0, 0);
        g.cameraRig.snap();
        buildDuel.simulate(1 / 60);
        g.frameUpdate(1 / 60, 1);
        const cam = buildDuel.camera;
        cam.updateMatrixWorld(true);
        const h = window.innerHeight;
        const out = [];
        const a = new THREE.Vector3();
        const b = new THREE.Vector3();
        g.map.root.traverse((o) => {
          if (!o.isSprite) return;
          a.copy(o.position).add(new THREE.Vector3(0, o.scale.y / 2, 0)).project(cam);
          b.copy(o.position).add(new THREE.Vector3(0, -o.scale.y / 2, 0)).project(cam);
          if (a.z > 1 || b.z > 1) return; // hinter der Kamera
          out.push(Math.abs(a.y - b.y) * h / 2);
        });
        return out;
      });
      ctx.assert(labels.length >= 5 && labels.every((px) => px >= 18), `Schild-Höhen (Pixel): ${labels.map((px) => px.toFixed(0)).join(', ')}`);
      await ctx.shot('15-schilder-vom-start');
      // Aus der Nähe (Rampe zum Drunter-durch-Laufen hinauf, auf dem Schieß-Stand): kein Schild
      // höher als labelMaxScreenHeight, ganz nahe Schilder verblasst
      const near = await ctx.page.evaluate(async () => {
        const THREE = await import('three');
        const g = buildDuel.game;
        const V = buildDuel.CONFIG.visuals;
        const out = [];
        for (const [x, y, z, yaw] of [[18, 3.05, -9.6, 0], [18, 5.4, -12.4, 0], [35, 0.05, 33, Math.PI / 2]]) {
          g.player.spawnAt({ x, y, z }, yaw, 0);
          g.cameraRig.snap();
          buildDuel.simulate(1 / 60);
          g.frameUpdate(1 / 60, 1);
          const cam = buildDuel.camera;
          cam.updateMatrixWorld(true);
          const h = window.innerHeight;
          const a = new THREE.Vector3();
          const b = new THREE.Vector3();
          g.map.root.traverse((o) => {
            if (!o.isSprite || !o.visible) return;
            const d = o.position.distanceTo(cam.position);
            a.copy(o.position).add(new THREE.Vector3(0, o.scale.y / 2, 0)).project(cam);
            b.copy(o.position).add(new THREE.Vector3(0, -o.scale.y / 2, 0)).project(cam);
            if (a.z > 1 || b.z > 1) return; // hinter der Kamera
            if (Math.abs(a.x) > 1 || (a.y < -1 && b.y < -1) || (a.y > 1 && b.y > 1)) return; // nicht im Bild
            out.push({ px: Math.abs(a.y - b.y) * h / 2, d, opacity: o.material.opacity, max: V.labelMaxScreenHeight, fadeNear: V.labelFadeNear });
          });
        }
        return out;
      });
      const tooBig = near.filter((l) => l.px > l.max + 1 || (l.d < l.fadeNear && l.opacity > 0.02));
      ctx.assert(near.length >= 5 && tooBig.length === 0, `Schilder aus der Nähe: ${JSON.stringify(tooBig.map((l) => [l.px.toFixed(0), l.d.toFixed(1)]))}`);
      await ctx.page.evaluate(() => {
        const g = buildDuel.game;
        g.player.spawnAt({ x: 0, y: 0, z: 22 }, 0, 0);
        g.cameraRig.snap();
        buildDuel.simulate(1 / 60);
      });
      await ctx.page.setViewportSize({ width: 800, height: 600 });
      await ctx.page.waitForTimeout(400);
      const r = await ctx.page.evaluate(async () => {
        const THREE = await import('three');
        const g = buildDuel.game;
        g.frameUpdate(1 / 60, 1);
        const cam = buildDuel.camera;
        cam.updateMatrixWorld(true);
        g.player.view.root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(g.player.view.root, true); // genau (Ecken der Formen)
        let minX = Infinity;
        let maxY = -Infinity;
        for (const x of [box.min.x, box.max.x]) {
          for (const y of [box.min.y, box.max.y]) {
            for (const z of [box.min.z, box.max.z]) {
              const v = new THREE.Vector3(x, y, z).project(cam);
              minX = Math.min(minX, (v.x + 1) / 2 * window.innerWidth);
              maxY = Math.max(maxY, (1 - v.y) / 2 * window.innerHeight);
            }
          }
        }
        const help = document.getElementById('help').getBoundingClientRect();
        return { helpRight: help.right, helpTop: help.top, figureLeft: minX, figureBottom: maxY };
      });
      ctx.assert(r.helpRight < r.figureLeft || r.helpTop > r.figureBottom,
        `Hilfe (rechts ${r.helpRight.toFixed(0)}) und Figur (links ${r.figureLeft.toFixed(0)}) überlappen`);
      await ctx.shot('16-800x600');
      await ctx.page.setViewportSize({ width: 1280, height: 720 });
      await ctx.page.waitForTimeout(300);
    },
  },
  {
    name: 'Maus-Sperre abgelehnt: Hinweis, beim 2. Mal "Ohne Maus-Sperre spielen"',
    async run(ctx) {
      const page = await ctx.openPage(() => {
        // Browser lehnt die Maus-Sperre immer ab
        HTMLCanvasElement.prototype.requestPointerLock = function () {
          return Promise.reject(new DOMException('abgelehnt', 'NotAllowedError'));
        };
      });
      try {
        await page.click('#play-button');
        await page.waitForTimeout(300);
        const first = await page.evaluate(() => ({ hint: document.getElementById('play-hint').textContent, alt: !document.getElementById('play-nolock').hidden }));
        await page.waitForTimeout(300);
        await page.click('#play-button');
        await page.waitForTimeout(300);
        const second = await page.evaluate(() => ({ hint: document.getElementById('play-hint').textContent, alt: !document.getElementById('play-nolock').hidden }));
        ctx.assert(/nochmal klicken/.test(first.hint) && !first.alt, `1. Mal: ${JSON.stringify(first)}`);
        ctx.assert(/F5/.test(second.hint) && second.alt, `2. Mal: ${JSON.stringify(second)}`);
        await page.screenshot({ path: ctx.outPath('17-maus-sperre-abgelehnt.png') });
        await page.click('#play-nolock');
        await page.waitForTimeout(300);
        await page.evaluate(() => buildDuel.manualStep(true));
        const before = await page.evaluate(() => ({ state: buildDuel.state, yaw: buildDuel.game.player.yaw }));
        await page.mouse.move(640, 360);
        await page.mouse.move(740, 360, { steps: 5 });
        await page.keyboard.down('KeyW');
        const after = await page.evaluate(() => {
          buildDuel.simulate(0.5);
          return { yaw: buildDuel.game.player.yaw, z: buildDuel.game.player.position.z };
        });
        await page.keyboard.up('KeyW');
        ctx.assert(before.state === 'playing', `spielt ohne Sperre: ${before.state}`);
        ctx.assert(Math.abs(after.yaw - before.yaw) > 0.05, `Maus dreht: ${before.yaw.toFixed(2)} → ${after.yaw.toFixed(2)}`);
        ctx.assert(after.z < 21, `W läuft: z=${after.z.toFixed(2)}`);
      } finally {
        await page.close();
      }
    },
  },
  // Phase 5 (Welle 2b): Waffen, Zielpuppen, Treffer-Zahlen – siehe weaponChecks.cjs
  ...require('./weaponChecks.cjs').WEAPON_CHECKS,
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
  // ---------------------------------------------------------------------------
  // Welle 2a: Bauen und Editieren (über die echte Eingabe: Z/X/C/V, Klick, Q, R, G, E)
  // ---------------------------------------------------------------------------
  ...require('./buildChecks.cjs').BUILD_CHECKS,
  ...require('./worldChecks.cjs').WORLD_CHECKS, // Welle 3b: Welt (Insel, Sturm, Loot, Absprung, Arena, Zone Wars)
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
          if (options.grep && !options.grep.test(check.name)) continue;
          const messages = [];
          let ok = true;
          const ctx = {
            page,
            baseUrl,
            outPath: (name) => path.join(options.out, name),
            // Zweite Seite (z. B. mit verändertem Browser-Verhalten); bitte selbst schließen
            openPage: async (initScript) => {
              const extra = await browser.newPage({ viewport: { width: 1280, height: 720 } });
              watchPage(extra, 'Spiel 2', problems);
              if (initScript) await extra.addInitScript(initScript);
              await extra.goto(baseUrl + '?seed=1', { waitUntil: 'load' });
              await extra.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 60000 });
              return extra;
            },
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
