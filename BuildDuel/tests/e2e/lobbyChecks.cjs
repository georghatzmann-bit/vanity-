// =============================================================================
// Browser-Prüfungen für Welle 5 (Ladebildschirm, Lobby, Spind, Shop, Einstellungen,
// Pause-Menü, Kreativ-Modus) – in run.cjs in GAME_CHECKS eingehängt, Namen beginnen
// mit "Lobby:" (nur diese: --grep Lobby).
// Die Prüfungen öffnen eine EIGENE Seite ohne ?mode (= Lobby) mit frischem Speicher und
// steuern sie über echte Klicks/Tasten. Screenshots: 50-… bis 69-….
// =============================================================================
'use strict';

// Eine Lobby-Seite für alle Prüfungen dieser Datei (wird in der letzten geschlossen)
let lobbyPage = null;
async function lobby(ctx) {
  if (!lobbyPage || lobbyPage.isClosed()) {
    lobbyPage = await ctx.openPage(null, '?seed=1');
    await lobbyPage.waitForFunction(() => window.buildDuel?.state === 'lobby', null, { timeout: 30000 });
    // Vorschau-Bilder werden im Hintergrund fertig (Software-Grafik: kann dauern)
    await lobbyPage.waitForFunction(() => document.querySelector('.profile-avatar img')?.src.startsWith('data:image/png'), null, { timeout: 60000 });
    await lobbyPage.waitForTimeout(500);
  }
  return lobbyPage;
}

// animations: 'disabled' – Übergänge (Einblenden) fertig zeigen; Software-Grafik malt nur 1–5 Bilder/s
const shot = (ctx, page, name) => page.screenshot({ path: ctx.outPath(`${name}.png`), animations: 'disabled' });

// Liegt ein Element ganz im Bild? Überlappen sich zwei?
async function layout(page, selectors) {
  return page.evaluate((sels) => {
    const out = {};
    for (const s of sels) {
      const el = document.querySelector(s);
      if (!el) { out[s] = null; continue; }
      const r = el.getBoundingClientRect();
      out[s] = { x: r.x, y: r.y, w: r.width, h: r.height, inside: r.x >= -1 && r.y >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1, visible: r.width > 0 && r.height > 0 };
    }
    return out;
  }, selectors);
}
function overlaps(a, b) {
  return a && b && a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;
}

const LOBBY_PARTS = ['.lobby .profile', '.lobby .chip-coins', '.lobby .gear-btn', '.btn-shop', '.btn-locker', '.mode-card', '.team-toggle', '.play-big'];

