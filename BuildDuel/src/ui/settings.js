// =============================================================================
// Einstellungs-Fenster (Reiter: Steuerung, Empfindlichkeit, Grafik, Ton, Spiel)
// =============================================================================
// Öffnet sich aus der Lobby (Zahnrad) und aus dem Pause-Menü. Jede Änderung wird
// sofort gespeichert (core/settings.js) und – wo möglich – sofort benutzt:
//   Tasten → input.applySettings + hud.applySettings, Ton → audio.setVolumes,
//   Auflösung/FPS-Anzeige → sofort; Qualität und Sichtweite brauchen einen Neustart
//   der Seite (Knopf "Jetzt neu laden").
// Tasten neu belegen: Feld anklicken, dann Taste, Maustaste oder Mausrad drücken.
// Esc = abbrechen, Entf/Rücktaste = Taste löschen. Doppelt belegte Tasten werden rot.
// =============================================================================
import { CONFIG } from '../config.js';
import { defaultSettings } from '../core/settings.js';
import { keyLabel } from './hud.js';
import { settingsActions, findKeyConflicts, rebind, eventToCode, pickNeighbor } from './menuLogic.js';
import { ICONS } from './menuIcons.js';

const TABS = [
  ['controls', 'Steuerung'],
  ['sensitivity', 'Empfindlichkeit'],
  ['graphics', 'Grafik'],
  ['audio', 'Ton'],
  ['game', 'Spiel'],
];

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/**
 * @param {object} o
 * @param {HTMLElement} o.root
 * @param {object} o.settings      wird direkt geändert (alle Teile des Spiels haben dieselbe Referenz)
 * @param {Function} o.onApply     (bereich) – 'controls' | 'sensitivity' | 'graphics' | 'audio' | 'game'
 * @param {Function} o.onSave      speichern
 * @param {object} [o.audio]       für Klick-Töne
 * @param {Function} [o.onClose]
 */
