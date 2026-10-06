// =============================================================================
// Browser-Prüfungen der Welt (Welle 3b) – werden in run.cjs in GAME_CHECKS eingehängt
// =============================================================================
// Benutzt die versteckten Test-Modi (src/modes/sandbox.js):
//   sandbox-island   – Insel, Sturm, Kisten/Boden-Loot, Absprung-Ballon
//   sandbox-arena    – Duell-Arena mit Felsen und Bäumen
//   sandbox-zonewars – Zone-Wars-Karte mit wandernder Zone
// Geprüft wird: Erzeugungs-Zeit der Insel, Zeichen-Aufrufe (draw calls), Absprung →
// freier Fall → Gleiter → Landung ohne Schaden, E öffnet Kisten und hebt Waffen auf,
// ins Haus laufen und die Treppe hinauf, Sturm-Schaden. Dazu Screenshots.
// Am Ende wird wieder der Übungsplatz gestartet.
// =============================================================================
'use strict';

// Hilfen im Browser
async function installHelpers(page) {
  await page.evaluate(() => {
    window.__wd = {
      press(action, seconds = 1 / 60) {
        buildDuel.input.setVirtual(action, true);
        buildDuel.simulate(1 / 60);
        buildDuel.input.setVirtual(action, false);
        if (seconds > 1 / 60) buildDuel.simulate(seconds - 1 / 60);
      },
      hold(action, seconds) {
        buildDuel.input.setVirtual(action, true);
        buildDuel.simulate(seconds);
        buildDuel.input.setVirtual(action, false);
      },
      look(yaw, pitch = 0) {
        const p = buildDuel.game.player;
        p.yaw = p.prevYaw = yaw;
        p.pitch = p.prevPitch = pitch;
      },
      // Spieler (aus dem Ballon) an einen Ort setzen
      place(x, y, z, yaw, pitch = 0) {
        const g = buildDuel.game;
        const p = g.player;
        const v = g.mode.vehicle;
        if (v && p.moveState === 'vehicle') v.drop(p);
        p.moveState = 'ground';
        p.spawnAt({ x, y, z }, yaw, pitch);
        window.__wd.look(yaw, pitch);
        g.cameraRig.snap();
        buildDuel.simulate(0.1);
      },
      // Zeichen-Aufrufe nur der Welt (Figuren für ein Bild ausgeblendet) und mit Figuren
      worldCalls() {
        const g = buildDuel.game;
        const r = buildDuel.renderer;
        g.frameUpdate(0, 1);
        const roots = g.characters.map((c) => c.view?.root).filter((root) => root && root.visible);
        for (const root of roots) root.visible = false;
        r.render(buildDuel.scene, buildDuel.camera);
        const world = r.info.render.calls;
        for (const root of roots) root.visible = true;
        r.render(buildDuel.scene, buildDuel.camera);
        return { world, all: r.info.render.calls, characters: g.characters.length };
      },
    };
  });
}

