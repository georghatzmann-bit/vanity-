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
];

module.exports = { LOOK_CHECKS, installStudio, studioShot };
