// Reaktions-Labor: Reaktionstest (Fläche wird hell -> klicken) und Trainer für deine Bau-/Edit-Tasten.
// Es wird nur innerhalb des HELIX-Fensters gehört – keine globalen Tastatur-Hooks, nichts im Spiel.

import {
  ROUNDS, PROMPTS, PROMPT_TIMEOUT_MS, MAX_REACTION_MS, ACTIONS, actionById, defaultBinds, normalizeBinds, codeLabel, bindFromEvent,
  findDuplicates, activeActions, actionForCode, trainingBlocker, randomDelay, randomGap, makeSequence, classifyPress,
  evaluateReaction, rateReaction, evaluateKeys, rateKeys, keysTip, trend, bars,
} from '../lib/reaktion-logic.mjs';

let cleanup = [];

const PREF_KEY = 'helix.reaktion.showKeys';
function readPref() {
  try { return localStorage.getItem(PREF_KEY) !== '0'; } catch { return true; }
}
function writePref(v) {
  try { localStorage.setItem(PREF_KEY, v ? '1' : '0'); } catch { /* egal */ }
}

export default {
  async mount(root, env) {
    const ui = env.ui;
    const { h, icon } = ui;

    let alive = true;
    let tab = 'reaction';
    let st = null;
    let binds = defaultBinds();
    let active = null; // laufende Sache: { kind, onKey(e), stop() }
    let showKeys = readPref();

    // Timer zentral verwalten, damit beim Verlassen nichts weiterläuft
    const timers = new Set();
    const rafs = new Set();
    const later = (fn, ms) => {
      const id = setTimeout(() => { timers.delete(id); if (alive) fn(); }, ms);
      timers.add(id);
      return id;
    };
    const cancelLater = (id) => { if (id) { clearTimeout(id); timers.delete(id); } };
    const frame = (fn) => {
      const id = requestAnimationFrame((t) => { rafs.delete(id); if (alive) fn(t); });
      rafs.add(id);
      return id;
    };

    function stopActive() {
      if (active) { try { active.stop?.(); } catch { /* egal */ } }
      active = null;
    }

    const tabs = h('div.tabs', { role: 'tablist' });
    const body = h('div.tab-body');
    root.append(tabs, body);
    const TABS = [
      ['reaction', 'Reaktionstest', 'clock'],
      ['keys', 'Tasten-Trainer', 'sparkle'],
      ['history', 'Verlauf', 'refresh'],
    ];
    function renderTabs() {
      ui.clear(tabs);
      for (const [id, label, ic] of TABS) {
        tabs.appendChild(h(`button.tab${tab === id ? '.active' : ''}`, {
          type: 'button', role: 'tab', 'aria-selected': String(tab === id),
          onclick: () => { if (tab === id) return; stopActive(); tab = id; renderTabs(); render(); },
        }, icon(ic, 16), h('span', label)));
      }
    }

    async function loadState() {
      try {
        st = await env.call('reaktion.getState');
        binds = normalizeBinds(st.binds);
      } catch (e) {
        st = null;
        ui.showError(e, 'Verlauf konnte nicht geladen werden');
      }
    }

    // Tastatur: ein zentraler Empfänger in der Einfang-Phase. Nur Ereignisse im HELIX-Fenster.
    const onKey = (e) => {
      if (!alive || !active || !active.onKey) return;
      if (document.querySelector('.overlay')) return; // ein Dialog ist offen
      active.onKey(e);
    };
    window.addEventListener('keydown', onKey, true);

    // ---------------------------------------------------------------- Reaktionstest

    function reactionTab() {
      const title = h('div.arena-title');
      const sub = h('div.arena-sub');
      const arena = h('div.arena', { tabindex: '0', role: 'button', 'aria-label': 'Reaktionsfläche – klicken oder Leertaste' }, title, sub);
      const slots = h('div.round-slots');
      const resultBox = h('div.result-box');
      let phase = 'idle';
      let times = [];
      let falseStarts = 0;
      let timer = null;
      let goAt = 0;
      let readyAt = 0;

      function setPhase(p, t, s) {
        phase = p;
        arena.className = `arena ${p}`;
        title.textContent = t;
        sub.textContent = s || '';
      }

      function renderSlots() {
        ui.clear(slots);
        for (let i = 0; i < ROUNDS; i++) {
          const v = times[i];
          slots.append(h(`span.slot${Number.isFinite(v) ? '.done' : ''}`, h('span.hint', `Runde ${i + 1}`), h('strong', Number.isFinite(v) ? `${Math.round(v)} ms` : '–')));
        }
        slots.append(h('span.slot.fs', h('span.hint', 'Fehlstarts'), h('strong', String(falseStarts))));
      }

      function reset() {
        cancelLater(timer);
        times = [];
        falseStarts = 0;
        ui.clear(resultBox);
        setPhase('idle', 'Hier klicken zum Starten', 'oder die Leertaste drücken');
        renderSlots();
      }

      function waitRound() {
        setPhase('wait', 'Warte …', 'Klick erst, wenn die Fläche hell wird.');
        timer = later(() => frame(() => {
          if (phase !== 'wait') return;
          setPhase('go', 'JETZT!', 'Klicken oder Leertaste');
          goAt = performance.now();
          timer = later(() => { if (phase === 'go') tooSlow(); }, MAX_REACTION_MS);
        }), randomDelay());
      }

      // Wer abgelenkt war, wiederholt die Runde – sonst verdirbt eine einzige Runde den ganzen Schnitt
      function tooSlow() {
        setPhase('slow', 'Zu langsam', `Über ${MAX_REACTION_MS / 1000} Sekunden zählt nicht. Klick zum Wiederholen.`);
        readyAt = performance.now();
      }

      async function finish() {
        const ev = evaluateReaction(times);
        const rate = rateReaction(ev.avgMs);
        setPhase('done', 'Fertig!', `Ø ${ev.avgMs} ms · Klick für einen neuen Test`);
        ui.mount(resultBox,
          h('div.stat-row',
            h('div.stat', h('span.hint', 'Durchschnitt'), h('strong', `${ev.avgMs} ms`)),
            h('div.stat', h('span.hint', 'Bester Klick'), h('strong', `${ev.bestMs} ms`)),
            h('div.stat', h('span.hint', 'Langsamster Klick'), h('strong', `${ev.worstMs} ms`)),
            h('div.stat', h('span.hint', 'Fehlstarts'), h('strong', String(falseStarts)))),
          h(`div.callout.${rate.tone === 'ok' ? 'ok' : rate.tone === 'warn' ? 'warn' : 'info'}`, icon(rate.tone === 'warn' ? 'warn' : 'check'),
            h('div', h('strong', rate.label), h('p.hint', rate.text))));
        try {
          const res = await env.call('reaktion.saveReaction', { avgMs: ev.avgMs, bestMs: ev.bestMs, rounds: times.length, falseStarts });
          st = res.state;
          const best = st.stats.reaction.bestMs;
          ui.toast(ev.bestMs <= best && st.stats.reaction.count > 1 ? `Gespeichert: Ø ${ev.avgMs} ms – neuer Bestwert mit ${ev.bestMs} ms!` : `Gespeichert: Ø ${ev.avgMs} ms.`);
          if (alive && tab === 'reaction') ui.mount(bestLine, bestText());
        } catch (e) { ui.showError(e, 'Ergebnis nicht gespeichert'); }
      }

      function press(ts) {
        if (phase === 'idle' || phase === 'done') {
          if (phase === 'done') reset();
          ui.clear(resultBox);
          waitRound();
          return;
        }
        if (phase === 'early') { waitRound(); return; }
        if (phase === 'result' || phase === 'slow') {
          if (performance.now() - readyAt < 250) return; // Doppelklick nicht als neue Runde zählen
          waitRound();
          return;
        }
        if (phase === 'wait') {
          cancelLater(timer);
          falseStarts++;
          setPhase('early', 'Zu früh!', 'Fehlstart. Klick, um die Runde neu zu starten.');
          renderSlots();
          return;
        }
        if (phase === 'go') {
          cancelLater(timer);
          const ms = Math.max(0, ts - goAt);
          const kind = classifyPress(ms);
          if (kind === 'early') {
            falseStarts++;
            setPhase('early', 'Geraten!', 'Unter 100 ms zählt als Fehlstart. Klick für einen neuen Versuch.');
            renderSlots();
            return;
          }
          if (kind === 'slow') { tooSlow(); return; }
          times.push(ms);
          renderSlots();
          if (times.length >= ROUNDS) { finish(); return; }
          setPhase('result', `${Math.round(ms)} ms`, `Klick für Runde ${times.length + 1} von ${ROUNDS}`);
          readyAt = performance.now();
        }
      }

      arena.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        press(e.timeStamp);
      });

      active = {
        kind: 'reaction',
        onKey: (e) => {
          if (e.code === 'Space' || e.key === ' ') {
            const t = e.target;
            if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
            e.preventDefault();
            e.stopPropagation();
            if (!e.repeat) press(e.timeStamp);
          } else if (e.key === 'Escape' && !['idle', 'done'].includes(phase)) {
            e.preventDefault();
            e.stopPropagation(); // Esc bricht nur den Test ab, nicht das ganze Tool
            reset();
            ui.toast('Test abgebrochen.', 'info');
          }
        },
        stop: () => cancelLater(timer),
      };

      const bestLine = h('p.hint.best-line', bestText());
      reset();
      return [
        ui.section('Reaktionstest', `${ROUNDS} Runden: Wird die Fläche hell, sofort klicken oder Leertaste.`,
          arena, slots, bestLine,
          ui.more('So liest du das Ergebnis',
            'Die meisten Menschen liegen zwischen 200 und 300 ms.',
            'Bildschirm und Maus fügen ein paar Millisekunden hinzu – vergleiche deine Werte deshalb am besten auf demselben PC.'),
          resultBox),
      ];
    }

    function bestText() {
      const s = st?.stats?.reaction;
      if (!s || !s.count) return 'Noch kein Ergebnis gespeichert.';
      const last = st.reaction[st.reaction.length - 1];
      return `Dein Bestwert: ${s.bestMs} ms · Letzter Test: Ø ${last.avgMs} ms (${ui.fmtAgo(last.at)})`;
    }

    // ---------------------------------------------------------------- Tasten-Trainer

    function keysTab() {
      let capturing = null;
      const grid = h('div.bind-grid');
      const startBtn = ui.button('Training starten', { variant: 'primary', iconName: 'play', onClick: () => startTraining() });
      const abortBtn = ui.button('Abbrechen', { variant: 'ghost', iconName: 'x', onClick: () => { abortTraining(); ui.toast('Training abgebrochen.', 'info'); } });
      abortBtn.hidden = true;
      const blockerLine = h('p.hint.blocker');

      const progEl = h('div.cmd-progress', ' ');
      const cmdEl = h('div.cmd', 'Bereit?');
      const keyEl = h('div.cmd-key');
      const fbEl = h('div.cmd-feedback', ' ');
      const area = h('div.trainer', { tabindex: '-1', 'aria-live': 'polite' }, progEl, cmdEl, keyEl, fbEl);
      const resultBox = h('div.result-box');
      let run = null; // laufendes Training

      function updateStart() {
        const blocker = trainingBlocker(binds);
        startBtn.disabled = !!blocker || !!run;
        blockerLine.textContent = blocker || `${activeActions(binds).length} Aktionen · bis zu ${String(PROMPT_TIMEOUT_MS / 1000).replace('.', ',')} s pro Befehl`;
        blockerLine.classList.toggle('warn-text', !!blocker);
      }

      function renderBinds() {
        ui.clear(grid);
        const dups = findDuplicates(binds);
        const dupIds = new Set([...dups.values()].flat());
        for (const a of ACTIONS) {
          const b = binds[a.id];
          const isDup = dupIds.has(a.id);
          const sw = h('input', {
            type: 'checkbox', role: 'switch', checked: b.on, 'aria-label': `${a.label} im Training üben`,
            disabled: !!run,
            onchange: (e) => {
              binds[a.id] = { ...binds[a.id], on: e.target.checked };
              renderBinds();
              saveBinds(e.target.checked ? `${a.label} wird jetzt mit geübt.` : `${a.label} wird nicht mehr geübt.`);
            },
          });
          grid.append(h(`div.bind-row${isDup ? '.dup' : ''}${b.on ? '' : '.off'}`,
            h('div.grow',
              h('span.bind-name', a.label),
              h('span.hint', `Standard: ${a.key}`)),
            isDup ? ui.badge('doppelt belegt', 'warn') : null,
            h(`button.keycap${capturing === a.id ? '.capturing' : ''}`, {
              type: 'button',
              disabled: !!run,
              title: 'Klicken und dann die neue Taste drücken',
              'aria-label': `Taste für ${a.label} ändern, jetzt: ${b.label}`,
              onclick: () => startCapture(a.id),
            }, capturing === a.id ? 'Taste drücken …' : b.label),
            h('label.mini-switch', h('span.hint', 'üben'), h('span.switch', sw, h('span.knob')))));
        }
        updateStart();
      }

      async function saveBinds(msg) {
        try {
          const res = await env.call('reaktion.saveBinds', { binds });
          binds = normalizeBinds(res.binds);
          if (st) st.binds = binds;
          if (msg) ui.toast(msg, 'ok', { timeout: 2600 });
          const dups = findDuplicates(binds);
          if (dups.size) ui.toast(trainingBlocker(binds), 'warn');
        } catch (e) { ui.showError(e, 'Tasten nicht gespeichert'); }
        if (alive && tab === 'keys') renderBinds();
      }

      // ---- Taste einfangen (nur im HELIX-Fenster)
      let mouseCap = null;
      function endCapture(b) {
        const id = capturing;
        capturing = null;
        if (mouseCap) { mouseCap(); mouseCap = null; }
        if (active && active.kind === 'capture') active = null;
        if (b && id) {
          binds[id] = { ...binds[id], code: b.code, label: b.label };
          renderBinds();
          saveBinds(`${actionById(id).label}: ${b.label} gespeichert.`);
        } else renderBinds();
      }
      function startCapture(id) {
        if (run) return;
        stopActive();
        capturing = id;
        renderBinds();
        const onDown = (e) => {
          if (e.button === 0) { endCapture(null); return; } // Linksklick = abbrechen
          e.preventDefault();
          e.stopPropagation();
          const b = bindFromEvent(e);
          if (b) endCapture(b);
        };
        const onWheel = (e) => {
          e.preventDefault();
          const b = bindFromEvent(e);
          if (b) endCapture(b);
        };
        const onCtx = (e) => e.preventDefault();
        const onUp = (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); };
        window.addEventListener('mousedown', onDown, true);
        window.addEventListener('mouseup', onUp, true);
        window.addEventListener('wheel', onWheel, { capture: true, passive: false });
        window.addEventListener('contextmenu', onCtx, true);
        mouseCap = () => {
          window.removeEventListener('mousedown', onDown, true);
          window.removeEventListener('mouseup', onUp, true);
          window.removeEventListener('wheel', onWheel, { capture: true });
          // Kontextmenü nach einem Rechtsklick noch kurz unterdrücken
          setTimeout(() => window.removeEventListener('contextmenu', onCtx, true), 400); // bewusst ohne later(): muss auch nach dem Verlassen laufen
        };
        active = {
          kind: 'capture',
          onKey: (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') { endCapture(null); ui.toast('Nicht geändert.', 'info'); return; }
            if (e.repeat) return;
            const b = bindFromEvent(e);
            if (!b) { ui.toast('Diese Taste geht nicht. Nimm bitte eine andere.', 'warn'); return; }
            endCapture(b);
          },
          stop: () => { capturing = null; if (mouseCap) { mouseCap(); mouseCap = null; } },
        };
      }

      // ---- Training
      function setFeedback(text, tone) {
        fbEl.className = `cmd-feedback${tone ? ' ' + tone : ''}`;
        fbEl.textContent = text || ' ';
      }

      function abortTraining() {
        if (!run) return;
        run.stop();
        run = null;
        if (active && active.kind === 'train') active = null;
        area.classList.remove('running');
        progEl.textContent = ' ';
        cmdEl.textContent = 'Bereit?';
        keyEl.textContent = '';
        setFeedback('');
        startBtn.hidden = false;
        abortBtn.hidden = true;
        renderBinds();
      }

      function startTraining() {
        const blocker = trainingBlocker(binds);
        if (blocker) { ui.toast(blocker, 'warn'); return; }
        stopActive();
        ui.clear(resultBox);
        const seq = makeSequence(activeActions(binds), PROMPTS);
        const results = [];
        let idx = -1;
        let phase = 'ready';
        let shownAt = 0;
        let timeoutId = null;
        let nextId = null;

        const answer = (code, ts, isTimeout) => {
          if (phase !== 'prompt') return;
          const want = seq[idx];
          let got = null;
          if (!isTimeout) {
            got = actionForCode(binds, code);
            if (!got) { setFeedback('Diese Taste ist im Training nicht belegt.', 'muted'); return; }
          }
          cancelLater(timeoutId);
          phase = 'gap';
          const ms = Math.max(0, ts - shownAt);
          if (isTimeout) {
            results.push({ id: want, kind: 'timeout', ms });
            setFeedback('Zu langsam', 'warn');
          } else if (got === want) {
            results.push({ id: want, kind: 'hit', ms });
            setFeedback(`Richtig – ${Math.round(ms)} ms`, 'ok');
          } else {
            results.push({ id: want, kind: 'wrong', ms });
            setFeedback(`Falsch – das war ${actionById(got).label}`, 'err');
          }
          area.classList.add('answered');
          nextId = later(next, randomGap());
        };

        const next = () => {
          idx++;
          if (idx >= seq.length) { finish(results); return; }
          phase = 'pending';
          frame(() => {
            if (!run) return;
            const a = actionById(seq[idx]);
            area.classList.remove('answered');
            progEl.textContent = `Befehl ${idx + 1} von ${PROMPTS}`;
            cmdEl.textContent = a.cmd;
            keyEl.textContent = showKeys ? binds[a.id].label : '';
            setFeedback('');
            phase = 'prompt';
            shownAt = performance.now();
            timeoutId = later(() => answer(null, performance.now(), true), PROMPT_TIMEOUT_MS);
          });
        };

        // Maustasten und Mausrad nur im HELIX-Fenster
        const onDown = (e) => {
          if (e.button === 0) return; // Linksklick bleibt frei (Abbrechen-Knopf)
          e.preventDefault();
          const b = bindFromEvent(e);
          if (b) answer(b.code, e.timeStamp, false);
        };
        const onUp = (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); };
        const onWheel = (e) => {
          e.preventDefault();
          const b = bindFromEvent(e);
          if (b && phase === 'prompt') answer(b.code, e.timeStamp, false);
        };
        const onCtx = (e) => e.preventDefault();
        window.addEventListener('mousedown', onDown, true);
        window.addEventListener('mouseup', onUp, true);
        window.addEventListener('wheel', onWheel, { capture: true, passive: false });
        window.addEventListener('contextmenu', onCtx, true);

        run = {
          stop: () => {
            cancelLater(timeoutId);
            cancelLater(nextId);
            window.removeEventListener('mousedown', onDown, true);
            window.removeEventListener('mouseup', onUp, true);
            window.removeEventListener('wheel', onWheel, { capture: true });
            setTimeout(() => window.removeEventListener('contextmenu', onCtx, true), 400); // bewusst ohne later(): muss auch nach dem Verlassen laufen
          },
        };
        active = {
          kind: 'train',
          onKey: (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') { abortTraining(); ui.toast('Training abgebrochen.', 'info'); return; }
            if (e.repeat) return;
            const b = bindFromEvent(e);
            if (b) answer(b.code, e.timeStamp, false);
          },
          stop: () => abortTraining(),
        };
        startBtn.hidden = true;
        abortBtn.hidden = false;
        area.classList.add('running');
        area.focus({ preventScroll: true });
        renderBinds();
        progEl.textContent = ' ';
        cmdEl.textContent = 'Gleich geht’s los …';
        keyEl.textContent = '';
        setFeedback('Finger auf die Tasten.', 'muted');
        nextId = later(next, 1200);
      }

      async function finish(results) {
        const ev = evaluateKeys(results);
        if (run) { run.stop(); run = null; }
        if (active && active.kind === 'train') active = null;
        area.classList.remove('running', 'answered');
        startBtn.hidden = false;
        abortBtn.hidden = true;
        progEl.textContent = 'Fertig';
        cmdEl.textContent = ev.avgMs !== null ? `Ø ${ev.avgMs} ms` : 'Fertig';
        keyEl.textContent = '';
        setFeedback(`${String(ev.accuracy).replace('.', ',')} % richtig`, ev.accuracy >= 90 ? 'ok' : 'warn');
        renderBinds();
        const rate = rateKeys(ev);
        const tip = keysTip(ev);
        ui.mount(resultBox,
          h('div.stat-row',
            h('div.stat', h('span.hint', 'Ø Reaktion (richtige)'), h('strong', ev.avgMs !== null ? `${ev.avgMs} ms` : '–')),
            h('div.stat', h('span.hint', 'Richtig'), h('strong', `${String(ev.accuracy).replace('.', ',')} %`)),
            h('div.stat', h('span.hint', 'Falsche Taste'), h('strong', String(ev.wrong))),
            h('div.stat', h('span.hint', 'Zu langsam'), h('strong', String(ev.timeouts)))),
          h(`div.callout.${rate.tone === 'ok' ? 'ok' : rate.tone === 'warn' ? 'warn' : 'info'}`, icon(rate.tone === 'warn' ? 'warn' : 'check'),
            h('div', h('strong', rate.label), h('p.hint', [rate.text, tip].filter(Boolean).join(' ')))),
          h('div.table-wrap', h('table.table',
            h('thead', h('tr', h('th', 'Aktion'), h('th', 'Taste'), h('th', 'Ø Zeit'), h('th', 'Richtig'), h('th', 'Daneben'))),
            h('tbody', ev.perAction.map((p) => h('tr',
              h('td', p.label), h('td.mono', binds[p.id]?.label || codeLabel(binds[p.id]?.code)),
              h('td.num', p.avgMs !== null ? `${p.avgMs} ms` : '–'), h('td.num', `${p.hits} von ${p.total}`), h('td.num', String(p.misses))))))));
        try {
          const res = await env.call('reaktion.saveKeys', { avgMs: ev.avgMs, accuracy: ev.accuracy, count: ev.count });
          st = res.state;
          ui.toast(ev.avgMs !== null ? `Gespeichert: Ø ${ev.avgMs} ms, ${String(ev.accuracy).replace('.', ',')} % richtig.` : 'Gespeichert – probier es mal mit eingeblendeten Tasten.');
        } catch (e) { ui.showError(e, 'Ergebnis nicht gespeichert'); }
      }

      renderBinds();
      const keysToggle = ui.toggle({
        label: 'Taste beim Befehl mit anzeigen',
        checked: showKeys,
        onChange: (v) => { showKeys = v; writePref(v); ui.toast(v ? 'Tasten werden angezeigt.' : 'Tasten werden ausgeblendet.', 'info', { timeout: 2000 }); },
      });

      return [
        ui.section('Deine Tasten', 'Klick auf eine Taste und drück dann deine Taste aus Fortnite.',
          grid,
          h('div.row',
            ui.button('Fortnite-Standard laden', {
              iconName: 'refresh', small: true, variant: 'ghost',
              onClick: async () => {
                const ok = await ui.confirmDialog({ title: 'Fortnite-Standard laden?', text: 'Alle Tasten hier gehen zurück auf den Fortnite-Standard. In Fortnite selbst ändert sich nichts.', confirmLabel: 'Zurücksetzen' });
                if (!ok) return;
                binds = defaultBinds();
                renderBinds();
                await saveBinds('Fortnite-Standard geladen.');
              },
            })),
          ui.more('So funktioniert es',
            'Auch rechte und mittlere Maustaste, Maus 4 und 5 und das Mausrad gehen. Esc bricht ab.',
            'HELIX merkt sich nur hier, was du üben willst. In Fortnite ändert sich nichts.')),
        ui.section('Training', `${PROMPTS} Befehle wie „Wand!“ – drück so schnell wie möglich die passende Taste.`,
          keysToggle,
          area,
          h('div.row', startBtn, abortBtn, blockerLine),
          resultBox),
      ];
    }

    // ---------------------------------------------------------------- Verlauf

    function chart(list, field, unit, label) {
      const b = bars(list, field, 20);
      return h('div.chart', { role: 'img', 'aria-label': `${label}: die letzten ${b.length} Ergebnisse` },
        b.map((x) => h('div.bar-col', { title: `${ui.fmtDate(x.at)}: ${x.value} ${unit}` },
          h('span.bar-val', String(x.value)),
          h('div.bar-track', h('div.bar', { style: { height: `${Math.max(4, Math.round(x.h * 100))}%` } })))));
    }

    function trendText(list) {
      const t = trend(list, 'avgMs');
      if (!t) return null;
      if (Math.abs(t.diff) < 5) return `Letzter Test etwa so schnell wie davor (Ø ${t.prevAvg} ms).`;
      return t.diff < 0 ? `Letzter Test ${-t.diff} ms schneller als dein Schnitt davor.` : `Letzter Test ${t.diff} ms langsamer als dein Schnitt davor.`;
    }

    async function clear(which, title) {
      const ok = await ui.confirmDialog({ title: `${title} löschen?`, text: 'Alle Ergebnisse dieses Tests werden gelöscht. Deine Tasten bleiben.', confirmLabel: 'Löschen', danger: true });
      if (!ok) return;
      try {
        st = await env.call('reaktion.clearHistory', { which });
        ui.toast('Verlauf gelöscht.');
      } catch (e) { ui.showError(e); }
      render();
    }

    function historyTab() {
      if (!st) {
        return [ui.emptyState({
          title: 'Verlauf nicht verfügbar',
          text: 'Der Verlauf konnte gerade nicht geladen werden.',
          action: ui.button('Erneut laden', { iconName: 'refresh', onClick: async () => { await loadState(); render(); ui.toast('Neu geladen.', 'info'); } }),
        })];
      }
      const r = st.reaction;
      const k = st.keys;
      const rs = st.stats.reaction;
      const ks = st.stats.keys;
      const reactionBlock = r.length
        ? ui.section('Reaktionstest', 'Kürzere Balken heißt schneller.',
          h('div.stat-row',
            h('div.stat', h('span.hint', 'Bester Klick'), h('strong', `${rs.bestMs} ms`)),
            h('div.stat', h('span.hint', 'Bester Durchschnitt'), h('strong', `${rs.bestAvgMs} ms`)),
            h('div.stat', h('span.hint', 'Ø der letzten 5'), h('strong', `${rs.last5AvgMs} ms`)),
            h('div.stat', h('span.hint', 'Tests'), h('strong', String(rs.count)))),
          chart(r, 'avgMs', 'ms', 'Reaktionstest'),
          trendText(r) ? h('p.trend-line', trendText(r)) : null,
          h('ul.list.compact.hist-list', r.slice(-6).reverse().map((e) => h('li',
            h('div.grow', h('span', `Ø ${e.avgMs} ms · bester Klick ${e.bestMs} ms`), h('span.hint', `${ui.fmtDate(e.at)} · ${e.rounds} Runden · ${e.falseStarts === 1 ? '1 Fehlstart' : `${e.falseStarts} Fehlstarts`}`)),
            ui.badge(rateReaction(e.avgMs).label, rateReaction(e.avgMs).tone === 'ok' ? 'ok' : rateReaction(e.avgMs).tone === 'warn' ? 'warn' : 'accent')))),
          h('div.row', ui.button('Verlauf löschen', { iconName: 'trash', small: true, variant: 'ghost', onClick: () => clear('reaction', 'Verlauf des Reaktionstests') })))
        : ui.section('Reaktionstest', null, ui.emptyState({
          title: 'Noch kein Reaktionstest',
          text: 'Dauert keine Minute.',
          action: ui.button('Zum Reaktionstest', { variant: 'primary', iconName: 'play', onClick: () => { tab = 'reaction'; renderTabs(); render(); } }),
        }));
      const keysBlock = k.length
        ? ui.section('Tasten-Trainer', null,
          h('div.stat-row',
            h('div.stat', h('span.hint', 'Bester Durchschnitt'), h('strong', ks.bestAvgMs !== null ? `${ks.bestAvgMs} ms` : '–')),
            h('div.stat', h('span.hint', 'Ø der letzten 5'), h('strong', ks.last5AvgMs !== null ? `${ks.last5AvgMs} ms` : '–')),
            h('div.stat', h('span.hint', 'Richtig (letzte 5)'), h('strong', `${ks.last5Accuracy} %`)),
            h('div.stat', h('span.hint', 'Trainings'), h('strong', String(ks.count)))),
          chart(k.filter((e) => e.avgMs !== null), 'avgMs', 'ms', 'Tasten-Trainer'),
          h('ul.list.compact.hist-list', k.slice(-6).reverse().map((e) => h('li',
            h('div.grow', h('span', e.avgMs !== null ? `Ø ${e.avgMs} ms` : 'keine richtige Taste'), h('span.hint', `${ui.fmtDate(e.at)} · ${e.count} Befehle`)),
            ui.badge(`${String(e.accuracy).replace('.', ',')} % richtig`, e.accuracy >= 90 ? 'ok' : 'warn')))),
          h('div.row', ui.button('Verlauf löschen', { iconName: 'trash', small: true, variant: 'ghost', onClick: () => clear('keys', 'Verlauf des Tasten-Trainers') })))
        : ui.section('Tasten-Trainer', null, ui.emptyState({
          title: 'Noch kein Training',
          text: 'Trag deine Tasten ein und starte ein Training.',
          action: ui.button('Zum Tasten-Trainer', { variant: 'primary', iconName: 'play', onClick: () => { tab = 'keys'; renderTabs(); render(); } }),
        }));
      return [reactionBlock, keysBlock];
    }

    // ---------------------------------------------------------------- Aufbau

    function render() {
      if (!alive) return;
      stopActive();
      const nodes = tab === 'keys' ? keysTab() : tab === 'history' ? historyTab() : reactionTab();
      ui.mount(body, nodes);
    }

    cleanup = [
      () => { alive = false; },
      () => stopActive(),
      () => { for (const id of timers) clearTimeout(id); timers.clear(); },
      () => { for (const id of rafs) cancelAnimationFrame(id); rafs.clear(); },
      () => window.removeEventListener('keydown', onKey, true),
    ];

    renderTabs();
    ui.mount(body, h('div.loading', ui.spinner()));
    await loadState();
    render();
  },

  unmount() {
    for (const f of cleanup) { try { f(); } catch { /* egal */ } }
    cleanup = [];
  },
};
