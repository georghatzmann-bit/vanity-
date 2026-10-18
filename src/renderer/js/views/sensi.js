// Sensi-Kalibrierung: eigene Werte und eDPI, Aim-Test mit Empfehlung, Umrechner für andere Spiele, Verlauf.
// Der Aim-Test läuft komplett hier in der Oberfläche (Canvas). Gespeichert wird über sensi.* im Hauptprozess.
// Die Fortnite-Sensi stellt der Spieler selbst im Spiel ein (sie liegt in der Epic-Cloud des Kontos).

import * as SM from '../lib/sensi-math.mjs';
import { TestSession } from '../lib/sensi-session.mjs';
import { createArena, MODE_TEXT } from '../lib/sensi-arena.mjs';
import { sfx } from '../sound.js';

const TABS = [
  ['werte', 'Deine Sensi', 'settings'],
  ['test', 'Aim-Test', 'play'],
  ['umrechner', 'Umrechner', 'refresh'],
  ['verlauf', 'Verlauf', 'clock'],
];

const CONF = {
  hoch: ['Ergebnis klar', 'ok', 'Die Empfehlung ist ziemlich sicher.'],
  mittel: ['Ergebnis brauchbar', 'accent', 'Ein zweiter Test macht es sicherer.'],
  niedrig: ['Ergebnis unsicher', 'warn', 'Mach den Test am besten noch einmal, gern „Gründlich“.'],
};

let active = null;

export default {
  async mount(root, env) {
    active = createView(root, env);
    await active.start();
  },
  unmount() {
    active?.destroy();
    active = null;
  },
};

