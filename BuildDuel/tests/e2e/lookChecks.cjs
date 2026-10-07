// =============================================================================
// Browser-Prüfungen für das AUSSEHEN (Figuren, Skins, Waffen, Spitzhacken, Bauteile,
// Vorschau, Edit-Raster) – werden in run.cjs in GAME_CHECKS eingehängt (Namen "Look: …")
// =============================================================================
// Zwei Wege zu Bildern:
//   1. "Studio": eine eigene Bild-Fläche (Canvas) über dem Spiel mit eigenem Renderer,
//      Himmel, Sonne und Wiese – dort stehen Figuren/Waffen in einer Reihe (Drehteller).
//   2. Das echte Spiel (Übungsplatz): Bauteile, Vorschau, Edit, Waffe in der Hand.
// Die Bilder landen in tests/e2e/out/look-*.png – ANSCHAUEN gehört zur Prüfung.
// Nur: --grep "Look"
// =============================================================================
'use strict';

// Studio im Browser anlegen (einmal): window.__studio
async function installStudio(page) {
  await page.evaluate(async () => {
    if (window.__studio) return;
    const THREE = await import('three');
    const { createCharacterView } = await import('./src/world/characterModel.js');
    const { Character } = await import('./src/player.js');
    const models = await import('./src/weapons/models.js');
    const CONFIG = buildDuel.CONFIG;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:99999;display:none';
    document.body.appendChild(canvas);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(1);
    renderer.setSize(innerWidth, innerHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(CONFIG.visuals.colors.skyHorizon);
    const hemi = new THREE.HemisphereLight(CONFIG.visuals.colors.skyHorizon, new THREE.Color(CONFIG.visuals.colors.grass).multiplyScalar(0.8), CONFIG.visuals.hemiIntensity);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff3dd, CONFIG.visuals.sunIntensity);
    const sd = CONFIG.visuals.sunDirection;
    sun.position.set(sd.x, sd.y, sd.z).normalize().multiplyScalar(30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 80 });
    sun.shadow.bias = -0.0003;
    scene.add(sun);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(40, 48), new THREE.MeshLambertMaterial({ color: CONFIG.visuals.colors.grass }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.1, 200);
    const items = [];
    const game = { time: 0 };
    window.__studio = {
      THREE, renderer, scene, camera, game, models,
      clear() {
        for (const it of items) {
          if (it.view) it.view.dispose();
          else scene.remove(it.object);
        }
        items.length = 0;
      },
      /** Figur mit Skin hinstellen; pose(c) setzt Zustände; weapon = Waffen-id (an die Hand) */
      character(skin, x, z, yaw, pose = null, weapon = null, rarity = 'rare') {
        const c = new Character(game, { skin, position: { x, y: 0, z }, yaw });
        c.prevPosition.copy(c.position);
        c.prevYaw = c.yaw;
        c.time = 0;
        Object.defineProperty(c, 'time', { get: () => game.time });
        const view = createCharacterView(c, scene);
        if (weapon) {
          const model = models.createWeaponModel(weapon, rarity);
          const mount = models.createHandMount(weapon, model);
          view.attach('weapon', mount);
          c.mode = weapon === 'pickaxe' ? 'pickaxe' : 'weapon';
          if (weapon !== 'pickaxe') c.slots[c.selectedSlot] = { id: weapon, kind: 'weapon', rarity };
        }
        if (pose) pose(c);
        items.push({ view, c, pose });
        return { c, view };
      },
      object(obj) {
        scene.add(obj);
        items.push({ object: obj });
        return obj;
      },
      /** Animation laufen lassen (Sekunden) */
      animate(seconds, step = 1 / 60) {
        for (let t = 0; t < seconds; t += step) {
          game.time += step;
          for (const it of items) if (it.view) {
            if (it.pose) it.pose(it.c, game.time);
            it.view.update(1, step);
          }
        }
      },
      show(on) {
        canvas.style.display = on ? 'block' : 'none';
      },
      render(cx, cy, cz, tx, ty, tz, fov = 30) {
        camera.fov = fov;
        camera.aspect = innerWidth / innerHeight;
        camera.updateProjectionMatrix();
        camera.position.set(cx, cy, cz);
        camera.lookAt(tx, ty, tz);
        renderer.setSize(innerWidth, innerHeight, false);
        renderer.render(scene, camera);
        return renderer.info.render.calls;
      },
    };
  });
}

