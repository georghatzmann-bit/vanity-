// Monitor-Tuner: Testbilder (mit Vollbild) und geführte Einrichtung in fünf Schritten.
// HELIX verändert hier nichts am Monitor oder Treiber – es zeigt Testbilder und erklärt die Einstellungen.

import {
  PATTERNS, findPattern, nextPatternId, backingSize, drawPattern, stormScene, rateStorm,
} from '../lib/monitor-patterns.mjs';
import { STEPS, BRANDS, VENDORS, stepChecks, progress } from '../lib/monitor-guide.mjs';

let cleanup = [];

const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

export default {
  async mount(root, env) {
    const ui = env.ui;
    const { h, icon } = ui;
    let alive = true;
    let tab = 'bilder';
    let views = []; // aktive Testbild-Flächen (werden beim Tabwechsel aufgeräumt)
    let fsView = null; // Fläche im Vollbild
    let lastFsExit = 0;
    let hintTimer = null;

    const saved = await env.call('monitor.state').catch(() => ({ wizard: null, stormTests: [] }));
    const wiz = {
      step: Math.min(STEPS.length - 1, Math.max(0, saved.wizard?.step || 0)),
      checks: { ...(saved.wizard?.checks || {}) },
      vendor: saved.wizard?.vendor || null,
      completedAt: saved.wizard?.completedAt || null,
    };
    let stormTests = saved.stormTests || [];
    let gpu = null; // Ergebnis der Erkennung
    let winOnlyMsg = null; // Hinweis, wenn eine Windows-Funktion hier nicht geht

    const tabs = h('div.tabs', { role: 'tablist' });
    const body = h('div.mon-body');
    root.append(tabs, body);

    // ---------------- Testbild-Fläche ----------------
    /** fixed: das Bild bleibt immer dasselbe (Pfeiltasten im Vollbild wechseln es nicht), z. B. der Sturm-Test der Kontrolle. */
    function patternView({ pattern, variant = 'mittel', compact = false, fixed = false, onChange }) {
      const st = { pattern, base: pattern, variant, seed: randomSeed(), reveal: false, hintUntil: 0 };
      let scene = stormScene(st.seed);
      const canvas = h('canvas.mon-canvas', { tabindex: '0', role: 'img' });
      const wrap = h(`div.mon-canvas-wrap${compact ? '.compact' : ''}`, canvas);
      const view = {
        el: wrap, canvas, st,
        get scene() { return scene; },
        draw() {
          if (!alive) return;
          const r = canvas.getBoundingClientRect();
          if (!r.width || !r.height) return;
          const b = backingSize(r.width, r.height, window.devicePixelRatio || 1);
          if (canvas.width !== b.w || canvas.height !== b.h) { canvas.width = b.w; canvas.height = b.h; }
          const fs = document.fullscreenElement === canvas;
          const p = findPattern(st.pattern);
          const hint = fs && Date.now() < st.hintUntil
            ? [`${p.name}: ${p.instruction}`, fixed ? 'Esc beendet das Vollbild' : 'Pfeiltasten ← → wechseln das Bild · Esc beendet das Vollbild']
            : null;
          drawPattern(canvas.getContext('2d'), st.pattern, canvas.width, canvas.height, { variant: st.variant, scene, reveal: st.reveal, hint, dpr: b.dpr });
          canvas.setAttribute('aria-label', `Testbild ${p.name}. ${p.instruction}`);
        },
        set(patch) {
          Object.assign(st, patch);
          if ('seed' in patch) scene = stormScene(st.seed);
          view.draw();
          onChange?.(st);
        },
        step(dir) {
          if (fixed) return;
          view.set({ pattern: nextPatternId(st.pattern, dir), reveal: false });
          if (document.fullscreenElement === canvas) showHint(view);
        },
        async fullscreen() {
          if (!canvas.requestFullscreen) { ui.toast('Vollbild wird hier nicht unterstützt.', 'warn'); return; }
          try { await canvas.requestFullscreen({ navigationUI: 'hide' }); } catch (e) { ui.showError(e, 'Vollbild nicht möglich'); }
        },
        destroy() { ro.disconnect(); },
      };
      canvas.addEventListener('dblclick', () => (document.fullscreenElement ? document.exitFullscreen().catch(() => {}) : view.fullscreen()));
      const ro = new ResizeObserver(() => view.draw());
      ro.observe(canvas);
      views.push(view);
      return view;
    }

    function showHint(view) {
      view.st.hintUntil = Date.now() + 3500;
      view.draw();
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => { if (alive) view.draw(); }, 3600);
    }

    function onFsChange() {
      const el = document.fullscreenElement;
      const v = views.find((x) => x.canvas === el) || null;
      if (v) {
        fsView = v;
        showHint(v);
        return;
      }
      if (fsView) {
        lastFsExit = Date.now();
        const v2 = fsView;
        fsView = null;
        v2.st.hintUntil = 0;
        // kleine Vorschauen gehen nach dem Vollbild auf ihr eigenes Bild zurück
        if (v2.el.classList.contains('compact') && v2.st.pattern !== v2.st.base) v2.set({ pattern: v2.st.base });
        else v2.draw();
      }
    }

    function onKey(e) {
      const active = fsView && document.fullscreenElement === fsView.canvas;
      if (e.key === 'Escape' && (active || Date.now() - lastFsExit < 700)) {
        // Esc beendet nur das Vollbild – nicht das ganze Tool
        e.stopImmediatePropagation();
        if (active) document.exitFullscreen?.().catch(() => {});
        return;
      }
      if (!active) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); fsView.step(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); fsView.step(-1); }
      else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && fsView.st.pattern === 'ausleuchtung') {
        e.preventDefault();
        const vs = findPattern('ausleuchtung').variants;
        const i = Math.max(0, vs.findIndex((x) => x.id === fsView.st.variant));
        fsView.set({ variant: vs[(i + (e.key === 'ArrowUp' ? 1 : -1) + vs.length) % vs.length].id });
      }
    }

    document.addEventListener('fullscreenchange', onFsChange);
    window.addEventListener('keydown', onKey, true);
    cleanup = [
      () => { alive = false; },
      () => clearTimeout(hintTimer),
      () => document.removeEventListener('fullscreenchange', onFsChange),
      () => window.removeEventListener('keydown', onKey, true),
      () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); },
      () => clearViews(),
    ];

    function clearViews() {
      for (const v of views) v.destroy();
      views = [];
    }

    // ---------------- Sturm-Test (Antwort) ----------------
    function stormPanel(view, { onRated } = {}) {
      const resultBox = h('div.mon-storm-result');
      const revealBtn = ui.button('Lösung zeigen', {
        small: true, iconName: 'eye',
        onClick: () => {
          view.set({ reveal: !view.st.reveal });
          revealBtn.querySelector('span').textContent = view.st.reveal ? 'Lösung ausblenden' : 'Lösung zeigen';
          ui.toast(view.st.reveal ? `Im Bild sind ${view.scene.total} Figuren – jetzt eingerahmt.` : 'Lösung ausgeblendet.', 'info');
        },
      });
      const numbers = h('div.segmented.mon-numbers', { role: 'group', 'aria-label': 'Anzahl erkannter Figuren' },
        Array.from({ length: 10 }, (_, n) => h('button.seg', {
          type: 'button',
          onclick: async (e) => {
            numbers.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b === e.currentTarget));
            const r = rateStorm(n, view.scene.total);
            ui.mount(resultBox, h(`div.callout.${r.level}`, icon(r.level === 'ok' ? 'check' : 'warn'), h('div',
              h('strong', `Ergebnis: ${r.label}`), h('p.hint', r.text))));
            if (n <= view.scene.total) {
              try {
                await env.call('monitor.saveStormTest', { seen: n, total: view.scene.total });
                stormTests = [...stormTests, { at: Date.now(), seen: n, total: view.scene.total }];
                ui.toast(`Gespeichert: ${n} von ${view.scene.total} Figuren erkannt.`);
              } catch (err) { ui.showError(err); }
            } else {
              ui.toast('Mehr Figuren als im Bild – zähle noch einmal.', 'warn');
            }
            onRated?.(r);
          },
        }, String(n))));
      const last = stormTests[stormTests.length - 1];
      return h('div.mon-storm',
        h('div.mon-storm-q', h('strong', 'Wie viele Figuren erkennst du?'), h('p.hint', 'Aus normalem Abstand schauen, nicht ganz nah ran.')),
        numbers,
        resultBox,
        h('div.row',
          revealBtn,
          ui.button('Neue Anordnung', {
            small: true, iconName: 'refresh',
            onClick: () => {
              view.set({ seed: randomSeed(), reveal: false });
              revealBtn.querySelector('span').textContent = 'Lösung zeigen';
              numbers.querySelectorAll('.seg').forEach((b) => b.classList.remove('active'));
              ui.clear(resultBox);
              ui.toast('Neue Figuren verteilt.', 'info');
            },
          }),
          last ? h('span.hint', `Letztes Ergebnis: ${last.seen} von ${last.total} (${ui.fmtAgo(last.at)})`) : null));
    }

    // ---------------- Tab: Testbilder ----------------
    function renderPatterns(initial = 'schwarz') {
      const info = h('div.callout.info.mon-instruction');
      const variantBox = h('div.mon-variants');
      const extra = h('div.mon-extra');
      let view;
      const paintInfo = (st) => {
        const p = findPattern(st.pattern);
        ui.mount(info, icon('info'), h('div', h('strong', p.name), h('p.hint', p.instruction),
          p.id === 'gamma' ? ui.more('So liest du es', 'Jedes Feld hat feine Streifen außen und eine feste Fläche in der Mitte. Das Feld, bei dem beides gleich hell wirkt, ist dein Gamma (wie hell Mitteltöne sind). Bei 2,4 oder 2,6 wirken dunkle Stellen zu dunkel.') : null,
          p.id === 'schwarz' ? ui.more('Erste Stufen unsichtbar?', 'Prüfe in einem nicht zu hellen Raum. Hilft das nicht, stell den Schwarz-Stabilisator im Monitor-Menü höher (Schritt 1 der Einrichtung).') : null));
        seg.querySelectorAll('.seg').forEach((b) => { const on = b.dataset.id === st.pattern; b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on)); });
        ui.clear(variantBox);
        if (p.variants) {
          variantBox.append(h('div.segmented', { role: 'radiogroup', 'aria-label': 'Helligkeit der Fläche' }, p.variants.map((v) => h(`button.seg${st.variant === v.id ? '.active' : ''}`, {
            type: 'button', role: 'radio', 'aria-checked': String(st.variant === v.id),
            onclick: () => { view.set({ variant: v.id }); ui.toast(`Fläche: ${v.label}`, 'info', { timeout: 1600 }); },
          }, v.label))), h('p.hint', 'Im Vollbild: Helligkeit mit ↑ ↓.'));
        }
        if (p.id === 'sturm' && !extra.dataset.storm) {
          extra.dataset.storm = '1';
          ui.mount(extra, stormPanel(view));
        } else if (p.id !== 'sturm') {
          delete extra.dataset.storm;
          ui.clear(extra);
        }
      };
      const seg = h('div.segmented.mon-patterns', { role: 'radiogroup', 'aria-label': 'Testbild' }, PATTERNS.map((p) => h('button.seg', {
        type: 'button', role: 'radio', dataset: { id: p.id },
        onclick: () => view.set({ pattern: p.id, reveal: false }),
      }, p.name)));
      view = patternView({ pattern: initial, onChange: (st) => paintInfo(st) });
      paintInfo(view.st);
      return [
        h('div.mon-toolbar', seg),
        h('div.mon-layout',
          h('div.mon-stage', view.el),
          h('aside.mon-side',
            info,
            h('div.mon-controls',
              ui.button('Vollbild', { variant: 'primary', iconName: 'eye', onClick: () => view.fullscreen() }),
              h('div.mon-controls-pair',
                ui.button('Zurück', { iconName: 'back', onClick: () => view.step(-1) }),
                ui.button('Weiter', { iconName: 'chevron', onClick: () => view.step(1) }))),
            h('p.hint', 'Vollbild ist am genauesten. Pfeiltasten wechseln, Esc beendet.'),
            variantBox,
            extra)),
      ];
    }

    // ---------------- Tab: Einrichtung ----------------
    async function saveProgress(done = false) {
      try {
        const r = await env.call('monitor.saveWizard', { checks: wiz.checks, step: wiz.step, vendor: wiz.vendor, done });
        if (done) wiz.completedAt = r.completedAt || Date.now();
        return true;
      } catch (e) { ui.showError(e, 'Fortschritt nicht gespeichert'); return false; }
    }

    async function runAction(a) {
      try {
        if (a.type === 'settings') {
          await env.call('app.openWindowsSettings', { uri: a.uri });
          ui.toast('Windows-Einstellungen geöffnet.');
        } else if (a.type === 'hdrStore') {
          await env.call('monitor.openHdrStore');
          ui.toast('Der Microsoft Store öffnet „Windows HDR Calibration“.');
        } else if (a.type === 'calibration') {
          await env.call('monitor.openCalibration');
          ui.toast('Die Farbkalibrierung startet gleich in einem eigenen Fenster.');
        } else if (a.type === 'nav') {
          env.nav.go(a.to);
        }
      } catch (e) {
        if (e.code === 'NOT_WINDOWS') {
          winOnlyMsg = e.message;
          renderBody();
          ui.toast('Das geht nur unter Windows.', 'warn');
        } else ui.showError(e);
      }
    }

    function checkRow(c) {
      const id = `mon-check-${c.id}`;
      const input = h('input', { type: 'checkbox', id, checked: !!wiz.checks[c.id] });
      input.addEventListener('change', () => {
        if (input.checked) wiz.checks[c.id] = true; else delete wiz.checks[c.id];
        paintProgress();
        paintStepper();
        saveProgress();
      });
      return h('div.mon-check',
        h('div.mon-check-main', input, h('div.mon-check-text',
          h('label', { for: id }, h('strong', c.label), h('span.hint', c.hint)),
          c.how ? ui.more('So geht’s', c.how) : null,
          c.why ? ui.more('Warum?', c.why) : null)),
        c.action ? ui.button(c.action.label, { small: true, iconName: c.action.type === 'nav' ? 'chevron' : 'settings', onClick: () => runAction(c.action) }) : null);
    }

    function previewCard(patternId) {
      const p = findPattern(patternId);
      const v = patternView({ pattern: patternId, compact: true });
      return h('div.mon-preview',
        v.el,
        h('div.mon-preview-foot',
          h('div.grow', h('strong', p.name), h('span.hint', p.instruction)),
          ui.button('Vollbild', { small: true, iconName: 'eye', onClick: () => v.fullscreen() })));
    }

    let progressEl = null;
    let stepperEl = null;
    function paintStepper() {
      if (!stepperEl) return;
      const fresh = stepper();
      stepperEl.replaceWith(fresh);
      stepperEl = fresh;
    }
    function paintProgress() {
      if (!progressEl) return;
      const pr = progress(wiz.checks, wiz.vendor || 'nvidia');
      progressEl.textContent = `${pr.done} von ${pr.total} Punkten erledigt`;
    }

    /** Schritt ist erledigt, wenn alle Haken gesetzt sind (Kontrolle: wenn ein Sturm-Test gespeichert ist). */
    function stepComplete(s) {
      const list = stepChecks(s, wiz.vendor || 'nvidia');
      if (!list.length) return s.id === 'kontrolle' ? stormTests.length > 0 && !!wiz.completedAt : false;
      return list.every((c) => wiz.checks[c.id]);
    }

    function stepper() {
      return h('div.mon-stepper', { role: 'tablist', 'aria-label': 'Schritte' }, STEPS.map((s, i) => {
        const complete = stepComplete(s);
        return h(`button.mon-step${i === wiz.step ? '.active' : ''}${complete ? '.done' : ''}`, {
          type: 'button', role: 'tab', 'aria-selected': String(i === wiz.step),
          title: complete ? `${s.title}: erledigt` : `${s.title}: noch offen`,
          onclick: () => goStep(i),
        }, h('span.mon-step-num', complete ? icon('check', 14) : String(i + 1)), h('span', s.title), complete ? h('span.mon-sr', '(erledigt)') : null);
      }));
    }

    function goStep(i) {
      wiz.step = Math.min(STEPS.length - 1, Math.max(0, i));
      saveProgress();
      renderBody();
      root.scrollTo?.({ top: 0 });
    }

    function vendorPicker() {
      const detected = gpu?.vendor;
      return h('div.mon-vendor-box', h('div.mon-vendor',
        h('div.segmented', { role: 'radiogroup', 'aria-label': 'Hersteller der Grafikkarte' }, VENDORS.map((v) => h(`button.seg${(wiz.vendor || 'nvidia') === v.id ? '.active' : ''}`, {
          type: 'button', role: 'radio', 'aria-checked': String((wiz.vendor || 'nvidia') === v.id),
          onclick: () => { wiz.vendor = v.id; saveProgress(); renderBody(); ui.toast(`Anleitung für ${v.label}.`, 'info', { timeout: 1600 }); },
        }, v.label))),
        gpu == null
          ? h('span.hint', 'Grafikkarte wird erkannt …')
          : gpu.unsupported
            ? ui.badge('Erkennung nur unter Windows', '')
            : detected
              ? ui.badge(`Erkannt: ${gpu.name || VENDORS.find((x) => x.id === detected)?.label}`, 'ok')
              : ui.badge('Nicht erkannt – bitte selbst wählen', 'warn')),
        h('p.hint', 'Zwei Grafikkarten? Es zählt die, an der dein Monitor steckt.'));
    }

    function brandTable() {
      return h('div.mon-brands',
        h('h4', 'Schwarz-Stabilisator je Marke'),
        h('div.table-wrap', h('table.table',
          h('thead', h('tr', h('th', 'Marke'), h('th', 'Name im Menü'), h('th', 'Startwert'))),
          h('tbody', BRANDS.map((b) => h('tr', h('td', b.brand), h('td', h('strong', b.name)), h('td.hint', b.tip)))))),
        h('p.hint', 'Je nach Modell anders. Ziel: Schwarzwert-Bild Stufe 3–4 gerade sichtbar.'));
    }

    function renderWizard() {
      const step = STEPS[wiz.step];
      progressEl = h('p.hint.mon-progress-text');
      const checks = stepChecks(step, wiz.vendor || 'nvidia');
      const parts = [
        wiz.completedAt
          ? h('div.callout.ok', icon('check'), h('div', h('strong', `Einrichtung abgeschlossen am ${ui.fmtDate(wiz.completedAt)}`), h('p.hint', 'Nach einem Treiber-Update lohnt sich ein neuer Durchgang.')))
          : null,
        (stepperEl = stepper()),
        progressEl,
        h('div.mon-step-body',
          h('h2', `${wiz.step + 1}. ${step.title}`),
          h('p.hint.mon-intro', step.intro),
          step.id === 'kontrolle'
            ? controlStep()
            : h('div.mon-step-grid',
              h('div.mon-step-main',
                step.id === 'treiber' ? vendorPicker() : null,
                winOnlyMsg && step.id === 'windows'
                  ? h('div.callout.warn', icon('info'), h('div', h('strong', 'Nur unter Windows'), h('p.hint', `${winOnlyMsg} Auf deinem Gaming-PC funktioniert der Knopf.`)))
                  : null,
                checks.length ? h('div.mon-checks', checks.map(checkRow)) : null,
                step.id === 'osd' ? brandTable() : null),
              h('aside.mon-step-side',
                step.patterns.length
                  ? [h('h4', 'Zum Prüfen'), h('div.mon-previews', step.patterns.map(previewCard))]
                  : h('div.callout.info', icon('info'), h('p.hint', 'Den Erfolg prüfst du im letzten Schritt mit dem Sturm-Test.'))))),
        h('div.mon-nav',
          ui.button('Zurück', { iconName: 'back', disabled: wiz.step === 0, onClick: () => goStep(wiz.step - 1) }),
          h('span.grow'),
          wiz.step < STEPS.length - 1
            ? ui.button(`Weiter: ${STEPS[wiz.step + 1].title}`, { variant: 'primary', iconName: 'chevron', onClick: () => goStep(wiz.step + 1) })
            : ui.button('Fertig', {
              variant: 'primary', iconName: 'check',
              onClick: async () => {
                if (!(await saveProgress(true))) return;
                ui.toast('Einrichtung abgeschlossen. Viel Erfolg im Sturm!');
                renderBody();
                root.scrollTo?.({ top: 0 });
              },
            })),
      ];
      requestAnimationFrame(paintProgress);
      return parts;
    }

    function controlStep() {
      // fest auf den Sturm-Test: Frage, Bewertung und „Lösung zeigen“ gehören zu diesem Bild
      const v = patternView({ pattern: 'sturm', fixed: true });
      return h('div.mon-step-grid.mon-control',
        h('div.mon-step-main', v.el,
          h('div.row', ui.button('Vollbild', { small: true, iconName: 'eye', onClick: () => v.fullscreen() }), h('span.hint', 'Im Vollbild ist der Test am ehrlichsten. Esc beendet es.'))),
        h('aside.mon-step-side',
          stormPanel(v, { onRated: () => { if (alive) paintStepper(); } }),
          h('p.hint', 'Weniger als die Hälfte? Schwarz-Stabilisator (Schritt 1) eine Stufe höher.')));
    }

    // ---------------- Rahmen ----------------
    const TABS = [['bilder', 'Testbilder', 'eye'], ['wizard', 'Geführte Einrichtung', 'sparkle']];
    function renderTabs() {
      ui.clear(tabs);
      for (const [id, label, ic] of TABS) {
        tabs.appendChild(h(`button.tab${tab === id ? '.active' : ''}`, {
          type: 'button', role: 'tab', 'aria-selected': String(tab === id),
          onclick: () => { if (tab === id) return; tab = id; renderTabs(); renderBody(); },
        }, icon(ic, 16), h('span', label)));
      }
    }

    function renderBody() {
      if (!alive) return;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      clearViews();
      ui.mount(body, tab === 'wizard' ? renderWizard() : renderPatterns());
    }

    renderTabs();
    renderBody();

    // Grafikkarte erkennen (für die passende Treiber-Anleitung)
    env.call('monitor.detectGpu').catch(() => ({ vendor: null, failed: true })).then((g) => {
      if (!alive) return;
      gpu = g || { vendor: null };
      if (!wiz.vendor && gpu.vendor) wiz.vendor = gpu.vendor;
      if (tab === 'wizard' && STEPS[wiz.step].id === 'treiber') renderBody();
    });
  },

  unmount() {
    for (const f of cleanup) { try { f(); } catch { /* egal */ } }
    cleanup = [];
  },
};
