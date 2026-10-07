// =============================================================================
// Browser-Prüfungen für den Kreativ-Modus (Fliegen wie in Fortnite Kreativ) –
// Teil von tests/e2e/run.cjs. Namen beginnen mit "Kreativ:" (--grep Kreativ).
// =============================================================================
'use strict';

const CREATIVE_CHECKS = [
  {
    name: 'Kreativ: Fliegen mit 2× Springen (echte Eingabe), hoch, im Flug bauen, kein Fallschaden',
    async run(ctx) {
      const page = ctx.page;
      await page.setViewportSize({ width: 1280, height: 720 });
      const r = await page.evaluate(() => {
        buildDuel.startMode('creative');
        buildDuel.play();
        buildDuel.manualStep(true);
        const g = buildDuel.game;
        const p = g.player;
        const input = buildDuel.input;
        const H = buildDuel.CONFIG.world.wallHeight;
        const tick = (n = 1) => buildDuel.simulate(n / 60);
        const press = (action) => {
          input.setVirtual(action, true);
          tick();
          input.setVirtual(action, false);
          tick();
        };
        input.releaseAll();
        p.pitch = p.prevPitch = 0;
        tick(10);
        // eine Wand am Boden (Z + Linksklick) – darauf kommt nachher die Wand im Flug
        const before = g.building.pieces.size;
        press('buildWall');
        press('primary');
        // 2× Springen (Leertaste) kurz hintereinander
        press('jump');
        tick(4);
        press('jump');
        const flying = p.moveState;
        // Springen halten: hoch bis über eine Ebene
        input.setVirtual('jump', true);
        for (let i = 0; i < 600 && p.position.y < H + 1; i++) tick();
        input.setVirtual('jump', false);
        tick(20);
        const high = p.position.y;
        // im Flug eine Wand (auf die untere) und einen Boden bauen (Z / X + Linksklick)
        press('buildWall');
        press('primary');
        p.pitch = p.prevPitch = -0.6;
        press('buildFloor');
        press('primary');
        p.pitch = p.prevPitch = 0;
        tick(5);
        const built = g.building.pieces.size - before;
        const hud = g.mode.hudInfo().extra.join(' | ');
        return { flying, high, built, stillFlying: p.moveState, hud, H };
      });
      ctx.assert(r.flying === 'fly', `2× Springen = Fliegen (${r.flying})`);
      ctx.assert(r.high > r.H, `hoch geflogen: ${r.high.toFixed(2)} m`);
      ctx.assert(r.built >= 3 && r.stillFlying === 'fly', `am Boden + im Flug gebaut: ${r.built} Teile, Zustand ${r.stillFlying}`);
      ctx.assert(/Fliegen: an/.test(r.hud), `HUD: ${r.hud}`);
      await page.evaluate(() => {
        const p = buildDuel.game.player;
        p.pitch = p.prevPitch = -0.25;
        buildDuel.game.cameraRig.snap();
        buildDuel.simulate(1 / 60);
      });
      await page.waitForTimeout(900);
      await ctx.shot('k01-kreativ-fliegen');
      // Fliegen aus (2× Springen) → fallen → landen ohne Schaden
      const land = await page.evaluate(() => {
        const p = buildDuel.game.player;
        const input = buildDuel.input;
        input.setVirtual('jump', true); buildDuel.simulate(1 / 60); input.setVirtual('jump', false); buildDuel.simulate(4 / 60);
        input.setVirtual('jump', true); buildDuel.simulate(1 / 60); input.setVirtual('jump', false);
        const off = p.moveState;
        buildDuel.simulate(3);
        return { off, grounded: p.grounded, health: p.health, shield: p.shield };
      });
      ctx.assert(land.off !== 'fly' && land.grounded && land.health === 100 && land.shield === 100, `gelandet ohne Schaden: ${JSON.stringify(land)}`);
      // zurück zum Übungsplatz (spätere Prüfungen erwarten ihn)
      await page.evaluate(() => {
        buildDuel.startMode('practice');
        buildDuel.play();
        buildDuel.manualStep(true);
      });
    },
  },
];

module.exports = { CREATIVE_CHECKS };