const LOBBY_CHECKS = [
  {
    name: 'Lobby: Ladebildschirm zeigt echte Lade-Schritte bis 100 %',
    async run(ctx) {
      const browser = ctx.page.context().browser();
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const problems = [];
      page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(m.text()); });
      page.on('pageerror', (e) => problems.push(e.message));
      try {
        // Schritte mitschreiben (index.html legt setLoadingProgress an, main.js ruft es auf)
        await page.addInitScript(() => {
          let fn = null;
          window.__steps = [];
          Object.defineProperty(window, 'setLoadingProgress', {
            configurable: true,
            get() { return fn && ((f, t) => { window.__steps.push([f, t]); fn(f, t); }); },
            set(v) { fn = v; },
          });
        });
        // main.js kurz zurückhalten → Ladebildschirm fotografieren
        let release;
        const held = new Promise((r) => { release = r; });
        await page.route('**/src/main.js', async (route) => { await held; await route.continue(); });
        // (Modul-Skripte halten "DOMContentLoaded" auf – darum nur auf die Antwort warten)
        await page.goto(ctx.baseUrl + '?seed=1', { waitUntil: 'commit' });
        await page.waitForSelector('#loading-fill', { timeout: 30000 });
        await page.waitForTimeout(1500);
        const early = await page.evaluate(() => ({ width: document.getElementById('loading-fill').style.width, visible: getComputedStyle(document.getElementById('loading')).opacity === '1' }));
        // (page.screenshot wartet auf die Schriften – das klappt erst nach dem Laden; darum direkt über CDP)
        const cdp = await page.context().newCDPSession(page);
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
        require('fs').writeFileSync(ctx.outPath('50-lobby-ladebildschirm.png'), Buffer.from(data, 'base64'));
        await cdp.detach();
        release();
        await page.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 60000 });
        const r = await page.evaluate(() => ({ steps: window.__steps, pct: document.getElementById('loading-pct').textContent, state: buildDuel.state }));
        ctx.log(`Schritte: ${r.steps.map(([f, t]) => `${Math.round(f * 100)}% ${t}`).join(' | ')}`);
        ctx.assert(early.visible && parseFloat(early.width) > 0 && parseFloat(early.width) <= 32, `Balken kriecht vor dem Laden: ${early.width}`);
        ctx.assert(r.steps.length >= 5, `mindestens 5 echte Schritte: ${r.steps.length}`);
        ctx.assert(r.steps.every((s, i) => i === 0 || s[0] >= r.steps[i - 1][0]), 'Schritte steigen');
        ctx.assert(r.steps[r.steps.length - 1][0] === 1 && r.pct === '100 %', `endet bei 100 %: ${r.pct}`);
        ctx.assert(r.state === 'lobby', `danach Lobby: ${r.state}`);
        ctx.assert(problems.length === 0, `Konsole sauber: ${problems.join(' | ')}`);
      } finally {
        await page.close();
      }
    },
  },
  {
    name: 'Lobby: Hauptmenü mit Figur, Profil, Münzen, Shop/Spind, Modus und SPIELEN',
    async run(ctx) {
      const page = await lobby(ctx);
      const r = await page.evaluate(() => ({
        state: buildDuel.state,
        game: buildDuel.game,
        lobbyVisible: buildDuel.lobby.visible,
        skin: buildDuel.lobby.character?.skin?.id,
        menu: buildDuel.menus.debugState(),
        overlay: !document.getElementById('play-overlay').hidden,
        mode: document.querySelector('.mode-card .mode-name').textContent,
        play: document.querySelector('.play-big').textContent.trim(),
        duoDisabled: document.querySelector('.team-duo').getAttribute('aria-disabled'),
        avatar: document.querySelector('.profile-avatar img').src.startsWith('data:image/png'),
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
      }));
      ctx.assert(r.state === 'lobby' && r.game === null && r.lobbyVisible, `Lobby ohne Spiel: ${r.state}`);
      ctx.assert(!r.overlay, 'kein "Klicken zum Spielen" in der Lobby');
      ctx.assert(!!r.skin, `Figur auf dem Podest: ${r.skin}`);
      ctx.assert(r.mode === 'Kreativ', `Kreativ vorgewählt: ${r.mode}`);
      ctx.assert(/Spielen/i.test(r.play), `SPIELEN-Knopf: ${r.play}`);
      ctx.assert(r.duoDisabled === 'true', 'Duo gesperrt ("bald")');
      ctx.assert(r.avatar, 'Profilbild ist ein gemaltes Bild der Figur');
      ctx.assert(r.menu.name === 'Spieler' && r.menu.level === '1', `Profil: ${r.menu.name}, Level ${r.menu.level}`);
      ctx.assert(!r.overflow, 'keine waagerechte Scroll-Leiste');
      const a1 = await page.evaluate(() => buildDuel.lobby.angle);
      await page.waitForTimeout(1200);
      const a2 = await page.evaluate(() => buildDuel.lobby.angle);
      ctx.log(`Drehung: ${a1.toFixed(2)} → ${a2.toFixed(2)}`);
      await shot(ctx, page, '51-lobby-1280');
    },
  },
  {
    name: 'Lobby: passt in 1920×1080 und 360×640 (nichts ragt heraus, nichts überlappt)',
    async run(ctx) {
      const page = await lobby(ctx);
      for (const [w, h] of [[1920, 1080], [360, 640], [1280, 720]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(700);
        const l = await layout(page, LOBBY_PARTS);
        const outside = Object.entries(l).filter(([, v]) => !v || !v.inside || !v.visible).map(([k]) => k);
        ctx.assert(outside.length === 0, `${w}×${h}: alles im Bild ${outside.join(', ')}`);
        const pairs = [['.btn-locker', '.mode-card'], ['.mode-card', '.play-big'], ['.team-toggle', '.play-big'], ['.lobby .profile', '.lobby .chip-coins'], ['.btn-locker', '.play-big']];
        for (const [a, b] of pairs) ctx.assert(!overlaps(l[a], l[b]), `${w}×${h}: ${a} / ${b} überlappen nicht`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
        ctx.assert(!overflow, `${w}×${h}: keine Scroll-Leiste`);
        if (w !== 1280) await shot(ctx, page, `52-lobby-${w}x${h}`);
      }
    },
  },
  {
    name: 'Lobby: Tastatur – Pfeile wandern über die Knöpfe, Name ändern wird gespeichert',
    async run(ctx) {
      const page = await lobby(ctx);
      await page.evaluate(() => document.querySelector('.play-big').focus());
      await page.keyboard.press('ArrowUp');
      const f1 = await page.evaluate(() => document.activeElement.className);
      await page.keyboard.press('ArrowLeft');
      const f2 = await page.evaluate(() => document.activeElement.className);
      ctx.assert(/mode-card/.test(f1), `Pfeil hoch von SPIELEN → Modus-Karte: ${f1}`);
      ctx.assert(f2 !== f1, `Pfeil links wandert weiter: ${f2}`);
      await page.click('.name-btn');
      await page.fill('.name-input', 'Baumeister');
      await page.keyboard.press('Enter');
      const r = await page.evaluate(() => ({ name: buildDuel.settings.game.playerName, shown: document.querySelector('.name-text').textContent, stored: JSON.parse(localStorage.getItem('buildduel.settings.v1') || '{}').game?.playerName }));
      ctx.assert(r.name === 'Baumeister' && r.shown === 'Baumeister' && r.stored === 'Baumeister', `Name: ${JSON.stringify(r)}`);
    },
  },
  {
    name: 'Lobby: Modus-Auswahl – "bald" gesperrt, Übungsplatz wählbar, wird gespeichert',
    async run(ctx) {
      const page = await lobby(ctx);
      await page.click('.mode-card');
      await page.waitForTimeout(300);
      const tiles = await page.evaluate(() => [...document.querySelectorAll('.mode-tile')].map((t) => ({ id: t.dataset.mode, soon: t.classList.contains('soon') })));
      ctx.assert(tiles.length >= 3 && tiles[0].id === 'creative' && !tiles[0].soon, `Kacheln: ${tiles.map((t) => t.id + (t.soon ? '(bald)' : '')).join(', ')}`);
      ctx.assert(!tiles.some((t) => t.id.startsWith('sandbox')), 'keine Test-Modi');
      await shot(ctx, page, '53-lobby-modus-auswahl');
      const soon = tiles.find((t) => t.soon);
      if (soon) {
        // (aria-disabled: Playwright klickt das nicht – darum direkt im Browser klicken)
        await page.$eval(`.mode-tile[data-mode="${soon.id}"]`, (el) => el.click());
        ctx.assert(await page.evaluate(() => buildDuel.menus.selectedMode) === 'creative', '"bald"-Modus nicht wählbar');
      }
      await page.click('.mode-tile[data-mode="practice"]');
      await page.waitForTimeout(200);
      const r = await page.evaluate(() => ({ mode: buildDuel.menus.selectedMode, card: document.querySelector('.mode-name').textContent, saved: JSON.parse(localStorage.getItem('buildduel.progress.v1')).lastMode, picker: buildDuel.menus.debugState().picker }));
      ctx.assert(r.mode === 'practice' && r.card === 'Übungsplatz' && r.saved === 'practice' && !r.picker, `Übungsplatz gewählt: ${JSON.stringify(r)}`);
      await page.evaluate(() => buildDuel.menus.setMode('creative'));
    },
  },
  {
    name: 'Lobby: Spind – anderen Skin ausrüsten, Spitzhacke und Emote-Vorschau',
    async run(ctx) {
      const page = await lobby(ctx);
      await page.click('.btn-locker');
      await page.waitForTimeout(400);
      const cards = await page.evaluate(() => [...document.querySelectorAll('.item-card')].map((c) => ({ id: c.dataset.id, owned: c.classList.contains('owned'), img: !!c.querySelector('img')?.src.startsWith('data:') })));
      ctx.assert(cards.length >= 2 && cards.every((c) => c.img), `Skin-Karten mit Bildern: ${cards.length}`);
      ctx.assert(cards.some((c) => !c.owned), 'gesperrte Skins zeigen Schloss + Preis');
      // ein Skin, den man besitzt, aber gerade nicht anhat (unabhängig von den Skin-Namen)
      const worn = await page.evaluate(() => buildDuel.progress.equipped.skin);
      const other = cards.find((c) => c.owned && c.id !== worn);
      ctx.assert(!!other, `zweiter Gratis-Skin: ${cards.filter((c) => c.owned).map((c) => c.id).join(', ')}`);
      await page.click(`.item-card[data-id="${other.id}"]`);
      await page.click('.col-detail [data-action="equip"]');
      await page.waitForTimeout(500);
      const r = await page.evaluate(() => ({ eq: buildDuel.progress.equipped.skin, lobbySkin: buildDuel.lobby.character.skin.id, saved: JSON.parse(localStorage.getItem('buildduel.progress.v1')).equipped.skin }));
      ctx.assert(r.eq === other.id && r.lobbySkin === other.id && r.saved === other.id, `Skin ausgerüstet + gespeichert: ${JSON.stringify(r)}`);
      await page.waitForTimeout(800); // Figur dreht sich zur Kamera
      await shot(ctx, page, '54-spind-skin');
      // Spitzhacken: in der Hand
      await page.click('.col-tabs [data-kind="pickaxes"]');
      await page.waitForTimeout(300);
      const pick = await page.evaluate(() => ({ mode: buildDuel.lobby.character.mode, cards: document.querySelectorAll('.item-card').length }));
      ctx.assert(pick.mode === 'pickaxe' && pick.cards >= 3, `Spitzhacke in der Hand: ${JSON.stringify(pick)}`);
      await page.click('.item-card.locked');
      await page.waitForTimeout(600);
      await shot(ctx, page, '55-spind-spitzhacke');
      // Emotes: Vorschau tanzt
      await page.click('.col-tabs [data-kind="emotes"]');
      await page.waitForTimeout(300);
      await page.click('.col-detail [data-action="preview"]');
      await page.waitForTimeout(700);
      const dance = await page.evaluate(() => ({ until: buildDuel.lobby.character.emoteUntil, now: buildDuel.lobby.character.time }));
      ctx.assert(dance.until > dance.now, `Emote-Vorschau läuft: ${JSON.stringify(dance)}`);
      await shot(ctx, page, '56-spind-emote');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      ctx.assert(await page.evaluate(() => buildDuel.menus.screen) === 'lobby', 'Esc → zurück zur Lobby');
    },
  },
  {
    name: 'Lobby: Shop – Kaufen mit Bestätigung, Besitz, zu wenig Münzen',
    async run(ctx) {
      const page = await lobby(ctx);
      await page.click('.btn-shop');
      await page.click('.col-tabs [data-kind="pickaxes"]');
      await page.waitForTimeout(300);
      const before = await page.evaluate(() => buildDuel.progress.coins);
      const target = await page.evaluate(() => {
        const c = [...document.querySelectorAll('.item-card.locked')].find((x) => Number(x.querySelector('.price b').textContent.replace(/\D/g, '')) <= buildDuel.progress.coins);
        return c ? c.dataset.id : null;
      });
      ctx.assert(!!target, `kaufbare Spitzhacke: ${target}`);
      await page.click(`.item-card[data-id="${target}"]`);
      await page.click('.col-detail [data-action="buy"]');
      await page.waitForTimeout(300);
      ctx.assert(await page.evaluate(() => buildDuel.menus.debugState().confirm), 'Bestätigungs-Fenster offen');
      await shot(ctx, page, '57-shop-kaufen');
      await page.click('.confirm-yes');
      await page.waitForTimeout(400);
      const r = await page.evaluate((id) => ({
        owned: buildDuel.progress.owned.pickaxes.includes(id),
        eq: buildDuel.progress.equipped.pickaxe,
        coins: buildDuel.progress.coins,
        saved: JSON.parse(localStorage.getItem('buildduel.progress.v1')).owned.pickaxes.includes(id),
        button: document.querySelector('.col-detail .act').textContent.trim(),
      }), target);
      ctx.assert(r.owned && r.saved && r.eq === target, `gekauft + ausgerüstet + gespeichert: ${JSON.stringify(r)}`);
      ctx.assert(r.coins < before, `Münzen ${before} → ${r.coins}`);
      ctx.assert(/Im Besitz/.test(r.button), `Knopf: ${r.button}`);
      await shot(ctx, page, '58-shop-gekauft');
      // zu wenig Münzen: Kaufen gesperrt
      await page.evaluate(() => { buildDuel.progress.coins = 0; });
      await page.click('.col-tabs [data-kind="skins"]');
      await page.click('.item-card.locked');
      const poor = await page.evaluate(() => ({ disabled: document.querySelector('.col-detail .act-buy')?.disabled, warn: document.querySelector('.detail-warn')?.textContent }));
      ctx.assert(poor.disabled === true && /Zu wenig/.test(poor.warn ?? ''), `zu wenig Münzen: ${JSON.stringify(poor)}`);
      await page.evaluate(() => { buildDuel.progress.coins = 5000; });
      await page.click('.col-back');
    },
  },
  {
    name: 'Lobby: Einstellungen – alle Reiter, Lautstärke sofort, gespeichert',
    async run(ctx) {
      const page = await lobby(ctx);
      await page.click('.gear-btn');
      await page.waitForTimeout(300);
      ctx.assert(await page.evaluate(() => buildDuel.settingsWindow.isOpen), 'Einstellungen offen');
      const tabs = ['controls', 'sensitivity', 'graphics', 'audio', 'game'];
      for (let i = 0; i < tabs.length; i++) {
        await page.click(`.settings-tabs [data-tab="${tabs[i]}"]`);
        await page.waitForTimeout(250);
        await shot(ctx, page, `${59 + i}-einstellungen-${tabs[i]}`);
      }
      // Ton: Gesamt-Lautstärke ändern
      await page.click('.settings-tabs [data-tab="audio"]');
      await page.$eval('[data-slider="audio.master"]', (el) => { el.value = '0.35'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
      // Grafik: Auflösung sofort
      await page.click('.settings-tabs [data-tab="graphics"]');
      await page.$eval('[data-slider="graphics.resolutionScale"]', (el) => { el.value = '0.8'; el.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.click('.settings-tabs [data-tab="sensitivity"]');
      await page.$eval('[data-slider="sensitivity.x"]', (el) => { el.value = '1.5'; el.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => ({
        master: buildDuel.settings.audio.master,
        scale: buildDuel.quality.resolutionScale,
        sx: buildDuel.settings.sensitivity.x,
        saved: JSON.parse(localStorage.getItem('buildduel.settings.v1') || '{}'),
      }));
      ctx.assert(r.master === 0.35 && r.saved.audio?.master === 0.35, `Lautstärke: ${r.master}`);
      ctx.assert(r.scale === 0.8, `Auflösung sofort: ${r.scale}`);
      ctx.assert(r.sx === 1.5 && r.saved.sensitivity?.x === 1.5, `Empfindlichkeit X: ${r.sx}`);
      await page.$eval('[data-slider="sensitivity.x"]', (el) => { el.value = '1'; el.dispatchEvent(new Event('input', { bubbles: true })); });
      // Auflösung zurück auf 100 % (schärfere Bilder für die nächsten Prüfungen)
      await page.click('.settings-tabs [data-tab="graphics"]');
      await page.$eval('[data-slider="graphics.resolutionScale"]', (el) => { el.value = '1'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    },
  },
  {
    name: 'Lobby: Taste neu belegen (Taste, Maus), Konflikt rot, Standard zurück',
    async run(ctx) {
      const page = await lobby(ctx);
      if (!(await page.evaluate(() => buildDuel.settingsWindow.isOpen))) await page.click('.gear-btn');
      await page.click('.settings-tabs [data-tab="controls"]');
      await page.click('.skey[data-action="jump"][data-index="0"]');
      await page.waitForTimeout(100);
      ctx.assert(await page.evaluate(() => buildDuel.settingsWindow.capturing?.action === 'jump'), 'wartet auf Taste');
      await page.keyboard.press('KeyK');
      await page.waitForTimeout(150);
      const r1 = await page.evaluate(() => ({ jump: buildDuel.settings.controls.keyboard.jump, bound: buildDuel.input.bindings.get('KeyK') }));
      ctx.assert(r1.jump[0] === 'KeyK' && r1.bound?.includes('jump'), `Springen = K (sofort im Spiel): ${JSON.stringify(r1)}`);
      // Maus-Seitentaste auf Emote (zweites Feld)
      await page.click('.skey[data-action="emote"][data-index="1"]');
      await page.waitForTimeout(100);
      await page.mouse.click(640, 360, { button: 'middle' });
      await page.waitForTimeout(150);
      const r2 = await page.evaluate(() => buildDuel.settings.controls.keyboard.emote);
      ctx.assert(r2.includes('Mouse1'), `Emote auch auf Mausrad-Klick: ${JSON.stringify(r2)}`);
      // Konflikt: Springen auf W (= Vorwärts)
      await page.click('.skey[data-action="jump"][data-index="0"]');
      await page.waitForTimeout(100);
      await page.keyboard.press('KeyW');
      await page.waitForTimeout(150);
      const r3 = await page.evaluate(() => ({ red: document.querySelectorAll('.skey.conflict').length, banner: document.querySelector('.sconflicts').textContent }));
      ctx.assert(r3.red >= 2 && /Doppelt belegt/.test(r3.banner), `Konflikt rot: ${JSON.stringify(r3)}`);
      await page.evaluate(() => document.querySelector('.skey.conflict').scrollIntoView({ block: 'center' }));
      await shot(ctx, page, '64-einstellungen-konflikt');
      await page.click('[data-reset="controls"]');
      await page.waitForTimeout(200);
      const r4 = await page.evaluate(() => ({ jump: buildDuel.settings.controls.keyboard.jump, red: document.querySelectorAll('.skey.conflict').length }));
      ctx.assert(r4.jump[0] === 'Space' && r4.red === 0, `Standard zurück: ${JSON.stringify(r4)}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      ctx.assert(!(await page.evaluate(() => buildDuel.settingsWindow.isOpen)), 'Esc schließt die Einstellungen');
    },
  },
  {
    name: 'Lobby: SPIELEN → Kreativ (HUD, Bauteile/s), Pause-Menü, Alles löschen, zurück zur Lobby',
    async run(ctx) {
      const page = await lobby(ctx);
      await page.click('.play-big');
      await page.waitForFunction(() => buildDuel.modeId === 'creative' && buildDuel.state !== 'lobby', null, { timeout: 20000 });
      await page.waitForTimeout(600);
      await page.evaluate(() => {
        buildDuel.play();
        buildDuel.manualStep(true);
      });
      const start = await page.evaluate(() => ({
        state: buildDuel.state,
        menu: buildDuel.menus.visible,
        lobby: buildDuel.lobby.visible,
        skin: buildDuel.game.player.skin.id,
        eqSkin: buildDuel.progress.equipped.skin,
        infinite: buildDuel.game.player.infiniteMaterials,
        size: buildDuel.game.map.size,
        cosmetics: !!buildDuel.game.player.cosmetics && (!!buildDuel.CONFIG.pickaxes?.list || !!buildDuel.game.player.cosmetics.pickaxe),
        pitch: buildDuel.game.player.pitch,
        camPitch: buildDuel.game.cameraRig?.pitch ?? null,
        locked: buildDuel.input.locked,
        pos: buildDuel.game.player.position.toArray().map((v) => +v.toFixed(2)),
      }));
      ctx.log(`Start: Blick ${start.pitch.toFixed(2)} (Kamera ${start.camPitch}), Maus gesperrt: ${start.locked}, Position ${start.pos}`);
      ctx.assert(Math.abs(start.pitch) < 0.3, `Kamera schaut nach dem Start geradeaus: ${start.pitch}`);
      ctx.assert(start.state === 'playing' && !start.menu && !start.lobby, `im Spiel, Lobby weg: ${JSON.stringify(start)}`);
      ctx.assert(start.skin === start.eqSkin, `Spind-Skin im Spiel: ${start.skin}`);
      ctx.assert(start.infinite && start.size === 200, 'Kreativ: unendlich Material, 200 m');
      ctx.assert(start.cosmetics, 'Spind-Aussehen (Spitzhacke, Emote) am Spieler');
      // Spitzhacke ziehen (F) → umgefärbt
      await page.keyboard.press('KeyF');
      await page.evaluate(() => { buildDuel.simulate(0.2); });
      // (Software-Grafik: ein Bild kann über eine halbe Sekunde dauern – auf die Hacke in der Hand warten)
      // (Mit eigenen Spitzhacken-Formen – CONFIG.pickaxes.list – baut models.js die Form selbst: dann zählt player.pickaxeId)
      await page.waitForFunction(() => buildDuel.CONFIG.pickaxes?.list || buildDuel.game.player.view.rightHand.children.some((m) => /pickaxe/.test(m.name) && m.userData.pickaxeStyle), null, { timeout: 15000 }).catch(() => {});
      const styled = await page.evaluate(() => ({
        styles: buildDuel.game.player.view.rightHand.children.map((m) => m.userData.pickaxeStyle ?? null),
        forms: !!buildDuel.CONFIG.pickaxes?.list,
        pickaxeId: buildDuel.game.player.pickaxeId ?? null,
        equipped: buildDuel.progress.equipped.pickaxe,
      }));
      ctx.assert(styled.forms ? styled.pickaxeId === styled.equipped : styled.styles.includes(styled.equipped), `Spitzhacke aus dem Spind in der Hand: ${JSON.stringify(styled)}`);
      // Bauen: 6 Wände schnell nacheinander → Bauteile/s
      await page.evaluate(() => {
        const g = buildDuel.game;
        for (let k = 0; k < 6; k++) g.building.placePiece('wall', `wx:${k}:0:-2`, g.player, 'wood', { instant: true, force: true });
        buildDuel.simulate(0.2);
      });
      await page.waitForTimeout(700);
      const hud = await page.evaluate(() => ({ extra: document.querySelector('.hud-extra')?.textContent ?? '', pieces: buildDuel.game.building.pieces.size, pps: buildDuel.game.mode.stats.perSecond }));
      ctx.assert(/Bauteile\/s/.test(hud.extra) && hud.pieces === 6 && hud.pps >= 5, `HUD: ${JSON.stringify(hud)}`);
      // HUD-Text wird beim Malen erneuert – auf das nächste Bild warten
      await page.waitForFunction(() => /Bauteile: 6/.test(document.querySelector('.hud-extra')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {});
      const view = await page.evaluate(() => ({ pitch: buildDuel.game.player.pitch, pos: buildDuel.game.player.position.toArray().map((v) => +v.toFixed(2)), locked: buildDuel.input.locked }));
      ctx.log(`Vor dem Bild: Blick ${view.pitch.toFixed(2)}, Position ${view.pos}, Maus gesperrt: ${view.locked}`);
      await page.evaluate(() => buildDuel.game.hud.setPaused?.(true));
      await shot(ctx, page, '65-kreativ-im-spiel');
      await page.evaluate(() => buildDuel.game.hud.setPaused?.(false));
      // Taste P = alles löschen
      await page.keyboard.press('KeyP');
      await page.evaluate(() => buildDuel.simulate(0.1));
      ctx.assert(await page.evaluate(() => buildDuel.game.building.pieces.size) === 0, 'P löscht alle Bauteile');
      await page.waitForTimeout(900); // ein paar Bilder (Meldung "Alle Bauteile gelöscht")
      await shot(ctx, page, '65b-kreativ-alles-geloescht');
      // Pause-Menü
      await page.evaluate(() => {
        const g = buildDuel.game;
        for (let k = 0; k < 3; k++) g.building.placePiece('floor', `f:${k}:0:-3`, g.player, 'stone', { instant: true, force: true });
      });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const pause = await page.evaluate(() => ({
        state: buildDuel.state,
        title: document.getElementById('play-title').textContent,
        buttons: [...document.querySelectorAll('#play-overlay button')].filter((b) => !b.hidden && b.offsetParent).map((b) => b.textContent.trim()),
      }));
      ctx.assert(pause.state === 'paused' && pause.title === 'Pausiert', `Pause: ${JSON.stringify(pause)}`);
      ctx.assert(['Weiter', 'Einstellungen', 'Alle Bauteile löschen', 'Zurück zur Lobby'].every((t) => pause.buttons.includes(t)), `Knöpfe: ${pause.buttons.join(', ')}`);
      await shot(ctx, page, '66-pause-menue');
      // Einstellungen aus der Pause: bleibt pausiert
      await page.click('#pause-settings');
      await page.waitForTimeout(250);
      await shot(ctx, page, '67-pause-einstellungen');
      await page.click('.settings-done');
      ctx.assert(await page.evaluate(() => buildDuel.state) === 'paused', 'nach den Einstellungen weiter pausiert');
      await page.click('#pause-clear');
      ctx.assert(await page.evaluate(() => buildDuel.game.building.pieces.size) === 0 && await page.evaluate(() => buildDuel.state) === 'paused', 'Knopf löscht alles, bleibt pausiert');
      await page.click('#pause-lobby');
      await page.waitForTimeout(800);
      const back = await page.evaluate(() => ({ state: buildDuel.state, game: buildDuel.game, menu: buildDuel.menus.screen, lobby: buildDuel.lobby.visible, overlay: !document.getElementById('play-overlay').hidden, hud: !!document.querySelector('.hud') }));
      ctx.assert(back.state === 'lobby' && back.game === null && back.menu === 'lobby' && back.lobby && !back.overlay && !back.hud, `zurück in der Lobby: ${JSON.stringify(back)}`);
      await shot(ctx, page, '68-zurueck-in-der-lobby');
      // XP-Balken: Fortschritt kommt an
      const xp = await page.evaluate(() => ({ xp: buildDuel.progress.xp, pieces: buildDuel.progress.piecesBuilt }));
      ctx.log(`Fortschritt: ${JSON.stringify(xp)}`);
      ctx.assert(xp.pieces >= 9, `gebaute Bauteile gezählt: ${xp.pieces}`);
      await lobbyPage.close();
      lobbyPage = null;
    },
  },
];

module.exports = { LOBBY_CHECKS };
