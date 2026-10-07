// =============================================================================
// Browser-Prüfungen für Phase 5 (Waffen) – werden in run.cjs in GAME_CHECKS eingehängt
// =============================================================================
// Der Spieler steht am Schieß-Stand des Übungsplatzes und schießt mit jeder Waffe
// auf die Zielpuppen (über window.buildDuel und die virtuellen Tasten). Geprüft wird:
// Schaden kommt an, Treffer-Zahlen erscheinen (weiß/gelb/blau), Zielfernrohr,
// Granate, Spitzhacke, Heilen. Dazu Screenshots zum Anschauen.
// Für Screenshots werden die Effekte kurz angehalten (weapons.setEffectsPaused),
// damit Mündungsblitz, Leuchtspur und Zahlen sicher im Bild sind.
// =============================================================================
'use strict';

// Hilfen im Browser: genau auf einen Punkt zielen (über die Fadenkreuz-Linie), Taste drücken
async function installHelpers(page) {
  await page.evaluate(async () => {
    if (window.__wp) return;
    const THREE = await import('three');
    const o = new THREE.Vector3();
    const d = new THREE.Vector3();
    window.__wp = {
      aimAt(x, y, z) {
        const g = buildDuel.game;
        const p = g.player;
        let yaw = p.yaw;
        let pitch = p.pitch;
        for (let i = 0; i < 6; i++) {
          g.cameraRig.computeAimRay(p, g.world, o, d, yaw, pitch);
          const vx = x - o.x;
          const vy = y - o.y;
          const vz = z - o.z;
          yaw = Math.atan2(-vx, -vz);
          pitch = Math.atan2(vy, Math.hypot(vx, vz));
        }
        p.yaw = p.prevYaw = yaw;
        p.pitch = p.prevPitch = pitch;
      },
      press(action, seconds = 1 / 60) {
        buildDuel.input.setVirtual(action, true);
        buildDuel.simulate(1 / 60);
        buildDuel.input.setVirtual(action, false);
        if (seconds > 1 / 60) buildDuel.simulate(seconds - 1 / 60);
      },
      // Schieß-Stand, Blick nach Westen; Puppe nach Name
      toStand() {
        const g = buildDuel.game;
        g.weapons.setEffectsPaused(false);
        g.weapons.clearEffects(); // saubere Bilder: alte Zahlen/Feuerbälle weg
        const r = buildDuel.CONFIG.practiceRange;
        g.player.resetForRound({ health: 100, shield: 100, position: { x: r.stand.x, y: 0, z: r.stand.z }, yaw: Math.PI / 2 });
        g.cameraRig.snap();
        buildDuel.simulate(0.1);
      },
      dummy(name) {
        return buildDuel.game.characters.find((c) => c.isDummy && c.name === name);
      },
      // Waffe in die Hand: Platz drücken, bis die gewünschte Waffe drin ist
      select(id) {
        const p = buildDuel.game.player;
        const slot = p.slots.findIndex((s) => s && s.id === id);
        const list = p.weaponState?.variants ?? [];
        let index = slot;
        if (index < 0) index = list.findIndex((l) => l && l.some((s) => s.id === id));
        if (index < 0) return false;
        __wp.press(`slot${index + 1}`, 0.1);
        for (let i = 0; i < 4 && p.slots[index].id !== id; i++) __wp.press(`slot${index + 1}`, 0.1);
        buildDuel.simulate(0.3); // Wechsel-Zeit
        return p.slots[index].id === id && p.selectedSlot === index;
      },
    };
  });
}

