// =============================================================================
// Browser-Prüfungen für Welle 3a (HUD, Ton, Effekte) – in run.cjs in GAME_CHECKS eingehängt
// =============================================================================
// Auf dem Übungsplatz werden alle HUD-Zustände hergestellt und fotografiert – in
// 1280 x 720, 1920 x 1080 und 360 x 640: Waffe (Sturmgewehr), Treffer-X, Kill-Feed nach
// besiegten Zielpuppen, Baumodus (blauer Rahmen), Edit ("EDIT"), Zielfernrohr, wenig
// Leben + Treffer-Richtung, Heilen, Hilfe (H), Zone/Minimap/Stand/Nachricht, Zuschauen.
// Dazu: HUD-Bereiche überlappen sich nicht und ragen nicht aus dem Bild, die Taste H
// schaltet die Hilfe, der Hinweis "E – Tür öffnen" erscheint vor einer Tür, alle Töne
// lassen sich ohne Fehler erzeugen (gleichzeitige Töne bleiben begrenzt) und die
// Teilchen-Vorräte wachsen nie.
// Für die Bilder werden Zeit-Anzeigen angehalten (hud.setPaused, weapons.setEffectsPaused).
// =============================================================================
'use strict';

const SIZES = [
  { w: 1280, h: 720 },
  { w: 1920, h: 1080 },
  { w: 360, h: 640 },
];

