// =============================================================================
// Browser-Prüfungen für das Bau-System (Welle 2a) – Teil von tests/e2e/run.cjs
// =============================================================================
// Alles läuft über die echte Eingabe (window.buildDuel.input.setVirtual):
// Z/X/C/V wählen, Linksklick setzt, Q wechselt Material, R dreht, G editiert,
// E öffnet Türen. Dazu Bilder von Box, Rampen-Turm, 90ern, Tür/Fenster,
// Materialien, Vorschau (blau/rot), Rissen und Einsturz.
// =============================================================================
'use strict';

// Wird IN der Seite ausgeführt: legt window.__b mit kleinen Helfern an.
function installHelpers() {
  if (window.__b) return;
  const bd = window.buildDuel;
  const KEY = { wall: 'buildWall', floor: 'buildFloor', ramp: 'buildRamp', roof: 'buildRoof' };
  const h = {
    get game() { return bd.game; },
    get p() { return bd.game.player; },
    get building() { return bd.game.building; },
    // Bau-Raster aus config.js: Lagen in den Prüfungen sind Vielfache davon (passt zu jedem Raster)
    get S() { return bd.CONFIG.world.gridCellSize; },
    get H() { return bd.CONFIG.world.wallHeight; },
    step(n = 1) { bd.simulate(n / 60); },
    /** Aktion kurz drücken (1 Tick gedrückt, dann loslassen) */
    press(action, ticks = 1) {
      bd.input.setVirtual(action, true);
      h.step(ticks);
      bd.input.setVirtual(action, false);
      h.step();
    },
    hold(action, down) { bd.input.setVirtual(action, down); },
    face(yaw, pitch = 0) {
      const p = h.p;
      p.yaw = yaw; p.prevYaw = yaw; p.pitch = pitch; p.prevPitch = pitch;
    },
    spawn(x, y, z, yaw = 0, pitch = 0) {
      bd.input.releaseAll();
      h.p.resetForRound({ health: 100, shield: 100, position: { x, y, z }, yaw });
      h.face(yaw, pitch);
      bd.game.cameraRig.snap();
      h.step();
    },
    /** Fadenkreuz auf einen Punkt richten (die Linie geht durch den Schulter-Punkt) */
    aimAt(point) {
      const p = h.p;
      const cam = bd.CONFIG.camera;
      for (let n = 0; n < 6; n++) {
        const side = cam.shoulderOffset;
        const sx = p.position.x + Math.cos(p.yaw) * side;
        const sy = p.position.y + (p.crouching ? cam.crouchHeight : cam.height);
        const sz = p.position.z - Math.sin(p.yaw) * side;
        const dx = point.x - sx;
        const dy = point.y - sy;
        const dz = point.z - sz;
        h.face(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
      }
      h.step();
    },
    /** Wie aimAt, aber OHNE Logik-Schritt (für Prüfungen mit laufender Spielschleife) */
    look(point) {
      const p = h.p;
      const cam = bd.CONFIG.camera;
      for (let n = 0; n < 6; n++) {
        const sx = p.position.x + Math.cos(p.yaw) * cam.shoulderOffset;
        const sy = p.position.y + (p.crouching ? cam.crouchHeight : cam.height);
        const sz = p.position.z - Math.sin(p.yaw) * cam.shoulderOffset;
        const dx = point.x - sx;
        const dy = point.y - sy;
        const dz = point.z - sz;
        h.face(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
      }
    },
    select(type) { h.press(KEY[type]); },
    click() { h.press('primary'); },
    /** Bauteil wählen und setzen; liefert den Slot-Schlüssel oder null */
    build(type) {
      const before = h.building.pieces.size;
      h.select(type);
      h.click();
      if (h.building.pieces.size === before) return null;
      return [...h.building.pieces.values()].pop().slotKey;
    },
    clear() {
      bd.input.releaseAll();
      h.building.clearAll();
      h.step();
    },
    /** Kamera-Bild: Figur woanders hinstellen, Blick auf einen Punkt */
    viewFrom(x, y, z, target) {
      const dx = target.x - x;
      const dz = target.z - z;
      const yaw = Math.atan2(-dx, -dz);
      const eye = y + bd.CONFIG.camera.height;
      const pitch = Math.atan2(target.y - eye, Math.hypot(dx, dz));
      h.spawn(x, y, z, yaw, pitch);
      bd.input.setVirtual('pickaxe', true);
      h.step();
      bd.input.setVirtual('pickaxe', false);
      h.step();
    },
  };
  window.__b = h;
}

async function setup(ctx) {
  await ctx.page.setViewportSize({ width: 1280, height: 720 });
  await ctx.page.evaluate(() => {
    buildDuel.play();
    buildDuel.manualStep(true);
  });
  await ctx.page.evaluate(installHelpers);
}

// ein paar Bilder warten (Software-Grafik ist langsam)
const settle = (ctx, ms = 700) => ctx.page.waitForTimeout(ms);

const BUILD_CHECKS = [
  {
    name: 'Bauen: Z wählt sofort die Wand, Vorschau blau; ohne Material rot',
    async run(ctx) {
      await setup(ctx);
      const r = await ctx.page.evaluate(() => {
        const b = window.__b;
        b.clear();
        b.spawn(0.5 * b.S, 0, 7.5 * b.S, 0, -0.15);
        b.select('wall');
        b.game.frameUpdate(1 / 60, 1);
        const ghost = b.building.view.root.getObjectByName('Vorschau wall');
        return {
          mode: b.p.mode, piece: b.p.buildPiece, visible: ghost.visible,
          color: ghost.material.color.getHexString(), target: b.building.targetOf(b.p)?.slotKey,
        };
      });
      ctx.assert(r.mode === 'build' && r.piece === 'wall', `Baumodus mit Wand: ${r.mode}/${r.piece}`);
      ctx.assert(r.visible && r.color === '4da6ff', `Vorschau blau sichtbar (${r.color}) bei ${r.target}`);
      await settle(ctx);
      await ctx.shot('b01-vorschau-blau');
      const red = await ctx.page.evaluate(() => {
        const b = window.__b;
        b.p.infiniteMaterials = false;
        b.p.materials = { wood: 0, stone: 0, metal: 0 };
        b.select('ramp');
        b.game.frameUpdate(1 / 60, 1);
        const ghost = b.building.view.root.getObjectByName('Vorschau ramp');
        const placed = b.build('ramp');
        return { visible: ghost.visible, color: ghost.material.color.getHexString(), reason: b.building.targetOf(b.p)?.reason, placed };
      });
      ctx.assert(red.visible && red.color === 'ff4d4d' && red.reason === 'material', `Vorschau rot: ${JSON.stringify(red)}`);
      ctx.assert(red.placed === null, 'ohne Material wird nichts gebaut');
      await settle(ctx);
      await ctx.shot('b02-vorschau-rot');
      await ctx.page.evaluate(() => {
        const b = window.__b;
        b.p.infiniteMaterials = true;
        b.p.materials = { wood: 999, stone: 999, metal: 999 };
      });
    },
  },
  {
    name: 'Box 1×1: 4 Wände, Dach, Boden mit Z/V/X + Linksklick',
    async run(ctx) {
      await setup(ctx);
      const r = await ctx.page.evaluate(() => {
        const b = window.__b;
        b.clear();
        b.spawn(-1.5 * b.S, 0, 6.5 * b.S, 0, 0);
        const keys = [];
        for (let side = 0; side < 4; side++) {
          b.face((side * Math.PI) / 2, 0);
          keys.push(b.build('wall'));
        }
        keys.push(b.build('roof'));
        b.face(0, -1.2);
        keys.push(b.build('floor'));
        b.step(70); // fertig aufbauen
        return { keys, count: b.building.pieces.size, y: b.p.position.y };
      });
      ctx.assert(r.count === 6 && !r.keys.includes(null), `Box: ${r.keys.join(', ')}`);
      await ctx.page.evaluate(() => { const b = window.__b; b.viewFrom(-3 * b.S, 0, 8.25 * b.S, { x: -1.5 * b.S, y: 2.2, z: 6.5 * b.S }); });
      await settle(ctx);
      await ctx.shot('b03-box');
    },
  },
  {
    name: 'Ramp Rush: W + Maus gedrückt, C und Z abwechselnd → 3 Ebenen hoch',
    async run(ctx) {
      await setup(ctx);
      const r = await ctx.page.evaluate(() => {
        const b = window.__b;
        b.clear();
        b.spawn(6.5 * b.S, 0, 9 * b.S, 0, 0);
        b.hold('moveForward', true);
        b.hold('primary', true);
        let maxY = 0;
        for (let t = 0; t < 60 * 3; t++) {
          if (t % 4 === 0) b.hold((t / 4) % 2 === 0 ? 'buildRamp' : 'buildWall', true);
          if (t % 4 === 1) { b.hold('buildRamp', false); b.hold('buildWall', false); }
          b.step();
          maxY = Math.max(maxY, b.p.position.y);
        }
        b.hold('moveForward', false);
        b.hold('primary', false);
        b.step(70);
        const pieces = [...b.building.pieces.values()];
        return { maxY, H: b.H, ramps: pieces.filter((x) => x.type === 'ramp').length, walls: pieces.filter((x) => x.type === 'wall').length };
      });
      ctx.assert(r.maxY >= 3 * r.H, `höchster Punkt ${r.maxY.toFixed(1)} m (${r.ramps} Rampen, ${r.walls} Wände)`);
      await ctx.page.evaluate(() => { const b = window.__b; b.viewFrom(3.25 * b.S, 0, 9.25 * b.S, { x: 6.5 * b.S, y: 1.75 * b.H, z: 5.75 * b.S }); });
      await settle(ctx);
      await ctx.shot('b04-rampen-turm');
    },
  },
  {
    name: '90er: Wand, Rampe, 90° drehen, springen, wiederholen → jede Runde fast eine Ebene, über 3 Ebenen',
    async run(ctx) {
      await setup(ctx);
      const r = await ctx.page.evaluate(() => {
        const b = window.__b;
        const S = buildDuel.CONFIG.world.gridCellSize;
        const H = buildDuel.CONFIG.world.wallHeight;
        b.clear();
        b.spawn(-6.5 * S, 0, 8.5 * S, 0, 0);
        const p = b.p;
        b.build('ramp');
        b.build('wall');
        const heights = [];
        let yaw = 0;
        const until = (cond, seconds) => {
          for (let i = 0; i < seconds * 60; i++) {
            if (cond()) return true;
            b.step();
          }
          return cond();
        };
        for (let cycle = 0; cycle < 4; cycle++) {
          const f = [-Math.sin(yaw), -Math.cos(yaw)];
          const l = [-Math.sin(yaw + Math.PI / 2), -Math.cos(yaw + Math.PI / 2)];
          const edge = (a) => {
            const cx = Math.floor(p.position.x / S) * S;
            const cz = Math.floor(p.position.z / S) * S;
            return a[0] > 0.5 ? cx + S - p.position.x : a[0] < -0.5 ? p.position.x - cx : a[1] > 0.5 ? cz + S - p.position.z : p.position.z - cz;
          };
          const startY = p.position.y;
          const ok = until(() => {
            const high = p.position.y > startY + H / 2;
            b.hold('moveForward', edge(f) > 1.0 || !high);
            b.hold('moveLeft', edge(l) > 0.95);
            return p.grounded && high && edge(f) < 1.05 && edge(l) < 1.0 && Math.hypot(p.velocity.x, p.velocity.z) < 0.5;
          }, 4);
          b.hold('moveForward', false);
          b.hold('moveLeft', false);
          heights.push(p.position.y);
          if (!ok) break;
          yaw += Math.PI / 2;
          b.face(yaw, 0);
          b.step();
          b.build('wall');
          b.select('ramp');
          const level = Math.floor((p.position.y + 0.01) / H);
          b.hold('moveForward', true);
          b.press('jump');
          until(() => {
            const t = b.building.getTarget(p, 'ramp');
            return t.j === level + 1 && t.valid;
          }, 1);
          b.click();
          b.build('wall');
          until(() => p.grounded, 2);
          b.hold('moveForward', false);
        }
        b.step(80);
        return { heights, health: p.health, shield: p.shield, H };
      });
      const ok = r.heights.every((h, i) => i === 0 || h > r.heights[i - 1] + 0.75 * r.H) && Math.max(...r.heights) >= 3 * r.H;
      ctx.assert(ok, `Höhen: ${r.heights.map((h) => h.toFixed(1)).join(' → ')} (Leben ${r.health}, Schild ${r.shield})`);
      await ctx.page.evaluate(() => { const b = window.__b; b.viewFrom(-2.75 * b.S, 0, 6.25 * b.S, { x: -7 * b.S, y: 1.75 * b.H, z: 8 * b.S }); });
      await settle(ctx);
      await ctx.shot('b05-90er');
    },
  },
  {
    name: 'Edit: Tür (G, Klicken + Ziehen, G), E öffnet; Fenster; Zurücksetzen (G, Rechtsklick, G)',
    async run(ctx) {
      await setup(ctx);
      const r = await ctx.page.evaluate(() => {
        const b = window.__b;
        const H = buildDuel.CONFIG.world.wallHeight;
        b.clear();
        const S = b.S;
        b.spawn(0.5 * S, 0, 7.5 * S, 0, 0); // Wand bei z = 7·S (wx:0:0:7)
        const key = b.build('wall');
        b.face(Math.PI / 2, 0);
        const key2 = b.build('wall'); // wz:0:0:7 bei x = 0
        b.step(70);
        const wall = b.building.getPieceAt(key);
        const tile = (t) => ({ x: (t % 3 + 0.5) * (S / 3), y: H - (Math.floor(t / 3) + 0.5) * (H / 3), z: 7 * S });
        b.aimAt(tile(4));
        b.press('edit');
        const opened = b.p.mode;
        b.hold('primary', true);
        b.step();
        b.aimAt(tile(7));
        b.step();
        b.hold('primary', false);
        b.step();
        const selection = b.building.editSession(b.p)?.selection;
        return { key, key2, opened, selection };
      });
      ctx.assert(r.opened === 'edit' && r.selection === ((1 << 4) | (1 << 7)), `Edit offen, Felder 4+7 gewählt: ${JSON.stringify(r)}`);
      await settle(ctx);
      await ctx.shot('b06-edit-kacheln');
      const door = await ctx.page.evaluate(() => {
        const b = window.__b;
        b.press('edit');
        const wall = b.building.getPieceAt('wx:0:0:7');
        return { mode: b.p.mode, isDoor: wall.isDoor, colliders: wall.colliders.length };
      });
      ctx.assert(door.isDoor && door.mode === 'build' && door.colliders === 4, `Tür: ${JSON.stringify(door)}`);
      await ctx.page.evaluate(() => {
        const b = window.__b;
        b.press('pickaxe');
        b.aimAt({ x: 0.5 * b.S, y: 1.3, z: 7 * b.S });
      });
      await settle(ctx);
      await ctx.shot('b07-tuer-zu');
      const open = await ctx.page.evaluate(() => {
        const b = window.__b;
        b.press('use');
        b.step(20); // Tür schwingt auf
        return b.building.getPieceAt('wx:0:0:7').doorOpen;
      });
      ctx.assert(open, 'E öffnet die Tür');
      await settle(ctx);
      await ctx.shot('b08-tuer-offen');
      // Fenster in die zweite Wand (Feld 1 = oben Mitte)
      const win = await ctx.page.evaluate(() => {
        const b = window.__b;
        const H = buildDuel.CONFIG.world.wallHeight;
        b.select('wall');
        b.aimAt({ x: 0, y: H / 2, z: 7.5 * b.S }); // Feld 4 = Mitte → Fenster
        b.press('edit');
        b.click();
        b.press('edit');
        const w = b.building.getPieceAt('wz:0:0:7');
        b.viewFrom(-1.375 * b.S, 0, 7.7 * b.S, { x: 0, y: 2.3, z: 7.5 * b.S });
        return [...w.edit].sort();
      });
      ctx.assert(JSON.stringify(win) === '[4]', `Fenster: ${JSON.stringify(win)}`);
      await settle(ctx);
      await ctx.shot('b09-fenster');
      const reset = await ctx.page.evaluate(() => {
        const b = window.__b;
        const H = buildDuel.CONFIG.world.wallHeight;
        b.spawn(0.5 * b.S, 0, 7.5 * b.S, Math.PI / 2, 0);
        b.select('wall');
        b.aimAt({ x: 0, y: H / 2, z: 7.5 * b.S });
        b.press('edit');
        b.press('secondary');
        b.press('edit');
        const w = b.building.getPieceAt('wz:0:0:7');
        return { mask: w.editMask, colliders: w.colliders.length };
      });
      ctx.assert(reset.mask === 0 && reset.colliders === 1, `zurückgesetzt: ${JSON.stringify(reset)}`);
    },
  },
  {
    name: 'Edit-Formen wie in Fortnite: Boden-Loch, halbe Rampe, L-/U-Treppe, Dach-Ecken hoch, Dreieck, Bogen (Bild = Kollision)',
    async run(ctx) {
      await setup(ctx);
      const r = await ctx.page.evaluate(() => {
        const b = window.__b;
        const w = b.building;
        b.clear();
        const put = (type, key, edit, dir = 0, material = 'wood', editPath = null) => w.placePiece(type, key, b.p, material, { dir, edit, editPath, instant: true, force: true });
        const pieces = [
          put('floor', 'f:-3:0:5', [3]),
          put('ramp', 'r:-2:0:5', null, 3, 'stone', [3, 1]), // halbe Rampe (rechte Hälfte, steigt nach −Z)
          put('ramp', 'r:-1:0:5', null, 3, 'wood', [3, 2, 0]), // L-Treppe: Lauf – Podest – Lauf
          put('ramp', 'r:0:0:5', null, 3, 'wood', [3, 2, 0, 1]), // U-Treppe: Lauf – Podest (2 Felder) – Lauf
          put('roof', 'c:1:0:5', [0], 0, 'metal'), // 1/4-Pyramide (Ecke 0 hoch)
          put('roof', 'c:2:0:5', [0, 1]), // Rampen-Pyramide
          put('wall', 'wx:-3:0:7', [1, 2, 5]), // Dreieck
          put('wall', 'wx:-2:0:7', [3, 4, 5, 6, 7, 8], 0, 'stone'), // Bogen
        ];
        const down = { x: 0, y: -1, z: 0 };
        const heightAt = (x, z) => {
          const hit = b.game.world.raycast({ x, y: 20, z }, down, 30, { skipTerrain: true });
          return hit && hit.collider?.data?.kind === 'piece' ? Math.round(hit.point.y * 100) / 100 : null;
        };
        const wallHit = (x, y) => {
          const hit = b.game.world.raycast({ x, y, z: 7 * b.S + 2 }, { x: 0, y: 0, z: -1 }, 4, { skipTerrain: true });
          return hit?.collider?.data?.ref?.slotKey ?? null;
        };
        const S = b.S;
        const H = b.H;
        const at = (i, fx, fz) => [(i + fx) * S, (5 + fz) * S];
        const probes = {
          floorHole: heightAt(...at(-3, 0.75, 0.75)), floorSolid: heightAt(...at(-3, 0.25, 0.25)),
          halfMissing: heightAt(...at(-2, 0.25, 0.5)), halfPresent: heightAt(...at(-2, 0.75, 0.5)),
          lLow: heightAt(...at(-1, 0.75, 0.75)), lLanding: heightAt(...at(-1, 0.25, 0.75)), lHigh: heightAt(...at(-1, 0.25, 0.25)), lHole: heightAt(...at(-1, 0.75, 0.25)),
          uLow: heightAt(...at(0, 0.75, 0.75)), uLanding: heightAt(...at(0, 0.25, 0.5)), uHigh: heightAt(...at(0, 0.75, 0.25)),
          quarterCorner: heightAt(...at(1, 0.02, 0.02)), quarterOther: heightAt(...at(1, 0.98, 0.98)),
          rampPyrBack: heightAt(...at(2, 0.5, 0.02)), rampPyrFront: heightAt(...at(2, 0.5, 0.98)),
          triKept: wallHit(-3 * S + 0.2 * S, 0.3 * H), triGone: wallHit(-3 * S + 0.8 * S, 0.8 * H),
          archOpen: wallHit(-2 * S + 0.5 * S, 0.4 * H), archTop: wallHit(-2 * S + 0.5 * S, 0.85 * H),
        };
        b.viewFrom(-0.5 * S, 2.2, 8.6 * S, { x: -0.5 * S, y: 0.6, z: 5.8 * S });
        return { ok: pieces.every(Boolean), probes, H, R: buildDuel.CONFIG.building.roofHeight, T: buildDuel.CONFIG.building.pieceThickness };
      });
      const p = r.probes;
      const near = (v, t, tol = 0.02) => v !== null && Math.abs(v - t) < tol;
      ctx.assert(r.ok, 'alle Teile gesetzt');
      ctx.assert(p.floorHole === null && near(p.floorSolid, r.T / 2), `Boden: Loch frei, Rest fest ${JSON.stringify(p)}`);
      ctx.assert(p.halfMissing === null && near(p.halfPresent, r.H / 2), 'halbe Rampe');
      ctx.assert(near(p.lLow, r.H / 4) && near(p.lLanding, r.H / 2) && near(p.lHigh, (3 * r.H) / 4) && p.lHole === null,
        `L-Treppe: ${p.lLow} / ${p.lLanding} / ${p.lHigh} / Loch ${p.lHole}`);
      ctx.assert(near(p.uLow, r.H / 4) && near(p.uLanding, r.H / 2) && near(p.uHigh, (3 * r.H) / 4), `U-Treppe: ${p.uLow} / ${p.uLanding} / ${p.uHigh}`);
      ctx.assert(near(p.quarterCorner, r.R, 0.05) && near(p.quarterOther, 0, 0.1), `1/4-Pyramide: ${p.quarterCorner} / ${p.quarterOther}`);
      ctx.assert(near(p.rampPyrBack, r.R, 0.05) && near(p.rampPyrFront, 0, 0.1), `Rampen-Pyramide: ${p.rampPyrBack} / ${p.rampPyrFront}`);
      ctx.assert(p.triKept === 'wx:-3:0:7' && p.triGone === null, `Dreieck: ${p.triKept} / ${p.triGone}`);
      ctx.assert(p.archOpen === null && p.archTop === 'wx:-2:0:7', `Bogen: ${p.archOpen} / ${p.archTop}`);
      await settle(ctx);
      await ctx.shot('b13-edit-formen');
    },
  },
  {
    name: 'L-Treppe: Rampe (C), G + Weg ziehen (Maus halten), G, mit W hinauf, 90° drehen, oben ankommen',
    async run(ctx) {
      await setup(ctx);
      const r = await ctx.page.evaluate(() => {
        const b = window.__b;
        b.clear();
        const S = b.S;
        const H = b.H;
        // Rampe vor sich (Zelle 2, 0, 6: x 2·S..3·S, z 6·S..7·S), steigt nach −Z
        b.spawn(2.5 * S, 0, 7.625 * S, 0, 0);
        const key = b.build('ramp');
        const ramp = b.building.getPieceAt(key);
        b.step(200); // fertig aufgebaut
        // Feld-Mitten auf der ganzen Rampe (steigt nach −Z: Reihe 1 unten, Reihe 0 oben)
        const tile = (t) => ({ x: (2 + ((t % 2) + 0.5) / 2) * S, y: (1 - (Math.floor(t / 2) + 0.5) / 2) * H, z: (6 + (Math.floor(t / 2) + 0.5) / 2) * S });
        // G auf Feld 3 (vorne rechts), Maus halten, über Feld 2 (Podest) nach Feld 0 ziehen, loslassen, G
        b.aimAt(tile(3));
        b.press('edit');
        const hover = b.building.editSession(b.p)?.hover;
        b.hold('primary', true);
        b.step();
        b.aimAt(tile(2));
        b.aimAt(tile(0));
        const path = [...(b.building.editSession(b.p)?.path ?? [])];
        b.hold('primary', false);
        b.step();
        b.press('edit');
        // Boden oben dahinter (Ziel der Treppe)
        b.building.placePiece('floor', 'f:2:1:5', b.p, 'wood', { instant: true, force: true });
        // von Osten in den unteren Lauf (geht nach −X), aufs Podest, 90° nach rechts (−Z), hinauf
        b.spawn(3.4 * S, 0, 6.75 * S, Math.PI / 2, 0);
        b.hold('moveForward', true);
        for (let n = 0; n < 240 && b.p.position.x > 2.25 * S; n++) b.step();
        const landing = { x: b.p.position.x, y: b.p.position.y };
        b.face(0, 0);
        for (let n = 0; n < 240 && b.p.position.z > 5.625 * S; n++) b.step();
        b.hold('moveForward', false);
        b.step(20);
        const end = { x: b.p.position.x, y: b.p.position.y, z: b.p.position.z, grounded: b.p.grounded };
        b.viewFrom(4 * S, 3, 8.25 * S, { x: 2.5 * S, y: 1.5, z: 6.5 * S });
        return { key, hover, path, editPath: ramp?.editPath, colliders: ramp?.colliders.length, landing, end, S, H, T: buildDuel.CONFIG.building.pieceThickness };
      });
      ctx.assert(r.key === 'r:2:0:6' && r.hover === 3, `Rampe ${r.key}, Feld unter dem Fadenkreuz ${r.hover}`);
      ctx.assert(JSON.stringify(r.editPath) === '[3,2,0]' && r.colliders === 3, `L-Treppe (Weg ${JSON.stringify(r.path)} → ${JSON.stringify(r.editPath)}, ${r.colliders} Teile)`);
      ctx.assert(Math.abs(r.landing.y - r.H / 2) < 0.05, `auf dem Podest: ${JSON.stringify(r.landing)}`);
      ctx.assert(Math.abs(r.end.y - (r.H + r.T / 2)) < 0.05 && r.end.z <= 5.625 * r.S && r.end.grounded, `oben: ${JSON.stringify(r.end)}`);
      await settle(ctx);
      await ctx.shot('b13b-l-treppe');
    },
  },
  {
    name: 'Doppel-/Dreifach-Edit mit ECHTER Maus und Tastatur (Spielschleife läuft): Wand, Boden, Rampe – G/Klick/G und Beim-Loslassen',
    async run(ctx) {
      await setup(ctx);
      const page = ctx.page;
      // auf echte Logik-Schritte warten (Software-Grafik: oft nur 3–10 Bilder pro Sekunde)
      const ticks = async (n) => {
        const start = await page.evaluate(() => buildDuel.ticks);
        await page.waitForFunction((t) => buildDuel.ticks >= t, start + n, { timeout: 20000 });
      };
      const mode = (m) => page.waitForFunction((want) => buildDuel.game.player.mode === want, m, { timeout: 8000 }).then(() => true, () => false);
      const look = (target) => page.evaluate((t) => {
        const b = window.__b;
        b.look({ x: t[0] * b.S, y: t[1] * b.H, z: t[2] * b.S });
      }, target);
      // Ziel-Punkte (Vielfache von S bzw. H): Wand wx:0:0:6 vor der Figur, Boden f:0:0:6 unter ihr,
      // Rampe r:0:0:7 hinter ihr (steigt nach +Z, von der Figur weg)
      const wallTile = (t) => [(t % 3 + 0.5) / 3, 1 - (Math.floor(t / 3) + 0.5) / 3, 6];
      const floorTile = (t) => [((t % 2) + 0.5) / 2, 0.026, 6 + (Math.floor(t / 2) + 0.5) / 2];
      const rampTile = (t) => [((t % 2) + 0.5) / 2, (Math.floor(t / 2) + 0.5) / 2, 7 + (Math.floor(t / 2) + 0.5) / 2];
      const results = [];
      for (const release of [false, true]) {
        const plan = release
          ? { wall: [1], floor: [1], ramp: [1, 3, 2] } // Fenster oben, Boden-Ecke, L-Treppe
          : { wall: [4], floor: [0], ramp: [0, 2] }; // Fenster Mitte, Boden-Ecke, halbe Rampe
        // Bühne aufbauen (noch mit Test-Schritten)
        await page.evaluate((rel) => {
          const b = window.__b;
          const S = b.S;
          b.clear();
          b.spawn(0.5 * S, 0, 6.62 * S, 0, 0);
          const own = { instant: true, force: true };
          b.building.placePiece('wall', 'wx:0:0:6', b.p, 'wood', own);
          b.building.placePiece('floor', 'f:0:0:6', b.p, 'wood', own);
          b.building.placePiece('ramp', 'r:0:0:7', b.p, 'wood', { ...own, dir: 1 });
          b.step(20);
          b.press('slot1'); // Waffe in der Hand (wie nach einem Kampf)
          buildDuel.settings.controls.editOnRelease = rel;
          // "Ohne Maus-Sperre spielen": Maus-Tasten zählen trotzdem, echte Spielschleife
          buildDuel.input.allowMouseWithoutLock = true;
          buildDuel.input.lookWithoutLock = true;
          buildDuel.manualStep(false);
        }, release);
        await ticks(3);
        const log = [];
        // Wie ein schneller Spieler: innerhalb eines Edits nur kurze Pausen (50–120 ms), KEIN
        // Warten auf Bilder – bei Software-Grafik landen G, Klick und G oft im selben Bild.
        // Nur beim Ziehen über die Rampe und vor dem Umdrehen zum nächsten Teil wartet die
        // Prüfung auf Logik-Schritte (eine echte Maus fährt über die Felder dazwischen und
        // braucht zum Drehen länger als ein Bild; der Blick wird hier direkt gesetzt).
        const edit = async (name, tiles, target) => {
          await look(target(tiles[0]));
          await page.waitForTimeout(50);
          await page.keyboard.press('KeyG');
          await page.waitForTimeout(60);
          await page.mouse.down();
          for (const t of tiles.slice(1)) {
            await ticks(2);
            await look(target(t));
          }
          if (tiles.length > 1) await ticks(2);
          await page.waitForTimeout(90);
          await page.mouse.up();
          await page.waitForTimeout(70);
          if (!release) await page.keyboard.press('KeyG');
          await ticks(3); // die Spielschleife hat alles abgeholt
          const closed = await mode('weapon');
          log.push(`${name}: zu ${closed}`);
          await page.waitForTimeout(120);
        };
        await edit('Wand', plan.wall, wallTile);
        await page.evaluate(() => window.__b.face(0, -1.1));
        await edit('Boden', plan.floor, floorTile);
        await page.evaluate(() => window.__b.face(Math.PI, -0.6)); // umdrehen zur Rampe
        await edit('Rampe', plan.ramp, rampTile);
        const state = await page.evaluate(() => {
          buildDuel.manualStep(true);
          buildDuel.input.allowMouseWithoutLock = false;
          buildDuel.input.lookWithoutLock = false;
          buildDuel.input.releaseAll();
          const w = window.__b.building;
          return {
            wall: w.getPieceAt('wx:0:0:6')?.editMask,
            floor: w.getPieceAt('f:0:0:6')?.editMask,
            ramp: w.getPieceAt('r:0:0:7')?.editPath ?? null,
            mode: buildDuel.game.player.mode,
          };
        });
        const want = { wall: 1 << plan.wall[0], floor: 1 << plan.floor[0], ramp: plan.ramp };
        const ok = state.wall === want.wall && state.floor === want.floor && JSON.stringify(state.ramp) === JSON.stringify(want.ramp);
        results.push({ release, ok, state, want, log });
        if (release) {
          await page.evaluate(() => window.__b.viewFrom(1.4 * window.__b.S, 0, 8.6 * window.__b.S, { x: 0.5 * window.__b.S, y: 1, z: 6.5 * window.__b.S }));
          await settle(ctx);
          await ctx.shot('b13c-doppel-edit');
        }
      }
      await page.evaluate(() => { buildDuel.settings.controls.editOnRelease = false; });
      for (const r of results) {
        ctx.assert(r.ok, `${r.release ? 'Beim Loslassen bestätigen' : 'G, Klick, G'}: ${JSON.stringify(r.state)} (erwartet ${JSON.stringify(r.want)}) – ${r.log.join('; ')}`);
      }
    },
  },
  {
    name: 'Materialien Holz/Stein/Metall (Q) und fremde Wand nicht editierbar',
    async run(ctx) {
      await setup(ctx);
      const r = await ctx.page.evaluate(() => {
        const b = window.__b;
        b.clear();
        const S = b.S;
        b.spawn(3.5 * S, 0, 6.5 * S, 0, 0);
        const made = [];
        b.select('wall');
        for (let n = 0; n < 3; n++) {
          b.spawn((3.5 + n) * S, 0, 6.5 * S, 0, 0);
          b.select('wall');
          while (b.p.currentMaterial !== ['wood', 'stone', 'metal'][n]) b.press('switchMaterial');
          made.push(b.build('wall'));
          b.face(0, -1.2);
          made.push(b.build('floor'));
          b.face(0, 0.2);
          b.press('reloadOrRotate'); // R: Rampe quer
          made.push(b.build('ramp'));
          b.press('reloadOrRotate');
          b.press('reloadOrRotate');
          b.press('reloadOrRotate');
        }
        b.step(200);
        const pieces = made.map((k) => k && b.building.getPieceAt(k));
        // fremde Wand: gehört einer Übungs-Figur
        const other = b.game.characters.find((c) => c !== b.p);
        b.building.placePiece('wall', 'wx:2:0:8', other, 'stone', { instant: true });
        b.spawn(2.5 * S, 0, 8.5 * S, 0, 0);
        b.select('wall');
        b.aimAt({ x: 2.5 * S, y: b.H / 2, z: 8 * S });
        b.press('edit');
        return {
          materials: pieces.map((x) => x && x.material),
          dirs: pieces.filter((x) => x && x.type === 'ramp').map((x) => x.dir),
          foreignMode: b.p.mode,
        };
      });
      ctx.assert(JSON.stringify(r.materials) === JSON.stringify(['wood', 'wood', 'wood', 'stone', 'stone', 'stone', 'metal', 'metal', 'metal']),
        `Materialien: ${r.materials.join(', ')}`);
      ctx.assert(r.dirs.every((d) => d === 0), `R dreht die Rampe: ${r.dirs.join(', ')}`);
      ctx.assert(r.foreignMode === 'build', `fremde Wand: kein Edit (${r.foreignMode})`);
      await ctx.page.evaluate(() => { const b = window.__b; b.viewFrom(4.75 * b.S, 0, 7.875 * b.S, { x: 4.75 * b.S, y: 1.6, z: 5.75 * b.S }); });
      await settle(ctx);
      await ctx.shot('b10-materialien');
    },
  },
  {
    name: 'Schaden: unter 50 % dunkler mit Rissen; Einsturz mitten in der Animation',
    async run(ctx) {
      await setup(ctx);
      await ctx.page.evaluate(() => {
        const b = window.__b;
        b.clear();
        const w = b.building;
        const a = w.placePiece('wall', 'wx:4:0:7', b.p, 'wood', { instant: true });
        const c = w.placePiece('wall', 'wx:5:0:7', b.p, 'stone', { instant: true });
        const d = w.placePiece('wall', 'wx:6:0:7', b.p, 'metal', { instant: true });
        a.applyDamage(a.maxHealth * 0.7);
        c.applyDamage(c.maxHealth * 0.55);
        d.applyDamage(d.maxHealth * 0.3);
        b.viewFrom(5.5 * b.S, 0, 8.75 * b.S, { x: 5.5 * b.S, y: 1.8, z: 7 * b.S });
      });
      await settle(ctx);
      await ctx.shot('b11-risse');
      const r = await ctx.page.evaluate(() => {
        const b = window.__b;
        const w = b.building;
        b.clear();
        for (let n = 0; n < 5; n++) w.placePiece('ramp', `r:6:${n}:${6 - n}`, b.p, n % 2 ? 'stone' : 'wood', { dir: 3, instant: true });
        // Wände oben an den Rampen (hängen nur an der Rampe – kein eigener Halt am Boden)
        for (let n = 1; n < 5; n++) w.placePiece('wall', `wx:6:${n}:${6 - n}`, b.p, n % 2 ? 'metal' : 'wood', { instant: true });
        b.viewFrom(5.75 * b.S, 0, 9.125 * b.S, { x: 6.5 * b.S, y: 1.75 * b.H, z: 4.5 * b.S });
        w.getPieceAt('r:6:0:6').applyDamage(1e6);
        // kurz nach dem Wegfallen, mitten in der Animation
        b.step(Math.round((buildDuel.CONFIG.building.collapseDelay + buildDuel.CONFIG.building.collapseAnimTime * 0.45) * 60));
        return { left: w.pieces.size, debris: w.view.stats().debris };
      });
      ctx.assert(r.left === 0 && r.debris >= 8, `Einsturz: ${r.left} Teile übrig, ${r.debris} Trümmer in der Animation`);
      await settle(ctx, 500);
      await ctx.shot('b12-einsturz');
      const after = await ctx.page.evaluate(() => {
        const b = window.__b;
        b.step(40);
        b.game.frameUpdate(1 / 60, 1);
        return b.building.view.stats().debris;
      });
      ctx.assert(after === 0, `Trümmer verschwunden: ${after}`);
      await ctx.page.evaluate(() => {
        window.__b.clear();
        const sp = buildDuel.game.mode.spawnPoint;
        window.__b.spawn(sp.x, 0, sp.z, 0, 0);
      });
    },
  },
];

module.exports = { BUILD_CHECKS, setup, settle }; // setup/settle: auch für lookChecks.cjs