// ein Bild abwarten (Grafik hat Schüsse/Treffer verarbeitet)
async function nextFrames(page, n = 2) {
  for (let i = 0; i < n; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
}

const WEAPON_CHECKS = [
  {
    name: 'Waffen: Übungsplatz-Ausrüstung (1 Schrotflinte, 2 AR, 3 Sniper, 4 MP/Pistole/Granatwerfer, 5 Heilen)',
    async run(ctx) {
      await ctx.page.evaluate(() => {
        buildDuel.play();
        buildDuel.manualStep(true);
      });
      await installHelpers(ctx.page);
      const r = await ctx.page.evaluate(() => {
        __wp.toStand();
        const p = buildDuel.game.player;
        const slots = p.slots.map((s) => s?.id ?? null);
        const cycle4 = [];
        __wp.press('slot4', 0.1);
        cycle4.push(p.slots[3].id);
        for (let i = 0; i < 3; i++) {
          __wp.press('slot4', 0.1);
          cycle4.push(p.slots[3].id);
        }
        const cycle5 = [];
        __wp.press('slot5', 0.1);
        cycle5.push(p.slots[4].id);
        for (let i = 0; i < 4; i++) {
          __wp.press('slot5', 0.1);
          cycle5.push(p.slots[4].id);
        }
        __wp.press('slot1', 0.3);
        const dummies = buildDuel.game.characters.filter((c) => c.isDummy).map((c) => c.name);
        buildDuel.game.hud.setHelpOpen(true); // Steuerungs-Hilfe (H) des HUD
        const help = document.querySelector('.hud-help-card').textContent;
        buildDuel.game.hud.setHelpOpen(false);
        return { slots, cycle4, cycle5, mode: p.mode, dummies, help };
      });
      ctx.assert(JSON.stringify(r.slots) === JSON.stringify(['shotgun', 'ar', 'sniper', 'smg', 'bandage']), `Plätze: ${r.slots.join(', ')}`);
      ctx.assert(JSON.stringify(r.cycle4) === JSON.stringify(['smg', 'pistol', 'grenadeLauncher', 'smg']), `4 nochmal: ${r.cycle4.join(' → ')}`);
      ctx.assert(r.cycle5.join(',') === 'bandage,medkit,smallShield,bigShield,bandage', `5 nochmal: ${r.cycle5.join(' → ')}`);
      ctx.assert(r.dummies.length === 5, `Zielpuppen: ${r.dummies.join(', ')}`);
      ctx.assert(/Schießen/.test(r.help) && /Spitzhacke/.test(r.help) && /Nachladen/.test(r.help), 'Hilfe nennt Schießen, Spitzhacke, Nachladen');
      await nextFrames(ctx.page, 3);
      await ctx.shot('20-schiess-stand');
      // Alle Modelle aus der Nähe: je drei Figuren halten sie (schräg zur Kamera),
      // der Spieler zielt (Kamera näher dran, engeres Sichtfeld)
      const groups = [['shotgun', 'ar', 'smg'], ['sniper', 'pistol', 'grenadeLauncher'], ['pickaxe', 'medkit', 'bigShield']];
      const rarity = { shotgun: 'common', ar: 'uncommon', smg: 'rare', sniper: 'epic', pistol: 'legendary', grenadeLauncher: 'rare' };
      for (let k = 0; k < groups.length; k++) {
        await ctx.page.evaluate(({ ids, rarity }) => {
          const g = buildDuel.game;
          for (const c of window.__lineup ?? []) g.removeCharacter(c);
          g.player.resetForRound({ health: 100, shield: 100, position: { x: 0, y: 0, z: 23.5 }, yaw: 0 });
          g.player.pitch = g.player.prevPitch = -0.1;
          g.cameraRig.snap();
          __wp.press('slot1', 0.3);
          buildDuel.input.setVirtual('secondary', true);
          window.__lineup = ids.map((id, i) => {
            const c = g.addCharacter({ name: `Modell ${id}`, isBot: true, brain: null, team: 300 + i, position: { x: 1.5 + i * 1.15, y: 0, z: 20.8 }, yaw: Math.PI * 0.8 });
            if (id === 'pickaxe') {
              g.weapons.giveLoadout(c, []);
              c.setMode('pickaxe');
            } else {
              g.weapons.giveLoadout(c, [id], { rarity: rarity[id] ?? 'common' });
            }
            return c;
          });
          buildDuel.simulate(0.3);
        }, { ids: groups[k], rarity });
        await nextFrames(ctx.page, 3); // die Grafik hängt die Modelle im nächsten Bild an
        await ctx.page.waitForTimeout(900); // Zoom beim Zielen
        await ctx.shot(`21-waffen-modelle-${k + 1}`);
        const attached = await ctx.page.evaluate(() => window.__lineup.map((c) => {
          let found = false;
          c.view.root.traverse((o) => { if (o.name.startsWith('Waffe ')) found = true; });
          return found;
        }));
        ctx.assert(attached.every(Boolean), `${groups[k].join(', ')}: jede Figur hält ihr Modell`);
      }
      await ctx.page.evaluate(() => {
        buildDuel.input.setVirtual('secondary', false);
        buildDuel.simulate(0.05);
        for (const c of window.__lineup) buildDuel.game.removeCharacter(c);
        window.__lineup = null;
      });
    },
  },
  {
    name: 'Waffen: jede Waffe trifft die Zielpuppen (Schaden + Treffer-Zahl)',
    async run(ctx) {
      await installHelpers(ctx.page);
      // id, Puppe, Ziel-Höhe, erwarteter Mindest-Schaden
      const plan = [
        ['shotgun', 'Zielpuppe 5 m', 1.0, 60],
        ['ar', 'Zielpuppe 15 m', 1.0, 30],
        ['smg', 'Zielpuppe 15 m', 1.0, 15], // MP: voll nur bis 12 m
        ['pistol', 'Zielpuppe 15 m', 1.0, 24],
        ['sniper', 'Zielpuppe 30 m', 1.0, 105],
        ['grenadeLauncher', 'Zielpuppe 15 m', 1.6, 20],
      ];
      for (const [id, dummyName, height, minDamage] of plan) {
        const r = await ctx.page.evaluate(({ id, dummyName, height }) => {
          __wp.toStand();
          const g = buildDuel.game;
          const ok = __wp.select(id);
          const d = __wp.dummy(dummyName);
          d.health = buildDuel.CONFIG.practiceRange.dummies.health;
          __wp.aimAt(d.position.x, d.position.y + height, d.position.z);
          if (id === 'sniper') buildDuel.input.setVirtual('secondary', true); // Zielfernrohr: genau
          buildDuel.simulate(id === 'sniper' ? 0.2 : 1 / 60);
          __wp.aimAt(d.position.x, d.position.y + height, d.position.z);
          let shots = 0;
          const off = g.events.on('shot', () => shots++);
          const before = d.health + d.shield;
          __wp.press('primary', 1 / 60);
          // warten, bis Geschosse ankommen (Sniper, Granate)
          for (let i = 0; i < 90 && d.health + d.shield >= before; i++) buildDuel.simulate(1 / 60);
          off();
          buildDuel.input.setVirtual('secondary', false);
          const after = d.health + d.shield;
          g.weapons.setEffectsPaused(true);
          return { ok, shots, damage: before - after, ammo: g.weapons.getAmmo(g.player), held: g.player.slots[g.player.selectedSlot]?.id };
        }, { id, dummyName, height });
        await nextFrames(ctx.page, 2);
        const numbers = await ctx.page.evaluate(() => buildDuel.game.weapons.visuals.visibleNumbers());
        await ctx.shot(`22-schuss-${id}`);
        await ctx.page.evaluate(() => buildDuel.game.weapons.setEffectsPaused(false));
        ctx.assert(r.ok && r.held === id && r.shots === 1, `${id}: in der Hand und 1 Schuss (${r.held}, ${r.shots})`);
        ctx.assert(r.damage >= minDamage - 1e-6, `${id}: Schaden an "${dummyName}": ${r.damage.toFixed(1)}`);
        ctx.assert(numbers.length > 0, `${id}: Treffer-Zahl sichtbar ${JSON.stringify(numbers)}`);
        ctx.assert(r.ammo && r.ammo.infinite, `${id}: Munition ${JSON.stringify(r.ammo)}`);
      }
    },
  },
  {
    name: 'Treffer-Zahlen: weiß (Körper), gelb (Kopf), blau (Schild)',
    async run(ctx) {
      await installHelpers(ctx.page);
      const r = await ctx.page.evaluate(() => {
        __wp.toStand();
        const g = buildDuel.game;
        __wp.select('ar');
        const body = __wp.dummy('Zielpuppe 5 m');
        const shield = __wp.dummy('Zielpuppe 15 m (Schild)');
        shield.shield = 100;
        const hits = [];
        const off = g.events.on('hit', (e) => hits.push({ amount: e.amount, head: e.head, shield: e.shield, target: e.target.name }));
        __wp.aimAt(body.position.x, 1.0, body.position.z);
        __wp.press('primary', 0.3);
        __wp.aimAt(body.position.x, body.height - 0.12, body.position.z);
        __wp.press('primary', 0.3);
        __wp.aimAt(shield.position.x, 1.0, shield.position.z);
        __wp.press('primary', 0.05);
        off();
        g.weapons.setEffectsPaused(false);
        return { hits, numbers: g.weapons.visuals.visibleNumbers() };
      });
      await nextFrames(ctx.page, 2);
      await ctx.page.waitForTimeout(150);
      await ctx.page.evaluate(() => buildDuel.game.weapons.setEffectsPaused(true));
      await nextFrames(ctx.page, 1);
      const style = await ctx.page.evaluate(() => [...document.querySelectorAll('.bd-dmg')]
        .filter((el) => el.style.display !== 'none').map((el) => ({ text: el.textContent, color: getComputedStyle(el).color, shadow: getComputedStyle(el).textShadow !== 'none' })));
      await ctx.shot('23-treffer-zahlen');
      await ctx.page.evaluate(() => buildDuel.game.weapons.setEffectsPaused(false));
      const kinds = r.numbers.map((n) => `${n.text}:${n.kind}`).join(' ');
      ctx.assert(r.hits.length === 3 && r.hits[0].amount === 30 && r.hits[1].amount === 45 && r.hits[1].head && r.hits[2].shield,
        `Treffer: ${JSON.stringify(r.hits)}`);
      ctx.assert(/30:body/.test(kinds) && /45:head/.test(kinds) && /30:shield/.test(kinds), `Zahlen: ${kinds}`);
      const colors = new Set(style.map((s) => s.color));
      ctx.assert(colors.has('rgb(255, 255, 255)') && colors.has('rgb(255, 217, 61)') && colors.has('rgb(79, 195, 247)'), `Farben: ${[...colors].join(', ')}`);
      ctx.assert(style.every((s) => s.shadow), 'dunkler Rand (lesbar vor dem Himmel)');
    },
  },
  {
    name: 'Sturmgewehr von der Seite: Mündungsblitz und Leuchtspur',
    async run(ctx) {
      await installHelpers(ctx.page);
      await ctx.page.evaluate(async () => {
        const THREE = await import('three');
        const g = buildDuel.game;
        // Spieler schaut quer auf eine Schuss-Linie: ein Übungs-Schütze schießt von rechts nach links
        g.weapons.clearEffects();
        g.player.resetForRound({ health: 100, shield: 100, position: { x: 12, y: 0, z: 36.5 }, yaw: 0 });
        g.player.pitch = g.player.prevPitch = -0.05;
        g.cameraRig.snap();
        __wp.select('ar');
        const shooter = g.addCharacter({ name: 'Übungs-Schütze', team: 400, position: { x: 24, y: 0, z: 26 }, yaw: Math.PI / 2, brain: null });
        g.weapons.giveLoadout(shooter, ['ar'], { rarity: 'epic', infiniteReserve: true });
        const target = new THREE.Vector3(2, 1.0, 30);
        let fire = false;
        shooter.brain = {
          think() {
            const cmd = shooter.command;
            cmd.moveX = cmd.moveZ = 0;
            shooter.eyePosition(cmd.aimOrigin);
            cmd.aimDir.subVectors(target, cmd.aimOrigin).normalize();
            cmd.yaw = Math.atan2(-cmd.aimDir.x, -cmd.aimDir.z);
            cmd.pitch = Math.asin(cmd.aimDir.y);
            cmd.primary = fire;
            cmd.primaryPressed = fire;
            cmd.selectSlot = 0;
            return cmd;
          },
        };
        window.__sideShooter = shooter;
        buildDuel.simulate(0.4);
        g.frameUpdate(1 / 60, 1);
        fire = true;
        buildDuel.simulate(1 / 60);
        fire = false;
        g.weapons.setEffectsPaused(true);
      });
      await nextFrames(ctx.page, 2);
      const fx = await ctx.page.evaluate(() => {
        let tracers = 0;
        let flashes = 0;
        buildDuel.game.root.traverse((o) => {
          if (!o.visible) return;
          if (o.name === 'Mündungsblitz' && o.material.opacity > 0.5) flashes++;
          if (o.name === 'Leuchtspur' && o.material.opacity > 0.5 && o.scale.z > 5) tracers++;
        });
        return { tracers, flashes };
      });
      await ctx.shot('24-ar-leuchtspur-muendungsblitz');
      await ctx.page.evaluate(() => {
        buildDuel.game.weapons.setEffectsPaused(false);
        buildDuel.game.removeCharacter(window.__sideShooter);
        window.__sideShooter = null;
      });
      ctx.assert(fx.tracers >= 1, `Leuchtspur sichtbar (${fx.tracers})`);
      ctx.assert(fx.flashes >= 1, `Mündungsblitz sichtbar (${fx.flashes})`);
    },
  },
  {
    name: 'Schuss aus der Box (eigene Figur ausgeblendet): kein Blitz und keine Spur vor der Kamera',
    async run(ctx) {
      await installHelpers(ctx.page);
      // Box 1×1 (Zelle −6, 0, 4), Rücken zur Wand → Kamera rückt an den Kopf, Figur ausgeblendet
      const setup = await ctx.page.evaluate(() => {
        const g = buildDuel.game;
        const p = g.player;
        g.weapons.setEffectsPaused(false);
        g.weapons.clearEffects();
        g.building.clearAll();
        p.resetForRound({ health: 100, shield: 100, position: { x: -22, y: 0, z: 19.4 }, yaw: 0 });
        g.cameraRig.snap();
        for (const k of ['wx:-6:0:4', 'wx:-6:0:5', 'wz:-6:0:4', 'wz:-5:0:4']) g.building.placePiece('wall', k, p, 'wood', { instant: true, force: true });
        g.building.placePiece('roof', 'c:-6:1:4', p, 'wood', { instant: true, force: true });
        __wp.select('ar');
        p.yaw = p.prevYaw = 0;
        p.pitch = p.prevPitch = 0;
        buildDuel.simulate(0.3);
        return { ar: p.slots[p.selectedSlot]?.id };
      });
      await nextFrames(ctx.page, 3);
      const hidden = await ctx.page.evaluate(() => ({ hide: buildDuel.game.cameraRig.hideCharacter, visible: buildDuel.game.player.view.root.visible }));
      ctx.assert(setup.ar === 'ar' && hidden.hide && !hidden.visible, `Figur ausgeblendet: ${JSON.stringify({ ...setup, ...hidden })}`);
      await ctx.page.evaluate(() => {
        __wp.press('primary');
        buildDuel.game.weapons.setEffectsPaused(true);
      });
      await nextFrames(ctx.page, 2);
      const fx = await ctx.page.evaluate(() => {
        const cam = buildDuel.camera.position;
        const e = buildDuel.game.weapons.visuals.visibleEffects();
        const dist = (o) => Math.hypot(o.x - cam.x, o.y - cam.y, o.z - cam.z);
        return { flashes: e.flashes.map(dist), tracers: e.tracers.map(dist) };
      });
      await ctx.shot('24b-schuss-aus-der-box');
      await ctx.page.evaluate(() => {
        buildDuel.game.weapons.setEffectsPaused(false);
        buildDuel.game.building.clearAll();
      });
      ctx.assert(fx.flashes.length === 0, `kein Mündungsblitz (Figur unsichtbar): ${JSON.stringify(fx.flashes)}`);
      ctx.assert(fx.tracers.length === 1 && fx.tracers[0] > 1, `Leuchtspur beginnt weiter als 1 m vor der Kamera: ${JSON.stringify(fx.tracers)}`);
    },
  },
  {
    name: 'Scharfschützengewehr: Zielfernrohr (20°), eigene Figur ausgeblendet, Kopfschuss = gelbe Zahl',
    async run(ctx) {
      await installHelpers(ctx.page);
      await ctx.page.evaluate(() => {
        __wp.toStand();
        __wp.select('sniper');
        const d = __wp.dummy('Zielpuppe 60 m');
        __wp.aimAt(d.position.x, d.height - 0.12, d.position.z);
        buildDuel.input.setVirtual('secondary', true);
        buildDuel.simulate(0.2);
        __wp.aimAt(d.position.x, d.height - 0.12, d.position.z);
      });
      await ctx.page.waitForTimeout(1200); // Sichtfeld gleitet auf 20°
      const scoped = await ctx.page.evaluate(() => ({
        fov: buildDuel.camera.fov,
        scopeFov: buildDuel.game.player.scopeFov,
        overlay: getComputedStyle(document.querySelector('.hud-scope')).display,
        figureVisible: buildDuel.game.player.view.root.visible,
      }));
      await ctx.shot('25-sniper-zielfernrohr');
      const r = await ctx.page.evaluate(() => {
        const g = buildDuel.game;
        const d = __wp.dummy('Zielpuppe 60 m');
        d.health = buildDuel.CONFIG.practiceRange.dummies.health;
        const hits = [];
        const off = g.events.on('hit', (e) => hits.push({ amount: e.amount, head: e.head }));
        __wp.press('primary', 0.4);
        off();
        g.weapons.setEffectsPaused(true);
        return { hits };
      });
      await nextFrames(ctx.page, 2);
      await ctx.shot('26-sniper-kopfschuss');
      await ctx.page.evaluate(() => {
        buildDuel.game.weapons.setEffectsPaused(false);
        buildDuel.input.setVirtual('secondary', false);
        buildDuel.simulate(0.1);
      });
      ctx.assert(scoped.scopeFov === 20 && Math.abs(scoped.fov - 20) < 1.5, `Sichtfeld ${scoped.fov.toFixed(1)}°`);
      ctx.assert(scoped.overlay === 'block', 'Zielfernrohr-Bild sichtbar');
      ctx.assert(!scoped.figureVisible, 'eigene Figur ausgeblendet');
      ctx.assert(r.hits.length === 1 && r.hits[0].head && Math.abs(r.hits[0].amount - 262.5) < 1e-6, `Kopfschuss: ${JSON.stringify(r.hits)}`);
    },
  },
  {
    name: 'Kopf: sichtbare Kopf-Kugel = Kopfschuss (stehend und geduckt, von vorn und hinten, Zielfernrohr)',
    async run(ctx) {
      await installHelpers(ctx.page);
      const bad = [];
      let shots = 0;
      for (const pose of [{ crouch: false, yaw: 0 }, { crouch: true, yaw: 0 }, { crouch: false, yaw: Math.PI }, { crouch: true, yaw: Math.PI }]) {
        const head = await ctx.page.evaluate(async (pose) => {
          const THREE = await import('three');
          const g = buildDuel.game;
          const p = g.player;
          for (const c of [...g.characters]) if (c.name === 'Kopf-Test') g.removeCharacter(c);
          g.weapons.clearEffects();
          p.resetForRound({ health: 100, shield: 100, position: { x: 0, y: 0, z: 30 }, yaw: 0 });
          g.cameraRig.snap();
          __wp.select('sniper');
          const t = g.addCharacter({ name: 'Kopf-Test', isBot: true, team: 77, position: { x: 0, y: 0, z: 10 }, yaw: pose.yaw, health: 100000, shield: 0, brain: null });
          t.brain = { think() { t.command.crouch = pose.crouch; t.command.yaw = pose.yaw; t.command.pitch = 0; return t.command; } };
          window.__kt = t;
          buildDuel.simulate(0.6);
          return { crouching: t.crouching };
        }, pose);
        await nextFrames(ctx.page, 3);
        // Mitte der Kopf-Kugel IM BILD (nicht aus der Rechnung)
        const sphere = await ctx.page.evaluate(async () => {
          const THREE = await import('three');
          const t = __kt;
          const r = buildDuel.CONFIG.player.hitbox.headRadius;
          t.view.root.updateMatrixWorld(true);
          // Gruppe "Kopf" der Figur = Mitte der Treffer-Kugel (der sichtbare Kopf liegt darin)
          const c = t.view.head.getWorldPosition(new THREE.Vector3());
          return { x: c.x, y: c.y, z: c.z, r };
        });
        // Punkte auf der Kugel, die der Schütze sieht. Von hinten verdeckt der vorgebeugte
        // Oberkörper (geduckt) den unteren Teil des Kopfes – dort nur die obere Hälfte.
        const offsets = [[0, 0], [0, 0.5], [0, 0.8], [-0.7, 0], [0.7, 0]];
        if (!(pose.crouch && pose.yaw === 0)) offsets.push([0, -0.5], [0, -0.8]);
        for (const [fx, fy] of offsets) {
          const res = await ctx.page.evaluate(({ sphere, fx, fy }) => {
            const g = buildDuel.game;
            const p = g.player;
            const t = __kt;
            g.weapons.resetCharacter(p); // volles Magazin, kein Nachladen
            buildDuel.input.setVirtual('secondary', true);
            buildDuel.simulate(0.35);
            __wp.aimAt(sphere.x + fx * sphere.r, sphere.y + fy * sphere.r, sphere.z);
            let out = 'Fehlschuss';
            const off = g.events.on('hit', (e) => { if (e.target === t) out = e.head ? 'KOPF' : 'Körper'; });
            __wp.press('primary', 0.25);
            off();
            buildDuel.input.setVirtual('secondary', false);
            buildDuel.simulate(1 / 60);
            return out;
          }, { sphere, fx, fy });
          shots++;
          if (res !== 'KOPF') bad.push(`${pose.crouch ? 'geduckt' : 'stehend'} ${pose.yaw ? 'von vorn' : 'von hinten'} (${fx}, ${fy}): ${res}`);
        }
        if (pose.crouch && pose.yaw === Math.PI) {
          await ctx.page.evaluate((sphere) => {
            buildDuel.game.weapons.resetCharacter(buildDuel.game.player);
            buildDuel.input.setVirtual('secondary', true);
            buildDuel.simulate(0.35);
            __wp.aimAt(sphere.x, sphere.y - sphere.r * 0.5, sphere.z);
            buildDuel.simulate(1 / 60);
          }, sphere);
          await nextFrames(ctx.page, 3);
          await ctx.shot('25b-kopf-geduckt-zielfernrohr');
          await ctx.page.evaluate(() => { buildDuel.input.setVirtual('secondary', false); buildDuel.simulate(0.1); });
        }
      }
      await ctx.page.evaluate(() => {
        const g = buildDuel.game;
        for (const c of [...g.characters]) if (c.name === 'Kopf-Test') g.removeCharacter(c);
      });
      ctx.log(`${shots} Schüsse auf die sichtbare Kopf-Kugel`);
      ctx.assert(bad.length === 0, `kein Kopfschuss: ${bad.join('; ')}`);
    },
  },
  {
    name: 'Granatwerfer: Bogen, Explosion (Feuerball), Schaden in 4 m',
    async run(ctx) {
      await installHelpers(ctx.page);
      const r = await ctx.page.evaluate(() => {
        __wp.toStand();
        const g = buildDuel.game;
        __wp.select('grenadeLauncher');
        const d = __wp.dummy('Zielpuppe 15 m');
        d.health = buildDuel.CONFIG.practiceRange.dummies.health;
        __wp.aimAt(d.position.x, 2.6, d.position.z);
        let explosion = null;
        const off = g.events.on('explosion', (e) => { explosion = { x: e.position.x, y: e.position.y, z: e.position.z, r: e.radius }; });
        __wp.press('primary', 1 / 60);
        for (let i = 0; i < 120 && !explosion; i++) buildDuel.simulate(1 / 60);
        off();
        return { explosion, damage: buildDuel.CONFIG.practiceRange.dummies.health - d.health };
      });
      await nextFrames(ctx.page, 1);
      await ctx.page.evaluate(() => buildDuel.game.weapons.setEffectsPaused(true));
      await nextFrames(ctx.page, 1);
      await ctx.shot('27-granate-explosion');
      await ctx.page.evaluate(() => buildDuel.game.weapons.setEffectsPaused(false));
      ctx.assert(r.explosion && r.explosion.r === 4, `Explosion: ${JSON.stringify(r.explosion)}`);
      ctx.assert(r.damage > 0, `Puppe in der Nähe: ${r.damage.toFixed(1)} Schaden`);
    },
  },
  {
    name: 'Spitzhacke: Baum gibt 5–10 Holz, Zahl "+N"',
    async run(ctx) {
      await installHelpers(ctx.page);
      const r = await ctx.page.evaluate(() => {
        const g = buildDuel.game;
        const t = buildDuel.CONFIG.practiceRange.harvest.tree;
        const p = g.player;
        g.weapons.clearEffects();
        p.resetForRound({ health: 100, shield: 100, position: { x: t.x, y: 0, z: t.z + 1.5 }, yaw: 0 });
        g.cameraRig.snap();
        p.materials.wood = 100;
        __wp.press('pickaxe', 0.3);
        __wp.aimAt(t.x, 1.3, t.z);
        let harvest = null;
        const off = g.events.on('harvest', (e) => { harvest = { material: e.material, amount: e.amount }; });
        buildDuel.input.setVirtual('primary', true);
        buildDuel.simulate(0.05);
        buildDuel.input.setVirtual('primary', false);
        off();
        return { harvest, wood: p.materials.wood, mode: p.mode };
      });
      await nextFrames(ctx.page, 2);
      // Die Zahl zeigt, was WIRKLICH dazukam
      const shown = await ctx.page.evaluate(() => buildDuel.game.weapons.visuals.visibleNumbers().filter((n) => n.kind === 'harvest').map((n) => n.text));
      ctx.assert(r.harvest && shown.includes(`+${r.harvest.amount}`), `Zahl: ${JSON.stringify(shown)} für ${JSON.stringify(r.harvest)}`);
      await ctx.page.evaluate(() => buildDuel.game.weapons.setEffectsPaused(true));
      await nextFrames(ctx.page, 1);
      await ctx.shot('28-spitzhacke-baum');
      await ctx.page.evaluate(() => buildDuel.game.weapons.setEffectsPaused(false));
      ctx.assert(r.mode === 'pickaxe', `Spitzhacke in der Hand (${r.mode})`);
      ctx.assert(r.harvest && r.harvest.material === 'wood' && r.harvest.amount >= 5 && r.harvest.amount <= 10, `Ernte: ${JSON.stringify(r.harvest)}`);
      ctx.assert(r.wood === 100 + r.harvest.amount, `Holz: ${r.wood}`);
      // Holz schon voll (999): keine "+N"-Zahl, sondern "voll"
      const full = await ctx.page.evaluate(() => {
        const g = buildDuel.game;
        const p = g.player;
        g.weapons.clearEffects();
        p.materials.wood = buildDuel.CONFIG.materials.maxPerType;
        let amount = null;
        const off = g.events.on('harvest', (e) => { amount = e.amount; });
        buildDuel.simulate(buildDuel.CONFIG.weapons.pickaxe.swingInterval);
        buildDuel.input.setVirtual('primary', true);
        buildDuel.simulate(0.05);
        buildDuel.input.setVirtual('primary', false);
        off();
        return { amount, wood: p.materials.wood };
      });
      await nextFrames(ctx.page, 2);
      const shownFull = await ctx.page.evaluate(() => buildDuel.game.weapons.visuals.visibleNumbers().filter((n) => n.kind === 'harvest').map((n) => n.text));
      ctx.assert(full.amount === 0 && full.wood === 999, `bei 999: ${JSON.stringify(full)}`);
      ctx.assert(shownFull.length === 1 && shownFull[0] === 'voll', `bei 999 angezeigt: ${JSON.stringify(shownFull)}`);
    },
  },
  {
    name: 'Waffe in der Hand verdeckt das Fadenkreuz nicht (alle Waffen, Blick hoch/runter, Zielen)',
    async run(ctx) {
      await installHelpers(ctx.page);
      const bad = await ctx.page.evaluate(async () => {
        const THREE = await import('three');
        const g = buildDuel.game;
        const p = g.player;
        const cam = buildDuel.camera;
        const rc = new THREE.Raycaster();
        const v2 = new THREE.Vector2();
        const out = [];
        for (const id of ['shotgun', 'ar', 'smg', 'pistol', 'sniper', 'grenadeLauncher', 'medkit']) {
          __wp.toStand();
          __wp.select(id);
          for (const aiming of id === 'medkit' ? [false] : [false, true]) { // mit Heil-Item kein Zielen
            for (const pitch of [-0.3, 0, 0.4, 0.75, 1.05, 1.2, 1.35]) { // steil nach unten liegt die Waffe naturgemäß neben der Mitte
              p.spawnAt({ x: 0, y: 0, z: 22 }, 0, pitch);
              p.aiming = aiming && id !== 'medkit';
              g.cameraRig.snap();
              g.cameraRig.fixedUpdate(p, 1 / 60, g.world);
              g.frameUpdate(1 / 60, 1);
              g.frameUpdate(1 / 60, 1);
              cam.updateMatrixWorld(true);
              p.view.root.updateMatrixWorld(true);
              if (!p.view.root.visible) continue;
              // Raster über dem Fadenkreuz (Striche 12 Pixel lang) + etwas Rand
              let hits = 0;
              for (let dx = -0.03; dx <= 0.031; dx += 0.015) {
                for (let dy = -0.045; dy <= 0.046; dy += 0.0225) {
                  rc.setFromCamera(v2.set(dx, dy), cam);
                  // nur die Waffe zählt (die Figur selbst prüft "Kamera: eigene Figur verdeckt …")
                  const h = rc.intersectObject(p.view.root, true)[0];
                  let o = h?.object;
                  while (o && !o.name.startsWith('Halter ')) o = o.parent;
                  if (o) hits++;
                }
              }
              if (hits) out.push(`${id} Neigung ${pitch}${p.aiming ? ' zielend' : ''}: ${hits}`);
            }
          }
        }
        p.aiming = false;
        __wp.toStand();
        return out;
      });
      ctx.assert(bad.length === 0, `Fadenkreuz verdeckt: ${bad.join('; ')}`);
    },
  },
  {
    name: 'Heilen: Verband (langsamer laufen, +15), Wechsel bricht ab',
    async run(ctx) {
      await installHelpers(ctx.page);
      const r = await ctx.page.evaluate(() => {
        const g = buildDuel.game;
        const p = g.player;
        __wp.toStand();
        p.health = 40;
        __wp.select('bandage');
        buildDuel.input.setVirtual('primary', true);
        buildDuel.simulate(1.5);
        const during = { factor: p.speedFactor, healing: p.healing?.itemId };
        buildDuel.simulate(1.6);
        buildDuel.input.setVirtual('primary', false);
        const afterUse = p.health;
        buildDuel.input.setVirtual('primary', true);
        buildDuel.simulate(1);
        buildDuel.input.setVirtual('primary', false);
        __wp.press('slot2', 3); // Wechsel → abgebrochen
        return { during, afterUse, afterCancel: p.health, factor: p.speedFactor, healing: p.healing };
      });
      await nextFrames(ctx.page, 2);
      ctx.assert(r.during.factor === 0.5 && r.during.healing === 'bandage', `beim Heilen: ${JSON.stringify(r.during)}`);
      ctx.assert(r.afterUse === 55, `Leben nach dem Verband: ${r.afterUse}`);
      ctx.assert(r.afterCancel === 55 && r.factor === 1 && r.healing === null, `abgebrochen: Leben ${r.afterCancel}, Tempo ${r.factor}`);
      await ctx.page.evaluate(() => __wp.toStand());
    },
  },
];

module.exports = { WEAPON_CHECKS, installHelpers }; // installHelpers: auch für lookChecks.cjs