// Hilfen im Browser (window.__hud)
async function installHelpers(page) {
  await page.evaluate(async () => {
    if (window.__hud) return;
    const THREE = await import('three');
    const o = new THREE.Vector3();
    const d = new THREE.Vector3();
    window.__hud = {
      THREE,
      g: () => buildDuel.game,
      aimAt(x, y, z) {
        const g = buildDuel.game;
        const p = g.player;
        let yaw = p.yaw;
        let pitch = p.pitch;
        for (let i = 0; i < 6; i++) {
          g.cameraRig.computeAimRay(p, g.world, o, d, yaw, pitch);
          yaw = Math.atan2(-(x - o.x), -(z - o.z));
          pitch = Math.atan2(y - o.y, Math.hypot(x - o.x, z - o.z));
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
      // sauberer Ausgangszustand am Schieß-Stand, Blick nach Westen auf die Zielpuppen
      reset() {
        const g = buildDuel.game;
        if (buildDuel.state !== 'playing') buildDuel.play();
        buildDuel.manualStep(true);
        for (const a of ['primary', 'secondary']) buildDuel.input.setVirtual(a, false);
        g.hud.setPaused(false);
        g.hud.clear();
        g.hud.setHelpOpen(false);
        g.hud.setPrompt(null, 'test');
        g.weapons.setEffectsPaused(false);
        g.weapons.clearEffects();
        g.effects.setPaused(false);
        g.building.clearAll();
        delete g.spectateTarget;
        if (g.storm && g.storm.__fake) g.storm = null;
        if (g.mode.__origHudInfo) {
          g.mode.hudInfo = g.mode.__origHudInfo;
          delete g.mode.__origHudInfo;
        }
        const r = buildDuel.CONFIG.practiceRange;
        g.weapons.resetCharacter(g.player); // Heilen/Nachladen abbrechen
        g.player.resetForRound({ health: 100, shield: 100, position: { x: r.stand.x, y: 0, z: r.stand.z }, yaw: Math.PI / 2 });
        g.player.pitch = g.player.prevPitch = 0;
        g.cameraRig.snap();
        buildDuel.simulate(0.1);
      },
      dummy(name) {
        return buildDuel.game.characters.find((c) => c.isDummy && c.name === name);
      },
      select(id) {
        const p = buildDuel.game.player;
        const slot = p.slots.findIndex((s) => s && s.id === id) >= 0 ? p.slots.findIndex((s) => s && s.id === id)
          : (p.weaponState?.variants ?? []).findIndex((list) => list && list.some((it) => it.id === id));
        if (slot < 0) throw new Error(`kein Platz mit ${id}`);
        for (let k = 0; k < 6 && p.slots[slot]?.id !== id; k++) this.press(`slot${slot + 1}`, 0.05);
        if (p.mode !== 'weapon' || p.selectedSlot !== slot) this.press(`slot${slot + 1}`, 0.05);
        for (let k = 0; k < 6 && p.slots[slot]?.id !== id; k++) this.press(`slot${slot + 1}`, 0.05);
        buildDuel.simulate(0.3);
      },
      state() {
        return buildDuel.game.hud.debugState();
      },
      // Rechtecke der HUD-Bereiche (nur sichtbare)
      rects() {
        const out = {};
        const parts = {
          vitals: '.hud-vitals', mats: '.hud-mats', build: '.hud-build', weapons: '.hud-weapons', feed: '.hud-feed',
          map: '.hud-map', stats: '.hud-stats', score: '.hud-score', title: '.hud-title', hint: '.hud-hint', fps: '#fps',
        };
        for (const [name, sel] of Object.entries(parts)) {
          const el = document.querySelector(sel);
          if (!el || getComputedStyle(el).display === 'none') continue;
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          out[name] = { l: r.left, t: r.top, r: r.right, b: r.bottom };
        }
        return out;
      },
    };
  });
}

// Bild-Wechsel abwarten (die Spielschleife malt weiter, auch wenn die Logik steht)
async function frames(page, n = 3) {
  await page.evaluate((count) => new Promise((resolve) => {
    let left = count;
    const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }), n);
}

function overlaps(a, b, pad = 0) {
  return a.l < b.r - pad && b.l < a.r - pad && a.t < b.b - pad && b.t < a.b - pad;
}

// Alle Zustände in einer Bild-Größe herstellen und fotografieren
async function captureAll(ctx, size) {
  const page = ctx.page;
  const tag = `${size.w}x${size.h}`;
  const shot = async (name) => {
    await frames(page, 3);
    await page.screenshot({ path: ctx.outPath(`hud-${name}-${tag}.png`) });
  };
  await page.setViewportSize({ width: size.w, height: size.h });
  await page.waitForTimeout(300);
  await page.evaluate(() => __hud.reset());

  // 1. Waffe: Sturmgewehr
  await page.evaluate(() => __hud.select('ar'));
  await frames(page, 3);
  const weapon = await page.evaluate(() => __hud.state());
  await shot('01-waffe');
  ctx.assert(weapon.slots[1] === 'ar:common*' && weapon.ammo === '30 / ∞' && weapon.ammoName === 'Sturmgewehr',
    `${tag} Waffe: Platz ${weapon.slots[1]}, Munition "${weapon.ammo}", Name "${weapon.ammoName}"`);
  ctx.assert(weapon.shield === 100 && weapon.health === 100 && weapon.crosshair.type === 'cross', `${tag} Leben/Schild/Fadenkreuz: ${JSON.stringify([weapon.shield, weapon.health, weapon.crosshair])}`);
  const rects = await page.evaluate(() => __hud.rects());
  const names = Object.keys(rects);
  const bad = [];
  for (let i = 0; i < names.length; i++) {
    const a = rects[names[i]];
    if (a.l < -1 || a.t < -1 || a.r > size.w + 1 || a.b > size.h + 1) bad.push(`${names[i]} ragt hinaus`);
    for (let j = i + 1; j < names.length; j++) if (overlaps(a, rects[names[j]], 2)) bad.push(`${names[i]} ↔ ${names[j]}`);
  }
  ctx.assert(bad.length === 0 && names.includes('vitals') && names.includes('weapons'), `${tag} HUD-Bereiche frei: ${bad.join(', ') || names.join(' ')}`);
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ctx.assert(!scroll, `${tag} keine waagerechte Scroll-Leiste`);

  // 2. Treffer-X + Kill-Feed: zwei Zielpuppen werden besiegbar gemacht und besiegt
  const kills = await page.evaluate(() => {
    const g = buildDuel.game;
    const d15 = __hud.dummy('Zielpuppe 15 m');
    d15.health = 40;
    d15.shield = 0;
    __hud.aimAt(d15.position.x, d15.position.y + 1.0, d15.position.z);
    buildDuel.input.setVirtual('primary', true);
    for (let i = 0; i < 90 && d15.alive; i++) buildDuel.simulate(1 / 60);
    buildDuel.input.setVirtual('primary', false);
    __hud.select('shotgun');
    const d5 = __hud.dummy('Zielpuppe 5 m');
    d5.health = 30;
    d5.shield = 0;
    __hud.aimAt(d5.position.x, d5.position.y + d5.height - 0.12, d5.position.z);
    __hud.press('primary', 0.05);
    g.hud.setPaused(true);
    g.weapons.setEffectsPaused(true);
    g.effects.setPaused(true);
    return { d15: d15.alive, d5: d5.alive };
  });
  await frames(page, 3);
  kills.s = await page.evaluate(() => __hud.state());
  await shot('02-kill-feed');
  ctx.assert(!kills.d15 && !kills.d5, `${tag} Zielpuppen besiegt`);
  ctx.assert(kills.s.feed.some((t) => /^Du \[AR\] Zielpuppe 15 m/.test(t)) && kills.s.feed.some((t) => /^Du \[Schrot\] Zielpuppe 5 m/.test(t)),
    `${tag} Kill-Feed: ${JSON.stringify(kills.s.feed)}`);
  ctx.assert(kills.s.hit === 'kill' && /besiegt/.test(kills.s.elimination ?? ''), `${tag} rotes Treffer-X + "besiegt": ${kills.s.hit} / ${kills.s.elimination}`);

  // 3. Treffer-X (normal) auf die Puppe mit Schild
  await page.evaluate(() => {
    __hud.reset();
    __hud.select('ar');
    const d = __hud.dummy('Zielpuppe 15 m (Schild)');
    __hud.aimAt(d.position.x, d.position.y + 1.0, d.position.z);
    __hud.press('primary', 0.02);
    buildDuel.game.hud.setPaused(true);
    buildDuel.game.weapons.setEffectsPaused(true);
  });
  await frames(page, 3);
  const hit = await page.evaluate(() => __hud.state().hit);
  await shot('03-treffer');
  ctx.assert(hit === 'hit' || hit === 'head', `${tag} Treffer-X: ${hit}`);

  // 4. Baumodus (blauer Rahmen um die Bau-Leiste)
  await page.evaluate(() => {
    __hud.reset();
    __hud.press('buildRamp', 0.1);
  });
  await frames(page, 3);
  const build = await page.evaluate(() => ({ s: __hud.state(), border: getComputedStyle(document.querySelector('.hud-build')).borderTopColor }));
  await shot('04-bauen');
  ctx.assert(build.s.flags.includes('mode-build') && build.s.crosshair.type === 'build', `${tag} Baumodus: ${build.s.flags.join(' ')}`);
  ctx.assert(/77, 166, 255/.test(build.border), `${tag} blauer Rahmen: ${build.border}`);

  // 5. Edit ("EDIT" unter dem Fadenkreuz): Wand setzen, G
  await page.evaluate(() => {
    __hud.press('buildWall', 0.05);
    __hud.press('primary', 0.1);
    __hud.press('edit', 0.1);
  });
  await frames(page, 3);
  const edit = await page.evaluate(() => {
    const el = document.querySelector('.hud-edit');
    return { s: __hud.state(), mode: buildDuel.game.player.mode, visible: getComputedStyle(el).display !== 'none', text: el.textContent };
  });
  await shot('05-edit');
  ctx.assert(edit.mode === 'edit' && edit.visible && edit.text === 'EDIT', `${tag} Edit: Modus ${edit.mode}, sichtbar ${edit.visible}`);

  // 6. Zielfernrohr
  await page.evaluate(() => {
    __hud.reset();
    __hud.select('sniper');
    const d = __hud.dummy('Zielpuppe 60 m');
    __hud.aimAt(d.position.x, d.position.y + 1.2, d.position.z);
    buildDuel.input.setVirtual('secondary', true);
    buildDuel.simulate(0.3);
  });
  await page.waitForTimeout(1300); // Sichtfeld gleitet auf 20°
  const scope = await page.evaluate(() => ({
    s: __hud.state(),
    lens: getComputedStyle(document.querySelector('.hud-scope')).display,
    cross: getComputedStyle(document.querySelector('.hud-cross')).display,
  }));
  await shot('06-zielfernrohr');
  await page.evaluate(() => {
    buildDuel.input.setVirtual('secondary', false);
    buildDuel.simulate(0.1);
  });
  ctx.assert(scope.s.flags.includes('scoped') && scope.lens === 'block' && scope.cross === 'none', `${tag} Zielfernrohr: ${scope.lens}, Fadenkreuz ${scope.cross}`);

  // 7. Wenig Leben + Treffer-Richtung (Angreifer links hinten)
  await page.evaluate(() => {
    __hud.reset();
    __hud.select('ar');
    const g = buildDuel.game;
    const p = g.player;
    const bot = g.characters.find((c) => !c.isPlayer && !c.isDummy);
    const save = { x: bot.position.x, y: bot.position.y, z: bot.position.z };
    // Angreifer kurz links hinter den Spieler stellen (Blick nach −X: links = +Z, hinten = +X)
    bot.position.set(p.position.x + 6, 0, p.position.z + 6);
    p.applyDamage(100 + 82, { attacker: bot, kind: 'bullet', weaponId: 'ar' });
    bot.position.set(save.x, save.y, save.z);
    g.hud.setPaused(true);
  });
  await frames(page, 3);
  const low = await page.evaluate(() => __hud.state());
  await shot('07-wenig-leben');
  ctx.assert(low.health === 18 && low.shield === 0 && low.flags.includes('lowhp'), `${tag} wenig Leben: ${low.health}/${low.shield} ${low.flags.join(' ')}`);
  ctx.assert(low.arcs.length === 1 && low.arcs[0] < -Math.PI / 2 && low.arcs[0] > -Math.PI, `${tag} Treffer-Richtung links hinten: ${JSON.stringify(low.arcs)}`);

  // 8. Heilen (Verband)
  await page.evaluate(() => {
    __hud.reset();
    const p = buildDuel.game.player;
    p.health = 40;
    __hud.select('bandage');
    buildDuel.input.setVirtual('primary', true);
    buildDuel.simulate(1.4);
    buildDuel.input.setVirtual('primary', false);
  });
  await frames(page, 3);
  const heal = await page.evaluate(() => __hud.state());
  await shot('08-heilen');
  ctx.assert(/^Verband \d,\d s$/.test(heal.heal ?? ''), `${tag} Heil-Balken: ${heal.heal}`);
  ctx.assert(heal.slots[4] && heal.slots[4].startsWith('bandage') && /∞/.test(heal.ammo), `${tag} Heil-Platz: ${heal.slots[4]} ${heal.ammo}`);

  // 9. Hilfe (echte Taste H)
  await page.evaluate(() => __hud.reset());
  await page.keyboard.press('KeyH');
  const help = await page.evaluate(() => ({
    open: buildDuel.game.hud.helpOpen,
    rows: document.querySelectorAll('.hud-help-grid .row').length,
    text: document.querySelector('.hud-help-card').textContent,
    // Tasten, deren Text nicht in ihr Kästchen passt (abgeschnitten), und ob die Karte ohne Scrollen passt
    cut: [...document.querySelectorAll('.hud-help-card kbd')].filter((k) => k.scrollWidth > k.clientWidth + 1).map((k) => k.textContent),
    overflow: (() => {
      const card = document.querySelector('.hud-help-card');
      return card.scrollHeight - card.clientHeight;
    })(),
  }));
  await shot('09-hilfe');
  await page.keyboard.press('KeyH');
  const closed = await page.evaluate(() => buildDuel.game.hud.helpOpen);
  ctx.assert(help.open && help.rows >= 20 && /Wand/.test(help.text) && /Leertaste/.test(help.text), `${tag} Hilfe: offen ${help.open}, ${help.rows} Zeilen`);
  ctx.assert(help.cut.length === 0 && help.overflow <= 1, `${tag} Hilfe vollständig lesbar: abgeschnitten [${help.cut.join(', ')}], ${help.overflow} px zu hoch`);
  ctx.assert(!closed, `${tag} H schließt die Hilfe wieder`);

  // 10. Zone, Minimap, Stand, große Nachricht, Hinweis (Sturm-Attrappe, Modus-Anzeige ersetzt)
  const zone = await page.evaluate(() => {
    __hud.reset();
    const g = buildDuel.game;
    const { THREE } = __hud;
    const storm = {
      __fake: true,
      center: new THREE.Vector3(-5, 0, 10),
      radius: 34,
      nextCenter: new THREE.Vector3(-12, 0, 4),
      nextRadius: 16,
      phase: 1,
      state: 'wait',
      timeLeft: 45,
      damagePerSecond: 1,
      isInside(pos) {
        return Math.hypot(pos.x - this.center.x, pos.z - this.center.z) <= this.radius;
      },
      update() {},
      dispose() {},
    };
    g.storm = storm;
    g.mode.__origHudInfo = g.mode.hudInfo;
    g.mode.hudInfo = () => ({ topCenter: { leftName: 'Du', leftScore: 3, rightName: 'Bot_1', rightScore: 2 }, alive: 7, kills: 2, zoneText: null, extra: [] });
    g.events.emit('message', { text: 'RUNDE 2', kind: 'round', duration: 3 });
    g.hud.setPrompt('Aufheben: Sturmgewehr', 'test');
    buildDuel.simulate(0.05);
    return null;
  });
  await frames(page, 4);
  const zs = await page.evaluate(() => {
    buildDuel.game.hud.setPaused(true);
    return __hud.state();
  });
  await shot('10-zone-minimap');
  void zone;
  ctx.assert(zs.minimap && zs.flags.includes('outside-storm') && zs.stats.zone === 'Zone schrumpft in 0:45', `${tag} Zone: Minimap ${zs.minimap}, ${zs.stats.zone}, ${zs.flags.join(' ')}`);
  ctx.assert(zs.stats.alive === 7 && zs.stats.kills === 2 && zs.message === 'RUNDE 2' && /^E – Aufheben/.test(zs.prompt ?? ''), `${tag} Stand/Nachricht/Hinweis: ${JSON.stringify([zs.stats, zs.message, zs.prompt])}`);
  const zrects = await page.evaluate(() => __hud.rects());
  const zbad = [];
  const zn = Object.keys(zrects);
  for (let i = 0; i < zn.length; i++) {
    for (let j = i + 1; j < zn.length; j++) if (overlaps(zrects[zn[i]], zrects[zn[j]], 2)) zbad.push(`${zn[i]} ↔ ${zn[j]}`);
  }
  ctx.assert(zbad.length === 0, `${tag} mit Minimap und Stand keine Überlappung: ${zbad.join(', ') || 'ok'}`);

  // 11. Zuschauen (Spieler besiegt)
  const spec = await page.evaluate(() => {
    __hud.reset();
    const g = buildDuel.game;
    g.spectateTarget = g.characters.find((c) => !c.isPlayer && !c.isDummy);
    g.player.applyDamage(500, { kind: 'fall', weaponId: 'fall' });
    buildDuel.simulate(0.05);
    return null;
  });
  void spec;
  await frames(page, 3);
  const sp = await page.evaluate(() => __hud.state());
  await shot('11-zuschauen');
  ctx.assert(/^Du schaust zu: Bot_/.test(sp.spectate ?? '') && sp.feed.some((t) => /\[Sturz\] Du/.test(t)), `${tag} Zuschauen: ${sp.spectate} / ${JSON.stringify(sp.feed)}`);
  await page.evaluate(() => {
    delete buildDuel.game.spectateTarget;
    buildDuel.simulate(2.5); // Übungsplatz: steht wieder auf
    __hud.reset();
  });
}

const HUD_CHECKS = [
  {
    name: 'HUD: alle Zustände in 1280x720, 1920x1080 und 360x640 (Bilder hud-*.png)',
    async run(ctx) {
      await installHelpers(ctx.page);
      try {
        for (const size of SIZES) await captureAll(ctx, size);
      } finally {
        await ctx.page.setViewportSize({ width: 1280, height: 720 });
        await ctx.page.evaluate(() => __hud.reset());
      }
    },
  },
  {
    name: 'HUD: Hinweis "E – Tür öffnen" vor einer Tür, danach "Tür schließen"',
    async run(ctx) {
      await installHelpers(ctx.page);
      const r = await ctx.page.evaluate(() => {
        __hud.reset();
        const g = buildDuel.game;
        const p = g.player;
        // Wand 2 Zellen vor dem Spieler (Blick nach −X), als Tür editiert
        const S = buildDuel.CONFIG.world.gridCellSize;
        const i = Math.floor(p.position.x / S);
        const k = Math.floor(p.position.z / S);
        const piece = g.building.placePiece('wall', `wz:${i}:0:${k}`, p, 'wood', { instant: true, force: true });
        const cells = buildDuel.CONFIG.building.wallDoorCells;
        g.building.setEdit(piece, (1 << cells[0]) | (1 << cells[1]));
        p.spawnAt({ x: i * S + 1.6, y: 0, z: k * S + S / 2 }, Math.PI / 2, 0);
        g.cameraRig.snap();
        buildDuel.simulate(0.05);
        return { door: piece.isDoor };
      });
      await frames(ctx.page, 4);
      const before = await ctx.page.evaluate(() => __hud.state().prompt);
      const opened = await ctx.page.evaluate(() => {
        __hud.press('use', 0.05);
        return buildDuel.game.building.findDoor(buildDuel.game.player)?.doorOpen ?? null;
      });
      await frames(ctx.page, 4);
      const after = await ctx.page.evaluate(() => __hud.state().prompt);
      await ctx.shot('hud-12-tuer');
      await ctx.page.evaluate(() => __hud.reset());
      ctx.assert(r.door && opened === true, `Tür gebaut und mit E geöffnet (${opened})`);
      ctx.assert(before === 'E – Tür öffnen', `vorher: ${before}`);
      ctx.assert(after === 'E – Tür schließen', `nach E: ${after}`);
    },
  },
  {
    name: 'Ton: alle Geräusche ohne Fehler, Ereignisse, gleichzeitige Töne begrenzt, Menü-Musik',
    async run(ctx) {
      await installHelpers(ctx.page);
      // Klick ins Bild = "Benutzer-Geste" (Browser erlauben Ton erst danach)
      await ctx.page.mouse.click(5, 5);
      const r = await ctx.page.evaluate(async () => {
        const g = buildDuel.game;
        const audio = g.audio;
        audio.unlock();
        for (let i = 0; i < 20 && audio.debug.stats().state !== 'running'; i++) await new Promise((res) => setTimeout(res, 50));
        const errors = [];
        const before = audio.debug.stats().played;
        try {
          audio.debug.playAll();
        } catch (e) {
          errors.push(`playAll: ${e.message}`);
        }
        const afterAll = audio.debug.stats().played;
        // Ereignisse des Spiels (echte Figuren/Bauteile)
        __hud.reset();
        const p = g.player;
        const bot = g.characters.find((c) => !c.isPlayer && !c.isDummy);
        const piece = g.building.placePiece('wall', 'wx:2:0:2', p, 'metal', { instant: true, force: true });
        const at = bot.position.clone();
        const emit = (name, payload) => {
          try {
            g.events.emit(name, payload);
          } catch (e) {
            errors.push(`${name}: ${e.message}`);
          }
        };
        for (const weaponId of ['shotgun', 'ar', 'smg', 'sniper', 'pistol', 'grenadeLauncher']) {
          emit('shot', { shooter: bot, weaponId, origin: at, dir: new __hud.THREE.Vector3(1, 0, 0), end: at, pellets: 1, kind: 'hitscan' });
          emit('shot', { shooter: p, weaponId, origin: p.position, dir: new __hud.THREE.Vector3(1, 0, 0), end: at, pellets: 1, kind: 'hitscan' });
        }
        emit('explosion', { position: at, radius: 4, owner: bot, weaponId: 'grenadeLauncher' });
        emit('impact', { shooter: p, weaponId: 'pickaxe', point: at, normal: new __hud.THREE.Vector3(0, 1, 0), kind: 'static' });
        emit('swing', { character: p });
        for (const material of ['wood', 'stone', 'metal']) emit('harvest', { character: p, material, amount: 7, rolled: 7, point: at });
        emit('hit', { attacker: p, target: bot, amount: 30, head: false, kind: 'character', killed: false, point: at });
        emit('hit', { attacker: p, target: bot, amount: 45, head: true, kind: 'character', killed: false, point: at });
        emit('hit', { attacker: p, target: bot, amount: 45, head: true, kind: 'character', killed: true, point: at });
        emit('shieldBroken', { character: bot });
        emit('piecePlaced', { piece, owner: p });
        emit('doorToggled', { piece, open: true });
        emit('footstep', { character: p });
        emit('footstep', { character: bot });
        emit('jump', { character: bot });
        emit('land', { character: p, fallHeight: 6 });
        emit('reloadStart', { character: p, weaponId: 'ar', interrupted: false });
        emit('reloadEnd', { character: p, weaponId: 'ar', interrupted: false });
        emit('weaponSwitched', { character: p, slot: 1 });
        emit('healStart', { character: p, itemId: 'bandage', duration: 3 });
        emit('heal', { character: p, kind: 'health', amount: 15 });
        emit('heal', { character: bot, kind: 'shield', amount: 25 });
        emit('pickup', { character: p, item: null });
        emit('chestOpened', { chest: null, character: p });
        emit('message', { text: 'SIEG!', kind: 'win', duration: 1 });
        emit('message', { text: 'Runde 2', kind: 'round', duration: 1 });
        emit('pieceDestroyed', { piece, by: p, collapsed: false });
        audio.ui('click');
        audio.ui('hover');
        // 20 Bots schießen gleichzeitig: Töne bleiben begrenzt
        let maxActive = 0;
        let maxShots = 0;
        for (let i = 0; i < 200; i++) {
          audio.play(i % 2 ? 'ar' : 'shotgun', { x: at.x + (i % 7), y: 1, z: at.z + (i % 5) });
          maxActive = Math.max(maxActive, audio.debug.activeVoices());
          maxShots = Math.max(maxShots, audio.debug.activeVoices('shot'));
        }
        audio.frameUpdate();
        audio.playMusic('menu');
        await new Promise((res) => setTimeout(res, 400));
        const musicOn = audio.debug.stats().music;
        audio.stopMusic();
        const stats = audio.debug.stats();
        g.building.clearAll();
        return { errors, before, afterAll, names: audio.debug.soundNames().length, maxActive, maxShots, shotCap: buildDuel.CONFIG.audio.voicesPerType.shot, stats, musicOn, musicOff: audio.debug.stats().music };
      });
      ctx.log(`Ton: ${r.stats.state}, gespielt ${r.stats.played}, weggelassen ${r.stats.dropped}, höchstens gleichzeitig ${r.stats.maxActive}`);
      ctx.assert(r.stats.state === 'running', `AudioContext läuft: ${r.stats.state}`);
      ctx.assert(r.errors.length === 0, `keine Fehler: ${r.errors.join('; ')}`);
      ctx.assert(r.afterAll - r.before >= Math.min(r.names, r.stats.maxVoices) - 2, `alle Rezepte spielbar: ${r.afterAll - r.before} von ${r.names}`);
      ctx.assert(r.maxActive <= r.stats.maxVoices && r.stats.maxActive <= r.stats.maxVoices, `gleichzeitig höchstens ${r.stats.maxVoices}: ${r.maxActive} / ${r.stats.maxActive}`);
      ctx.assert(r.maxShots <= r.shotCap && r.maxShots > 0, `Schüsse gleichzeitig höchstens ${r.shotCap}: ${r.maxShots}`);
      ctx.assert(r.musicOn && !r.musicOff, `Menü-Musik an/aus: ${r.musicOn} / ${r.musicOff}`);
    },
  },
  {
    name: 'Effekte: Splitter/Staub/Funken erscheinen, Vorräte wachsen nie',
    async run(ctx) {
      await installHelpers(ctx.page);
      const r = await ctx.page.evaluate(() => {
        __hud.reset();
        const g = buildDuel.game;
        const p = g.player;
        // Wand vor den Spieler, mit dem Sturmgewehr darauf schießen
        const S = buildDuel.CONFIG.world.gridCellSize;
        const i = Math.floor(p.position.x / S);
        const k = Math.floor(p.position.z / S);
        const piece = g.building.placePiece('wall', `wz:${i}:0:${k}`, p, 'wood', { instant: true, force: true });
        __hud.select('ar');
        __hud.aimAt(i * S, 1.5, k * S + S / 2);
        buildDuel.input.setVirtual('primary', true);
        buildDuel.simulate(0.4);
        buildDuel.input.setVirtual('primary', false);
        g.frameUpdate(1 / 60, 1);
        const afterHits = g.effects.stats();
        g.building.removePiece(piece, { by: p });
        g.effects.spawn('explosion', { x: p.position.x - 6, y: 0.2, z: p.position.z });
        g.frameUpdate(1 / 60, 1);
        const afterBurst = g.effects.stats();
        g.effects.setPaused(true);
        g.weapons.setEffectsPaused(true);
        // sehr viele Effekte: Vorräte bleiben gleich groß
        for (let n = 0; n < 300; n++) g.effects.spawn('sparks', { x: p.position.x - 5, y: 1, z: p.position.z }, { count: 5 });
        for (let n = 0; n < 300; n++) g.effects.spawn('splinters', { x: p.position.x - 5, y: 1, z: p.position.z }, { count: 5 });
        for (let n = 0; n < 100; n++) g.effects.spawn('dust', { x: p.position.x - 5, y: 0.2, z: p.position.z }, { count: 5 });
        // kurz fliegen lassen (frisch erzeugte Teilchen blenden erst ein), dann anhalten
        g.effects.setPaused(false);
        for (let n = 0; n < 3; n++) g.effects.frameUpdate(0.03);
        g.effects.setPaused(true);
        g.frameUpdate(1 / 60, 1);
        return { afterHits, afterBurst, full: g.effects.stats() };
      });
      await frames(ctx.page, 3);
      await ctx.shot('hud-13-effekte');
      await ctx.page.evaluate(() => __hud.reset());
      const c = r.full.capacity;
      ctx.assert(r.afterHits.chunks > 0 && r.afterHits.glow > 0, `Splitter und Funken beim Beschuss: ${JSON.stringify(r.afterHits)}`);
      ctx.assert(r.afterBurst.dust > 0, `Staub/Rauch: ${JSON.stringify(r.afterBurst)}`);
      ctx.assert(r.full.dust <= c.dust && r.full.glow <= c.glow && r.full.chunks <= c.chunks && r.full.glow === c.glow,
        `Vorräte voll, aber nicht größer: ${JSON.stringify(r.full)}`);
    },
  },
];

module.exports = { HUD_CHECKS };
