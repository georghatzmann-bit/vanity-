// PC-Check & Video-Settings-Finder.
// Liest die Hardware (nur lesend), zeigt drei passende Grafik-Vorschläge, eine genaue Vorschau
// (Einstellung | jetzt | neu | warum) und übernimmt den Vorschlag mit Backup in GameUserSettings.ini.

import {
  fpsExplain, fpsLabel, fmtMs, frameTimeMs, timelineTicks, groupRows, countWrites, meterLevel, estText, estFightText,
} from '../lib/pccheck-view.mjs';

const DRIVER_LINKS = {
  nvidia: ['NVIDIA-Treiber laden', 'https://www.nvidia.com/de-de/drivers/'],
  amd: ['AMD-Treiber laden', 'https://www.amd.com/de/support/download/drivers.html'],
  intel: ['Intel-Treiber laden', 'https://www.intel.de/content/www/de/de/support/detect.html'],
};

let session = null; // aktuelle Anzeige; nach unmount werden späte Antworten verworfen

export default {
  async mount(root, env) {
    const ui = env.ui;
    const { h, icon } = ui;
    const me = { offs: [] };
    session = me;
    const alive = () => session === me;

    const st = {
      result: null, // Ergebnis von pccheck.scan
      preset: null, // gewählter Vorschlag
      fps: {}, // gewählte FPS-Grenze je Vorschlag
      preview: null,
      previewError: null,
      previewLoading: false,
      skip: new Set(), // abgewählte Zeilen
      onlyChanges: true,
      applied: null, // letztes Ergebnis von pccheck.apply
      active: null, // aktives Profil (für "Auch im Profil speichern")
      savedTo: null, // Profil, in das schon gespeichert wurde
      fortnite: null,
    };
    let previewSeq = 0;

    const hwBox = h('div.pc-hw');
    const presetBox = h('div.pc-presets');
    const fpsBox = h('div.pc-fps');
    const diffBox = h('div.pc-diff');
    root.append(hwBox, presetBox, fpsBox, diffBox);

    const presetById = (id) => st.result?.presets?.find((p) => p.id === id) || null;
    const curPreset = () => presetById(st.preset);
    const curCap = () => {
      const p = curPreset();
      if (!p) return null;
      return st.fps[p.id] ?? p.fps.cap;
    };

    // ------------------------------------------------------------ Hardware lesen

    async function scan(fresh) {
      ui.mount(hwBox, h('div.loading', h('div.pc-loading', ui.spinner(),
        h('div', h('strong', fresh ? 'HELIX prüft deinen PC neu …' : 'HELIX prüft deinen PC …'),
          h('p.hint', 'Prozessor, Grafikkarte, Arbeitsspeicher und Monitor werden nur ausgelesen. Das dauert ein paar Sekunden.')))));
      ui.clear(presetBox); ui.clear(fpsBox); ui.clear(diffBox);
      let r;
      try {
        r = await env.call('pccheck.scan', { fresh: !!fresh });
      } catch (e) {
        if (!alive()) return;
        renderScanError(e);
        ui.toast('Die Hardware konnte nicht gelesen werden.', 'err');
        return;
      }
      if (!alive()) return;
      if (r?.unsupported) { renderUnsupported(r.message); return; }
      st.result = r;
      if (!presetById(st.preset)) st.preset = r.recommended;
      renderHardware();
      renderPresets();
      renderFps();
      if (fresh) ui.toast('PC geprüft. Die Vorschläge sind aktuell.');
      await loadPreview();
    }

    function renderUnsupported(message) {
      ui.mount(hwBox, ui.emptyState({
        title: 'Der PC-Check läuft nur unter Windows',
        text: `${message || 'HELIX liest die Hardware mit Windows-Bordmitteln aus. Auf diesem System geht das nicht.'} Starte HELIX auf deinem Windows-PC – dann siehst du hier deine Hardware und die passenden Grafik-Einstellungen für Fortnite.`,
      }));
    }

    function renderScanError(e) {
      ui.mount(hwBox, ui.emptyState({
        title: 'Die Hardware konnte nicht gelesen werden',
        text: `${e?.message || 'Unbekannter Fehler.'} Versuch es noch einmal – manchmal braucht Windows beim ersten Mal etwas länger.`,
        action: ui.button('Erneut versuchen', { variant: 'primary', iconName: 'refresh', onClick: () => scan(true) }),
      }));
    }

    // ------------------------------------------------------------ Hardware-Karten

    function meter(level, label) {
      return h('div.pc-meter', { role: 'img', 'aria-label': `Stufe ${level} von 4: ${label}` },
        [1, 2, 3, 4].map((i) => h(`span${i <= level ? '.on' : ''}`)));
    }

    function tipLine(tip) {
      const extra = [];
      if (tip.kind === 'driver' && DRIVER_LINKS[tip.vendor]) {
        const [label, url] = DRIVER_LINKS[tip.vendor];
        extra.push(ui.button(label, {
          small: true, variant: 'ghost', iconName: 'download',
          onClick: async () => {
            try { await env.call('app.openUrl', { url }); ui.toast('Die Treiber-Seite wurde im Browser geöffnet.', 'info'); } catch (e) { ui.showError(e); }
          },
        }));
      }
      if (tip.kind === 'hz') {
        extra.push(ui.button('Anzeige-Einstellungen öffnen', {
          small: true, variant: 'ghost', iconName: 'settings',
          onClick: async () => {
            try { await env.call('app.openWindowsSettings', { uri: 'ms-settings:display-advanced' }); ui.toast('Windows-Anzeige geöffnet. Wähle dort die höchste Bildwiederholrate.', 'info'); } catch (e) { ui.showError(e); }
          },
        }));
      }
      return h('div.pc-tip', icon('info', 16), h('div', h('span', tip.text), extra.length ? h('div.pc-tip-actions', extra) : null));
    }

    function hwCard(kind, title, name, rating, level) {
      return h('article.pc-hw-card',
        h('div.pc-hw-head', h('span.pc-hw-kind', title), ui.badge(rating.label || 'unbekannt', rating.tone || '')),
        h('strong.pc-hw-name', { title: name || '' }, name || 'nicht erkannt'),
        meter(level, rating.label || 'unbekannt'),
        rating.details ? h('p.hint.pc-hw-details', rating.details) : null,
        h('p.pc-hw-text', rating.text || ''),
        (rating.tips || []).map(tipLine));
    }

    function renderHardware() {
      const r = st.result;
      const hw = r.hardware || {};
      const rt = r.ratings || {};
      const d = hw.display;
      const cards = h('div.pc-hw-grid',
        hwCard('cpu', 'Prozessor', hw.cpu?.short || hw.cpu?.name, rt.cpu || {}, meterLevel('cpu', rt.cpu)),
        hwCard('gpu', 'Grafikkarte', hw.gpu?.short || hw.gpu?.name, rt.gpu || {}, meterLevel('gpu', rt.gpu)),
        hwCard('ram', 'Arbeitsspeicher', hw.ram?.gb ? `${hw.ram.gb} GB${hw.ram.type ? ' ' + hw.ram.type : ''}` : null, rt.ram || {}, meterLevel('ram', rt.ram, { gb: hw.ram?.gb })),
        hwCard('display', 'Monitor', d ? `${d.width} × ${d.height}${d.hz ? ` · ${d.hz} Hz` : ''}` : null, rt.display || {}, meterLevel('display', rt.display, { hz: d?.hz })));
      const perf = r.perf || {};
      const verdict = h('div.pc-verdict',
        h('div.pc-verdict-main',
          h('span.hint', 'Dein PC für Fortnite'),
          h('div.pc-verdict-title', h('strong', perf.label || 'unbekannt'), ui.badge(`Klasse ${perf.cls || '?'} von 4`, 'accent'))),
        h('div.grow', h('p', perf.text || ''), h('p.hint', perf.limiterText || '')));
      const warn = (r.warnings || []).length
        ? h('div.callout.warn', icon('warn'), h('div', h('strong', 'Nicht alles wurde erkannt'), (r.warnings || []).map((w) => h('p.hint', w))))
        : null;
      const head = h('div.toolbar',
        ui.button('PC neu prüfen', { iconName: 'refresh', onClick: () => scan(true) }),
        h('p.hint.grow', 'Liest nur aus – an deinem PC wird nichts verändert.'),
        r.at ? h('span.hint', `geprüft ${ui.fmtAgo(r.at)}`) : null);
      ui.mount(hwBox, ui.section('Dein PC', 'So schätzt HELIX deine Teile für Fortnite ein.', head, warn, verdict, cards,
        hw.os?.caption ? h('p.hint.pc-os', `${hw.os.caption}${hw.os.build ? ` (Build ${hw.os.build})` : ''}`) : null));
    }

    // ------------------------------------------------------------ Vorschläge

    function presetCard(p) {
      const selected = p.id === st.preset;
      return h(`button.pc-preset${selected ? '.selected' : ''}${p.recommended ? '.recommended' : ''}`, {
        type: 'button', 'aria-pressed': String(selected),
        onclick: () => selectPreset(p.id),
      },
      h('div.pc-preset-head', h('h3', p.title), p.recommended ? ui.badge('Empfohlen', 'accent') : null, selected ? ui.badge('ausgewählt', 'ok') : null),
      h('p.hint', p.desc),
      h('dl.pc-preset-facts',
        h('dt', 'Bilder pro Sekunde'), h('dd', estText(p.est)),
        h('dt', 'Grafik'), h('dd', p.quality),
        h('dt', 'Modus'), h('dd', p.mode)),
      h('p.hint', estFightText(p.est) ? `Grobe Schätzung, ${estFightText(p.est)}.` : 'Grobe Schätzung.'),
      (p.warnings || []).map((w) => h('div.pc-preset-warn', ui.badge('Achtung', 'warn'), h('span.hint', w))));
    }

    function renderPresets() {
      const r = st.result;
      const rec = presetById(r.recommended);
      ui.mount(presetBox, ui.section('Vorschläge für deinen PC', 'Wähle einen Vorschlag. Unten siehst du genau, was sich in Fortnite ändern würde.',
        h('div.pc-preset-grid', r.presets.map(presetCard)),
        h('div.callout.info', icon('sparkle'), h('div',
          h('strong', `Empfehlung: ${rec?.title || '–'}`),
          h('p.hint', r.recommendReason || ''),
          r.competitiveTip ? h('p.hint', r.competitiveTip) : null))));
    }

    function selectPreset(id) {
      if (id === st.preset) return;
      st.preset = id;
      st.skip = new Set();
      st.applied = null;
      renderPresets();
      renderFps();
      loadPreview();
    }

    // ------------------------------------------------------------ FPS-Grenze

    function timeline(label, sub, rate, cls) {
      const ticks = timelineTicks(rate, 50, 120);
      return h('div.pc-tl-row',
        h('div.pc-tl-label', h('span', label), h('span.hint', sub)),
        h(`div.pc-tl-track.${cls}`, { 'aria-hidden': 'true' }, ticks.map((x) => h('i', { style: { left: `${x}%` } }))));
    }

    function renderFps() {
      const p = curPreset();
      if (!p) { ui.clear(fpsBox); return; }
      const hz = st.result.hz || 60;
      const cap = curCap();
      const opts = p.fpsOptions || [60, hz, 0];
      const seg = h('div.segmented', { role: 'radiogroup', 'aria-label': 'FPS-Grenze' }, opts.map((v) => h(`button.seg${v === cap ? '.active' : ''}`, {
        type: 'button', role: 'radio', 'aria-checked': String(v === cap),
        onclick: () => {
          if (v === cap) return;
          st.fps[p.id] = v;
          st.applied = null;
          renderFps();
          loadPreview();
        },
      }, fpsLabel(v), v === p.fps.recommendedCap ? h('span.pc-seg-rec', ' · empfohlen') : null)));
      const ex = fpsExplain({ cap, hz, est: p.est });
      const gameSub = cap > 0
        ? `${fpsLabel(cap)} Grenze · alle ${fmtMs(frameTimeMs(cap))} ein Bild`
        : `ca. ${Math.round(ex.gameRate)} FPS · alle ${fmtMs(ex.gameMs)} ein Bild`;
      ui.mount(fpsBox, ui.section('FPS-Grenze', 'FPS = Bilder pro Sekunde. Die Grenze legt fest, wie viele Bilder Fortnite höchstens berechnet.',
        seg,
        h('p.hint.pc-seg-hint', `„empfohlen“ passt zu deinem PC und deinem ${hz}-Hz-Monitor. „Unbegrenzt“ heißt: so viele Bilder, wie der PC schafft.`),
        h(`div.pc-fps-explain.callout.${ex.tone === 'warn' ? 'warn' : ex.tone === 'ok' ? 'ok' : 'info'}`,
          icon(ex.tone === 'warn' ? 'warn' : 'clock'),
          h('div.grow',
            h('strong', ex.title),
            ex.lines.map((l) => h('p.hint', l)),
            h('div.pc-tl', { role: 'img', 'aria-label': `Zeitleiste über 50 Millisekunden: Monitor ${hz} Hz, Fortnite ${Math.round(ex.gameRate)} Bilder pro Sekunde` },
              timeline('Monitor', `${hz} Hz · alle ${fmtMs(ex.monitorMs)} ein Bild`, hz, 'monitor'),
              timeline('Fortnite', gameSub, ex.gameRate, 'game'),
              h('p.hint.pc-tl-legend', 'Jeder Strich ist ein Bild. Gezeigt sind 50 Millisekunden (eine Zwanzigstelsekunde).'))))));
    }

    // ------------------------------------------------------------ Vorschau

    async function loadPreview() {
      const p = curPreset();
      if (!p) return;
      const seq = ++previewSeq;
      st.previewLoading = true;
      st.previewError = null;
      renderDiff();
      let pv = null;
      let err = null;
      try {
        pv = await env.call('pccheck.preview', { preset: p.id, fpsCap: curCap() });
      } catch (e) { err = e; }
      if (!alive() || seq !== previewSeq) return;
      st.previewLoading = false;
      st.preview = pv;
      st.previewError = err;
      if (pv?.fortnite) st.fortnite = pv.fortnite;
      if (err && !['NO_FILE', 'NO_FORTNITE', 'NOT_WINDOWS'].includes(err.code)) ui.toast(`Vorschau nicht möglich: ${err.message}`, 'err');
      renderDiff();
    }

    async function retryPreview() {
      await loadPreview();
      if (!alive()) return;
      if (!st.previewError) ui.toast('Gefunden. Die Vorschau ist jetzt da.');
      else if (['NO_FILE', 'NO_FORTNITE'].includes(st.previewError.code)) ui.toast('Noch nicht gefunden.', 'warn');
    }

    function fileProblem(e) {
      if (e.code === 'NO_FORTNITE') {
        return h('div.callout.err', icon('folder'), h('div',
          h('strong', 'Der Fortnite-Ordner wurde nicht gefunden'),
          h('p.hint', 'HELIX braucht deinen Fortnite-Einstellungsordner. Starte Fortnite einmal oder wähle den Ordner bei den Settings-Profilen selbst aus.'),
          h('div.row', ui.button('Zu den Settings-Profilen', { small: true, variant: 'primary', iconName: 'folder', onClick: () => env.nav.go('profiles') }),
            ui.button('Erneut prüfen', { small: true, iconName: 'refresh', onClick: retryPreview }))));
      }
      if (e.code === 'NO_FILE') {
        return h('div.callout.warn', icon('file'), h('div',
          h('strong', 'Die Grafik-Datei fehlt noch'),
          h('p.hint', 'Fortnite legt GameUserSettings.ini (die Datei mit Auflösung, FPS und Grafik) erst beim ersten Spielstart an. Starte Fortnite einmal, schließe es wieder und prüfe dann erneut.'),
          h('div.row', ui.button('Erneut prüfen', { small: true, iconName: 'refresh', onClick: retryPreview }))));
      }
      if (e.code === 'NOT_WINDOWS') {
        return h('div.callout.info', icon('info'), h('div', h('strong', 'Nur unter Windows'), h('p.hint', e.message)));
      }
      return h('div.callout.err', icon('warn'), h('div',
        h('strong', 'Die Vorschau hat nicht geklappt'),
        h('p.hint', e.message || 'Unbekannter Fehler.'),
        h('div.row', ui.button('Erneut versuchen', { small: true, iconName: 'refresh', onClick: retryPreview }))));
    }

    function fortniteBox() {
      const fn = st.fortnite;
      if (!fn || fn.unsupported) return null;
      if (!fn.running) {
        return h('div.callout.ok', icon('check'), h('div', h('strong', 'Fortnite ist geschlossen'), h('p.hint', 'Die Einstellungen können sicher geschrieben werden.')));
      }
      return h('div.callout.warn', icon('warn'), h('div',
        h('strong', 'Fortnite läuft noch'),
        h('p.hint', 'Solange Fortnite offen ist, würde es die Einstellungen beim Beenden wieder überschreiben. Schließe Fortnite zuerst.'),
        h('div.row',
          ui.button('Fortnite schließen', { variant: 'primary', small: true, iconName: 'power', onClick: closeFortnite }),
          ui.button('Erneut prüfen', { small: true, iconName: 'refresh', onClick: recheckFortnite }))));
    }

    async function recheckFortnite() {
      try {
        st.fortnite = await env.call('core.fortniteStatus');
        if (!alive()) return;
        ui.toast(st.fortnite.running ? 'Fortnite läuft noch.' : 'Fortnite ist geschlossen.', st.fortnite.running ? 'warn' : 'ok');
        renderDiff();
      } catch (e) { ui.showError(e); }
    }

    async function closeFortnite() {
      try {
        const r = await env.call('core.fortniteClose', { force: false });
        if (r && r.closed === false) {
          const ok = await ui.confirmDialog({
            title: 'Fortnite reagiert nicht',
            text: 'Fortnite hat sich nicht normal beendet. Sofort beenden? Was im Spiel nicht gespeichert ist, geht dabei verloren.',
            confirmLabel: 'Sofort beenden', danger: true,
          });
          if (ok) await env.call('core.fortniteClose', { force: true });
        }
        st.fortnite = await env.call('core.fortniteStatus');
        if (!alive()) return;
        ui.toast(st.fortnite.running ? 'Fortnite läuft immer noch.' : 'Fortnite wurde geschlossen.', st.fortnite.running ? 'warn' : 'ok');
        renderDiff();
      } catch (e) { ui.showError(e); }
    }

    function diffTable(rows) {
      const groups = groupRows(st.onlyChanges ? rows.filter((r) => r.changed) : rows);
      const body = [];
      for (const g of groups) {
        body.push(h('tr.pc-group-row', h('td', { colspan: '5' }, g.group)));
        for (const r of g.rows) {
          const checked = r.changed && !st.skip.has(r.id);
          const box = h('input', {
            type: 'checkbox', checked, disabled: !r.changed,
            'aria-label': r.changed ? `${r.label} übernehmen` : `${r.label} ist schon richtig`,
            onchange: (e) => {
              if (e.target.checked) st.skip.delete(r.id); else st.skip.add(r.id);
              renderDiff();
            },
          });
          const keys = (r.raw || []).map((x) => x.key).join(', ');
          body.push(h(`tr${r.changed ? '' : '.same'}${r.changed && st.skip.has(r.id) ? '.skipped' : ''}`,
            h('td.pc-check', box),
            h('td.pc-name', h('span', r.label), keys ? h('span.hint.mono', { title: 'Eintrag in GameUserSettings.ini' }, keys) : null),
            h('td.pc-from', r.from ?? 'nicht gesetzt'),
            h('td.pc-to', r.changed ? h('strong', r.to ?? '–') : h('span', r.to ?? '–'), r.changed ? null : h('span.pc-same', ui.badge('schon so', ''))),
            h('td.pc-why', h('span.hint', r.why || ''), r.note ? h('div.pc-note', ui.badge('Hinweis', 'warn'), h('span.hint', r.note)) : null)));
        }
      }
      if (!body.length) {
        return ui.emptyState({ title: 'Alles schon so eingestellt', text: 'Deine Fortnite-Einstellungen passen bereits zu diesem Vorschlag. Es gibt nichts zu ändern.' });
      }
      return h('div.table-wrap', h('table.table.pc-table',
        h('thead', h('tr', h('th', { 'aria-label': 'Übernehmen' }, ''), h('th', 'Einstellung'), h('th', 'jetzt'), h('th', 'neu'), h('th', 'warum'))),
        h('tbody', body)));
    }

    function renderDiff() {
      const p = curPreset();
      if (!p) { ui.clear(diffBox); return; }
      const hint = 'Links deine jetzige Einstellung, rechts der Vorschlag. Nimm den Haken raus, wenn du etwas behalten willst.';
      if (st.previewLoading && !st.preview) {
        ui.mount(diffBox, ui.section('Was sich ändert', hint, h('div.loading', ui.spinner())));
        return;
      }
      if (st.previewError) {
        ui.mount(diffBox, ui.section('Was sich ändert', hint, fileProblem(st.previewError)));
        return;
      }
      const pv = st.preview;
      if (!pv) { ui.clear(diffBox); return; }
      const rows = pv.rows || [];
      const changed = rows.filter((r) => r.changed).length;
      const writes = countWrites(rows, st.skip);
      const toolbar = h('div.toolbar.pc-diff-bar',
        ui.badge(changed === 1 ? '1 Änderung' : `${changed} Änderungen`, changed ? 'accent' : 'ok'),
        ui.badge(`${rows.length - changed} schon richtig`, ''),
        st.skip.size ? ui.badge(`${[...st.skip].filter((id) => rows.some((r) => r.id === id && r.changed)).length} abgewählt`, 'warn') : null,
        h('span.grow'),
        h('div.pc-only', ui.toggle({
          label: 'Nur Änderungen zeigen',
          hint: 'Aus: Du siehst auch alles, was schon passt.',
          checked: st.onlyChanges,
          onChange: (v) => { st.onlyChanges = v; renderDiff(); },
        })));
      const ro = pv.readOnly
        ? h('div.callout.info', icon('lock'), h('div', h('strong', 'Die Datei ist schreibgeschützt'),
          h('p.hint', 'Der Schreibschutz (Fortnite darf die Datei nicht ändern) bleibt danach bestehen. HELIX schreibt den Vorschlag trotzdem hinein.')))
        : null;
      const applyBtn = ui.button('Jetzt in Fortnite übernehmen', {
        variant: 'primary', iconName: 'check', disabled: !writes || st.previewLoading, onClick: apply,
      });
      const bar = h('div.pc-apply',
        h('div.grow',
          h('strong', writes ? (writes === 1 ? '1 Einstellung wird geändert' : `${writes} Einstellungen werden geändert`) : 'Nichts zu ändern'),
          h('p.hint', 'Vorher macht HELIX automatisch ein Backup. Du findest es bei den Settings-Profilen unter „Zeitmaschine“.')),
        applyBtn);
      ui.mount(diffBox, ui.section(`Was sich ändert: ${p.title}`, hint,
        fortniteBox(), ro, toolbar, diffTable(rows), doneBox(),
        h('p.hint.pc-file', `Datei: ${pv.rel || 'GameUserSettings.ini'} · Nur diese eine Datei wird geändert.`), bar));
    }

    // ------------------------------------------------------------ Übernehmen

    async function apply() {
      const p = curPreset();
      if (!p) return;
      let res;
      try {
        res = await env.call('pccheck.apply', { preset: p.id, fpsCap: curCap(), skip: [...st.skip] });
      } catch (e) {
        if (!alive()) return;
        if (e.code === 'FORTNITE_RUNNING') {
          st.fortnite = { running: true, processes: e.details?.processes || [] };
          ui.toast('Fortnite läuft noch. Schließe es zuerst – dann klappt das Übernehmen.', 'warn', { timeout: 6000 });
          renderDiff();
          return;
        }
        if (e.code === 'NO_FILE' || e.code === 'NO_FORTNITE') {
          st.previewError = e;
          ui.toast(e.message, 'warn', { timeout: 6000 });
          renderDiff();
          return;
        }
        if (e.code === 'BUSY') { ui.toast('HELIX ist gerade mit etwas anderem beschäftigt. Versuch es gleich noch einmal.', 'warn'); return; }
        ui.showError(e, 'Übernehmen fehlgeschlagen');
        return;
      }
      if (!alive()) return;
      if (res.nothing) {
        ui.toast('Alles ist schon so eingestellt. Es wurde nichts geändert.', 'info');
        await loadPreview();
        return;
      }
      st.applied = res;
      st.savedTo = null;
      st.skip = new Set();
      st.active = (await env.call('core.status').catch(() => null))?.active || null;
      if (!alive()) return;
      ui.toast(`Fertig: ${res.applied === 1 ? '1 Einstellung' : `${res.applied} Einstellungen`} übernommen. Ein Backup ist gespeichert.`);
      env.refreshStatus?.();
      await loadPreview();
    }

    function doneBox() {
      const a = st.applied;
      if (!a) return null;
      const active = st.active;
      return h('div.callout.ok.pc-done', icon('check'), h('div.grow',
        h('strong', `„${a.title}“ ist jetzt in Fortnite eingestellt`),
        h('p.hint', `${a.applied === 1 ? '1 Einstellung wurde' : `${a.applied} Einstellungen wurden`} geändert. Starte Fortnite – die neuen Einstellungen gelten sofort.`),
        h('p.hint', 'Das Backup davor findest du bei den Settings-Profilen unter „Zeitmaschine“. Von dort kannst du alles mit einem Klick zurückholen.'),
        active && st.savedTo === active.id
          ? h('div.pc-done-actions', ui.badge(`im Profil „${active.name}“ gespeichert`, 'ok'),
            h('p.hint', 'Das Profil bringt diese Grafik beim nächsten Anwenden mit.'))
          : active
            ? h('div.pc-done-actions',
              ui.button(`Auch im aktiven Profil „${active.name}“ speichern`, {
                small: true, variant: 'primary', iconName: 'download', onClick: () => saveToProfile(active),
              }),
              h('p.hint', 'Dann bringt das Profil diese Grafik beim nächsten Anwenden mit. Gespeichert wird der jetzige Stand deiner Fortnite-Einstellungen.'))
          : h('div.pc-done-actions',
            h('p.hint', 'Tipp: Bei den Settings-Profilen kannst du diese Einstellungen als eigenes Profil speichern.')),
        h('div.row', ui.button('Zu den Settings-Profilen', { small: true, variant: 'ghost', iconName: 'sparkle', onClick: () => env.nav.go('profiles') }))));
    }

    async function saveToProfile(active) {
      try {
        await env.call('profiles.update', { id: active.id });
        ui.toast(`Profil „${active.name}“ wurde mit den neuen Einstellungen gespeichert.`);
        env.refreshStatus?.();
        if (!alive()) return;
        st.savedTo = active.id;
        renderDiff();
      } catch (e) {
        ui.showError(e, 'Profil nicht gespeichert');
      }
    }

    // ------------------------------------------------------------ Start

    me.offs.push(env.on('fortnite.state', (fn) => {
      if (!alive() || !fn) return;
      st.fortnite = fn;
      if (st.preview) renderDiff();
    }));

    // Nicht auf den Scan warten: PowerShell braucht ein paar Sekunden. So bleiben „Cockpit“ und Esc
    // sofort bedienbar; späte Antworten nach dem Verlassen verwirft alive().
    scan(false).catch((e) => {
      if (!alive()) return;
      console.error(e);
      renderScanError(e);
    });
  },

  unmount() {
    if (session) for (const off of session.offs) { try { off(); } catch { /* egal */ } }
    session = null;
  },
};