async function studioShot(ctx, name, cam) {
  await ctx.page.evaluate((c) => {
    __studio.show(true);
    __studio.render(...c);
  }, cam);
  await ctx.shot(name);
}

const LOOK_CHECKS = [
  {
    name: 'Look: Skins im Drehteller (vorn, hinten, Nahaufnahme), höchstens 12 Zeichen-Aufrufe pro Figur',
    async run(ctx) {
      await installStudio(ctx.page);
      const info = await ctx.page.evaluate(() => {
        const S = __studio;
        S.clear();
        // eine Figur allein, ohne Schatten: Zeichen-Aufrufe zählen
        S.renderer.shadowMap.enabled = false;
        S.character(buildDuel.CONFIG.skins.defaultId, 0, 0, 0);
        S.animate(0.2);
        S.scene.children.forEach((o) => { if (o.isMesh && !o.name) o.visible = false; });
        S.render(0, 1.2, 5, 0, 1, 0);
        const calls = S.renderer.info.render.calls;
        S.scene.children.forEach((o) => { if (o.isMesh) o.visible = true; });
        S.renderer.shadowMap.enabled = true;
        S.clear();
        const list = buildDuel.CONFIG.skins.list;
        list.forEach((s, i) => S.character(s.id, (i - (list.length - 1) / 2) * 1.05, 0, Math.PI)); // Blick zur Kamera (+Z)
        S.animate(0.5);
        return { calls, count: list.length };
      });
      ctx.assert(info.calls <= 12, `eine Figur = ${info.calls} Zeichen-Aufrufe (höchstens 12)`);
      const w = info.count * 1.05;
      await studioShot(ctx, 'look-skins-vorn', [0, 1.2, w * 1.12, 0, 0.95, 0, 30]);
      // hinten: die Figuren umgedreht hinstellen
      await ctx.page.evaluate(() => {
        const S = __studio;
        S.clear();
        const list = buildDuel.CONFIG.skins.list;
        list.forEach((s, i) => S.character(s.id, (i - (list.length - 1) / 2) * 1.05, 0, 0));
        S.animate(0.5);
      });
      await studioShot(ctx, 'look-skins-hinten', [0, 1.2, w * 1.12, 0, 0.95, 0, 30]);
      // Nahaufnahmen: je 5 Figuren, schräg von vorn
      for (const half of [0, 1]) {
        await ctx.page.evaluate((half) => {
          const S = __studio;
          S.clear();
          const list = buildDuel.CONFIG.skins.list.slice(half * 5, half * 5 + 5);
          list.forEach((s, i) => S.character(s.id, (i - 2) * 1.0, 0, Math.PI - 0.35));
          S.animate(0.5);
        }, half);
        await studioShot(ctx, `look-skins-nah-${half + 1}`, [0.6, 1.45, 4.6, 0, 1.15, 0, 34]);
      }
      await ctx.page.evaluate(() => __studio.show(false));
    },
  },
  {
    name: 'Look: Waffen (alle Seltenheiten) und Spitzhacken-Varianten',
    async run(ctx) {
      await installStudio(ctx.page);
      const info = await ctx.page.evaluate(() => {
        const S = __studio;
        const { THREE, models } = S;
        S.clear();
        const CONFIG = buildDuel.CONFIG;
        const ids = ['shotgun', 'ar', 'smg', 'sniper', 'pistol', 'grenadeLauncher'];
        const rarities = CONFIG.rarities.order;
        let maxMeshes = 0;
        ids.forEach((id, row) => {
          rarities.forEach((r, col) => {
            const m = models.createWeaponModel(id, r);
            let n = 0;
            m.traverse((o) => { if (o.isMesh) n++; });
            maxMeshes = Math.max(maxMeshes, n);
            m.scale.setScalar(1.6);
            m.rotation.y = -Math.PI / 2; // Lauf nach rechts (+X), Seite zur Kamera
            m.position.set((col - 2) * 2.0, 0.6 + (ids.length - 1 - row) * 0.42, 0);
            S.object(m);
          });
        });
        CONFIG.pickaxes.list.forEach((p, i) => {
          const m = models.createWeaponModel('pickaxe', p.id);
          m.scale.setScalar(1.6);
          m.rotation.set(Math.PI / 2, 0, 0); // Stiel senkrecht, Kopf oben, Spitzen zur Seite
          m.position.set(6.2, 0.2, (i - 1.5) * 1.1);
          S.object(m);
        });
        return { maxMeshes };
      });
      ctx.assert(info.maxMeshes <= 2, `je Waffe höchstens 2 Meshes (Körper + Seltenheits-Streifen): ${info.maxMeshes}`);
      await studioShot(ctx, 'look-waffen', [0.8, 1.9, 9.6, 0.8, 1.6, 0, 32]);
      await studioShot(ctx, 'look-spitzhacken', [10.5, 1.0, 0, 6.2, 0.75, 0, 30]);
      await ctx.page.evaluate(() => __studio.show(false));
    },
  },
  {
    name: 'Look: Figur hält jede Waffe mit beiden Händen (Seite + Spiel-Kamera), Posen',
    async run(ctx) {
      await installStudio(ctx.page);
      const ids = ['shotgun', 'ar', 'smg', 'sniper', 'pistol', 'grenadeLauncher', 'pickaxe', 'medkit'];
      await ctx.page.evaluate((ids) => {
        const S = __studio;
        S.clear();
        const skins = buildDuel.CONFIG.skins.list;
        ids.forEach((id, i) => S.character(skins[i % skins.length].id, (i - (ids.length - 1) / 2) * 1.3, 0, -Math.PI / 2, (c) => { c.aiming = i % 2 === 1; }, id, ['common', 'uncommon', 'rare', 'epic', 'legendary'][i % 5]));
        S.animate(0.6);
      }, ids);
      // Blick nach +X → Kamera auf der Seite (+Z) sieht das Profil
      await studioShot(ctx, 'look-halten-seite', [0, 1.4, 9.2, 0, 1.15, 0, 30]);
      // wie im Spiel: von hinten rechts über die Schulter
      await ctx.page.evaluate(() => {
        const S = __studio;
        S.clear();
        ['ar', 'shotgun', 'sniper'].forEach((id, i) => S.character('rekrut', (i - 1) * 4, 0, 0, (c) => { c.aiming = i === 2; }, id, 'epic'));
        S.animate(0.6);
      });
      for (const [i, id] of ['ar', 'shotgun', 'sniper'].entries()) {
        const x = (i - 1) * 4;
        await studioShot(ctx, `look-halten-hinten-${id}`, [x + 0.6, 1.75, 3.0, x + 0.25, 1.35, -6, 50]);
      }
      // Posen: Laufen, Rennen, Springen, Ducken (zielend), Bauen, Hacke, Tanz, getroffen, umfallen
      await ctx.page.evaluate(() => {
        const S = __studio;
        S.clear();
        const poses = [
          (c) => { c.velocity.set(6, 0, 0); },
          (c) => { c.velocity.set(7.5, 0, 0); c.mode = 'pickaxe'; },
          (c) => { c.grounded = false; },
          (c) => { c.crouching = true; c.aiming = true; },
          (c) => { c.mode = 'build'; c.slots[0] = null; },
          (c, t) => { c.mode = 'pickaxe'; if (t !== undefined && (c.time - c.actionTime) > 0.5) c.triggerAction('pickaxe'); },
          (c) => { c.emoteUntil = 999; },
          (c, t) => { if (t !== undefined && Math.floor(t * 4) % 2 === 0) c.health -= 0.5; },
          (c) => { if (c.alive) { c.alive = false; c.deathTime = c.time; } },
        ];
        const weapons = ['ar', null, 'shotgun', 'ar', null, 'pickaxe', null, 'smg', 'ar'];
        const skins = buildDuel.CONFIG.skins.list;
        poses.forEach((pose, i) => S.character(skins[(i + 3) % skins.length].id, (i - 4) * 1.25, 0, -Math.PI / 2 + 0.5, pose, weapons[i], 'rare'));
        S.animate(0.73);
      });
      await studioShot(ctx, 'look-posen', [0, 1.3, 9.0, 0, 1.0, 0, 34]);
      await ctx.page.evaluate(() => __studio.show(false));
    },
  },
  {
    name: 'Look: Waffen in der Hand im echten Spiel (Schulter-Kamera, auch zielend) und Spitzhacken-Varianten',
    async run(ctx) {
      const { installHelpers } = require('./weaponChecks.cjs');
      await ctx.page.evaluate(() => {
        buildDuel.play();
        buildDuel.manualStep(true);
      });
      await installHelpers(ctx.page);
      for (const [id, aim] of [['shotgun', false], ['ar', false], ['ar', true], ['smg', false], ['sniper', false], ['pistol', false], ['grenadeLauncher', false]]) {
        const ok = await ctx.page.evaluate(({ id, aim }) => {
          __wp.toStand();
          const p = buildDuel.game.player;
          p.yaw = p.prevYaw = Math.PI / 2 + 0.25; // etwas schräg: Waffe vor dem Himmel/der Wiese
          p.pitch = p.prevPitch = 0.05;
          const selected = __wp.select(id);
          buildDuel.input.setVirtual('secondary', aim && id !== 'sniper');
          buildDuel.simulate(0.4);
          return selected;
        }, { id, aim });
        ctx.assert(ok, `${id} in der Hand`);
        await ctx.page.waitForTimeout(600);
        await ctx.shot(`look-spiel-${id}${aim ? '-zielen' : ''}`);
      }
      // Spitzhacken-Varianten in der Hand
      for (const pick of await ctx.page.evaluate(() => buildDuel.CONFIG.pickaxes.list.map((x) => x.id))) {
        await ctx.page.evaluate((pick) => {
          buildDuel.input.setVirtual('secondary', false);
          __wp.toStand();
          const p = buildDuel.game.player;
          p.pickaxeId = pick;
          p.yaw = p.prevYaw = Math.PI / 2 + 0.6;
          __wp.press('pickaxe', 0.4);
        }, pick);
        await ctx.page.waitForTimeout(600);
        await ctx.shot(`look-spiel-hacke-${pick}`);
      }
      await ctx.page.evaluate(() => {
        const p = buildDuel.game.player;
        p.pickaxeId = buildDuel.CONFIG.pickaxes.defaultId;
        __wp.toStand();
      });
    },
  },
  {
    name: 'Look: Bauteile Holz/Stein/Metall (Wand, Boden, Rampe, Dach), beschädigt, im Aufbau, 90er-Turm',
    async run(ctx) {
      const { setup, settle } = require('./buildChecks.cjs');
      await setup(ctx);
      const r = await ctx.page.evaluate(() => {
        const b = window.__b;
        b.clear();
        const B = b.building;
        const opts = { instant: true, force: true };
        const made = [];
        ['wood', 'stone', 'metal'].forEach((m, row) => {
          const k = 5 + row * 2;
          made.push(B.placePiece('wall', `wx:2:0:${k}`, null, m, opts));
          made.push(B.placePiece('floor', `f:3:0:${k}`, null, m, opts));
          made.push(B.placePiece('ramp', `r:4:0:${k}`, null, m, { ...opts, dir: 1 }));
          made.push(B.placePiece('roof', `c:5:0:${k}`, null, m, opts));
          const hurt = B.placePiece('wall', `wx:6:0:${k}`, null, m, opts);
          hurt.applyDamage(hurt.health * 0.72, {});
          made.push(hurt);
          made.push(B.placePiece('wall', `wx:7:0:${k}`, null, m, { force: true })); // im Aufbau
        });
        // 90er-Turm: Rampe im Kasten, jede Ebene 90° gedreht
        for (let j = 0; j < 6; j++) {
          B.placePiece('ramp', `r:9:${j}:7`, null, 'wood', { ...opts, dir: j % 4 });
          B.placePiece('wall', `wx:9:${j}:7`, null, 'wood', opts);
          B.placePiece('wall', `wx:9:${j}:8`, null, 'wood', opts);
          B.placePiece('wall', `wz:9:${j}:7`, null, 'wood', opts);
          B.placePiece('wall', `wz:10:${j}:7`, null, 'wood', opts);
        }
        b.step(2);
        const constructing = made.filter((x) => x && x.buildProgress < 1);
        const tinted = constructing.every((x) => x.view?.mesh && x.view.mesh.material.color.b > x.view.mesh.material.color.r);
        return { placed: made.filter(Boolean).length, constructing: constructing.length, tinted, stats: B.view.stats() };
      });
      ctx.assert(r.placed === 18, `18 Teile gesetzt (${r.placed})`);
      ctx.assert(r.constructing === 3 && r.tinted, `im Aufbau bläulich (${r.constructing}, ${r.tinted})`);
      ctx.assert(r.stats.drawCalls <= 24, `fertige Teile in wenigen Zeichen-Aufrufen (${r.stats.drawCalls})`);
      const views = [
        ['look-bau-uebersicht', 20, 9, 47, { x: 20, y: 0, z: 30 }],
        ['look-bau-holzwand', 10, 0, 21.5, { x: 10, y: 2.2, z: 20 }],
        ['look-bau-steinwand', 10, 0, 29.5, { x: 10, y: 2.2, z: 28 }],
        ['look-bau-metallwand', 10, 0, 37.5, { x: 10, y: 2.2, z: 36 }],
        ['look-bau-boden-rampe-dach', 14, 4.5, 31, { x: 20, y: 1, z: 22 }],
        ['look-bau-schaden-aufbau', 28, 0, 21, { x: 26, y: 1.6, z: 30 }],
        ['look-bau-90er-turm', 46, 0, 16, { x: 38, y: 11, z: 30 }],
      ];
      for (const [name, x, y, z, target] of views) {
        await ctx.page.evaluate((a) => window.__b.viewFrom(a.x, a.y, a.z, a.target), { x, y, z, target });
        await settle(ctx);
        await ctx.shot(name);
      }
    },
  },
  {
    name: 'Look: Vorschau blau (Gitter) und rot, Edit-Raster (blaue Kacheln mit Umriss, gewählte rot)',
    async run(ctx) {
      const { setup, settle } = require('./buildChecks.cjs');
      await setup(ctx);
      const blue = await ctx.page.evaluate(() => {
        const b = window.__b;
        b.clear();
        b.spawn(18, 0, 30, 0, 0);
        b.select('wall');
        b.step(2);
        b.game.frameUpdate(1 / 60, 1);
        const ghost = b.building.view.root.getObjectByName('Vorschau wall');
        return { visible: ghost.visible, map: !!ghost.material.map, color: ghost.material.color.getHexString() };
      });
      ctx.assert(blue.visible && blue.map && blue.color === '4da6ff', `Vorschau blau mit Gitter: ${JSON.stringify(blue)}`);
      await settle(ctx);
      await ctx.shot('look-vorschau-blau');
      await ctx.page.evaluate(() => {
        window.__b.select('ramp');
        window.__b.step(2);
        window.__b.game.frameUpdate(1 / 60, 1);
      });
      await settle(ctx);
      await ctx.shot('look-vorschau-rampe');
      const red = await ctx.page.evaluate(() => {
        const b = window.__b;
        b.p.infiniteMaterials = false;
        for (const m of Object.keys(b.p.materials)) b.p.materials[m] = 0;
        b.select('wall');
        b.step(2);
        b.game.frameUpdate(1 / 60, 1);
        return b.building.view.root.getObjectByName('Vorschau wall').material.color.getHexString();
      });
      ctx.assert(red === 'ff4d4d', `ohne Material rot (${red})`);
      await settle(ctx);
      await ctx.shot('look-vorschau-rot');
      const edit = await ctx.page.evaluate(() => {
        const b = window.__b;
        b.p.infiniteMaterials = true;
        b.clear();
        b.spawn(18, 0, 30.6, 0, 0);
        b.build('wall');
        b.aimAt({ x: 18, y: 0.66, z: 28 });
        b.press('edit');
        b.click();
        b.aimAt({ x: 18, y: 2.0, z: 28 });
        b.click();
        b.aimAt({ x: 19.4, y: 3.3, z: 28 });
        b.step(2);
        b.game.frameUpdate(1 / 60, 1);
        const overlay = b.building.view.root.getObjectByName('Edit-Kacheln');
        const tiles = overlay ? overlay.children.length : 0;
        const edges = overlay ? overlay.children.filter((m) => m.children[0]?.isLineSegments).length : 0;
        return { tiles, edges, selection: b.building.editSession(b.p)?.selection ?? 0 };
      });
      ctx.assert(edit.tiles === 9 && edit.edges === 9, `9 Kacheln mit Umriss (${edit.tiles}/${edit.edges})`);
      ctx.assert(edit.selection !== 0, `Felder gewählt (${edit.selection})`);
      await settle(ctx);
      await ctx.shot('look-edit-raster');
      await ctx.page.evaluate(() => {
        window.__b.press('edit');
        window.__b.clear();
      });
    },
  },
];

module.exports = { LOOK_CHECKS, installStudio, studioShot };