const WORLD_CHECKS = [
  {
    name: 'Welt: Insel lädt schnell (< 2 s), wenige Zeichen-Aufrufe, Blick vom Absprung-Ballon',
    async run(ctx) {
      const r = await ctx.page.evaluate(() => {
        const t0 = performance.now();
        buildDuel.startMode('sandbox-island', { bots: 3 });
        const startMs = performance.now() - t0;
        buildDuel.play();
        buildDuel.manualStep(true);
        const g = buildDuel.game;
        return {
          startMs,
          genMs: g.map.generationMs,
          houses: g.map.houses.length,
          chests: g.loot.chests.length,
          items: g.loot.items.length,
          riders: g.mode.vehicle.riders.length,
          state: g.player.moveState,
        };
      });
      await installHelpers(ctx.page);
      ctx.log(`Insel: erzeugt in ${r.genMs.toFixed(0)} ms (Modus-Start ${r.startMs.toFixed(0)} ms), ${r.houses} Häuser, ${r.chests} Kisten, ${r.items} Boden-Gegenstände`);
      ctx.assert(r.genMs < 2000, `Erzeugung ${r.genMs.toFixed(0)} ms`);
      ctx.assert(r.startMs < 4000, `Modus-Start ${r.startMs.toFixed(0)} ms`);
      ctx.assert(r.riders === 4 && r.state === 'vehicle', 'alle stehen auf dem Ballon');
      // bis über die Insel fliegen, zur Mitte schauen
      const pos = await ctx.page.evaluate(() => {
        const g = buildDuel.game;
        const v = g.mode.vehicle;
        let n = 0;
        while (!v.canDrop() && n++ < 400) buildDuel.simulate(0.25);
        buildDuel.simulate(1.5);
        const p = g.player;
        __wd.look(Math.atan2(p.position.x, p.position.z), -0.38);
        return { y: p.position.y, canDrop: v.canDrop() };
      });
      ctx.assert(pos.canDrop && Math.abs(pos.y - 120) < 1e-6, `über der Insel auf ${pos.y} m`);
      await ctx.page.waitForTimeout(1500);
      const calls = await ctx.page.evaluate(() => __wd.worldCalls());
      ctx.log(`Zeichen-Aufrufe vom Ballon: Welt ${calls.world}, mit ${calls.characters} Figuren ${calls.all}`);
      ctx.assert(calls.world < 150, `Welt: ${calls.world} Zeichen-Aufrufe (Ziel < 150)`);
      await ctx.shot('40-welt-insel-vom-ballon');
    },
  },
  {
    name: 'Welt: Leertaste → freier Fall → Gleiter bei 30 m → Landung ohne Fallschaden',
    async run(ctx) {
      const r1 = await ctx.page.evaluate(() => {
        const g = buildDuel.game;
        const p = g.player;
        __wd.press('jump');
        const state = p.moveState;
        __wd.look(p.yaw, -0.55);
        buildDuel.simulate(1.2);
        return { state, y: p.position.y };
      });
      ctx.assert(r1.state === 'freefall', `nach Leertaste: ${r1.state}`);
      await ctx.page.waitForTimeout(1200);
      await ctx.shot('41-welt-freier-fall');
      const r2 = await ctx.page.evaluate(() => {
        const g = buildDuel.game;
        const p = g.player;
        let n = 0;
        while (p.moveState === 'freefall' && n++ < 6000) buildDuel.simulate(1 / 60);
        const height = p.position.y - g.world.surfaceHeight(p.position.x, p.position.z, p.position.y);
        const state = p.moveState;
        buildDuel.simulate(0.5);
        __wd.look(p.yaw, -0.2);
        return { state, height };
      });
      ctx.assert(r2.state === 'glide' && r2.height <= 30.01 && r2.height > 28, `Gleiter: ${r2.state} bei ${r2.height.toFixed(2)} m`);
      await ctx.page.waitForTimeout(1200);
      await ctx.shot('42-welt-gleiter');
      const r3 = await ctx.page.evaluate(() => {
        const p = buildDuel.game.player;
        let n = 0;
        while (p.moveState !== 'ground' && n++ < 6000) buildDuel.simulate(1 / 60);
        buildDuel.simulate(0.3);
        return { state: p.moveState, health: p.health, shield: p.shield };
      });
      ctx.assert(r3.state === 'ground' && r3.health === 100, `gelandet: ${r3.state}, Leben ${r3.health}`);
    },
  },
  {
    name: 'Welt: Kiste leuchtet, E öffnet sie, E hebt die Waffe auf',
    async run(ctx) {
      const r = await ctx.page.evaluate(() => {
        const g = buildDuel.game;
        const chest = g.loot.chests.find((c) => !c.opened && g.map.isLand(c.position.x, c.position.z) && !g.map.houses.some((h) =>
          c.position.x > h.bounds.minX && c.position.x < h.bounds.maxX && c.position.z > h.bounds.minZ && c.position.z < h.bounds.maxZ));
        const a = chest.yaw;
        const fx = -Math.sin(a);
        const fz = -Math.cos(a);
        __wd.place(chest.position.x + fx * 2.2, chest.position.y, chest.position.z + fz * 2.2, a + Math.PI, -0.35);
        return { prompt: g.interactionPrompt?.text ?? null };
      });
      ctx.assert(r.prompt === 'Kiste öffnen', `Hinweis: ${r.prompt}`);
      await ctx.page.waitForTimeout(1200);
      await ctx.shot('43-welt-kiste');
      const r2 = await ctx.page.evaluate(() => {
        const g = buildDuel.game;
        let opened = 0;
        const off = g.events.on('chestOpened', () => opened++);
        __wd.press('use', 0.8);
        off();
        const weapon = g.loot.items.filter((fi) => fi.kind === 'weapon').sort((a, b) => a.position.distanceTo(g.player.position) - b.position.distanceTo(g.player.position))[0];
        const p = g.player;
        const dx = weapon.position.x - p.position.x;
        const dz = weapon.position.z - p.position.z;
        __wd.look(Math.atan2(-dx, -dz), -0.45);
        buildDuel.simulate(0.1);
        return { opened, prompt: g.interactionPrompt?.text ?? null, weaponId: weapon.item.id };
      });
      ctx.assert(r2.opened === 1, 'Kiste geöffnet');
      ctx.assert(/Aufheben/.test(r2.prompt ?? ''), `Hinweis: ${r2.prompt}`);
      await ctx.page.waitForTimeout(1200);
      await ctx.shot('44-welt-boden-loot');
      const r3 = await ctx.page.evaluate((id) => {
        __wd.press('use', 0.3);
        const p = buildDuel.game.player;
        const item = p.slots[p.selectedSlot];
        return { id: item?.id ?? null, mode: p.mode };
      }, r2.weaponId);
      ctx.assert(r3.id === r2.weaponId && r3.mode === 'weapon', `in der Hand: ${r3.id}`);
    },
  },
  {
    name: 'Welt: Wüstenstadt, durch die Tür ins Haus und die Treppe hinauf',
    async run(ctx) {
      await ctx.page.evaluate(() => {
        // Marktplatz der Wüstenstadt, Blick über den Platz zu den Häusern
        const t = buildDuel.CONFIG.maps.island.town;
        __wd.place(t.x + 5, t.height, t.z + 9, Math.atan2(5, 9) + 0.35, 0.02);
      });
      await ctx.page.waitForTimeout(1200);
      await ctx.shot('45-welt-stadt');
      const r = await ctx.page.evaluate(() => {
        const g = buildDuel.game;
        const h = g.map.houses.find((x) => x.floors > 1 && x.area === 'Sandkrug');
        const o = h.door.outside;
        const i = h.door.inside;
        __wd.place(o.x, h.y, o.z, Math.atan2(-(i.x - o.x), -(i.z - o.z)), 0);
        __wd.hold('moveForward', 0.45);
        buildDuel.simulate(0.2);
        // etwas weiter hinein und zur Treppe schauen
        const s = h.stairs.bottom;
        const p0 = g.player.position;
        __wd.look(Math.atan2(-(s.x - p0.x), -(s.z - p0.z)) - 0.25, 0.08);
        buildDuel.simulate(0.05);
        const p = g.player;
        const inside = p.position.x > h.bounds.minX && p.position.x < h.bounds.maxX && p.position.z > h.bounds.minZ && p.position.z < h.bounds.maxZ;
        return { inside, y: p.position.y, floor: h.floorY[0] };
      });
      ctx.assert(r.inside && Math.abs(r.y - r.floor) < 1e-3, `im Haus (y ${r.y.toFixed(2)})`);
      await ctx.page.waitForTimeout(1000);
      await ctx.shot('46-welt-im-haus');
      const r2 = await ctx.page.evaluate(() => {
        const g = buildDuel.game;
        const h = g.map.houses.find((x) => x.floors > 1 && x.area === 'Sandkrug');
        const s = h.stairs;
        __wd.place(s.bottom.x, h.floorY[0], s.bottom.z, Math.atan2(-(s.top.x - s.bottom.x), -(s.top.z - s.bottom.z)), 0);
        __wd.hold('moveForward', 1.3);
        buildDuel.simulate(0.3);
        return { y: g.player.position.y, top: h.floorY[1] };
      });
      ctx.assert(Math.abs(r2.y - r2.top) < 1e-3, `2. Stock: y ${r2.y.toFixed(2)} (soll ${r2.top.toFixed(2)})`);
      await ctx.page.evaluate(() => {
        // oben in die Raum-Mitte und zum Treppen-Loch schauen
        const g = buildDuel.game;
        const h = g.map.houses.find((x) => x.floors > 1 && x.area === 'Sandkrug');
        const a = h.toWorld(h.width * 0.62, h.depth * 0.72);
        const b = h.toWorld(1.2, 1.2);
        __wd.place(a.x, h.floorY[1], a.z, Math.atan2(-(b.x - a.x), -(b.z - a.z)), -0.15);
      });
      await ctx.page.waitForTimeout(1000);
      await ctx.shot('47-welt-oben-im-haus');
    },
  },
  {
    name: 'Welt: Sturm-Wand von innen und außen, draußen Schaden aufs Leben',
    async run(ctx) {
      const r = await ctx.page.evaluate(() => {
        const g = buildDuel.game;
        const spot = g.map.spawnPoints(1, { minDistance: 0 })[0];
        const x = spot.x;
        const z = spot.z;
        __wd.place(x, spot.y, z, -Math.PI / 2, 0.06);
        const s = g.storm;
        s.phase = 1;
        s.state = 'wait';
        s.timeLeft = 30;
        s.radius = 60;
        s.center.set(x - 25, 0, z);
        s.nextCenter.copy(s.center);
        s.nextRadius = 30;
        buildDuel.simulate(0.1);
        return { inside: s.isInside(g.player.position) };
      });
      ctx.assert(r.inside, 'drinnen');
      await ctx.page.waitForTimeout(1200);
      await ctx.shot('48-welt-sturm-innen');
      const r2 = await ctx.page.evaluate(() => {
        const g = buildDuel.game;
        const p = g.player;
        p.health = 100;
        p.shield = 50;
        g.storm.center.set(p.position.x - 90, 0, p.position.z);
        __wd.look(Math.PI / 2, 0.06);
        buildDuel.simulate(3);
        return { inside: g.storm.isInside(p.position), health: p.health, shield: p.shield, dps: g.storm.damagePerSecond };
      });
      ctx.assert(!r2.inside && r2.health === 100 - 3 * r2.dps && r2.shield === 50, `draußen: Leben ${r2.health}, Schild ${r2.shield}`);
      await ctx.page.waitForTimeout(1200);
      await ctx.shot('49-welt-sturm-aussen');
    },
  },
  {
    name: 'Welt: Duell-Arena mit Felsen und Bäumen, unsichtbare Wand über der Mauer',
    async run(ctx) {
      const r = await ctx.page.evaluate(() => {
        buildDuel.startMode('sandbox-arena');
        buildDuel.play();
        buildDuel.manualStep(true);
        const g = buildDuel.game;
        const [a, b] = g.characters.map((c) => c.position.clone());
        // hoch über der Mauer (wie oben auf einer Rampe) hinaus laufen: die unsichtbare Wand hält auf
        const p = g.player;
        p.spawnAt({ x: 0, y: 6, z: 38 }, Math.PI);
        p.yaw = p.prevYaw = Math.PI; // nach +Z (hinaus)
        buildDuel.input.setVirtual('moveForward', true);
        buildDuel.simulate(1);
        buildDuel.input.setVirtual('moveForward', false);
        const z = p.position.z;
        p.spawnAt(a, 0);
        p.yaw = p.prevYaw = 0;
        g.cameraRig.snap();
        buildDuel.simulate(0.2);
        return { distance: Math.hypot(a.x - b.x, a.z - b.z), props: g.map.props.list.length, z };
      });
      ctx.assert(Math.abs(r.distance - 40) < 1e-6, `Startpunkte ${r.distance} m auseinander`);
      ctx.assert(r.props >= 8, `${r.props} Felsen/Bäume`);
      ctx.assert(r.z <= 40 - 0.4 + 1e-3, `an der Mauer-Linie aufgehalten (z ${r.z.toFixed(2)})`);
      await ctx.page.waitForTimeout(1200);
      await ctx.shot('50-welt-duell-arena');
    },
  },
  {
    name: 'Welt: Zone-Wars-Karte, Zone wandert',
    async run(ctx) {
      const r = await ctx.page.evaluate(() => {
        buildDuel.startMode('sandbox-zonewars');
        buildDuel.play();
        buildDuel.manualStep(true);
        const g = buildDuel.game;
        const c0 = g.storm.center.clone();
        const next = g.storm.nextCenter.clone();
        buildDuel.simulate(0.2);
        return { players: g.characters.length, moved: Math.hypot(next.x - c0.x, next.z - c0.z), r: g.storm.radius };
      });
      ctx.assert(r.players === 6 && r.moved > 5, `${r.players} Figuren, Zone wandert ${r.moved.toFixed(1)} m`);
      await ctx.page.waitForTimeout(1200);
      await ctx.shot('51-welt-zone-wars');
      await ctx.page.evaluate(() => {
        buildDuel.simulate(16);
        const g = buildDuel.game;
        const p = g.player.position;
        const c = g.storm.center;
        __wd.look(Math.atan2(-(c.x - p.x), -(c.z - p.z)), 0.05);
      });
      await ctx.page.waitForTimeout(1200);
      await ctx.shot('52-welt-zone-wars-sturm');
      // zurück zum Übungsplatz (spätere Prüfungen erwarten ihn)
      await ctx.page.evaluate(() => {
        buildDuel.startMode('practice');
        buildDuel.play();
        buildDuel.manualStep(true);
      });
    },
  },
];

module.exports = { WORLD_CHECKS };
