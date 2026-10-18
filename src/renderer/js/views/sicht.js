// Sicht-Presets: fertige Einstellungen für bessere Sicht (Sturm, Nacht, helle Karte, Turnier)
// plus eigener Feinschliff für Helligkeit und Anzeige-Kontrast.
// Ablauf immer: Vorschau (was ändert sich?) -> Anwenden (mit Sicherung) -> Rückmeldung.

import {
  PRESETS, KEYS, KEY_IDS, BRIGHTNESS, UI_CONTRAST, valuesFromIni, renderMode, valueText, rawText,
  presetValues, toChanges, customValues, matchesValues, activePreset, describeValues, percentToGamma,
} from '../lib/sicht-presets.mjs';

let cleanup = [];

export default {
  async mount(root, env) {
    const ui = env.ui;
    const { h, icon } = ui;
    let cur = null; // Antwort von sicht.current
    let values = {}; // fachliche Werte jetzt
    let originalValues = null;
    let custom = { brightness: BRIGHTNESS.def, uiContrast: UI_CONTRAST.def };
    let customTouched = false;
    let alive = true;

    const statusBox = h('div.sicht-status');
    const resultBox = h('div.sicht-result');
    const main = h('div.sicht-main');
    root.append(statusBox, resultBox, main);

    // ---------------- Laden ----------------
    async function load() {
      try {
        cur = await env.call('sicht.current');
      } catch (e) {
        cur = { found: false, reason: 'ERROR', message: e.message };
      }
      if (!alive) return;
      values = cur.found ? valuesFromIni(cur.raw) : {};
      originalValues = cur.original ? valuesFromIni(cur.original) : null;
      if (!customTouched && cur.found) {
        custom = {
          brightness: values.brightness ?? BRIGHTNESS.def,
          uiContrast: values.uiContrast ?? UI_CONTRAST.def,
        };
      }
      render();
    }

    function render() {
      renderStatus();
      if (!cur.found) {
        ui.mount(main, emptyView());
        return;
      }
      ui.mount(main, nowSection(), presetSection(), customSection(), cloudSection());
    }

    // ---------------- Status (Fortnite offen?) ----------------
    function renderStatus() {
      ui.clear(statusBox);
      const fn = cur?.fortnite || {};
      if (fn.running) statusBox.append(fortniteCallout(fn, load));
    }

    function fortniteCallout(fn, after) {
      return h('div.callout.warn', icon('warn'), h('div',
        h('strong', 'Fortnite läuft gerade'),
        h('p.hint', 'Solange Fortnite offen ist, kann HELIX nichts ändern – Fortnite würde die Datei beim Beenden wieder überschreiben. Die Vorschau geht trotzdem.'),
        h('div.row',
          ui.button('Fortnite schließen', {
            variant: 'primary', iconName: 'power', small: true,
            onClick: async () => {
              try {
                const r = await env.call('core.fortniteClose', { force: false });
                if (r && r.closed) ui.toast('Fortnite wurde geschlossen.');
                else ui.toast('Fortnite hat sich nicht beendet. Bitte schließe es im Spiel selbst.', 'warn');
              } catch (e) { ui.showError(e); }
              await after?.();
            },
          }),
          ui.button('Erneut prüfen', { small: true, iconName: 'refresh', onClick: async () => { await after?.(); ui.toast('Status aktualisiert.', 'info'); } }))));
    }

    function emptyView() {
      if (cur.reason === 'NO_FILE') {
        return ui.emptyState({
          title: 'Grafik-Datei nicht gefunden',
          text: 'HELIX braucht die Datei GameUserSettings.ini aus dem Fortnite-Ordner. Starte Fortnite einmal und schließe es wieder – dann legt Fortnite die Datei an.',
          action: ui.button('Erneut suchen', { iconName: 'refresh', onClick: async () => { await load(); ui.toast('Neu eingelesen.', 'info'); } }),
        });
      }
      return ui.emptyState({
        title: 'Fortnite-Ordner nicht gefunden',
        text: cur.message || 'HELIX hat den Fortnite-Einstellungsordner nicht gefunden. Starte Fortnite einmal oder wähle den Ordner bei den Settings-Profilen selbst aus.',
        action: h('div.row',
          ui.button('Ordner auswählen', { variant: 'primary', iconName: 'folder', onClick: () => env.nav.go('profiles') }),
          ui.button('Erneut suchen', { iconName: 'refresh', onClick: async () => { await load(); ui.toast('Neu eingelesen.', 'info'); } })),
      });
    }

    // ---------------- Werte jetzt ----------------
    function nowSection() {
      const mode = renderMode(cur.raw);
      const active = activePreset(values, { original: originalValues });
      const tiles = KEY_IDS.map((id) => h('div.sicht-tile',
        h('span.hint', KEYS[id].label),
        h('strong', valueText(id, values[id])),
        h('span.hint.sicht-tile-hint', KEYS[id].hint)));
      return ui.section('Deine Sicht-Werte jetzt', 'So steht es gerade in deiner Fortnite-Grafikdatei (GameUserSettings.ini).',
        h('div.sicht-meta',
          active ? ui.badge(`Aktiv: ${active.short || active.name}`, 'accent') : ui.badge('Kein Preset aktiv', ''),
          ui.badge(`Darstellung: ${mode.label}`, ''),
          cur.readOnly ? ui.badge('Datei schreibgeschützt', 'warn') : null),
        mode.id === 'performance'
          ? h('div.callout.info', icon('info'), h('div',
            h('strong', 'Du spielst im Leistungsmodus'),
            h('p.hint', 'Leistungsmodus = die schnelle Darstellung für schwächere PCs. Schatten, Nachbearbeitung und Gras sind dort schon aus oder wirken kaum. Spürbar sind vor allem Helligkeit und Anzeige-Kontrast.')))
          : null,
        h('div.sicht-tiles', tiles));
    }

    // ---------------- Presets ----------------
    function presetSection() {
      const active = activePreset(values, { original: originalValues });
      const cards = PRESETS.map((p) => {
        const vals = presetValues(p, { original: originalValues });
        const isActive = active?.id === p.id;
        const already = matchesValues(values, vals);
        return h(`article.sicht-card${isActive ? '.active' : ''}`,
          h('div.sicht-card-head',
            h('h3', p.name),
            isActive ? ui.badge('aktiv', 'accent') : already ? ui.badge('schon so eingestellt', 'ok') : null),
          h('p.sicht-wofuer', p.wofuer),
          h('ul.sicht-chips', describeValues(p.values).map((t) => h('li', t))),
          p.restoreOriginal
            ? h('p.hint', originalValues
              ? 'Grafikwerte von vorher sind gemerkt und kommen mit zurück.'
              : 'Noch kein Sicht-Preset benutzt – es werden nur Helligkeit und Anzeige-Kontrast zurückgesetzt.')
            : null,
          p.inGame?.length ? h('p.hint.sicht-ingame-note', icon('info', 14), ` Dazu ${p.inGame.length === 1 ? 'ein Schritt' : `${p.inGame.length} Schritte`} im Spiel`) : null,
          h('div.sicht-card-actions',
            ui.button('Vorschau & anwenden', { variant: isActive ? '' : 'primary', iconName: 'eye', onClick: () => previewFlow({ preset: p, values: vals }) })));
      });
      return ui.section('Presets', 'Ein Klick setzt mehrere Werte passend zur Situation. Vorher siehst du genau, was sich ändert.',
        h('div.sicht-grid', cards));
    }

    // ---------------- Eigener Wert ----------------
    function customSection() {
      const bVal = h('strong.sicht-slider-value');
      const bRaw = h('span.hint.mono');
      const cVal = h('strong.sicht-slider-value');
      const bRange = h('input.range.sicht-range', { type: 'range', min: BRIGHTNESS.min, max: BRIGHTNESS.max, step: 1, value: custom.brightness, 'aria-label': 'Helligkeit in Prozent' });
      const cRange = h('input.range.sicht-range', { type: 'range', min: 100, max: 150, step: 5, value: Math.round(custom.uiContrast * 100), 'aria-label': 'Anzeige-Kontrast' });
      const paint = () => {
        bVal.textContent = `${custom.brightness} %`;
        bRaw.textContent = `In der Datei: DisplayGamma ${percentToGamma(custom.brightness).toFixed(2)}`;
        cVal.textContent = custom.uiContrast.toFixed(2).replace('.', ',');
      };
      bRange.addEventListener('input', () => { custom.brightness = Number(bRange.value); customTouched = true; paint(); });
      cRange.addEventListener('input', () => { custom.uiContrast = Number(cRange.value) / 100; customTouched = true; paint(); });
      paint();
      return ui.section('Eigener Wert', 'Feinschliff von Hand. Gleicher Ablauf: erst Vorschau, dann anwenden.',
        h('div.sicht-slider',
          h('div.sicht-slider-top', h('label', 'Helligkeit'), bVal),
          bRange,
          h('p.hint', '100 % ist Fortnite-Standard. Für dunkle Ecken 110 bis 130 %. Über 140 % wirkt das Bild schnell grau.'),
          bRaw),
        h('div.sicht-slider',
          h('div.sicht-slider-top', h('label', 'Anzeige-Kontrast'), cVal),
          cRange,
          h('p.hint', 'Kontrast von Leben, Munition, Karte und Menüs. 1,00 ist Standard, 1,50 der stärkste Wert. Die Spielwelt ändert sich dadurch nicht.')),
        h('div.row',
          ui.button('Vorschau & anwenden', {
            variant: 'primary', iconName: 'eye',
            onClick: () => previewFlow({ preset: null, values: customValues(custom) }),
          }),
          ui.button('Auf jetzige Werte zurück', {
            iconName: 'refresh',
            onClick: () => {
              custom = { brightness: values.brightness ?? BRIGHTNESS.def, uiContrast: values.uiContrast ?? UI_CONTRAST.def };
              customTouched = false;
              bRange.value = custom.brightness;
              cRange.value = Math.round(custom.uiContrast * 100);
              paint();
              ui.toast('Regler stehen wieder auf deinen jetzigen Werten.', 'info');
            },
          }),
          h('span.hint', 'Tipp: Prüfe das Ergebnis mit den Testbildern im Monitor-Tuner.'),
          ui.button('Zum Monitor-Tuner', { small: true, variant: 'ghost', iconName: 'chevron', onClick: () => env.nav.go('monitor') })));
    }

    // ---------------- Cloud-Hinweis ----------------
    function cloudSection() {
      return h('div.callout.info', icon('info'), h('div',
        h('strong', 'Was HELIX hier nicht einstellen kann'),
        h('p.hint', 'Farbenblind-Modus, seine Stärke und die HUD-Größe speichert Fortnite in der Epic-Cloud deines Kontos (Cloud = Speicher auf Epic-Servern). Eine Änderung auf dem PC würde beim nächsten Einloggen überschrieben. Deshalb zeigt dir jedes Preset diese Schritte zum Einstellen im Spiel.')));
    }

    // ---------------- Vorschau & Anwenden ----------------
    async function previewFlow({ preset, values: target }) {
      const changes = toChanges(target);
      const name = preset ? preset.name : 'Eigene Werte';
      let prev;
      try {
        prev = await env.call('sicht.preview', { changes });
      } catch (e) { ui.showError(e, 'Vorschau nicht möglich'); return; }
      let fortnite = prev.fortnite || {};
      const changedCount = prev.changes.filter((c) => c.changed).length;
      const fnBox = h('div');
      let applyBtn = null;
      const paintFortnite = () => {
        ui.clear(fnBox);
        if (fortnite.running) {
          fnBox.append(fortniteCallout(fortnite, async () => {
            fortnite = await env.call('core.fortniteStatus').catch(() => fortnite);
            paintFortnite();
            load();
          }));
        }
        if (applyBtn) applyBtn.disabled = !!fortnite.running || changedCount === 0;
      };
      paintFortnite();
      const rows = prev.changes.map((c) => h(`tr${c.changed ? '' : '.same'}`,
        h('td', labelOf(c)),
        h('td', rawText(c.section, c.key, c.from)),
        h('td.accent-text', rawText(c.section, c.key, c.to)),
        h('td', c.changed ? ui.badge('ändert sich', 'accent') : ui.badge('bleibt gleich', ''))));
      const content = [
        fnBox,
        preset?.why ? h('p', preset.why) : h('p', 'Du setzt Helligkeit und Anzeige-Kontrast auf deine eigenen Werte.'),
        changedCount === 0
          ? h('div.callout.ok', icon('check'), h('div', h('strong', 'Schon eingestellt'), h('p.hint', 'Alle Werte stehen bereits so. Es gibt nichts zu ändern.')))
          : null,
        h('div.table-wrap', h('table.table.sicht-diff',
          h('thead', h('tr', h('th', 'Einstellung'), h('th', 'Jetzt'), h('th', 'Neu'), h('th', 'Status'))),
          h('tbody', rows))),
        prev.readOnly ? h('p.hint', 'Die Datei ist schreibgeschützt. HELIX schreibt die Werte trotzdem und setzt den Schutz danach wieder.') : null,
        preset?.inGame?.length ? inGameList(preset.inGame) : null,
        h('p.hint', 'Vorher legt HELIX automatisch eine Sicherung an. Du findest sie bei den Settings-Profilen unter „Zeitmaschine“.'),
      ];
      let result = null;
      const pending = ui.modal({
        title: preset ? `Sicht-Preset „${name}“` : 'Eigene Sicht-Werte',
        subtitle: 'Vorschau – noch wird nichts geändert.',
        wide: true,
        content: h('div', { dataset: { tool: 'sicht' } }, content),
        actions: [
          { label: 'Abbrechen', value: null },
          {
            label: changedCount ? `${changedCount} ${changedCount === 1 ? 'Wert' : 'Werte'} anwenden` : 'Nichts zu ändern',
            variant: 'primary', icon: 'check', value: 'applied', disabled: changedCount === 0,
            onClick: async () => {
              try {
                result = await env.call('sicht.apply', {
                  changes, presetId: preset ? preset.id : 'eigen', presetName: preset ? preset.name : '', presetShort: preset ? preset.short : '',
                });
                return true;
              } catch (e) {
                if (e.code === 'FORTNITE_RUNNING') {
                  fortnite = await env.call('core.fortniteStatus').catch(() => ({ running: true }));
                  paintFortnite();
                }
                ui.showError(e, 'Nicht angewendet');
                return false;
              }
            },
          },
        ],
      });
      requestAnimationFrame(() => {
        applyBtn = [...document.querySelectorAll('.modal .modal-actions .btn.primary')].pop() || null;
        paintFortnite();
      });
      const r = await pending;
      if (r !== 'applied' || !result) {
        ui.toast('Abgebrochen – nichts wurde geändert.', 'info');
        return;
      }
      const n = result.applied?.length || 0;
      ui.toast(n ? `${preset ? `Sicht-Preset „${name}“` : 'Eigene Sicht-Werte'} angewendet (${n} ${n === 1 ? 'Wert' : 'Werte'}).` : 'Alles war schon so eingestellt.');
      showResult(result, preset);
      customTouched = false;
      await load();
    }

    function labelOf(c) {
      const id = KEY_IDS.find((k) => KEYS[k].section === c.section && KEYS[k].key === c.key);
      return id ? KEYS[id].label : c.key;
    }

    function inGameList(steps) {
      return h('div.sicht-ingame',
        h('h4', 'Im Spiel einstellen'),
        h('p.hint', 'Diese Werte liegen in der Epic-Cloud. Stelle sie einmal in Fortnite selbst ein.'),
        h('ol.sicht-steps', steps.map((s) => h('li',
          h('strong', s.title),
          h('span.hint', s.text),
          h('span.hint', `Warum: ${s.why}`)))));
    }

    function showResult(result, preset) {
      ui.clear(resultBox);
      if (!result.backupId) return;
      const box = h('div.callout.ok', icon('check'), h('div.grow',
        h('strong', preset ? `„${preset.name}“ ist aktiv` : 'Eigene Werte sind aktiv'),
        h('p.hint', 'Starte Fortnite und probiere es aus. Gefällt es dir nicht, holst du mit einem Klick den Stand von vorher zurück.'),
        preset?.inGame?.length ? h('p.hint', `Denk an ${preset.inGame.length === 1 ? 'den Schritt' : 'die Schritte'} im Spiel: ${preset.inGame.map((s) => s.title).join(' · ')}`) : null,
        h('div.row',
          ui.button('Rückgängig machen', {
            small: true, iconName: 'refresh',
            onClick: async () => {
              try {
                const u = await env.call('backups.restore', { id: result.backupId });
                if (u.ok) ui.toast('Der Stand von vorher ist wieder da.');
                else ui.toast('Zurückholen nicht vollständig – bitte die Zeitmaschine prüfen.', 'warn');
                ui.clear(resultBox);
                env.refreshStatus?.();
                await load();
              } catch (e) { ui.showError(e); }
            },
          }),
          ui.button('Ausblenden', { small: true, variant: 'ghost', onClick: () => { ui.clear(resultBox); ui.toast('Hinweis ausgeblendet.', 'info'); } }))));
      resultBox.append(box);
    }

    const offFn = env.on('fortnite.state', () => { if (alive) load(); });
    cleanup = [offFn, () => { alive = false; }];

    ui.mount(main, h('div.loading', ui.spinner()));
    await load();
  },

  unmount() {
    for (const f of cleanup) { try { f(); } catch { /* egal */ } }
    cleanup = [];
  },
};