function createView(root, env) {
  const { h, icon } = env.ui;
  const ui = env.ui;
  const timers = new Set();
  let destroyed = false;

  let data = { settings: { ...SM.DEFAULT_SETTINGS }, saved: false, history: [] };
  let tab = 'werte';
  const cfg = { mode: 'sens', length: 'short', spread: 0.2, dpi2: '' };
  const conv = { dir: 'from', sens: '', dpi: '', targetDpi: '', fov: String(SM.PUBG_DEFAULT_FOV), game: 'valorant', value: '', gameDpi: '', fnDpi: '' };
  // Umrechner-Felder mit deinen Werten als Vorschlag. Sie folgen „Deine Sensi“, bis du sie selbst änderst.
  const CONV_FROM_SETTINGS = {
    sens: (s) => numText(s.sens), dpi: (s) => String(s.dpi), targetDpi: (s) => String(s.dpi),
    gameDpi: (s) => String(s.dpi), fnDpi: (s) => String(s.dpi),
  };
  const convEdited = new Set();
  let arena = null;
  let testSession = null;
  let abortNote = '';
  let outcome = null;
  let lastMode = null;
  const openDetails = new Set();

  const tabs = h('div.tabs', { role: 'tablist' });
  const body = h('div.sensi-body');
  root.append(tabs, body);

  const fmt0 = (v) => SM.fmtNum(v, 0);
  const pct = (v) => (Number.isFinite(v) ? `${fmt0(v)} %` : '–');

  // ---------------------------------------------------------------- Grundgerüst

  async function start() {
    ui.mount(body, h('div.loading', ui.spinner()));
    try {
      data = await env.call('sensi.state');
    } catch (e) {
      if (destroyed) return;
      ui.mount(body, h('div.callout.err', icon('warn'), h('div',
        h('strong', 'Deine Sensi-Daten konnten nicht geladen werden'),
        h('p.hint', e.message || String(e)),
        h('div.row', ui.button('Noch einmal versuchen', { iconName: 'refresh', small: true, onClick: start })))));
      return;
    }
    if (destroyed) return;
    tab = data.saved ? 'test' : 'werte';
    renderTabs();
    renderBody();
  }

  function setTab(id) {
    if (id === tab) return;
    if (arena) cancelTest();
    abortNote = '';
    tab = id;
    renderTabs();
    renderBody();
  }

  function renderTabs() {
    ui.clear(tabs);
    for (const [id, label, ic] of TABS) {
      tabs.appendChild(h(`button.tab${tab === id ? '.active' : ''}`, {
        type: 'button', role: 'tab', 'aria-selected': String(tab === id),
        onclick: () => setTab(id),
      }, icon(ic, 16), h('span', label), id === 'verlauf' && data.history.length ? h('span.badge', String(data.history.length)) : null));
    }
  }

  function renderBody({ keepScroll = false } = {}) {
    if (destroyed) return;
    const scroller = body.parentElement;
    const top = scroller ? scroller.scrollTop : 0;
    const fn = { werte: renderWerte, test: renderTest, umrechner: renderUmrechner, verlauf: renderVerlauf }[tab];
    ui.mount(body, fn());
    if (scroller) scroller.scrollTop = keepScroll ? top : 0;
  }

  function later(fn, ms) {
    const t = setTimeout(() => { timers.delete(t); if (!destroyed) fn(); }, ms);
    timers.add(t);
    return t;
  }

  async function saveSettings(settings, message) {
    try {
      const r = await env.call('sensi.saveSettings', { settings });
      data.settings = r.settings;
      data.saved = true;
      ui.toast(message || `Gespeichert: ${SM.fmtSens(r.settings.sens)} % bei ${r.settings.dpi} DPI (eDPI ${fmt0(SM.edpi(r.settings.dpi, r.settings.sens))}).`);
      return true;
    } catch (e) {
      ui.showError(e, 'Nicht gespeichert');
      return false;
    }
  }

  // ---------------------------------------------------------------- Deine Sensi

  function numText(v) {
    if (!Number.isFinite(v)) return '';
    return Number.isInteger(v) ? String(v) : SM.fmtNum(v, Math.abs(v * 10 - Math.round(v * 10)) < 1e-6 ? 1 : 2);
  }

  function renderWerte() {
    const s = data.settings;
    const FIELDS = [
      ['dpi', 'Maus-DPI', 'z. B. 800'],
      ['sens', 'Sensi X-Achse (%)', 'z. B. 6,5'],
      ['targeting', 'Zielen (%)', 'z. B. 45'],
      ['scope', 'Zielfernrohr (%)', 'z. B. 45'],
    ];
    const inputs = {};
    const errs = {};
    const liveBox = h('div.sensi-live');
    const howTo = h('div');

    const read = () => {
      const raw = {};
      for (const [k] of FIELDS) raw[k] = inputs[k].value;
      return SM.validateSettings(raw);
    };
    const refresh = () => {
      const v = read();
      for (const [k] of FIELDS) {
        const msg = v.errors[k] || '';
        errs[k].textContent = msg;
        inputs[k].classList.toggle('invalid', !!msg);
      }
      ui.mount(liveBox, liveValues(v.ok ? v.values : null));
      ui.mount(howTo, howToBox(v.ok ? v.values : s));
    };
    let saving = null;
    let intro = null;
    let saveRow = null;
    const save = async () => {
      while (saving) await saving; // erst fertig speichern lassen, dann mit dem neuen Stand vergleichen
      const v = read();
      if (!v.ok) return;
      const same = Object.keys(v.values).every((k) => v.values[k] === data.settings[k]);
      if (same && data.saved) return;
      const first = !data.saved;
      saving = saveSettings(v.values);
      const ok = await saving;
      saving = null;
      if (ok && first) { intro?.remove(); saveRow?.remove(); }
    };

    const form = h('div.sensi-form', FIELDS.map(([k, label, ph]) => {
      const id = `sensi-${k}`;
      inputs[k] = h('input.input', { id, type: 'text', inputmode: k === 'dpi' ? 'numeric' : 'decimal', value: numText(s[k]), placeholder: ph, autocomplete: 'off', spellcheck: 'false' });
      inputs[k].addEventListener('input', refresh);
      inputs[k].addEventListener('change', save);
      inputs[k].addEventListener('keydown', (e) => { if (e.key === 'Enter') inputs[k].blur(); });
      errs[k] = h('span.sensi-err', { role: 'alert' });
      return h('div.field', h('label', { for: id }, label), inputs[k], errs[k]);
    }));
    const where = ui.more('Wo finde ich das?',
      'Maus-DPI: in der Software deiner Maus, oft 400, 800 oder 1600.',
      'Sensi X-Achse: deine normale Sensi für links und rechts.',
      'Zielen: mit der rechten Maustaste. Zielfernrohr: z. B. beim Scharfschützengewehr. Beides in Prozent deiner Sensi.',
      'Gespeichert wird, sobald du ein Feld verlässt. Komma oder Punkt ist egal.');

    intro = data.saved ? null : h('div.callout.info', icon('info'), h('div',
      h('strong', 'Trag zuerst deine eigenen Werte ein'),
      h('p.hint', 'Bis dahin rechnet HELIX mit Beispielwerten (800 DPI, 6,5 %).')));
    // Spielt jemand genau mit den Beispielwerten, ändert sich kein Feld – dann speichert dieser Knopf.
    saveRow = data.saved ? null : h('div.row.sensi-gap',
      ui.button('Diese Werte speichern', { variant: 'primary', iconName: 'check', onClick: save }),
      h('span.hint', 'Stimmen die Werte schon? Dann hier speichern.'));

    refresh();
    return [
      intro,
      h('div.sensi-grid.sensi-werte',
        h('div.sensi-a-form', ui.section('Deine Werte', 'Aus Fortnite („Maus und Tastatur“) und deiner Maus-Software.', form, saveRow, where)),
        h('div.sensi-a-live', liveBox),
        h('div.sensi-a-howto', howTo)),
    ];
  }

  function liveValues(v) {
    if (!v) {
      return ui.section('So schnell ist deine Maus', null, h('p.hint', 'Trag erst gültige Werte ein.'));
    }
    const lv = SM.liveValues(v);
    const stat = (value, label, hint) => h('div.stat', h('strong', value), h('span', label), hint ? h('span.hint', hint) : null);
    return [
      ui.section('So schnell ist deine Maus', null,
        h('div.stat-row.sensi-stats',
          stat(SM.fmtNum(lv.edpi, lv.edpi % 1 ? 1 : 0), 'eDPI', 'DPI × Sensi ÷ 100'),
          stat(`${SM.fmtNum(lv.cm360, 1)} cm`, 'pro Umdrehung', `${SM.fmtNum(lv.inch360, 1)} Zoll`)),
        h('div.stat-row.sensi-stats',
          stat(`${SM.fmtNum(lv.adsCm360, 1)} cm`, 'beim Zielen', `mit ${numText(v.targeting)} %`),
          stat(`${SM.fmtNum(lv.scopeCm360, 1)} cm`, 'mit Zielfernrohr', `mit ${numText(v.scope)} %, ohne Zoom`)),
        ui.more('Was ist eDPI?',
          'eDPI ist deine echte Maus-Geschwindigkeit: DPI mal Sensi geteilt durch 100. So vergleichst du dich mit anderen, auch bei anderer DPI.',
          'Beispiel: 800 DPI und 6,5 % ergeben eDPI 52 – genau wie 1600 DPI und 3,25 %. „Pro Umdrehung“ ist der Mausweg für eine ganze Drehung (360°).')),
      ui.section('Vergleich mit Profis', null,
        proScale(lv.edpi),
        h('div.row', ui.badge(`Deine eDPI ${fmt0(lv.edpi)}: ${lv.pro.label}`, lv.pro.type || 'accent')),
        h('p.hint.sensi-gap', lv.pro.text),
        ui.more('Mehr dazu',
          'Werte von 259 Fortnite-Profis (senslab.pro). Kein Muss – nur zur Orientierung.',
          'Die meisten Profis spielen mit 800 DPI. Ihre Mitte liegt bei eDPI 52, also etwa 32 cm für eine Umdrehung.')),
    ];
  }

  function proScale(e) {
    const MIN = 20; const MAX = 100;
    const pos = (v) => `${(SM.clamp01((v - MIN) / (MAX - MIN)) * 100).toFixed(2)}%`;
    const P = SM.PRO_EDPI;
    return h('div.sensi-scale', { role: 'img', 'aria-label': `Deine eDPI ${fmt0(e)}. Profis liegen meist zwischen ${P.p25} und ${P.p75}.` },
      h('div.sensi-scale-track',
        h('div.sensi-scale-band', { style: { left: pos(P.p25), width: `calc(${pos(P.p75)} - ${pos(P.p25)})` } }),
        h('div.sensi-scale-median', { style: { left: pos(P.median) } }),
        h('div.sensi-scale-you', { style: { left: pos(e) } }, h('span', e > MAX ? `${fmt0(e)} →` : e < MIN ? `← ${fmt0(e)}` : 'du'))),
      h('div.sensi-scale-labels',
        h('span', `${MIN} langsam`),
        h('span.sensi-scale-mid', { style: { left: pos(P.median) } }, `Profis ${P.p25}–${P.p75}`),
        h('span', `schnell ${MAX}`)));
  }

  /** dpiStep: DPI, auf die der Spieler die Maus erst umstellen muss (nur nach einem DPI-Vergleich). */
  function howToBox(s, { compact = false, dpiStep = null } = {}) {
    const sens = SM.fmtSens(s.sens);
    return ui.section('So stellst du es in Fortnite ein', 'HELIX ändert deine Fortnite-Sensi nicht – das machst du im Spiel.',
      h('ol.sensi-steps',
        dpiStep ? h('li', `Stell deine Maus auf ${dpiStep} DPI um (DPI-Taste oder Maus-Software).`) : null,
        h('li', 'Öffne in Fortnite die Einstellungen (Menü oben rechts, Zahnrad).'),
        h('li', 'Wähle den Reiter „Maus und Tastatur“.'),
        h('li', `Stell X-Achse und Y-Achse auf ${sens} %.`),
        h('li', `Zielen auf ${numText(s.targeting)} %, Zielfernrohr auf ${numText(s.scope)} %. Dann übernehmen.`)),
      ui.more('Warum nicht automatisch?',
        'Fortnite speichert die Sensi in der Epic-Cloud deines Kontos. Deshalb stellst du sie im Spiel ein – so geht nichts verloren.',
        'Die Namen im Menü können je nach Fortnite-Version etwas anders heißen.'),
      compact ? null : h('div.row.sensi-gap',
        ui.button('Mausbeschleunigung prüfen', { small: true, iconName: 'chevron', onClick: () => env.nav.go('maus') })));
  }

  // ---------------------------------------------------------------- Aim-Test

  function renderTest() {
    if (outcome) return renderResult();
    return renderSetup();
  }

  function seg(options, value, onPick, label) {
    return h('div.segmented', { role: 'radiogroup', 'aria-label': label }, options.map(([v, text]) => h(`button.seg${v === value ? '.active' : ''}`, {
      type: 'button', role: 'radio', 'aria-checked': String(v === value),
      onclick: () => { sfx('click'); onPick(v); },
    }, text)));
  }

  function currentPlan(rng) {
    return SM.buildPlan({
      mode: cfg.mode, settings: data.settings, length: cfg.length, spread: cfg.spread,
      dpis: cfg.mode === 'dpi' ? [cfg.dpi2] : [], rng,
    });
  }

  function dpi2Error() {
    const n = SM.parseNum(cfg.dpi2);
    if (!String(cfg.dpi2).trim()) return 'Bitte trag die zweite DPI ein.';
    if (!Number.isFinite(n) || n < SM.LIMITS.dpi[0] || n > SM.LIMITS.dpi[1]) return 'Bitte eine Zahl zwischen 50 und 32000 eingeben.';
    if (Math.round(n) === data.settings.dpi) return `Das ist schon deine jetzige DPI (${data.settings.dpi}). Nimm einen anderen Wert.`;
    return '';
  }

  function renderSetup() {
    const s = data.settings;
    const pointerOk = typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.requestPointerLock === 'function';
    const durText = (len) => {
      try {
        const sec = SM.planDurationSec(SM.buildPlan({ mode: cfg.mode, settings: s, length: len, spread: cfg.spread, dpis: [s.dpi * 2] }));
        return `ca. ${Math.max(1, Math.round(sec / 30) / 2).toLocaleString('de-DE')} Min.`;
      } catch { return ''; }
    };
    const rerender = () => renderBody();

    const dpiErr = h('span.sensi-err', { role: 'alert' });
    const dpiInput = h('input.input', { id: 'sensi-dpi2', type: 'text', inputmode: 'numeric', value: cfg.dpi2, placeholder: `z. B. ${s.dpi >= 1600 ? s.dpi / 2 : s.dpi * 2}`, autocomplete: 'off' });
    dpiInput.addEventListener('input', () => { cfg.dpi2 = dpiInput.value; dpiErr.textContent = ''; dpiInput.classList.remove('invalid'); });

    const startBtn = ui.button('Test vorbereiten', {
      variant: 'primary', iconName: 'play', disabled: !pointerOk,
      onClick: () => {
        if (cfg.mode === 'dpi') {
          const err = dpi2Error();
          if (err) { dpiErr.textContent = err; dpiInput.classList.add('invalid'); dpiInput.focus(); return; }
        }
        prepareTest();
      },
    });

    return [
      abortNote ? h('div.callout.warn', icon('warn'), h('div',
        h('strong', 'Test abgebrochen – denk an deine Maus'),
        h('p.hint', abortNote))) : null,
      pointerOk ? null : h('div.callout.warn', icon('warn'), h('div',
        h('strong', 'Der Aim-Test geht hier leider nicht'),
        h('p.hint', 'Das klappt nur in der Windows-App. Umrechner und eDPI gehen trotzdem.'))),
      h('div.sensi-grid',
        h('div',
          ui.section('Was willst du testen?', null,
            seg([['sens', 'Beste Sensi finden'], ['dpi', 'DPI vergleichen']], cfg.mode, (v) => { cfg.mode = v; rerender(); }, 'Was willst du testen?'),
            h('p.hint.sensi-gap', cfg.mode === 'dpi'
              ? 'Vergleicht zwei DPI-Werte deiner Maus bei gleicher eDPI.'
              : 'Testet fünf Werte rund um deine Sensi und zeigt den besten.'),
            cfg.mode === 'dpi' ? h('div.field.sensi-gap',
              h('label', { for: 'sensi-dpi2' }, `Zweite DPI (jetzt: ${s.dpi} DPI)`),
              dpiInput,
              dpiErr) : null,
            ui.more('So funktioniert es',
              'Du spielst mehrere kurze Durchgänge mit je drei Teilen: Flicks (schnell auf Ziele springen), Tracking (einem Ziel folgen) und bewegte Ziele.',
              cfg.mode === 'dpi'
                ? 'Zwischendurch stellst du die DPI an der Maus um (DPI-Taste oder Maus-Software). HELIX passt die Sensi so an, dass deine eDPI gleich bleibt.'
                : 'In jedem Durchgang ist die Sensi ein bisschen anders. Welche gerade dran ist, verrät HELIX erst am Ende – so zielst du ehrlich.')),
          ui.section('Wie lange?', null,
            seg([['short', `Kurz (${durText('short')})`], ['normal', `Gründlich (${durText('normal')})`]], cfg.length, (v) => { cfg.length = v; rerender(); }, 'Wie lange?'),
            h('p.hint.sensi-gap', 'Gründlich dauert länger, das Ergebnis wird genauer.')),
          cfg.mode === 'sens' ? ui.section('Wie weit auseinander?', null,
            seg([[0.1, 'Eng (± 10 %)'], [0.2, 'Normal (± 20 %)'], [0.3, 'Weit (± 30 %)']], cfg.spread, (v) => { cfg.spread = v; rerender(); }, 'Spanne'),
            h('p.hint.sensi-gap', `Von ${SM.fmtSens(SM.roundSens(s.sens * (1 - cfg.spread)))} % bis ${SM.fmtSens(SM.roundSens(s.sens * (1 + cfg.spread)))} %. Weit zum Suchen, eng zum Feinschliff.`)) : null),
        h('div',
          ui.section('Bereit?', null,
            h('dl.kv',
              h('dt', 'Deine Sensi'), h('dd', `${SM.fmtSens(s.sens)} % bei ${s.dpi} DPI`),
              h('dt', 'eDPI'), h('dd', fmt0(SM.edpi(s.dpi, s.sens))),
              h('dt', 'Ablauf'), h('dd', cfg.mode === 'dpi' ? '4 Durchgänge (A, B, B, A)' : '5 Durchgänge in zufälliger Reihenfolge')),
            data.saved ? null : h('div.row', ui.badge('Noch Beispielwerte – trag erst deine eigenen ein', 'warn')),
            h('ul.sensi-tips',
              h('li', 'Sitz wie beim Spielen, mit deinem normalen Mauspad.'),
              h('li', 'Ziel ganz normal – nicht extra vorsichtig.'),
              h('li', 'Esc pausiert, noch einmal Esc bricht ab.')),
            h('div.row', startBtn, ui.button('Werte ändern', { variant: 'ghost', iconName: 'edit', onClick: () => setTab('werte') }))))),
    ];
  }

  function prepareTest() {
    let plan;
    try {
      plan = currentPlan();
    } catch (e) {
      ui.toast(e.message, 'warn');
      return;
    }
    const session = new TestSession(plan);
    testSession = session;
    abortNote = '';
    lastMode = null;
    const modeBadge = h('span.sensi-mode', ui.badge('Mausmodus: wird beim Start geprüft'));
    const modeHint = h('p.hint.sensi-mode-hint');
    arena = createArena({
      h, session, dpi: plan.warmup.dpi, sound: sfx,
      onMode: (m) => {
        lastMode = m;
        ui.mount(modeBadge, ui.badge(`Mausmodus: ${MODE_TEXT[m]}`, m === 'raw' ? 'ok' : 'warn'));
        // Rohdaten: das Abzeichen sagt schon alles. Sonst kurz sagen, was mitwirken kann.
        modeHint.textContent = m === 'raw' ? ''
          : (window.devicePixelRatio || 1) !== 1
            ? 'Mausbeschleunigung und Skalierung von Windows können mitwirken.'
            : 'Die Mausbeschleunigung von Windows kann mitwirken.';
      },
      onAbort: () => {
        abortNote = cancelTest();
        renderBody();
      },
      onFinish: (out) => finishTest(out, plan),
    });
    ui.mount(body,
      h('div.sensi-stage', arena.el),
      h('div.sensi-arena-bar',
        modeBadge,
        h('span.hint', 'Esc: Pause · noch einmal Esc: Abbrechen'),
        h('span.grow'),
        ui.button('Abbrechen', { small: true, variant: 'ghost', iconName: 'x', onClick: () => arena?.abort() })),
      modeHint);
    later(() => arena?.focus(), 50);
  }

  function stopArena() {
    arena?.destroy();
    arena = null;
    testSession = null;
  }

  /** DPI-Vergleich: Hinweis, die Maus wieder auf die eigene DPI zu stellen ('' = nichts zu tun). */
  function dpiBackNote() {
    const s = testSession;
    if (!s || s.plan.mode !== 'dpi') return '';
    return SM.dpiAbortHint({ baseDpi: s.plan.baseDpi, mouseDpi: s.mouseDpi, switchDpi: s.phase === 'switch' ? s.dpi : null });
  }

  /** Bricht den laufenden Test ab und sagt, was mit der Maus zu tun ist. Gibt den DPI-Hinweis zurück. */
  function cancelTest() {
    const note = dpiBackNote();
    stopArena();
    if (note) ui.toast(`Test abgebrochen, nichts gespeichert. ${note}`, 'warn', { timeout: 10000 });
    else ui.toast('Test abgebrochen, nichts gespeichert.', 'info');
    return note;
  }

  async function finishTest(out, plan) {
    stopArena();
    outcome = { ...out, plan, mode: lastMode };
    renderBody();
    if (out.rec?.method === 'zuwenig') {
      ui.toast('Zu wenige Treffer – dieser Test wurde nicht gespeichert.', 'info');
      return;
    }
    try {
      const r = await env.call('sensi.saveResult', { entry: out.entry });
      if (destroyed) return;
      data.history = [...data.history.filter((e) => e.at !== r.entry.at), r.entry].slice(-200);
      renderTabs();
      ui.toast('Fertig – Ergebnis im Verlauf gespeichert.');
    } catch (e) {
      ui.showError(e, 'Ergebnis nicht gespeichert');
    }
  }

  function renderResult() {
    const { rec, entry, plan } = outcome;
    const s = data.settings;
    if (!rec) {
      return [
        ui.emptyState({ title: 'Kein Ergebnis', text: 'Kein Durchgang war verwertbar. Versuch es noch einmal.', action: ui.button('Neuer Test', { variant: 'primary', iconName: 'play', onClick: () => { outcome = null; renderBody(); } }) }),
      ];
    }
    const dpiMode = plan.mode === 'dpi';
    const mouseDpi = Number.isFinite(outcome.mouseDpi) ? outcome.mouseDpi : plan.baseDpi;
    const dpiHint = dpiMode ? h('p.hint', SM.dpiResultHint({ recDpi: rec.dpi, baseDpi: plan.baseDpi, mouseDpi })) : null;
    if (rec.method === 'zuwenig') {
      return h('div.sensi-result.glass',
        h('div.sensi-result-main',
          h('span.hint', 'Keine Empfehlung'),
          h('div.sensi-big', 'Zu wenige Treffer'),
          h('div.row', ui.badge('nicht gespeichert', 'warn'))),
        h('div.sensi-result-text',
          // Die erste Zeile („zu wenige Treffer“) steht schon groß links.
          rec.lines.filter((l, i) => i > 0 || !/zu wenige Treffer/i.test(l)).map((l) => h('p', l)),
          h('p.hint', 'Tipp: Klick, sobald dein Fadenkreuz auf dem Ziel liegt.'),
          dpiHint,
          h('div.row',
            ui.button('Nochmal testen', { variant: 'primary', iconName: 'refresh', onClick: () => { outcome = null; renderBody(); } }))));
    }
    const conf = CONF[rec.confidence] || CONF.mittel;
    const adopted = Math.abs(s.sens - rec.sens) < 1e-9 && s.dpi === rec.dpi;
    const adoptBtn = ui.button(adopted ? (dpiMode ? 'Ist schon deine Einstellung' : 'Ist schon deine Sensi') : (dpiMode ? 'Als meine Einstellung übernehmen' : 'Als meine Sensi übernehmen'), {
      variant: 'primary', iconName: 'check', disabled: adopted,
      onClick: async () => {
        const ok = await saveSettings({ ...data.settings, sens: rec.sens, dpi: rec.dpi },
          `Übernommen – stell jetzt in Fortnite ${SM.fmtSens(rec.sens)} % ein${dpiMode && rec.dpi !== mouseDpi ? ` und deine Maus auf ${rec.dpi} DPI` : ''}.`);
        if (ok) renderBody();
      },
    });
    return [
      h('div.sensi-result.glass',
        h('div.sensi-result-main',
          h('span.hint', dpiMode ? 'Deine Empfehlung' : 'Deine beste Sensi'),
          h('div.sensi-big', dpiMode ? `${rec.dpi} DPI · ${SM.fmtSens(rec.sens)} %` : `${SM.fmtSens(rec.sens)} %`),
          h('p.hint', `${dpiMode ? '' : `bei ${rec.dpi} DPI · `}eDPI ${SM.fmtNum(rec.edpi, rec.edpi % 1 ? 1 : 0)} · ${SM.fmtNum(rec.cm360, 1)} cm für eine Umdrehung`),
          h('div.row', ui.badge(conf[0], conf[1]), outcome.mode ? ui.badge(`Mausmodus: ${MODE_TEXT[outcome.mode]}`, outcome.mode === 'raw' ? 'ok' : 'warn') : null),
          h('p.hint.sensi-gap', conf[2])),
        h('div.sensi-result-text',
          rec.lines.map((l) => h('p', l)),
          dpiHint,
          h('div.row', adoptBtn,
            ui.button('Nochmal testen', { iconName: 'refresh', onClick: () => { outcome = null; renderBody(); } }),
            ui.button('Verlauf ansehen', { variant: 'ghost', iconName: 'clock', onClick: () => setTab('verlauf') })))),
      ui.section(dpiMode ? 'Punkte pro DPI' : 'Punkte pro getesteter Sensi', 'Aus Treffern, Genauigkeit, Tempo und Tracking (0 bis 100).',
        barChart(entry.rounds, rec, plan),
        ui.more('Alle Werte im Detail', roundsTable(entry.rounds, dpiMode))),
      howToBox({ ...s, sens: rec.sens }, { compact: true, dpiStep: dpiMode && rec.dpi !== mouseDpi ? rec.dpi : null }),
    ];
  }

  function barChart(rounds, rec, plan) {
    const dpiMode = plan.mode === 'dpi';
    const list = rounds.slice().sort((a, b) => (dpiMode ? a.dpi - b.dpi : a.mult - b.mult));
    const best = list.reduce((m, r) => (r.score > m.score ? r : m), list[0]);
    return h('div.sensi-bars', { role: 'img', 'aria-label': list.map((r) => `${dpiMode ? `${r.dpi} DPI` : `${SM.fmtSens(r.sens)} %`}: ${fmt0(r.score)} Punkte`).join(', ') },
      list.map((r) => {
        const isBest = r === best;
        const isNow = dpiMode ? r.dpi === plan.baseDpi : Math.abs(r.mult - 1) < 1e-6;
        return h(`div.sensi-bar${isBest ? '.best' : ''}`,
          h('span.sensi-bar-value', fmt0(r.score)),
          h('div.sensi-bar-track', h('div.sensi-bar-fill', { style: { height: `${Math.max(2, SM.clamp(r.score, 0, 100))}%` } })),
          h('span.sensi-bar-label', dpiMode ? `${r.dpi} DPI` : `${SM.fmtSens(SM.roundTo(r.sens, 2))} %`),
          h('span.hint', isBest ? 'bester Wert' : isNow ? 'deine jetzige' : ' '));
      }));
  }

  function roundsTable(rounds, dpiMode) {
    const list = rounds.slice().sort((a, b) => (dpiMode ? a.dpi - b.dpi : a.mult - b.mult));
    const ratio = (v) => (Number.isFinite(v) ? `${fmt0(v * 100)} %` : '–');
    return [h('div.table-wrap', h('table.table',
      h('thead', h('tr',
        h('th', dpiMode ? 'DPI' : 'Sensi'), h('th', 'Punkte'), h('th', 'Treffer'), h('th', 'Genauigkeit'),
        h('th', 'Tracking'), h('th', 'Zeit bis Treffer'), h('th', 'Übers Ziel'), h('th', 'Zu kurz'))),
      h('tbody', list.map((r) => h('tr',
        h('td.num', dpiMode ? `${r.dpi} (${SM.fmtSens(SM.roundTo(r.sens, 2))} %)` : `${SM.fmtSens(SM.roundTo(r.sens, 2))} %`),
        h('td.num', fmt0(r.score)),
        h('td.num', `${r.hits} von ${r.hits + r.misses}`),
        h('td.num', pct(r.accuracy)),
        h('td.num', pct(r.trackingPct)),
        h('td.num', Number.isFinite(r.avgTtkMs) ? `${r.avgTtkMs} ms` : '–'),
        h('td.num', ratio(r.overshoot)),
        h('td.num', ratio(r.undershoot))))))),
    ui.more('Was bedeuten die Spalten?',
      'Zeit bis Treffer: vom Erscheinen des Ziels bis zum Treffer.',
      '„Übers Ziel“ und „Zu kurz“: Anteil der Flicks, bei denen du über das Ziel hinaus oder zu kurz gezielt hast.')];
  }

  // ---------------------------------------------------------------- Umrechner

  function renderUmrechner() {
    for (const [k, fill] of Object.entries(CONV_FROM_SETTINGS)) if (!convEdited.has(k)) conv[k] = fill(data.settings);
    const out = h('div.sensi-conv-out');

    const field = (key, label, hint = null, mode = 'decimal') => {
      const id = `sensi-conv-${key}`;
      const input = h('input.input', { id, type: 'text', inputmode: mode, value: conv[key], autocomplete: 'off' });
      input.addEventListener('input', () => {
        conv[key] = input.value;
        if (key in CONV_FROM_SETTINGS) { if (input.value.trim()) convEdited.add(key); else convEdited.delete(key); }
        update();
      });
      return h('div.field', h('label', { for: id }, label), input, hint ? h('p.hint', hint) : null);
    };

    let form;
    if (conv.dir === 'from') {
      form = [
        field('sens', 'Fortnite-Sensi X-Achse (%)'),
        field('dpi', 'Deine DPI in Fortnite', null, 'numeric'),
        field('targetDpi', 'DPI im anderen Spiel', 'Nur ändern, wenn du dort eine andere DPI nutzt.', 'numeric'),
        field('fov', 'Sichtfeld in PUBG', 'Nur für PUBG: Third-Person 80, First-Person dein Wert (Standard 90).', 'numeric'),
      ];
    } else {
      const select = h('select.input', { id: 'sensi-conv-game', 'aria-label': 'Spiel' }, SM.GAMES.map((g) => h('option', { value: g.id, selected: g.id === conv.game }, g.name)));
      select.addEventListener('change', () => { conv.game = select.value; renderBody(); });
      form = [
        h('div.field', h('label', { for: 'sensi-conv-game' }, 'Aus welchem Spiel?'), select),
        field('value', 'Sensi in diesem Spiel'),
        field('gameDpi', 'DPI in diesem Spiel', null, 'numeric'),
        field('fnDpi', 'DPI in Fortnite', 'Nur ändern, wenn du in Fortnite eine andere DPI willst.', 'numeric'),
        conv.game === 'pubg' ? field('fov', 'Sichtfeld in PUBG', 'Third-Person 80, First-Person dein Wert (Standard 90).', 'numeric') : null,
      ];
    }

    function update() {
      ui.mount(out, conv.dir === 'from' ? fromResult() : toResult());
    }

    function bad(text) {
      return h('div.callout.warn', icon('warn'), h('div', h('strong', 'Noch keine Rechnung möglich'), h('p.hint', text)));
    }

    function fromResult() {
      const sens = SM.parseNum(conv.sens); const dpi = SM.parseNum(conv.dpi); const tdpi = SM.parseNum(conv.targetDpi); const fov = SM.parseNum(conv.fov);
      if (!(sens >= SM.LIMITS.sens[0] && sens <= SM.LIMITS.sens[1])) return bad('Bitte eine Fortnite-Sensi zwischen 0,1 und 100 eintragen.');
      if (!(dpi >= 50 && dpi <= 32000) || !(tdpi >= 50 && tdpi <= 32000)) return bad('Bitte DPI-Werte zwischen 50 und 32000 eintragen.');
      const fovOk = fov >= 60 && fov <= 120;
      const cm = SM.cm360(dpi, sens);
      return [
        h('p.sensi-conv-lead', `Gleiche Drehung wie in Fortnite: ${SM.fmtNum(cm, 1)} cm für eine Umdrehung (eDPI ${SM.fmtNum(SM.edpi(dpi, sens), 1)}).`),
        h('div.table-wrap', h('table.table',
          h('thead', h('tr', h('th', 'Spiel'), h('th', 'Sensi dort'), h('th', 'Hinweis'))),
          h('tbody', SM.GAMES.map((g) => {
            const v = g.kind === 'pubg' && !fovOk ? NaN : SM.fortniteToGame(g, { sens, dpi, targetDpi: tdpi, fov });
            return h('tr', h('td', g.name), h('td.num.sensi-conv-val', SM.fmtGameValue(g, v)),
              h('td.hint', g.kind === 'pubg' && !fovOk ? 'Sichtfeld zwischen 60 und 120 eintragen.' : (g.note || '')));
          })))),
        h('p.hint.sensi-gap', 'Gilt fürs normale Umschauen. Zielen mit Visier stellst du im Spiel selbst ein.'),
      ];
    }

    function toResult() {
      const g = SM.findGame(conv.game);
      const value = SM.parseNum(conv.value); const gdpi = SM.parseNum(conv.gameDpi); const fdpi = SM.parseNum(conv.fnDpi); const fov = SM.parseNum(conv.fov);
      if (!Number.isFinite(value) || value <= 0) return bad(`Bitte deine Sensi aus ${g.name} eintragen.`);
      if (!(gdpi >= 50 && gdpi <= 32000) || !(fdpi >= 50 && fdpi <= 32000)) return bad('Bitte DPI-Werte zwischen 50 und 32000 eintragen.');
      if (g.kind === 'pubg' && !(fov >= 60 && fov <= 120)) return bad('Bitte ein Sichtfeld zwischen 60 und 120 eintragen.');
      const exact = SM.gameToFortnite(g, { value, gameDpi: gdpi, dpi: fdpi, fov });
      if (!(exact >= SM.LIMITS.sens[0] && exact <= SM.LIMITS.sens[1])) return bad('Das ergibt keinen Wert, den Fortnite einstellen kann. Prüf deine Eingaben.');
      const fn = SM.roundSens(exact);
      const s = data.settings;
      const adopted = Math.abs(s.sens - fn) < 1e-9 && s.dpi === Math.round(fdpi);
      return [
        h('div.sensi-conv-result',
          h('span.hint', 'In Fortnite einstellen'),
          h('div.sensi-big', `${SM.fmtSens(fn)} %`),
          h('p.hint', `bei ${Math.round(fdpi)} DPI · eDPI ${SM.fmtNum(SM.edpi(fdpi, fn), 1)} · ${SM.fmtNum(SM.cm360(fdpi, fn), 1)} cm pro Umdrehung`),
          h('p.hint', `genau ${SM.fmtNum(exact, 2)} % – Fortnite kann nur 0,1-%-Schritte`)),
        g.note ? h('p.hint', g.note) : null,
        h('div.row', ui.button(adopted ? 'Ist schon deine Sensi' : 'Als meine Sensi übernehmen', {
          variant: 'primary', iconName: 'check', disabled: adopted,
          onClick: async () => {
            const ok = await saveSettings({ ...data.settings, sens: fn, dpi: Math.round(fdpi) }, `Übernommen. Stell jetzt in Fortnite ${SM.fmtSens(fn)} % ein.`);
            if (!ok) return;
            // Die DPI im anderen Spiel bleibt stehen, sonst rechnet der Umrechner gleich mit der neuen Fortnite-DPI weiter.
            convEdited.add('gameDpi');
            renderBody({ keepScroll: true });
          },
        }), h('span.hint', 'Speichert nur in HELIX. In Fortnite stellst du ihn selbst ein.')),
      ];
    }

    update();
    return [
      h('div.toolbar',
        seg([['from', 'Fortnite → anderes Spiel'], ['to', 'Anderes Spiel → Fortnite']], conv.dir, (v) => { conv.dir = v; renderBody(); }, 'Richtung')),
      h('div.sensi-grid',
        ui.section('Deine Angaben', 'Komma oder Punkt ist egal.', form),
        ui.section('Ergebnis', null, out)),
    ];
  }

  // ---------------------------------------------------------------- Verlauf

  function renderVerlauf() {
    const list = data.history.slice().reverse();
    if (!list.length) {
      return ui.emptyState({
        title: 'Noch keine Tests',
        text: 'Mach deinen ersten Aim-Test – er dauert etwa zwei Minuten.',
        action: ui.button('Zum Aim-Test', { variant: 'primary', iconName: 'play', onClick: () => setTab('test') }),
      });
    }
    const recent = data.history.slice(-10);
    return [
      h('div.toolbar',
        h('p.hint.grow', `${data.history.length} ${data.history.length === 1 ? 'Test' : 'Tests'} gespeichert · höchstens 200, ältere fallen dann weg`),
        ui.button('Verlauf löschen', { variant: 'danger', small: true, iconName: 'trash', onClick: clearHistory })),
      recent.length >= 2 ? ui.section('Empfehlung im Verlauf', 'Deine letzten Tests, von alt nach neu.', trendStrip(recent)) : null,
      h('ul.list.sensi-history', list.map((e) => historyItem(e))),
    ];
  }

  function trendStrip(list) {
    const vals = list.map((e) => e.recommendedSens);
    const lo = Math.min(...vals); const hi = Math.max(...vals);
    return h('div.sensi-trend', { role: 'img', 'aria-label': `Empfehlungen: ${vals.map((v) => `${SM.fmtSens(v)} %`).join(', ')}` },
      list.map((e) => h('div.sensi-trend-item',
        h('div.sensi-trend-track', h('div.sensi-trend-dot', { style: { bottom: `${hi > lo ? 15 + ((e.recommendedSens - lo) / (hi - lo)) * 70 : 50}%` } })),
        h('span', `${SM.fmtSens(e.recommendedSens)} %`),
        h('span.hint', new Date(e.at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })))));
  }

  function historyItem(e) {
    const dpiMode = e.mode === 'dpi';
    const open = openDetails.has(e.at);
    const recDpi = Number.isFinite(e.recommendedDpi) ? e.recommendedDpi : e.dpi;
    const head = h('div.grow',
      h('span', h('strong', dpiMode ? `${recDpi} DPI · ${SM.fmtSens(e.recommendedSens)} %` : `${SM.fmtSens(e.recommendedSens)} %`),
        ` empfohlen · eDPI ${SM.fmtNum(e.edpi, 0)}`),
      h('span.hint', `${ui.fmtDate(e.at)} · ${dpiMode ? 'DPI-Vergleich' : 'Sensi-Test'} · ${e.length === 'normal' ? 'gründlich' : 'kurz'} · vorher ${SM.fmtSens(e.sens)} % bei ${e.dpi} DPI`));
    const details = open ? h('div.sensi-history-details',
      h('p.sensi-history-stats', `Punkte ${fmt0(e.score)} · Genauigkeit ${pct(e.accuracy)} · Tracking ${pct(e.trackingPct)} · Zeit bis Treffer ${Number.isFinite(e.avgTtkMs) ? `${e.avgTtkMs} ms` : '–'}`),
      (e.lines || []).map((l) => h('p.hint', l)),
      e.rounds?.length ? roundsTable(e.rounds, dpiMode) : null) : null;
    return h('li.sensi-history-item',
      h('div.sensi-history-row',
        icon('clock', 16),
        head,
        e.confidence && CONF[e.confidence] ? ui.badge(CONF[e.confidence][0], CONF[e.confidence][1]) : null,
        ui.button(open ? 'Weniger' : 'Details', { small: true, variant: 'ghost', iconName: 'chevron', onClick: () => { if (open) openDetails.delete(e.at); else openDetails.add(e.at); renderBody({ keepScroll: true }); } }),
        ui.button('', { small: true, variant: 'ghost', iconName: 'trash', title: 'Diesen Test löschen', onClick: () => removeEntry(e) })),
      details);
  }

  async function removeEntry(e) {
    const ok = await ui.confirmDialog({ title: 'Diesen Test löschen?', text: `Der Test vom ${ui.fmtDate(e.at)} wird aus dem Verlauf entfernt.`, confirmLabel: 'Löschen', danger: true });
    if (!ok) return;
    try {
      await env.call('sensi.removeResult', { at: e.at });
      data.history = data.history.filter((x) => x.at !== e.at);
      ui.toast('Test gelöscht.');
      renderTabs();
      renderBody({ keepScroll: true });
    } catch (err) { ui.showError(err); }
  }

  async function clearHistory() {
    const ok = await ui.confirmDialog({ title: 'Ganzen Verlauf löschen?', text: `Alle ${data.history.length} gespeicherten Tests werden gelöscht. Deine eingetragenen Werte bleiben.`, confirmLabel: 'Alles löschen', danger: true });
    if (!ok) return;
    try {
      const r = await env.call('sensi.clearHistory');
      data.history = [];
      ui.toast(`Verlauf gelöscht (${r.cleared} ${r.cleared === 1 ? 'Test' : 'Tests'}).`);
      renderTabs();
      renderBody();
    } catch (err) { ui.showError(err); }
  }

  return {
    start,
    destroy() {
      destroyed = true;
      // Tool verlassen, während der DPI-Vergleich lief: trotzdem an die Maus-DPI erinnern
      const note = arena ? dpiBackNote() : '';
      stopArena();
      if (note) ui.toast(`Test abgebrochen. ${note}`, 'warn', { timeout: 10000 });
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}