export function createSettingsWindow(o) {
  const settings = o.settings;
  const el = document.createElement('div');
  el.className = 'settings-root';
  el.hidden = true;
  el.innerHTML = `
    <div class="settings-card" role="dialog" aria-label="Einstellungen">
      <header class="settings-head">
        <h2>Einstellungen</h2>
        <button class="settings-close" type="button" aria-label="Schließen">${ICONS.close}</button>
      </header>
      <nav class="settings-tabs" role="tablist">
        ${TABS.map(([id, name]) => `<button type="button" role="tab" data-tab="${id}">${name}</button>`).join('')}
      </nav>
      <div class="settings-body"></div>
      <footer class="settings-foot"><span class="settings-note"></span><button class="sbtn settings-done" type="button">Fertig</button></footer>
    </div>`;
  o.root.appendChild(el);
  const body = el.querySelector('.settings-body');
  const note = el.querySelector('.settings-note');
  let tab = 'controls';
  let capture = null; // { action, index, button } – wartet auf eine Taste
  let saveTimer = 0;
  let layoutMap = null;
  let needsReload = false;
  const initialGraphics = JSON.stringify([settings.graphics.quality, settings.graphics.viewDistance]);

  // Echte Tasten-Beschriftung (QWERTZ: KeyZ → "Y"), wenn der Browser es kann
  try {
    navigator.keyboard?.getLayoutMap?.().then((map) => {
      layoutMap = map;
      if (!el.hidden && tab === 'controls') render();
    }, () => {});
  } catch {
    // egal
  }

  const sound = (name = 'click') => o.audio?.ui?.(name);

  function changed(area) {
    o.onApply?.(area);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => o.onSave?.(), 250);
  }

  // --- Bausteine -------------------------------------------------------------------------
  const row = (label, control, hint = '') =>
    `<div class="srow"><div class="slabel">${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</div><div class="scontrol">${control}</div></div>`;
  const toggle = (key, on) =>
    `<button type="button" class="stoggle${on ? ' on' : ''}" data-toggle="${key}" role="switch" aria-checked="${on}"><i></i><span>${on ? 'An' : 'Aus'}</span></button>`;
  const segmented = (key, options, value) =>
    `<div class="sseg" data-seg="${key}">${options.map(([v, name]) =>
      `<button type="button" data-value="${esc(v)}" class="${String(v) === String(value) ? 'on' : ''}">${esc(name)}</button>`).join('')}</div>`;
  const slider = (key, min, max, step, value, format) =>
    `<div class="sslider"><input type="range" data-slider="${key}" min="${min}" max="${max}" step="${step}" value="${value}">
      <output data-out="${key}">${esc(format(value))}</output></div>`;

  const pct = (v) => `${Math.round(v * 100)} %`;
  const percent = (v) => `${String(Math.round(Number(v) * 100) / 100).replace('.', ',')} %`;
  const meters = (v) => `${Math.round(v)} m`;

  const SLIDERS = {
    // Empfindlichkeit in % wie in Fortnite (Grenzen aus config.js)
    ...Object.fromEntries(Object.entries(CONFIG.sensitivity.limits).map(([k, [min, max]]) =>
      [`sensitivity.${k}`, { min, max, step: k === 'x' || k === 'y' ? 0.1 : 1, fmt: percent }])),
    'graphics.resolutionScale': { min: 0.5, max: 1, step: 0.05, fmt: pct },
    'graphics.viewDistance': { min: 100, max: 1500, step: 50, fmt: meters },
    'audio.master': { min: 0, max: 1, step: 0.05, fmt: pct },
    'audio.effects': { min: 0, max: 1, step: 0.05, fmt: pct },
    'audio.music': { min: 0, max: 1, step: 0.05, fmt: pct },
  };

  function get(path) {
    const [a, b] = path.split('.');
    return settings[a][b];
  }
  function set(path, value) {
    const [a, b] = path.split('.');
    settings[a][b] = value;
  }
  function effectiveGraphics(key) {
    const preset = CONFIG.graphics.presets[settings.graphics.quality] ?? CONFIG.graphics.presets.mittel;
    return settings.graphics[key] ?? preset[key];
  }

  // --- Inhalte der Reiter ------------------------------------------------------------------------
  function renderControls() {
    const c = settings.controls;
    const conflicts = findKeyConflicts(c.keyboard, { crouchOnCtrl: c.crouchOnCtrl });
    const actionName = new Map(settingsActions().flatMap(([, rows]) => rows));
    actionName.set('sprint', 'Sprinten');
    const conflictText = [...conflicts].map(([code, actions]) =>
      `<b>${esc(keyLabel(code, layoutMap))}</b>: ${actions.map((a) => esc(actionName.get(a) ?? a)).join(', ')}`).join(' · ');
    let html = `
      <div class="sgroup"><h3>Optionen</h3>
        ${row('Ducken', segmented('controls.crouchToggle', [[false, 'Halten'], [true, 'Umschalten']], c.crouchToggle))}
        ${row('Ducken auf Strg', toggle('controls.crouchOnCtrl', c.crouchOnCtrl), 'Shift wird dann Sprinten. Achtung: Strg + W schließt den Tab!')}
      </div>
      <div class="sgroup"><h3>Bauen &amp; Editieren (wie in Fortnite)</h3>
        ${row('Edit beim Loslassen bestätigen', toggle('controls.editOnRelease', c.editOnRelease), 'Confirm Edit on Release: Felder wählen, linke Maustaste loslassen = fertig (schnelle Doppel-Edits)')}
        ${row('Edits automatisch bestätigen', segmented('controls.autoConfirmEdits', [['off', 'Aus'], ['weapon', 'Waffe'], ['build', 'Bauen'], ['both', 'Beide']], c.autoConfirmEdits), 'Auto Confirm Edits: Wechsel zu Waffe/Bauteil während des Edits bestätigt ihn (Aus = verwerfen)')}
        ${row('Zurücksetzen bestätigt sofort', toggle('controls.resetConfirms', c.resetConfirms), 'Auto-Reset: Rechtsklick im Edit = Bauteil sofort wieder ganz')}
        ${row('Turbo-Bauen', toggle('controls.turboBuilding', c.turboBuilding), 'Turbo Building: Maustaste halten baut weiter')}
        ${row('Baumodus startet mit Wand', toggle('controls.resetBuildingChoice', c.resetBuildingChoice), 'Reset Building Choice: Q wählt immer zuerst die Wand')}
        ${row('Edit-Auswahl beim Öffnen leer', toggle('controls.resetEditAfterConfirm', c.resetEditAfterConfirm))}
      </div>
      <div class="sconflicts${conflicts.size ? '' : ' ok'}">${conflicts.size
        ? `${ICONS.lock}<span>Doppelt belegt – ${conflictText}</span>`
        : `${ICONS.check}<span>Keine doppelt belegten Tasten</span>`}</div>`;
    for (const [title, rows] of settingsActions()) {
      html += `<div class="sgroup"><h3>${esc(title)}</h3>`;
      for (const [action, name] of rows) {
        const codes = c.keyboard[action] ?? [];
        const locked = c.crouchOnCtrl && action === 'crouch';
        const fields = [0, 1].map((i) => {
          const code = codes[i];
          const waiting = capture && capture.action === action && capture.index === i;
          const bad = code && conflicts.has(code);
          const label = locked ? (i === 0 ? 'Strg' : '–') : waiting ? 'Taste drücken …' : code ? keyLabel(code, layoutMap) : '–';
          return `<button type="button" class="skey${waiting ? ' waiting' : ''}${bad ? ' conflict' : ''}${code ? '' : ' empty'}"
            data-action="${action}" data-index="${i}"${locked ? ' disabled' : ''}>${esc(label)}</button>`;
        }).join('');
        html += row(name, `<div class="skeys">${fields}</div>`);
      }
      html += '</div>';
    }
    html += `<div class="sgroup sreset"><button type="button" class="sbtn dim" data-reset="controls">Alle Tasten auf Standard</button>
      <small>Feld anklicken, dann Taste, Maustaste oder Mausrad drücken. Esc bricht ab, Entf löscht.</small></div>`;
    return html;
  }

  // Schieberegler + Zahlenfeld zum genauen Eintippen (z. B. 6,4 %)
  function sensRow(key, label, hint) {
    const d = SLIDERS[`sensitivity.${key}`];
    const v = settings.sensitivity[key];
    return row(label, `<div class="sslider"><input type="range" data-slider="sensitivity.${key}" min="${d.min}" max="${d.max}" step="${d.step}" value="${v}">
      <input type="number" class="snum" data-num="sensitivity.${key}" min="${d.min}" max="${d.max}" step="${d.step}" value="${v}" aria-label="${esc(label)} in Prozent"><span class="sunit">%</span></div>`, hint);
  }

  // Mausweg für eine volle Drehung bei 800 DPI (zum Vergleichen mit Fortnite)
  function cmPer360(percent) {
    const counts = 360 / (CONFIG.sensitivity.degreesPerCount * percent / 100);
    return (counts / 800) * 2.54;
  }

  function renderSensitivity() {
    const s = settings.sensitivity;
    const cm = cmPer360(s.x);
    return `<div class="sgroup"><h3>Maus (wie in Fortnite, in %)</h3>
      ${sensRow('x', 'Maus-Empfindlichkeit X', `Bei 800 DPI: ${cm.toFixed(1).replace('.', ',')} cm für eine volle Drehung`)}
      ${sensRow('y', 'Maus-Empfindlichkeit Y')}
      ${sensRow('targeting', 'Zielen (Targeting)', '% der normalen Empfindlichkeit, rechte Maustaste')}
      ${sensRow('scope', 'Zielfernrohr (Scope)', '% der normalen Empfindlichkeit')}
      ${row('Blick umkehren (Y)', toggle('sensitivity.invertY', s.invertY))}
    </div>
    <div class="sgroup"><h3>Bauen &amp; Editieren</h3>
      ${sensRow('build', 'Bau-Empfindlichkeit', 'Multiplikator – Fortnite-Standard 100 %')}
      ${sensRow('edit', 'Edit-Empfindlichkeit', 'Multiplikator – Fortnite-Standard 100 %')}
    </div>
    <div class="sgroup sreset"><button type="button" class="sbtn dim" data-reset="sensitivity">Auf Standard</button>
      <small>Gleiche Werte wie in Fortnite eintragen = gleiches Gefühl (rohe Maus-Eingabe ist an).</small></div>`;
  }

  function renderGraphics() {
    const g = settings.graphics;
    const rs = SLIDERS['graphics.resolutionScale'];
    const vd = SLIDERS['graphics.viewDistance'];
    return `<div class="sgroup"><h3>Bild</h3>
      ${row('Qualität', segmented('graphics.quality', [['niedrig', 'Niedrig'], ['mittel', 'Mittel'], ['hoch', 'Hoch']], g.quality), 'Schatten, Kantenglättung – gilt nach dem Neuladen')}
      ${row('Auflösung', slider('graphics.resolutionScale', rs.min, rs.max, rs.step, effectiveGraphics('resolutionScale'), rs.fmt), 'weniger = schneller (sofort)')}
      ${row('Sichtweite', slider('graphics.viewDistance', vd.min, vd.max, vd.step, effectiveGraphics('viewDistance'), vd.fmt), 'gilt nach dem Neuladen')}
      ${row('FPS-Anzeige', toggle('graphics.showFps', g.showFps))}
    </div>
    <div class="sgroup sreload"${needsReload ? '' : ' hidden'}>
      <span>Qualität/Sichtweite geändert – gilt nach dem Neuladen.</span>
      <button type="button" class="sbtn" data-reload>Jetzt neu laden</button>
    </div>`;
  }

  function renderAudio() {
    const a = settings.audio;
    const sl = (key, label) => {
      const d = SLIDERS[`audio.${key}`];
      return row(label, slider(`audio.${key}`, d.min, d.max, d.step, a[key], d.fmt));
    };
    return `<div class="sgroup"><h3>Lautstärke</h3>${sl('master', 'Gesamt')}${sl('effects', 'Effekte')}${sl('music', 'Musik')}</div>`;
  }

  function renderGame() {
    const g = settings.game;
    const diffs = Object.entries(CONFIG.bots.difficulties).map(([id, d]) => [id, d.name]);
    return `<div class="sgroup"><h3>Spiel</h3>
      ${row('Schadenszahlen', toggle('game.damageNumbers', g.damageNumbers !== false), 'Zahlen über getroffenen Gegnern')}
      ${row('Controller-Zielhilfe', toggle('controls.aimAssist', settings.controls.aimAssist), 'nur mit Controller: bremst die Drehung nahe am Gegner')}
      ${row('Bot-Schwierigkeit', segmented('game.botDifficulty', diffs, g.botDifficulty), 'für Modi mit Bots')}
    </div>`;
  }

  function render() {
    el.querySelectorAll('.settings-tabs [data-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tab);
      b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    });
    const scroll = body.scrollTop;
    body.innerHTML = tab === 'controls' ? renderControls() : tab === 'sensitivity' ? renderSensitivity()
      : tab === 'graphics' ? renderGraphics() : tab === 'audio' ? renderAudio() : renderGame();
    body.scrollTop = scroll;
    note.textContent = 'Wird automatisch gespeichert.';
  }

  // --- Eingaben -------------------------------------------------------------------------------
  el.querySelector('.settings-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    sound();
    stopCapture();
    tab = b.dataset.tab;
    body.scrollTop = 0;
    render();
  });

  body.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.toggle) {
      sound();
      const key = t.dataset.toggle;
      set(key, !get(key));
      changed(key.split('.')[0]);
      render();
    } else if (t.parentElement?.dataset.seg) {
      sound();
      const key = t.parentElement.dataset.seg;
      const raw = t.dataset.value;
      const value = raw === 'true' ? true : raw === 'false' ? false : raw;
      set(key, value);
      if (key === 'graphics.quality') {
        // Auflösung/Sichtweite folgen wieder der Stufe
        settings.graphics.resolutionScale = null;
        settings.graphics.viewDistance = null;
        checkReload();
      }
      changed(key.split('.')[0]);
      render();
    } else if (t.classList.contains('skey')) {
      sound();
      startCapture(t.dataset.action, Number(t.dataset.index));
    } else if (t.dataset.reset) {
      sound('back');
      const d = defaultSettings();
      if (t.dataset.reset === 'controls') {
        settings.controls.keyboard = d.controls.keyboard;
        for (const k of ['crouchOnCtrl', 'crouchToggle', 'editOnRelease', 'autoConfirmEdits', 'resetConfirms',
          'resetEditAfterConfirm', 'turboBuilding', 'resetBuildingChoice']) settings.controls[k] = d.controls[k];
        changed('controls');
      } else {
        Object.assign(settings.sensitivity, d.sensitivity);
        changed('sensitivity');
      }
      render();
    } else if (t.hasAttribute('data-reload')) {
      o.onSave?.();
      location.reload();
    }
  });

  body.addEventListener('input', (e) => {
    // Zahlenfeld (Empfindlichkeit genau eintippen)
    const num = e.target.closest('[data-num]');
    if (num) {
      const key = num.dataset.num;
      const d = SLIDERS[key];
      const value = Number(String(num.value).replace(',', '.'));
      if (!Number.isFinite(value) || value < d.min || value > d.max) return; // erst übernehmen, wenn gültig
      set(key, value);
      const range = body.querySelector(`[data-slider="${CSS.escape(key)}"]`);
      if (range) range.value = String(value);
      changed(key.split('.')[0]);
      return;
    }
    const input = e.target.closest('[data-slider]');
    if (!input) return;
    const key = input.dataset.slider;
    const value = Number(input.value);
    set(key, value);
    const out = body.querySelector(`[data-out="${CSS.escape(key)}"]`);
    if (out) out.textContent = SLIDERS[key].fmt(value);
    const numField = body.querySelector(`[data-num="${CSS.escape(key)}"]`);
    if (numField) numField.value = String(value);
    if (key === 'graphics.viewDistance') checkReload();
    changed(key.split('.')[0]);
  });
  body.addEventListener('change', (e) => {
    // Zahlenfeld verlassen: ungültige Eingabe → in die Grenzen bringen, Anzeige auffrischen
    const num = e.target.closest('[data-num]');
    if (num) {
      const key = num.dataset.num;
      const d = SLIDERS[key];
      const value = Number(String(num.value).replace(',', '.'));
      set(key, Number.isFinite(value) ? Math.min(d.max, Math.max(d.min, value)) : get(key));
      changed(key.split('.')[0]);
      render();
      return;
    }
    const input = e.target.closest('[data-slider]');
    if (!input) return;
    if (input.dataset.slider.startsWith('sensitivity.')) render(); // cm-Hinweis auffrischen
    if (input.dataset.slider.startsWith('audio.')) sound('confirm'); // Probe-Ton in neuer Lautstärke
    if (input.dataset.slider === 'graphics.viewDistance') render();
  });

  function checkReload() {
    needsReload = JSON.stringify([settings.graphics.quality, settings.graphics.viewDistance]) !== initialGraphics;
  }

  // --- Taste aufnehmen --------------------------------------------------------------------------
  function startCapture(action, index) {
    stopCapture();
    capture = { action, index };
    render();
    // erst nach diesem Klick zuhören (sonst zählt der Klick selbst als "Mouse0")
    setTimeout(() => {
      if (!capture) return;
      window.addEventListener('keydown', onCaptureKey, true);
      window.addEventListener('mousedown', onCaptureMouse, true);
      window.addEventListener('wheel', onCaptureWheel, { capture: true, passive: false });
      window.addEventListener('contextmenu', blockMenu, true);
    }, 0);
  }
  function stopCapture() {
    window.removeEventListener('keydown', onCaptureKey, true);
    window.removeEventListener('mousedown', onCaptureMouse, true);
    window.removeEventListener('wheel', onCaptureWheel, { capture: true });
    // Rechtsklick-Menü erst nach dem Loslassen wieder erlauben
    setTimeout(() => window.removeEventListener('contextmenu', blockMenu, true), 300);
    const was = !!capture;
    capture = null;
    return was;
  }
  function blockMenu(e) {
    e.preventDefault();
  }
  function assign(code) {
    if (!capture) return;
    const { action, index } = capture;
    stopCapture();
    rebind(settings.controls.keyboard, action, index, code);
    sound('confirm');
    changed('controls');
    render();
    body.querySelector(`.skey[data-action="${action}"][data-index="${Math.min(index, (settings.controls.keyboard[action] ?? []).length)}"]`)?.focus({ preventScroll: true });
  }
  function onCaptureKey(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') {
      stopCapture();
      sound('back');
      render();
      return;
    }
    if (e.code === 'Backspace' || e.code === 'Delete') {
      assign(null);
      return;
    }
    assign(eventToCode(e));
  }
  function onCaptureMouse(e) {
    e.preventDefault();
    e.stopPropagation();
    assign(eventToCode(e));
  }
  function onCaptureWheel(e) {
    e.preventDefault();
    e.stopPropagation();
    const code = eventToCode(e);
    if (code) assign(code);
  }

  // --- Öffnen / Schließen / Tastatur ----------------------------------------------------------------
  function open(which = tab) {
    tab = which;
    el.hidden = false;
    render();
    el.querySelector(`.settings-tabs [data-tab="${tab}"]`)?.focus({ preventScroll: true });
  }
  function close() {
    if (el.hidden) return;
    stopCapture();
    clearTimeout(saveTimer);
    o.onSave?.();
    el.hidden = true;
    o.onClose?.();
  }
  el.querySelector('.settings-close').addEventListener('click', () => {
    sound('back');
    close();
  });
  el.querySelector('.settings-done').addEventListener('click', () => {
    sound('confirm');
    close();
  });
  // Klicks im Fenster nicht an das Spiel weitergeben (Pause: "Klicken zum Weiterspielen")
  el.addEventListener('click', (e) => e.stopPropagation());
  el.addEventListener('mousedown', (e) => e.stopPropagation());

  function navigate(dir) {
    if (dir === 'back') {
      if (!stopCapture()) close();
      else render();
      return;
    }
    if (dir === 'press') {
      document.activeElement?.click?.();
      return;
    }
    const list = [...el.querySelectorAll('button, input')].filter((b) => !b.disabled && b.offsetParent !== null);
    const current = el.contains(document.activeElement) ? document.activeElement : null;
    if (!current) {
      list[0]?.focus();
      return;
    }
    // Schieberegler: links/rechts ändert den Wert
    if (current.type === 'range' && (dir === 'left' || dir === 'right')) {
      current.value = String(Number(current.value) + Number(current.step) * (dir === 'left' ? -1 : 1));
      current.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const others = list.filter((b) => b !== current);
    const i = pickNeighbor(current.getBoundingClientRect(), others.map((b) => b.getBoundingClientRect()), dir);
    if (i >= 0) {
      others[i].focus();
      others[i].scrollIntoView({ block: 'nearest' });
    }
  }

  window.addEventListener('keydown', (e) => {
    if (el.hidden || capture) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      sound('back');
      close();
    } else if (/^Arrow/.test(e.code) && !(e.target?.type === 'range' && /Left|Right/.test(e.code))) {
      e.preventDefault();
      navigate(e.code.slice(5).toLowerCase());
    }
  }, true);

  return {
    element: el,
    open,
    close,
    navigate,
    get isOpen() {
      return !el.hidden;
    },
    get tab() {
      return tab;
    },
    get capturing() {
      return capture ? { ...capture } : null;
    },
  };
}
