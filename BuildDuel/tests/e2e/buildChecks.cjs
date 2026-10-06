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
        b.spawn(2, 0, 30, 0, -0.15);
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
        b.spawn(-6, 0, 26, 0, 0);
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
      await ctx.page.evaluate(() => window.__b.viewFrom(-12, 0, 33, { x: -6, y: 2.2, z: 26 }));
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
        b.spawn(26, 0, 36, 0, 0);
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
        return { maxY, ramps: pieces.filter((x) => x.type === 'ramp').length, walls: pieces.filter((x) => x.type === 'wall').length };
      });
      ctx.assert(r.maxY >= 12, `höchster Punkt ${r.maxY.toFixed(1)} m (${r.ramps} Rampen, ${r.walls} Wände)`);
      await ctx.page.evaluate(() => window.__b.viewFrom(13, 0, 37, { x: 26, y: 7, z: 23 }));
      await settle(ctx);
      await ctx.shot('b04-rampen-turm');
    },
  },
  {
    name: '90er: Wand, Rampe, 90° drehen, springen, wiederholen → über 12 m',
    async run(ctx) {
      await setup(ctx);
      const r = await ctx.page.evaluate(() => {
        const b = window.__b;
        const S = buildDuel.CONFIG.world.gridCellSize;
        const H = buildDuel.CONFIG.world.wallHeight;
        b.clear();
        b.spawn(-26, 0, 34, 0, 0);
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
            const high = p.position.y > startY + 2;
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
        return { heights, health: p.health, shield: p.shield };
      });
      const ok = r.heights.every((h, i) => i === 0 || h > r.heights[i - 1] + 3) && Math.max(...r.heights) >= 12;
      ctx.assert(ok, `Höhen: ${r.heights.map((h) => h.toFixed(1)).join(' → ')} (Leben ${r.health}, Schild ${r.shield})`);
      await ctx.page.evaluate(() => window.__b.viewFrom(-11, 0, 25, { x: -28, y: 7, z: 32 }));
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
        b.spawn(2, 0, 30, 0, 0); // Wand bei z = 28 (wx:0:0:7)
        const key = b.build('wall');
        b.face(Math.PI / 2, 0);
        const key2 = b.build('wall'); // wz:0:0:7 bei x = 0
        b.step(70);
        const wall = b.building.getPieceAt(key);
        const tile = (t) => ({ x: (t % 3 + 0.5) * (4 / 3), y: H - (Math.floor(t / 3) + 0.5) * (H / 3), z: 28 });
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
        b.aimAt({ x: 2, y: 1.3, z: 28 });
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
        b.aimAt({ x: 0, y: H / 2, z: 28 + 2 }); // Feld 4 = Mitte → Fenster
        b.press('edit');
        b.click();
        b.press('edit');
        const w = b.building.getPieceAt('wz:0:0:7');
        b.viewFrom(-5.5, 0, 30.8, { x: 0, y: 2.3, z: 30 });
        return [...w.edit].sort();
      });
      ctx.assert(JSON.stringify(win) === '[4]', `Fenster: ${JSON.stringify(win)}`);
      await settle(ctx);
      await ctx.shot('b09-fenster');
      const reset = await ctx.page.evaluate(() => {
        const b = window.__b;
        const H = buildDuel.CONFIG.world.wallHeight;
        b.spawn(2, 0, 30, Math.PI / 2, 0);
        b.select('wall');
        b.aimAt({ x: 0, y: H / 2, z: 30 });
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
    name: 'Edit-Formen: Boden mit Loch, halbe Rampe, Ecktreppe, Dach ohne Viertel (Bild = Kollision)',
    async run(ctx) {
      await setup(ctx);
      const r = await ctx.page.evaluate(() => {
        const b = window.__b;
        const w = b.building;
        b.clear();
        const put = (type, key, edit, dir = 0, material = 'wood') => w.placePiece(type, key, b.p, material, { dir, edit, instant: true, force: true });
        const pieces = [
          put('floor', 'f:-3:0:5', [3]),
          put('ramp', 'r:-2:0:5', [0, 2], 3, 'stone'), // halbe Rampe (rechte Hälfte)
          put('ramp', 'r:-1:0:5', [1], 3), // Ecktreppe (L-Form: Rampe – Podest – Rampe)
          put('roof', 'c:0:0:5', [0], 0, 'metal'), // Dach ohne ein Viertel
          put('wall', 'wx:1:0:6', [0, 1, 2]), // halbe Wand (obere Reihe weg)
        ];
        // Strahlen von oben: über entfernten Feldern frei, sonst Treffer
        const down = { x: 0, y: -1, z: 0 };
        const hitAt = (x, z) => {
          const hit = b.game.world.raycast({ x, y: 20, z }, down, 30, { skipTerrain: true });
          return hit && hit.collider?.data?.kind === 'piece' ? hit.collider.data.ref.slotKey : null;
        };
        const heightAt = (x, z) => {
          const hit = b.game.world.raycast({ x, y: 20, z }, down, 30, { skipTerrain: true });
          return hit ? Math.round(hit.point.y * 100) / 100 : null;
        };
        const probes = {
          // Ecktreppe (steigt nach −Z, Feld 1 weg): Feld 3 unten (1 m in der Mitte), Podest 2 m, Feld 0 oben (3 m)
          stairLow: heightAt(-1, 23), stairLanding: heightAt(-3, 23), stairHigh: heightAt(-3, 21),
          floorHole: hitAt(-12 + 3, 20 + 3), floorSolid: hitAt(-12 + 1, 20 + 1),
          halfMissing: hitAt(-8 + 1, 20 + 2), halfPresent: hitAt(-8 + 3, 20 + 2),
          cornerMissing: hitAt(-4 + 3, 20 + 1), cornerPresent: hitAt(-4 + 1, 20 + 1),
          roofMissing: hitAt(0 + 1, 20 + 1), roofPresent: hitAt(0 + 3, 20 + 3),
        };
        b.viewFrom(-4, 0, 33, { x: -4, y: 1.2, z: 22 });
        return { ok: pieces.every(Boolean), probes };
      });
      const p = r.probes;
      ctx.assert(r.ok, 'alle Teile gesetzt');
      ctx.assert(!p.floorHole && p.floorSolid === 'f:-3:0:5', `Boden: Loch frei, Rest fest ${JSON.stringify(p)}`);
      ctx.assert(!p.halfMissing && p.halfPresent === 'r:-2:0:5', 'halbe Rampe');
      ctx.assert(!p.cornerMissing && p.cornerPresent === 'r:-1:0:5', 'Ecktreppe: Loch und Treppe');
      ctx.assert(p.stairLow === 1 && p.stairLanding === 2 && p.stairHigh === 3, `Ecktreppe: Höhen ${p.stairLow} / ${p.stairLanding} / ${p.stairHigh}`);
      ctx.assert(!p.roofMissing && p.roofPresent === 'c:0:0:5', 'Dach-Viertel');
      await settle(ctx);
      await ctx.shot('b13-edit-formen');
    },
  },
  {
    name: 'Ecktreppe: Rampe (C), G + 1 Feld + G, mit W hinauf, 90° drehen, oben ankommen',
    async run(ctx) {
      await setup(ctx);
      const r = await ctx.page.evaluate(() => {
        const b = window.__b;
        b.clear();
        // Rampe vor sich (Zelle 2, 0, 6: x 8..12, z 24..28), steigt nach −Z
        b.spawn(10, 0, 30.5, 0, 0);
        const key = b.build('ramp');
        const ramp = b.building.getPieceAt(key);
        b.step(200); // fertig aufgebaut
        // G auf das Feld hinten rechts (x 10..12, z 24..26), anklicken, G
        b.aimAt({ x: 11, y: 3, z: 25 });
        b.press('edit');
        b.step(2);
        const hover = b.building.editSession(b.p)?.hover;
        b.press('primary');
        b.press('edit');
        // Boden oben dahinter (Ziel der Treppe)
        b.building.placePiece('floor', 'f:2:1:5', b.p, 'wood', { instant: true, force: true });
        // von Osten in die untere Treppe (geht nach −X), aufs Podest, 90° nach rechts (−Z), hinauf
        b.spawn(13.6, 0, 27, Math.PI / 2, 0);
        b.hold('moveForward', true);
        let landing = null;
        for (let n = 0; n < 240 && b.p.position.x > 9; n++) b.step();
        landing = { x: b.p.position.x, y: b.p.position.y };
        b.face(0, 0);
        for (let n = 0; n < 240 && b.p.position.z > 22.5; n++) b.step();
        b.hold('moveForward', false);
        b.step(20);
        const end = { x: b.p.position.x, y: b.p.position.y, z: b.p.position.z, grounded: b.p.grounded };
        b.viewFrom(16, 3, 33, { x: 10, y: 1.5, z: 26 });
        return { key, hover, mask: ramp?.editMask, colliders: ramp?.colliders.length, landing, end };
      });
      ctx.assert(r.key === 'r:2:0:6' && r.hover === 1, `Rampe ${r.key}, Feld unter dem Fadenkreuz ${r.hover}`);
      ctx.assert(r.mask === 2 && r.colliders === 3, `Ecktreppe (Maske ${r.mask}, ${r.colliders} Teile)`);
      ctx.assert(Math.abs(r.landing.y - 2) < 0.05, `auf dem Podest: ${JSON.stringify(r.landing)}`);
      ctx.assert(Math.abs(r.end.y - 4.1) < 0.05 && r.end.z <= 22.5 && r.end.grounded, `oben: ${JSON.stringify(r.end)}`);
      await settle(ctx);
      await ctx.shot('b13b-ecktreppe');
    },
  },
  {
    name: 'Materialien Holz/Stein/Metall (Q) und fremde Wand nicht editierbar',
    async run(ctx) {
      await setup(ctx);
      const r = await ctx.page.evaluate(() => {
        const b = window.__b;
        b.clear();
        b.spawn(14, 0, 26, 0, 0);
        const made = [];
        b.select('wall');
        for (let n = 0; n < 3; n++) {
          b.spawn(14 + n * 4, 0, 26, 0, 0);
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
        b.spawn(10, 0, 34, 0, 0);
        b.select('wall');
        b.aimAt({ x: 10, y: 2, z: 32 });
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
      await ctx.page.evaluate(() => window.__b.viewFrom(19, 0, 31.5, { x: 19, y: 1.6, z: 23 }));
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
        b.viewFrom(22, 0, 35, { x: 22, y: 1.8, z: 28 });
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
        b.viewFrom(23, 0, 36.5, { x: 26, y: 7, z: 18 });
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
        window.__b.spawn(0, 0, 22, 0, 0);
      });
    },
  },
];

module.exports = { BUILD_CHECKS };
