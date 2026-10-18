// Maus-Check: Windows-Zeigergeschwindigkeit und -beschleunigung, Fortnites Mausbeschleunigung,
// Abfragerate (pointerrawupdate) und DPI (Zeigersperre) messen. Alles nur im HELIX-Fenster.

import {
  NEED_MOVE_MS, RULER_CM, CARD_CM, RUNS,
  analyzePolling, movingTime, pollingAdvice, evaluateDpi, moveLength, buildChecklist, classifyLabel, fmtInt, fmtDec,
} from '../lib/maus-measure.mjs';

let cleanup = [];

const MIN_RUN_COUNTS = 100;
const POLL_TIMEOUT_MS = 30000;

/** Zeigersperre mit Rohdaten (ohne Windows-Beschleunigung). Gibt true zurück, wenn Rohdaten möglich sind. */
async function lockRaw(el) {
  try {
    await el.requestPointerLock({ unadjustedMovement: true });
    return true;
  } catch (e) {
    if (e && e.name === 'NotSupportedError') {
      await el.requestPointerLock();
      return false;
    }
    throw e;
  }
}

export default {
  async mount(root, env) {
    const ui = env.ui;
    const { h, icon } = ui;

    let alive = true;
    let tab = 'overview';
    let status = null;
    let fn = null;
    let fnRunning = false;
    let pollLast = null; // letzte Messung (diese Sitzung oder gespeichert)
    let measure = null; // laufende Messung: { kind, stop() }
    let lastUnlockAt = 0;
    const dpi = { cm: RULER_CM, runs: [], raw: null, result: null, phase: 'idle', drag: null, pad: null, update: null };

    const tabs = h('div.tabs', { role: 'tablist' });
    const body = h('div.tab-body');
    root.append(tabs, body);

    const TABS = [
      ['overview', 'Einstellungen', 'settings'],
      ['polling', 'Abfragerate', 'clock'],
      ['dpi', 'DPI messen', 'eye'],
    ];

    function renderTabs() {
      ui.clear(tabs);
      for (const [id, label, ic] of TABS) {
        tabs.appendChild(h(`button.tab${tab === id ? '.active' : ''}`, {
          type: 'button', role: 'tab', 'aria-selected': String(tab === id),
          onclick: () => { if (tab === id) return; stopMeasure(); tab = id; renderTabs(); render(); },
        }, icon(ic, 16), h('span', label)));
      }
    }

    function stopMeasure() {
      if (measure) { try { measure.stop(); } catch { /* egal */ } }
      measure = null;
    }

    // ---------------------------------------------------------------- Daten laden

    async function loadStatus() {
      try {
        status = await env.call('maus.status');
        pollLast = pollLast || status.tests?.polling || null;
      } catch (e) {
        status = null;
        ui.showError(e, 'Mauswerte konnten nicht gelesen werden');
      }
    }

    async function loadFortnite() {
      try {
        fn = await env.call('maus.fortniteAccel');
        fnRunning = !!fn.fortniteRunning;
      } catch (e) {
        fn = { found: false, error: e.message };
      }
    }

    // ---------------------------------------------------------------- Bausteine

    function stateIcon(state) {
      return h(`span.state-ic.${state}`, icon(state === 'ok' ? 'check' : state === 'warn' ? 'warn' : 'info', 16));
    }

    function settingRow(label, value, ok, hint, mono) {
      const badge = ok === null || ok === undefined ? ui.badge('unbekannt', '') : ui.badge(ok ? 'passt' : 'ändern empfohlen', ok ? 'ok' : 'warn');
      return h('div.set-row',
        stateIcon(ok === null || ok === undefined ? 'open' : ok ? 'ok' : 'warn'),
        h('div.grow', h('span.set-label', label), h('p.hint', hint), mono ? h('span.hint.mono', mono) : null),
        h('strong.set-value', value),
        badge);
    }

    function factorText(f) {
      if (!Number.isFinite(f) || f === 1) return '';
      if (f < 1) return `Bei deiner Stufe läuft der Zeiger nur etwa ${fmtDec(f, 2)}-mal so weit wie die Maus meldet – dabei gehen kleine Bewegungen verloren.`;
      return `Bei deiner Stufe rechnet Windows jede Bewegung etwa ${fmtDec(f, 2)}-fach hoch – der Zeiger springt dabei über Pixel.`;
    }

    // ---------------------------------------------------------------- Übersicht

    function checklistBlock() {
      const c = buildChecklist({ windows: status?.windows || null, fortnite: fn, polling: pollLast, unsupported: !!status?.unsupported });
      const BADGE = { ok: ['passt', 'ok'], warn: ['ändern empfohlen', 'warn'], open: ['noch offen', ''] };
      return ui.section('So steht deine Maus', `${c.done} von ${c.total} Punkten passen. Grün heißt: alles gut. Orange heißt: hier lohnt sich eine Änderung.`,
        h('ul.list.check-list', c.items.map((it) => {
          const [t, cls] = BADGE[it.state];
          return h('li', stateIcon(it.state),
            h('div.grow', h('strong', it.title), h('span.hint', it.text)),
            h('span.check-now', it.now),
            ui.badge(t, cls));
        })));
    }

    function windowsBlock() {
      const title = 'Windows-Maus';
      if (!status) {
        return ui.section(title, null, ui.emptyState({
          title: 'Mauswerte nicht lesbar',
          text: 'HELIX konnte die Windows-Mauseinstellungen gerade nicht lesen.',
          action: ui.button('Erneut versuchen', { iconName: 'refresh', onClick: async () => { await loadStatus(); render(); ui.toast('Erneut gelesen.', 'info'); } }),
        }));
      }
      if (status.unsupported) {
        return ui.section(title, null, h('div.callout.info', icon('info'), h('div',
          h('strong', 'Nur unter Windows'),
          h('p.hint', 'Zeigergeschwindigkeit und Zeigerbeschleunigung kann HELIX nur unter Windows lesen und ändern. Die Messungen für Abfragerate und DPI gehen trotzdem.'))));
      }
      const w = status.windows;
      const rows = h('div.set-rows',
        settingRow('Zeigergeschwindigkeit', `Stufe ${w.speed.label}`, w.speed.ok,
          w.speed.ok ? 'Standard und empfohlen: Jede Mausbewegung wird 1:1 umgesetzt.' : `Empfohlen ist Stufe 6/11. ${factorText(w.speed.factor)}`.trim(),
          `MouseSensitivity=${w.speed.value}`),
        settingRow('Zeigerbeschleunigung verbessern', w.accel.on ? 'an' : 'aus', w.accel.ok,
          w.accel.on ? 'Windows schickt den Zeiger bei schnellen Bewegungen extra weit. So fühlt sich jeder Schwung anders an.' : 'Gut: Gleiche Handbewegung heißt gleicher Weg auf dem Bildschirm.',
          `MouseSpeed=${w.accel.mouseSpeed} · MouseThreshold1=${w.accel.threshold1} · MouseThreshold2=${w.accel.threshold2}`));
      const note = h('div.callout.info', icon('info'), h('div',
        h('strong', 'Gut zu wissen'),
        h('p.hint', 'Beim Zielen liest Fortnite die Maus direkt aus („Raw Input“, also ohne Windows dazwischen). Diese Windows-Werte wirken deshalb vor allem im Menü und auf dem Desktop. Mit 6/11 und ohne Beschleunigung fühlt sich die Maus überall gleich an – und die Messungen hier stimmen.')));
      const actions = h('div.row',
        ui.button(w.allOk ? 'Schon optimal' : 'Empfohlene Werte setzen', { variant: 'primary', iconName: 'check', disabled: w.allOk, onClick: fixWindows }),
        status.undo ? ui.button('Rückgängig', { iconName: 'refresh', onClick: undoWindows, title: 'Alte Werte wiederherstellen' }) : null,
        ui.button('Windows-Mauseinstellungen öffnen', { variant: 'ghost', iconName: 'settings', onClick: openWinSettings }));
      const undoHint = status.undo
        ? h('p.hint', `„Rückgängig“ holt die Werte von vor der Änderung am ${ui.fmtDate(status.undo.at)} zurück.`)
        : h('p.hint', 'HELIX merkt sich vor jeder Änderung die alten Werte. Du kannst sie mit einem Klick zurückholen.');
      return ui.section(title, 'Gelesen aus deinem Benutzerkonto. Ändern braucht keine Administratorrechte und wirkt sofort.', rows, note, actions, undoHint);
    }

    function fortniteBlock() {
      const title = 'Fortnite';
      const top = 'Fortnite speichert in seiner Datei GameUserSettings.ini, ob es eine eigene Mausbeschleunigung abschaltet.';
      if (!fn) return ui.section(title, top, h('div.loading', ui.spinner()));
      if (!fn.found) {
        return ui.section(title, top,
          h('div.callout.warn', icon('warn'), h('div',
            h('strong', fn.noFolder ? 'Fortnite-Ordner nicht gefunden' : 'GameUserSettings.ini nicht gefunden'),
            h('p.hint', fn.error || 'Starte Fortnite einmal und schließe es wieder. Dann legt Fortnite die Datei an.'))),
          h('div.row', ui.button('Erneut prüfen', { iconName: 'refresh', small: true, onClick: async () => { await loadFortnite(); render(); ui.toast('Erneut geprüft.', 'info'); } })));
      }
      const off = fn.disabled === true;
      const unknown = fn.disabled === null || fn.disabled === undefined;
      const row = settingRow('Mausbeschleunigung in Fortnite', unknown ? 'nicht eingetragen' : off ? 'aus' : 'an', unknown ? null : off,
        off ? 'Gut: Fortnite rechnet nichts auf deine Bewegung drauf.' : 'Empfohlen: aus. Dann geht gleiche Handbewegung immer gleich weit.',
        `bDisableMouseAcceleration=${fn.value ?? '–'}`);
      const actions = h('div.row', off
        ? ui.button('Wieder einschalten', { variant: 'ghost', small: true, disabled: fnRunning, onClick: () => setFortnite(false) })
        : ui.button('In Fortnite ausschalten', { variant: 'primary', iconName: 'check', disabled: fnRunning, onClick: () => setFortnite(true) }));
      return ui.section(title, top, row,
        fnRunning ? h('div.callout.warn', icon('warn'), h('div', h('strong', 'Fortnite läuft gerade'), h('p.hint', 'Schließe Fortnite. Danach kannst du den Wert hier ändern – sonst überschreibt Fortnite ihn beim Beenden.'))) : null,
        actions,
        h('p.hint', 'Vor jeder Änderung legt HELIX automatisch eine Sicherung an. Du findest sie bei Settings-Profile → Zeitmaschine.'),
        fn.readOnly ? h('p.hint', 'Die Datei ist schreibgeschützt. HELIX ändert nur diesen einen Wert und lässt den Schreibschutz danach wieder an.') : null);
    }

    async function fixWindows() {
      const w = status.windows;
      let speed = !w.speed.ok;
      let accel = !w.accel.ok;
      const content = [
        h('p', 'HELIX stellt Folgendes für dein Benutzerkonto ein:'),
        !w.speed.ok ? ui.toggle({ label: `Zeigergeschwindigkeit: ${w.speed.label} → 6/11`, hint: 'Der Windows-Standard. Jede Mausbewegung wird 1:1 umgesetzt.', checked: true, onChange: (v) => { speed = v; } }) : null,
        !w.accel.ok ? ui.toggle({ label: 'Zeigerbeschleunigung verbessern: an → aus', hint: 'Gleiche Handbewegung, gleicher Weg – egal wie schnell du bist.', checked: true, onChange: (v) => { accel = v; } }) : null,
        h('p.hint', 'Die alten Werte merkt sich HELIX. Mit „Rückgängig“ kommen sie zurück.'),
      ];
      const r = await ui.modal({
        title: 'Empfohlene Mauswerte setzen?',
        content,
        actions: [{ label: 'Abbrechen', value: null }, { label: 'Jetzt setzen', value: 'go', variant: 'primary' }],
      });
      if (r !== 'go') return;
      if (!speed && !accel) { ui.toast('Nichts ausgewählt – es wurde nichts geändert.', 'info'); return; }
      try {
        const res = await env.call('maus.fix', { speed, accel });
        status = res.status;
        if (res.alreadyOk) ui.toast('Die Werte waren schon richtig. Nichts geändert.', 'info');
        else if (res.live) ui.toast('Erledigt. Die neuen Mauswerte wirken ab sofort.');
        else ui.toast(res.liveError || 'Gespeichert. Wirkt nach dem nächsten Abmelden.', 'warn', { timeout: 7000 });
      } catch (e) { ui.showError(e); }
      render();
    }

    async function undoWindows() {
      const ok = await ui.confirmDialog({
        title: 'Alte Mauswerte zurückholen?',
        text: `Windows bekommt wieder die Mauswerte von vor der Änderung am ${ui.fmtDate(status.undo.at)}.`,
        confirmLabel: 'Zurückholen',
      });
      if (!ok) return;
      try {
        const res = await env.call('maus.undo');
        status = res.status;
        if (res.live) ui.toast('Die alten Mauswerte sind zurück.');
        else ui.toast(res.liveError || 'Gespeichert. Wirkt nach dem nächsten Abmelden.', 'warn', { timeout: 7000 });
      } catch (e) { ui.showError(e); }
      render();
    }

    async function openWinSettings() {
      try {
        await env.call('app.openWindowsSettings', { uri: 'ms-settings:mousetouchpad' });
        ui.toast('Windows-Mauseinstellungen geöffnet. „Zeigerbeschleunigung verbessern“ steht unter „Weitere Mauseinstellungen“.', 'info', { timeout: 6000 });
      } catch (e) { ui.showError(e); }
    }

    async function setFortnite(disable) {
      try {
        const res = await env.call('maus.fixFortniteAccel', { disable });
        fn = res;
        fnRunning = !!res.fortniteRunning;
        if (!res.applied?.length) ui.toast('Der Wert war schon so eingestellt.', 'info');
        else ui.toast(disable ? 'Mausbeschleunigung in Fortnite ist jetzt aus. Eine Sicherung liegt in der Zeitmaschine.' : 'Mausbeschleunigung in Fortnite ist wieder an.');
      } catch (e) {
        if (e.code === 'FORTNITE_RUNNING') fnRunning = true;
        ui.showError(e);
      }
      render();
    }

    // ---------------------------------------------------------------- Abfragerate

    function pollingTab() {
      const padMsg = h('p.pad-msg', 'Klicke auf „Messung starten“. Bewege dann die Maus hier im Feld schnell im Kreis, bis der Balken voll ist.');
      const live = h('p.hint.pad-live', ' ');
      const fill = h('div.progress-fill');
      const bar = h('div.progress', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': 'Fortschritt der Messung' }, fill);
      const pad = h('div.pad', { 'aria-live': 'polite' }, padMsg, live, bar);
      const resultBox = h('div.result-box');
      const startBtn = ui.button('Messung starten', { variant: 'primary', iconName: 'play', onClick: () => start() });
      const cancelBtn = ui.button('Abbrechen', { variant: 'ghost', iconName: 'x', onClick: () => cancel(true) });
      cancelBtn.hidden = true;

      function setProgress(p) {
        const pct = Math.max(0, Math.min(100, Math.round(p * 100)));
        fill.style.width = `${pct}%`;
        bar.setAttribute('aria-valuenow', String(pct));
      }

      function showResult(r) {
        ui.clear(resultBox);
        if (!r) return;
        const adv = pollingAdvice(r);
        ui.mount(resultBox,
          h('div.stat-row',
            h('div.stat', h('span.hint', 'Gemessen'), h('strong', `${Math.round(r.hz)} Hz`)),
            h('div.stat', h('span.hint', 'Das entspricht'), h('strong', classifyLabel(r.cls))),
            h('div.stat', h('span.hint', 'Abstand zwischen zwei Meldungen'), h('strong', r.medianMs == null ? '–' : `${fmtDec(r.medianMs, 2)} ms`)),
            h('div.stat', h('span.hint', 'Messpunkte'), h('strong', fmtInt(r.samples)))),
          h(`div.callout.${adv.tone}`, icon(adv.tone === 'ok' ? 'check' : 'warn'), h('div', h('strong', adv.tone === 'ok' ? 'Passt' : 'Tipp'), h('p.hint', adv.text))),
          r.stable === false && r.cls !== 'low' ? h('p.hint', 'Die Abstände waren unruhig. Miss noch einmal und bewege die Maus gleichmäßig schnell.') : null);
      }

      function cancel(byUser) {
        stopMeasure();
        startBtn.hidden = false;
        cancelBtn.hidden = true;
        pad.classList.remove('active');
        padMsg.textContent = 'Klicke auf „Messung starten“. Bewege dann die Maus hier im Feld schnell im Kreis, bis der Balken voll ist.';
        live.textContent = ' ';
        setProgress(0);
        if (byUser) ui.toast('Messung abgebrochen.', 'info');
      }

      function start() {
        stopMeasure();
        ui.clear(resultBox);
        const ts = [];
        const useRaw = 'onpointerrawupdate' in window;
        const evName = useRaw ? 'pointerrawupdate' : 'pointermove';
        const t0 = performance.now();
        let raf = 0;
        let lastUi = 0;
        const onMove = (e) => {
          const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
          for (const c of (list.length ? list : [e])) {
            if (c.movementX || c.movementY) ts.push(c.timeStamp);
          }
        };
        pad.addEventListener(evName, onMove);
        pad.classList.add('active');
        startBtn.hidden = true;
        cancelBtn.hidden = false;
        padMsg.textContent = 'Jetzt die Maus hier im Feld schnell im Kreis bewegen …';
        setProgress(0);
        const finish = async () => {
          stopMeasure();
          const r = analyzePolling(ts);
          startBtn.hidden = false;
          cancelBtn.hidden = true;
          pad.classList.remove('active');
          setProgress(1);
          padMsg.textContent = 'Fertig. Du kannst jederzeit noch einmal messen.';
          live.textContent = ' ';
          if (startBtn.querySelector('span')) startBtn.querySelector('span').textContent = 'Noch einmal messen';
          showResult(r);
          if (r.cls === 'low' || !r.enough) { ui.toast('Zu wenige Messpunkte. Bitte noch einmal und schneller bewegen.', 'warn'); return; }
          pollLast = r;
          try {
            const res = await env.call('maus.saveTest', { kind: 'polling', result: { hz: r.hz, medianMs: r.medianMs ?? 0, samples: r.samples, durationMs: r.durationMs, cls: r.cls, stable: r.stable } });
            if (status) status.tests = res.tests;
            ui.toast(`Abfragerate gemessen: ${classifyLabel(r.cls)}.`);
            if (alive && tab === 'polling') renderHistory();
          } catch (e) { ui.showError(e, 'Ergebnis nicht gespeichert'); }
        };
        const tick = (now) => {
          if (now - lastUi > 120) {
            lastUi = now;
            const m = movingTime(ts);
            setProgress(m.ms / NEED_MOVE_MS);
            live.textContent = ts.length ? `${fmtInt(ts.length)} Meldungen empfangen` : 'Warte auf Bewegung …';
            if (m.ms >= NEED_MOVE_MS) { finish(); return; }
            if (now - t0 > POLL_TIMEOUT_MS) {
              cancel(false);
              ui.toast('Die Messung hat zu lange gedauert. Bewege die Maus ohne Pause im Feld und versuch es noch einmal.', 'warn');
              return;
            }
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        measure = { kind: 'polling', stop: () => { pad.removeEventListener(evName, onMove); cancelAnimationFrame(raf); } };
      }

      const history = h('div.poll-history');
      function renderHistory() {
        ui.clear(history);
        const list = (status?.tests?.pollingHistory || []).slice().reverse();
        if (!list.length) return;
        history.append(h('h4', 'Letzte Messungen'), h('ul.list.compact', list.map((x) => h('li',
          icon('clock', 16), h('div.grow', h('span', `${x.hz} Hz – entspricht ${classifyLabel(x.cls)}`), h('span.hint', ui.fmtAgo(x.at)))))));
      }
      renderHistory();
      if (pollLast) showResult(pollLast.samples ? pollLast : null);

      return [
        ui.section('Abfragerate messen', 'Die Abfragerate (Polling Rate) sagt, wie oft die Maus pro Sekunde ihre Position an den PC meldet. Mehr Meldungen = flüssigeres Zielen.',
          pad,
          h('div.row', startBtn, cancelBtn, h('span.hint', 'Dauert etwa 3 Sekunden Bewegung. Pausen werden nicht mitgezählt.')),
          resultBox),
        h('div.callout.info', icon('info'), h('div',
          h('strong', 'Ehrlich gesagt'),
          h('p.hint', 'Ein Programmfenster misst nur, was bei ihm ankommt. Bis etwa 1000 Hz ist das verlässlich. Höhere Werte (2000, 4000 oder 8000 Hz) kann es nicht genau messen – die echte Einstellung steht dann in der Software deiner Maus.'))),
        history,
      ];
    }

    // ---------------------------------------------------------------- DPI

    function dpiTab() {
      const seg = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Strecke' },
        [[RULER_CM, 'Lineal: 10 cm'], [CARD_CM, 'Bankkarte: 8,56 cm']].map(([cm, label]) => h(`button.seg${dpi.cm === cm ? '.active' : ''}`, {
          type: 'button', role: 'radio', 'aria-checked': String(dpi.cm === cm),
          disabled: dpi.phase !== 'idle' && dpi.phase !== 'done',
          onclick: () => { dpi.cm = cm; dpi.runs = []; dpi.result = null; dpi.phase = 'idle'; render(); ui.toast(`Strecke: ${label.split(': ')[1]}.`, 'info', { timeout: 2000 }); },
        }, label)));
      const cmText = dpi.cm === RULER_CM ? '10 cm' : '8,56 cm';
      const padMsg = h('p.pad-msg');
      const live = h('p.hint.pad-live', ' ');
      const runsRow = h('div.run-dots');
      const pad = h('div.pad.dpi-pad', { 'aria-live': 'polite' }, padMsg, live, runsRow);
      dpi.pad = pad;
      const resultBox = h('div.result-box');
      const startBtn = ui.button(dpi.runs.length || dpi.result ? 'Neu messen' : 'Messung starten', { variant: 'primary', iconName: 'play', onClick: () => start() });

      function update() {
        if (!alive) return;
        const n = dpi.runs.length;
        const msg = {
          idle: `Lege ein Lineal (oder eine Bankkarte) neben die Maus und klicke auf „Messung starten“.`,
          locking: 'Einen Moment …',
          ready: `Messung ${n + 1} von ${RUNS}: Linke Maustaste gedrückt halten, Maus genau ${cmText} nach rechts schieben, loslassen.`,
          dragging: `Messung ${n + 1} von ${RUNS}: Weiter schieben – bei ${cmText} loslassen.`,
          done: 'Fertig. Das Ergebnis steht unten.',
        }[dpi.phase] || '';
        padMsg.textContent = msg;
        live.textContent = dpi.phase === 'dragging' && dpi.drag ? `${fmtInt(moveLength(dpi.drag.dx, dpi.drag.dy))} Schritte` : (dpi.phase === 'ready' || dpi.phase === 'locking') ? 'Esc bricht ab.' : ' ';
        pad.classList.toggle('active', dpi.phase === 'ready' || dpi.phase === 'dragging');
        ui.clear(runsRow);
        for (let i = 0; i < RUNS; i++) {
          const c = dpi.runs[i];
          runsRow.append(h(`span.run-dot${c ? '.done' : ''}`, c ? `${i + 1}: ${fmtInt(c)} Schritte` : `${i + 1}: offen`));
        }
        startBtn.disabled = dpi.phase === 'locking' || dpi.phase === 'ready' || dpi.phase === 'dragging';
      }
      dpi.update = update;

      function showResult() {
        ui.clear(resultBox);
        const r = dpi.result;
        if (!r) return;
        ui.mount(resultBox,
          h('div.stat-row',
            h('div.stat', h('span.hint', 'Geschätzte DPI'), h('strong', fmtInt(r.dpi))),
            h('div.stat', h('span.hint', 'Wahrscheinlich eingestellt'), h('strong', r.nearest ? `${fmtInt(r.nearest.value)} DPI` : 'kein üblicher Wert')),
            h('div.stat', h('span.hint', 'Unterschied der 3 Messungen'), h('strong', `${fmtDec(r.spreadPct, 0)} %`))),
          !r.plausible
            ? h('div.callout.warn', icon('warn'), h('div', h('strong', 'Der Wert ist sehr ungewöhnlich'), h('p.hint', `Mäuse haben meist zwischen 400 und 3200 DPI. Hast du die Maus wirklich die ganzen ${cmText} geschoben? Miss bitte noch einmal.`)))
            : r.consistent
            ? h('div.callout.ok', icon('check'), h('div', h('strong', 'Messung passt'), h('p.hint', `Trag ${r.nearest ? fmtInt(r.nearest.value) : fmtInt(r.dpi)} DPI in der Sensi-Kalibrierung ein. Weicht das stark von der Angabe deiner Maus ab, nimm lieber die Herstellerangabe.`)))
            : h('div.callout.warn', icon('warn'), h('div', h('strong', 'Die Messungen weichen stark ab'), h('p.hint', 'Miss noch einmal langsam und genau entlang der Kante. Die Maus nicht anheben.'))),
          dpi.raw === false ? h('p.hint', 'Dein System liefert hier keine Rohdaten. Schalte im Reiter „Einstellungen“ die Zeigerbeschleunigung aus, sonst stimmt die Schätzung nicht.') : null,
          h('div.row', ui.button('Zur Sensi-Kalibrierung', { iconName: 'chevron', small: true, onClick: () => env.nav.go('sensi') })));
      }

      async function start() {
        stopMeasure();
        dpi.runs = [];
        dpi.result = null;
        dpi.drag = null;
        dpi.phase = 'locking';
        ui.clear(resultBox);
        update();
        measure = { kind: 'dpi', stop: () => { dpi.drag = null; if (document.pointerLockElement) document.exitPointerLock(); } };
        try {
          dpi.raw = await lockRaw(pad);
          if (document.pointerLockElement === pad && dpi.phase === 'locking') { dpi.phase = 'ready'; update(); }
        } catch {
          measure = null;
          dpi.phase = 'idle';
          update();
          ui.toast('Der Mauszeiger konnte nicht gesperrt werden. Klicke noch einmal auf „Messung starten“.', 'warn');
        }
      }

      pad.addEventListener('mousedown', (e) => {
        if (document.pointerLockElement !== pad || e.button !== 0 || dpi.phase !== 'ready') return;
        e.preventDefault();
        dpi.drag = { dx: 0, dy: 0 };
        dpi.phase = 'dragging';
        update();
      });
      pad.addEventListener('mousemove', (e) => {
        if (!dpi.drag || document.pointerLockElement !== pad) return;
        dpi.drag.dx += e.movementX || 0;
        dpi.drag.dy += e.movementY || 0;
        if (live.isConnected) live.textContent = `${fmtInt(moveLength(dpi.drag.dx, dpi.drag.dy))} Schritte`;
      });
      pad.addEventListener('mouseup', async (e) => {
        if (!dpi.drag || e.button !== 0) return;
        const counts = moveLength(dpi.drag.dx, dpi.drag.dy);
        dpi.drag = null;
        if (counts < MIN_RUN_COUNTS) {
          dpi.phase = 'ready';
          update();
          ui.toast('Das war zu kurz. Schieb die Maus die ganze Strecke.', 'warn', { timeout: 3000 });
          return;
        }
        dpi.runs.push(Math.round(counts));
        if (dpi.runs.length < RUNS) {
          dpi.phase = 'ready';
          update();
          ui.toast(`Messung ${dpi.runs.length} gespeichert. Maus zurücklegen und noch einmal.`, 'info', { timeout: 2500 });
          return;
        }
        dpi.phase = 'done';
        measure = null;
        if (document.pointerLockElement) document.exitPointerLock();
        dpi.result = evaluateDpi(dpi.runs, dpi.cm);
        update();
        showResult();
        if (startBtn.querySelector('span')) startBtn.querySelector('span').textContent = 'Neu messen';
        try {
          const res = await env.call('maus.saveTest', { kind: 'dpi', result: { dpi: dpi.result.dpi, cm: dpi.cm, runs: dpi.runs, nearest: dpi.result.nearest?.value ?? null, raw: dpi.raw !== false } });
          if (status) status.tests = res.tests;
          ui.toast(`DPI gemessen: etwa ${fmtInt(dpi.result.dpi)}.`);
        } catch (err) { ui.showError(err, 'Ergebnis nicht gespeichert'); }
      });

      update();
      showResult();
      const lastSaved = status?.tests?.dpi;
      return [
        ui.section('DPI messen', 'DPI sagt, wie viele Schritte die Maus pro Zoll (2,54 cm) meldet. Du brauchst den Wert für die Sensi-Kalibrierung.',
          h('ol.steps',
            h('li', 'Lege ein Lineal oder eine Bankkarte flach neben die Maus.'),
            h('li', 'Klicke auf „Messung starten“. Der Mauszeiger verschwindet – das ist gewollt.'),
            h('li', `Linke Maustaste gedrückt halten, die Maus genau ${cmText} nach rechts schieben und loslassen.`),
            h('li', `Das Ganze ${RUNS}-mal. HELIX nimmt den Durchschnitt.`)),
          h('div.field', h('label', 'Strecke'), seg, h('p.hint', 'Eine Bank- oder Ausweiskarte ist überall genau 8,56 cm breit – praktisch, wenn kein Lineal da ist.')),
          pad,
          h('div.row', startBtn, h('span.hint', 'Esc bricht die Messung ab.')),
          resultBox),
        !dpi.result && lastSaved ? h('p.hint', `Letzte Messung: etwa ${fmtInt(lastSaved.dpi)} DPI (${ui.fmtAgo(lastSaved.at)}).`) : null,
        h('div.callout.info', icon('info'), h('div',
          h('strong', 'Ehrlich gesagt'),
          h('p.hint', 'Das ist eine Schätzung (etwa ±10 %). Genau ist nur, was in der Software deiner Maus steht. Die Messung hilft, wenn du deine DPI gar nicht kennst.'))),
      ];
    }

    // ---------------------------------------------------------------- Ereignisse

    const onKeyCapture = (e) => {
      if (e.key !== 'Escape') return;
      const busy = measure || dpi.phase === 'locking' || dpi.phase === 'ready' || dpi.phase === 'dragging';
      if (!busy && Date.now() - lastUnlockAt > 600) return;
      // Esc beendet nur die Messung, nicht gleich das ganze Tool
      e.stopPropagation();
      e.preventDefault();
      if (busy) {
        const wasDpi = measure?.kind === 'dpi' || dpi.phase !== 'idle';
        stopMeasure();
        if (wasDpi && dpi.phase !== 'done') { dpi.phase = 'idle'; dpi.runs = []; dpi.update?.(); }
        if (tab === 'polling') render();
        ui.toast('Messung abgebrochen.', 'info');
      }
    };
    const onLockChange = () => {
      if (document.pointerLockElement && document.pointerLockElement === dpi.pad) {
        if (dpi.phase === 'locking') { dpi.phase = 'ready'; dpi.update?.(); }
        return;
      }
      lastUnlockAt = Date.now();
      if (dpi.phase === 'locking' || dpi.phase === 'ready' || dpi.phase === 'dragging') {
        dpi.phase = 'idle';
        dpi.runs = [];
        dpi.drag = null;
        if (measure?.kind === 'dpi') measure = null;
        dpi.update?.();
        ui.toast('Messung abgebrochen. Der Mauszeiger ist wieder frei.', 'info');
      }
    };
    window.addEventListener('keydown', onKeyCapture, true);
    document.addEventListener('pointerlockchange', onLockChange);
    const offFn = env.on('fortnite.state', async (st) => {
      fnRunning = !!st?.running;
      if (alive && tab === 'overview') { await loadFortnite(); if (alive && tab === 'overview') render(); }
    });

    cleanup = [
      () => { alive = false; },
      () => stopMeasure(),
      () => { if (document.pointerLockElement) document.exitPointerLock(); },
      () => window.removeEventListener('keydown', onKeyCapture, true),
      () => document.removeEventListener('pointerlockchange', onLockChange),
      offFn,
    ];

    // ---------------------------------------------------------------- Aufbau

    function render() {
      if (!alive) return;
      const nodes = tab === 'polling' ? pollingTab() : tab === 'dpi' ? dpiTab() : [checklistBlock(), windowsBlock(), fortniteBlock()];
      ui.mount(body, nodes);
    }

    renderTabs();
    ui.mount(body, h('div.loading', ui.spinner()));
    await Promise.all([loadStatus(), loadFortnite()]);
    render();
  },

  unmount() {
    for (const f of cleanup) { try { f(); } catch { /* egal */ } }
    cleanup = [];
  },
};
