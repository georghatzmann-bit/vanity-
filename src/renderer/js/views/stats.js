// Session-Statistik: Spielzeit pro Tag und Profil, letzte Sitzungen, Aim-Test-Verlauf,
// Reaktionszeit und Ping. Alle Diagramme sind schlichtes SVG (document.createElementNS), ohne Bibliothek.

import {
  fmtNum, fmtSens, fmtDur, fmtDurNb, fmtAxisDuration, niceDurationTicks, valueRange, scaleLinear, linePath,
  labelStep, labelIndices, pickLabelIndices, fmtDay, fmtSpan, weekBadge, trendBadge, baseName,
  recSensText, recHint, progressInfo, keysText, exportParts,
} from '../lib/stats-chart.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RANGES = [[7, '7 Tage'], [30, '30 Tage'], [90, '90 Tage']];
const DAYS_KEY = 'helix.stats.days';

let cleanup = [];
let life = null; // { alive } der aktuellen Anzeige – alte Rückrufe prüfen ihr eigenes Objekt

/** SVG-Element bauen. Texte immer über textContent. */
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'text') el.textContent = String(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c) el.appendChild(c);
  return el;
}

function loadDays() {
  try {
    const v = Number(localStorage.getItem(DAYS_KEY));
    return RANGES.some(([d]) => d === v) ? v : 30;
  } catch { return 30; }
}

function saveDays(v) {
  try { localStorage.setItem(DAYS_KEY, String(v)); } catch { /* egal */ }
}

let gradientSeq = 0;

export default {
  async mount(root, env) {
    const { h, icon } = env.ui;
    const ui = env.ui;
    if (life) life.alive = false;
    const me = { alive: true };
    life = me;
    cleanup = [];
    const timeouts = new Set();
    const later = (fn, ms) => {
      const id = setTimeout(() => { timeouts.delete(id); if (me.alive) fn(); }, ms);
      timeouts.add(id);
    };
    cleanup.push(() => { for (const id of timeouts) clearTimeout(id); timeouts.clear(); });
    let days = loadDays();
    let data = null;
    let token = 0;

    // ---------- Diagramme an die Breite anpassen ----------
    const charts = new Map(); // host -> draw(width)
    let rafId = 0;
    const pending = new Set();
    const ro = typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => {
        for (const e of entries) pending.add(e.target);
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          for (const host of pending) {
            const draw = charts.get(host);
            if (draw && host.isConnected) draw(host.clientWidth);
          }
          pending.clear();
        });
      })
      : null;
    cleanup.push(() => { ro?.disconnect(); if (rafId) cancelAnimationFrame(rafId); charts.clear(); });

    function chartHost(draw, cls = '') {
      const host = h(`div.stats-chart${cls ? '.' + cls : ''}`);
      charts.set(host, (w) => {
        if (!w || w < 40) return;
        if (host.dataset.w === String(Math.round(w))) return;
        host.dataset.w = String(Math.round(w));
        const tip = h('div.stats-tip', { role: 'tooltip' });
        ui.mount(host, draw(Math.round(w), tip), tip);
      });
      ro?.observe(host);
      return host;
    }

    function drawAll() {
      for (const [host, draw] of charts) if (host.isConnected) draw(host.clientWidth);
    }

    function showTip(tip, host, x, y, title, lines = []) {
      ui.mount(tip, h('strong', title), lines.filter(Boolean).map((l) => h('span', l)));
      tip.classList.add('show');
      const w = tip.offsetWidth;
      const hw = host.clientWidth;
      const left = Math.min(Math.max(x, w / 2 + 4), Math.max(w / 2 + 4, hw - w / 2 - 4));
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(0, y)}px`;
    }
    const hideTip = (tip) => tip.classList.remove('show');

    // ---------- Aufbau ----------
    const top = h('div.stats-top');
    const content = h('div.stats-content', h('div.loading', ui.spinner()));
    root.append(top, content);

    async function load() {
      const my = ++token;
      try {
        const d = await env.call('stats.overview', { days });
        if (!me.alive || my !== token) return;
        data = d;
        renderTop();
        render();
      } catch (e) {
        if (!me.alive || my !== token) return;
        ui.mount(content, ui.emptyState({
          title: 'Die Statistik konnte nicht geladen werden',
          text: e.message || String(e),
          action: ui.button('Erneut versuchen', { iconName: 'refresh', onClick: () => load() }),
        }));
      }
    }

    function setDays(d) {
      if (d === days) return;
      days = d;
      saveDays(d);
      renderTop();
      load();
    }

    function renderTop() {
      const seg = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Zeitraum' },
        RANGES.map(([d, label]) => h(`button.seg${d === days ? '.active' : ''}`, {
          type: 'button', role: 'radio', 'aria-checked': String(d === days), onclick: () => setDays(d),
        }, label)));
      const hasData = !!data?.hasAnyData;
      ui.mount(top,
        h('div.stats-range',
          h('span.stats-label', 'Zeitraum'),
          seg,
          h('p.hint', 'Gilt für Spielzeit und Aim-Tests. Reaktionszeit und Ping zeigen immer deine letzten Messungen.')),
        h('span.grow'),
        h('div.stats-export',
          ui.button('Als Tabelle speichern', { iconName: 'download', onClick: exportCsv, disabled: !hasData }),
          h('p.hint', hasData
            ? 'Speichert alle Sitzungen, Tests und Messungen als CSV-Datei – eine Tabelle, die Excel öffnen kann.'
            : 'Das geht, sobald es die ersten Werte gibt.')));
    }

    async function exportCsv() {
      try {
        const r = await env.call('stats.exportCsv');
        if (!r || r.canceled) { ui.toast('Speichern abgebrochen. Es wurde nichts gespeichert.', 'info'); return; }
        const parts = exportParts(r);
        ui.toast(`Tabelle gespeichert: ${r.fileName || baseName(r.file)}${parts ? ` (${parts})` : ''}.`);
      } catch (e) {
        ui.showError(e, 'Speichern nicht möglich');
      }
    }

    // ---------- Inhalt ----------
    function render() {
      charts.clear();
      ro?.disconnect();
      const d = data;
      const out = [];
      if (!d.trackingSupported) {
        out.push(h('div.callout.info', icon('info'), h('div',
          h('strong', 'Spielzeit wird nur unter Windows gezählt'),
          h('p.hint', 'HELIX erkennt Fortnite über die Liste der laufenden Windows-Programme. Auf diesem System geht das nicht. Aim-Tests und andere Werte siehst du trotzdem.'))));
      }
      if (d.play.running && d.play.current) {
        out.push(h('div.callout.ok.stats-live', icon('play'), h('div.grow',
          h('strong', 'Fortnite läuft gerade'),
          h('p.hint', `Diese Sitzung zählt schon mit: ${fmtDur(d.play.current.seconds)} mit Profil „${d.play.current.profileName}“. Die Werte aktualisieren sich jede Minute.`)),
          ui.badge('zählt mit', 'ok')));
      }
      if (d.hasSessions) {
        out.push(kpiRow(d));
        out.push(h('div.stats-grid', dailyBlock(d), profileBlock(d)));
        out.push(h('div.stats-grid', aimBlock(d), recentBlock(d)));
      } else {
        out.push(noSessionsBlock());
        out.push(aimBlock(d));
      }
      out.push(h('div.stats-grid.half', reactionBlock(d), pingBlock(d)));
      ui.mount(content, out);
      requestAnimationFrame(() => { if (me.alive) drawAll(); });
    }

    // ---------- Kennzahlen ----------
    function kpi(label, value, hint, badge, title) {
      return h('div.stats-kpi', { title },
        h('span.kpi-label', label),
        h('strong.kpi-value', value),
        badge ? h('div.kpi-badge', ui.badge(badge.text, badge.type)) : null,
        h('span.hint', hint));
    }

    function kpiRow(d) {
      const p = d.play;
      const wk = p.week;
      const wb = weekBadge(wk);
      const fav = p.favourite;
      return h('div.stats-kpis',
        kpi('Spielzeit gesamt', fmtDur(p.totalSeconds),
          p.totalSeconds ? `in den letzten ${d.days} Tagen · an ${p.activeDays} ${p.activeDays === 1 ? 'Tag' : 'Tagen'} gespielt` : `In den letzten ${d.days} Tagen nicht gespielt.`),
        kpi('Diese Woche', fmtDur(wk.thisSeconds),
          `Vorwoche bis ${wk.weekdayName}: ${fmtDurNb(wk.lastSameTimeSeconds)}`, wb,
          `Die ganze Vorwoche: ${fmtDur(wk.lastSeconds)}. Die Woche beginnt am Montag.`),
        kpi('Sitzungen', String(p.sessionCount),
          p.sessionCount ? `im Schnitt ${fmtDurNb(p.avgSessionSeconds)} pro Sitzung` : 'Keine Sitzung in diesem Zeitraum.', null,
          'Eine Sitzung ist die Zeit von „Fortnite startet“ bis „Fortnite ist wieder zu“.'),
        kpi('Längste Sitzung', p.longest ? fmtDur(p.longest.seconds) : '–',
          p.longest ? `${fmtDay(p.longest.start, 'weekday')} · ${p.longest.profileName}` : 'Keine Sitzung in diesem Zeitraum.'),
        kpi('Lieblingsprofil', fav ? fav.name : '–',
          fav ? `${fav.sharePct}\u00a0% deiner Spielzeit · ${fmtDurNb(fav.seconds)}` : 'Wende ein Profil an, dann zählt HELIX die Zeit pro Profil.'));
    }

    // ---------- Spielzeit pro Tag ----------
    function dailyBlock(d) {
      const p = d.play;
      const host = chartHost((w, tip) => drawDaily(w, tip, host, p.daily, d.days));
      const foot = p.bestDay
        ? h('p.hint.stats-foot', `Bester Tag: ${fmtDay(p.bestDay.start, 'weekday')} mit ${fmtDurNb(p.bestDay.seconds)} · im Schnitt ${fmtDurNb(p.avgActiveDaySeconds)} an Tagen, an denen du gespielt hast.`)
        : h('p.hint.stats-foot', `In den letzten ${d.days} Tagen hast du nicht gespielt.`);
      return ui.section('Spielzeit pro Tag', 'Fahre mit der Maus über einen Balken, dann siehst du die genaue Zeit.', host, foot);
    }

    function drawDaily(width, tip, host, daily, rangeDays) {
      const H = 220; const padL = 64; const padR = 8; const padT = 12; const padB = 28;
      const n = daily.length;
      if (!n) return s('svg', { width, height: H, 'aria-hidden': 'true' });
      const innerW = Math.max(10, width - padL - padR);
      const innerH = H - padT - padB;
      const max = Math.max(0, ...daily.map((x) => x.seconds));
      const ticks = niceDurationTicks(max, 4);
      const y = (sec) => padT + innerH - (sec / ticks.max) * innerH;
      const slot = innerW / n;
      const barW = Math.max(2, Math.min(26, slot * 0.66));
      const total = daily.reduce((a, x) => a + x.seconds, 0);
      const svg = s('svg', { width, height: H, viewBox: `0 0 ${width} ${H}`, role: 'img', 'aria-label': `Spielzeit pro Tag in den letzten ${rangeDays} Tagen, zusammen ${fmtDur(total)}` });
      for (const t of ticks.ticks) {
        svg.appendChild(s('line', { x1: padL, x2: width - padR, y1: y(t), y2: y(t), class: t === 0 ? 'axis-line' : 'grid-line' }));
        svg.appendChild(s('text', { x: padL - 10, y: y(t) + 4, 'text-anchor': 'end', class: 'ax-label', text: fmtAxisDuration(t) }));
      }
      const mode = n <= 7 ? 'weekday' : 'short';
      const step = labelStep(n, slot, mode === 'weekday' ? 62 : 46);
      for (const i of labelIndices(n, step)) {
        svg.appendChild(s('text', { x: padL + i * slot + slot / 2, y: H - 8, 'text-anchor': 'middle', class: 'ax-label', text: fmtDay(daily[i].day, mode) }));
      }
      const bars = daily.map((x, i) => {
        if (!x.seconds) return null;
        const hgt = Math.max(2, (x.seconds / ticks.max) * innerH);
        const bar = s('rect', { x: padL + i * slot + (slot - barW) / 2, y: padT + innerH - hgt, width: barW, height: hgt, rx: Math.min(3, barW / 2), class: 'bar' });
        svg.appendChild(bar);
        return bar;
      });
      const guide = s('rect', { x: 0, y: padT, width: slot, height: innerH, class: 'hover-col', visibility: 'hidden' });
      svg.insertBefore(guide, svg.firstChild);
      daily.forEach((x, i) => {
        const hit = s('rect', { x: padL + i * slot, y: padT, width: slot, height: innerH, class: 'hit' });
        const enter = () => {
          guide.setAttribute('x', String(padL + i * slot));
          guide.setAttribute('visibility', 'visible');
          bars[i]?.classList.add('hover');
          const lines = x.seconds
            ? [fmtDur(x.seconds), `${x.sessions} ${x.sessions === 1 ? 'Sitzung' : 'Sitzungen'} begonnen`]
            : ['Nicht gespielt'];
          showTip(tip, host, padL + i * slot + slot / 2, x.seconds ? y(x.seconds) - 8 : y(0) - 8, fmtDay(x.day, 'long'), lines);
        };
        const leave = () => { guide.setAttribute('visibility', 'hidden'); bars[i]?.classList.remove('hover'); hideTip(tip); };
        hit.addEventListener('mouseenter', enter);
        hit.addEventListener('mouseleave', leave);
        svg.appendChild(hit);
      });
      return svg;
    }

    // ---------- pro Profil ----------
    function profileBlock(d) {
      const list = d.play.perProfile;
      const body = list.length
        ? h('ul.stats-prof', list.slice(0, 6).map((p, i) => h('li',
          h('div.prof-head',
            h('span.prof-name', { title: p.name }, p.name),
            h('span.prof-time', fmtDur(p.seconds)),
            h('span.prof-share', `${p.sharePct} %`)),
          h('div.prof-bar', { role: 'img', 'aria-label': `${p.name}: ${p.sharePct} Prozent` }, h('span', { style: { width: `${Math.max(p.sharePct, p.seconds ? 1 : 0)}%`, opacity: String(Math.max(0.45, 1 - i * 0.18)) } })),
          h('span.hint', p.profileId
            ? `${p.sessions} ${p.sessions === 1 ? 'Sitzung' : 'Sitzungen'}`
            : `${p.sessions} ${p.sessions === 1 ? 'Sitzung' : 'Sitzungen'} – in dieser Zeit war kein HELIX-Profil aktiv`))))
        : h('p.hint.stats-none', `In den letzten ${d.days} Tagen gibt es keine Spielzeit.`);
      return ui.section('Spielzeit pro Profil', 'Welches Profil aktiv war, während du gespielt hast. Die Prozente zeigen den Anteil an deiner Spielzeit.', body);
    }

    // ---------- letzte Sitzungen ----------
    function recentBlock(d) {
      const list = d.play.recent;
      const body = list.length
        ? h('ul.list.compact.stats-recent', list.map((x) => h('li',
          h('div.grow',
            h('span', fmtSpan(x.start, x.end)),
            h('span.hint', x.recovered ? `${x.profileName} · Ende geschätzt` : x.profileName)),
          x.live ? ui.badge('läuft gerade', 'accent') : null,
          h('span.recent-dur', fmtDur(x.seconds)))))
        : h('p.hint.stats-none', 'Noch keine Sitzung.');
      return ui.section('Letzte Sitzungen', 'Wann Fortnite zuletzt offen war – unabhängig vom gewählten Zeitraum. „Ende geschätzt“ heißt: HELIX wurde geschlossen, während Fortnite noch lief. Darum kennt HELIX das genaue Ende nicht.', body);
    }

    function noSessionsBlock() {
      return h('section.block.stats-empty-play', ui.emptyState({
        title: 'Noch keine Spielzeit gezählt',
        text: 'Spiele eine Runde Fortnite, während HELIX läuft. HELIX zählt die Zeit dann automatisch mit – pro Profil. Dafür schaut HELIX nur, ob Fortnite geöffnet ist.',
        action: ui.button('Zu den Profilen', { iconName: 'sparkle', onClick: () => env.nav.go('profiles') }),
      }), h('p.hint.stats-center', 'Tipp: Wende vorher ein Profil an. Dann siehst du hier, wie lange du mit welchem Profil gespielt hast.'));
    }

    // ---------- Aim-Test-Verlauf ----------
    function aimBlock(d) {
      const a = d.aim;
      const hintText = 'Punkte (0 bis 100) und Trefferquote aus der Sensi-Kalibrierung. Die kleine Zahl über einem Punkt ist die Sensi, die HELIX nach dem Test empfohlen hat.';
      if (!a.total) {
        return ui.section('Aim-Test-Verlauf', hintText, ui.emptyState({
          title: 'Noch kein Aim-Test',
          text: 'Mach einen Aim-Test in der Sensi-Kalibrierung. Danach siehst du hier, wie sich Punkte und Trefferquote entwickeln.',
          action: ui.button('Zur Sensi-Kalibrierung', { variant: 'primary', iconName: 'play', onClick: () => env.nav.go('sensi') }),
        }));
      }
      const tb = trendBadge(a.trend);
      const prog = progressInfo(a.trend);
      const best = a.bestAccuracy;
      const last = a.latest;
      const mini = h('div.stats-mini-kpis',
        miniKpi('Fortschritt', prog ? prog.value : '–',
          prog ? prog.text : 'Ab zwei Tests siehst du hier deinen Fortschritt.', tb),
        miniKpi('Beste Trefferquote', best ? `${fmtNum(best.accuracy, 0)} %` : '–',
          best ? `Test vom ${fmtDay(best.at, 'date')}${best.recommendedSens != null ? ` · Empfehlung damals: Sensi ${recSensText(best)}` : ''}` : 'Noch kein Wert.'),
        miniKpi('Aktuelle Empfehlung', last?.recommendedSens != null ? `Sensi ${fmtSens(last.recommendedSens)}` : '–',
          last ? recHint(last) : ''));
      const legend = h('div.stats-legend',
        h('span', h('i.swatch'), 'Punkte'),
        h('span', h('i.swatch.dashed'), 'Trefferquote in %'),
        h('span', h('b.swatch-num', '6,5'), 'empfohlene Sensi'));
      const parts = [mini];
      if (a.outOfRange) {
        parts.push(h('div.callout.info', icon('info'), h('div', h('strong', `Kein Aim-Test in den letzten ${d.days} Tagen`), h('p.hint', 'Darum siehst du hier deine letzten Tests von früher.'))));
      }
      const host = chartHost((w, tip) => drawAim(w, tip, host, a.points));
      parts.push(legend, host);
      if (a.points.length === 1) parts.push(h('p.hint.stats-foot', 'Ab zwei Tests wird daraus eine Linie. Mach den Test ab und zu, dann siehst du deinen Fortschritt.'));
      parts.push(h('div.row', ui.button('Neuen Aim-Test machen', { small: true, iconName: 'play', onClick: () => env.nav.go('sensi') }),
        h('span.hint', `${a.total} ${a.total === 1 ? 'Test' : 'Tests'} gespeichert${a.inRange && a.inRange !== a.total ? `, ${a.inRange} davon im Zeitraum` : ''}.`)));
      return ui.section('Aim-Test-Verlauf', hintText, parts);
    }

    function miniKpi(label, value, hint, badge) {
      return h('div.stats-mini',
        h('span.kpi-label', label),
        h('div.mini-line', h('strong', value), badge ? ui.badge(badge.text, badge.type) : null),
        hint ? h('span.hint', hint) : null);
    }

    function drawAim(width, tip, host, points) {
      const H = 250; const padL = 40; const padR = 16; const padT = 30; const padB = 28;
      const innerW = Math.max(10, width - padL - padR);
      const innerH = H - padT - padB;
      const n = points.length;
      const edge = Math.min(16, innerW / 6);
      const xs = points.map((_, i) => (n === 1 ? padL + innerW / 2 : padL + edge + ((innerW - 2 * edge) * i) / (n - 1)));
      const y = scaleLinear(0, 100, padT + innerH, padT);
      const gid = `stats-aim-grad-${++gradientSeq}`;
      const svg = s('svg', { width, height: H, viewBox: `0 0 ${width} ${H}`, role: 'img', 'aria-label': `Aim-Test-Verlauf mit ${n} ${n === 1 ? 'Test' : 'Tests'}` },
        s('defs', {}, s('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 },
          s('stop', { offset: '0%', class: 'grad-top' }), s('stop', { offset: '100%', class: 'grad-bottom' }))));
      for (const t of [0, 25, 50, 75, 100]) {
        svg.appendChild(s('line', { x1: padL, x2: width - padR, y1: y(t), y2: y(t), class: t === 0 ? 'axis-line' : 'grid-line' }));
        svg.appendChild(s('text', { x: padL - 10, y: y(t) + 4, 'text-anchor': 'end', class: 'ax-label', text: String(t) }));
      }
      const slot = n > 1 ? (innerW - 2 * edge) / (n - 1) : innerW;
      const step = labelStep(n, slot, 52);
      for (const i of labelIndices(n, step)) {
        svg.appendChild(s('text', { x: xs[i], y: H - 8, 'text-anchor': 'middle', class: 'ax-label', text: fmtDay(points[i].at, 'short') }));
      }
      const scorePts = points.map((p, i) => (p.score == null ? null : { x: xs[i], y: y(p.score) }));
      const accPts = points.map((p, i) => (p.accuracy == null ? null : { x: xs[i], y: y(p.accuracy) }));
      const valid = scorePts.filter(Boolean);
      if (valid.length > 1) {
        const area = `${linePath(valid)} L${valid[valid.length - 1].x} ${y(0)} L${valid[0].x} ${y(0)} Z`;
        svg.appendChild(s('path', { d: area, fill: `url(#${gid})`, class: 'area' }));
      }
      const guide = s('line', { x1: 0, x2: 0, y1: padT, y2: padT + innerH, class: 'guide', visibility: 'hidden' });
      svg.appendChild(guide);
      svg.appendChild(s('path', { d: linePath(accPts), class: 'line-acc' }));
      svg.appendChild(s('path', { d: linePath(scorePts), class: 'line-score' }));
      const accDots = accPts.map((p) => (p ? svg.appendChild(s('circle', { cx: p.x, cy: p.y, r: 2.5, class: 'dot-acc' })) : null));
      const scoreDots = scorePts.map((p) => (p ? svg.appendChild(s('circle', { cx: p.x, cy: p.y, r: 3.5, class: 'dot-score' })) : null));
      const labelIdx = pickLabelIndices(points.map((p) => p.recommendedSens), xs, 34);
      for (const i of labelIdx) {
        const p = points[i];
        const top = Math.min(scorePts[i]?.y ?? padT + innerH, accPts[i]?.y ?? padT + innerH);
        svg.appendChild(s('text', { x: xs[i], y: Math.max(12, top - 10), 'text-anchor': 'middle', class: 'sens-label', text: fmtSens(p.recommendedSens) }));
      }
      points.forEach((p, i) => {
        const left = i === 0 ? padL : (xs[i - 1] + xs[i]) / 2;
        const right = i === n - 1 ? width - padR : (xs[i] + xs[i + 1]) / 2;
        const hit = s('rect', { x: left, y: padT, width: Math.max(1, right - left), height: innerH, class: 'hit' });
        hit.addEventListener('mouseenter', () => {
          guide.setAttribute('x1', String(xs[i]));
          guide.setAttribute('x2', String(xs[i]));
          guide.setAttribute('visibility', 'visible');
          scoreDots[i]?.classList.add('hover');
          accDots[i]?.classList.add('hover');
          const lines = [
            `Punkte: ${p.score == null ? '–' : fmtNum(p.score, 0)} · Trefferquote: ${p.accuracy == null ? '–' : `${fmtNum(p.accuracy, 0)} %`}`,
            p.recommendedSens != null ? `Empfohlene Sensi: ${recSensText(p)}${p.edpi != null ? ` (eDPI ${fmtNum(p.edpi, 1)})` : ''}` : null,
            p.sens != null ? `Getestet rund um Sensi ${fmtSens(p.sens)}${p.dpi != null ? ` bei ${fmtNum(p.dpi, 0)} DPI` : ''}` : null,
          ];
          const ty = Math.min(scorePts[i]?.y ?? padT + innerH, accPts[i]?.y ?? padT + innerH) - 12;
          showTip(tip, host, xs[i], ty, `Test vom ${fmtDay(p.at, 'date')}, ${fmtDay(p.at, 'time')} Uhr`, lines);
        });
        hit.addEventListener('mouseleave', () => {
          guide.setAttribute('visibility', 'hidden');
          scoreDots[i]?.classList.remove('hover');
          accDots[i]?.classList.remove('hover');
          hideTip(tip);
        });
        svg.appendChild(hit);
      });
      return svg;
    }

    // ---------- kleine Verläufe (Reaktion, Ping) ----------
    function drawMini(width, tip, host, points, { value, fmt, title, unit = 10, minSpan = 20 }) {
      const H = 120; const padL = 52; const padR = 12; const padT = 12; const padB = 22;
      const innerW = Math.max(10, width - padL - padR);
      const innerH = H - padT - padB;
      const n = points.length;
      const vals = points.map(value);
      const range = valueRange(vals, { unit, minSpan });
      const y = scaleLinear(range.min, range.max, padT + innerH, padT);
      const edge = Math.min(10, innerW / 6);
      const xs = points.map((_, i) => (n === 1 ? padL + innerW / 2 : padL + edge + ((innerW - 2 * edge) * i) / (n - 1)));
      const svg = s('svg', { width, height: H, viewBox: `0 0 ${width} ${H}`, role: 'img', 'aria-label': title });
      for (const t of [range.min, range.max]) {
        svg.appendChild(s('line', { x1: padL, x2: width - padR, y1: y(t), y2: y(t), class: 'grid-line' }));
        svg.appendChild(s('text', { x: padL - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'ax-label', text: fmt(t) }));
      }
      if (n) {
        svg.appendChild(s('text', { x: xs[0], y: H - 6, 'text-anchor': n === 1 ? 'middle' : 'start', class: 'ax-label', text: fmtDay(points[0].at, 'short') }));
        if (n > 1) svg.appendChild(s('text', { x: xs[n - 1], y: H - 6, 'text-anchor': 'end', class: 'ax-label', text: fmtDay(points[n - 1].at, 'short') }));
      }
      const pts = vals.map((v, i) => ({ x: xs[i], y: y(v) }));
      svg.appendChild(s('path', { d: linePath(pts), class: 'line-score thin' }));
      const dots = pts.map((p, i) => svg.appendChild(s('circle', { cx: p.x, cy: p.y, r: i === n - 1 ? 3.5 : 2.2, class: i === n - 1 ? 'dot-score' : 'dot-mini' })));
      points.forEach((p, i) => {
        const left = i === 0 ? padL : (xs[i - 1] + xs[i]) / 2;
        const right = i === n - 1 ? width - padR : (xs[i] + xs[i + 1]) / 2;
        const hit = s('rect', { x: left, y: 0, width: Math.max(1, right - left), height: H, class: 'hit' });
        hit.addEventListener('mouseenter', () => {
          dots[i]?.classList.add('hover');
          showTip(tip, host, xs[i], pts[i].y - 10, `${fmtDay(p.at, 'date')}, ${fmtDay(p.at, 'time')} Uhr`, [fmt(vals[i], p)]);
        });
        hit.addEventListener('mouseleave', () => { dots[i]?.classList.remove('hover'); hideTip(tip); });
        svg.appendChild(hit);
      });
      return svg;
    }

    function miniEmpty(textLine, label, target) {
      return h('div.stats-mini-empty',
        h('p.hint', textLine),
        ui.button(label, { small: true, iconName: 'play', onClick: () => env.nav.go(target) }));
    }

    function reactionBlock(d) {
      const r = d.reaction;
      const hint = 'Aus dem Reaktions-Labor. Gemessen in Millisekunden (ms, also Tausendstelsekunden) – weniger ist schneller. Zeigt immer deine letzten Tests, unabhängig vom gewählten Zeitraum.';
      if (!r.count && !r.keys.count) {
        return ui.section('Reaktionszeit', hint, miniEmpty('Noch kein Reaktionstest gespeichert. Mach einen Test im Reaktions-Labor, dann siehst du hier deinen Verlauf.', 'Zum Reaktions-Labor', 'reaktion'));
      }
      const parts = [];
      if (r.count) {
        const tb = trendBadge(r.trend, { betterText: 'schneller geworden', worseText: 'langsamer geworden', sameText: 'gleich schnell' });
        parts.push(h('div.stats-mini-kpis',
          miniKpi('Zuletzt', `${r.latest.avgMs} ms`, `Durchschnitt am ${fmtDay(r.latest.at, 'date')}`, tb),
          miniKpi('Bester Schnitt', `${r.best.avgMs} ms`, r.bestSingleMs != null ? `Schnellste einzelne Reaktion: ${r.bestSingleMs} ms` : `am ${fmtDay(r.best.at, 'date')}`)));
        const host = chartHost((w, tip) => drawMini(w, tip, host, r.points, {
          value: (p) => p.avgMs, fmt: (v) => `${Math.round(v)} ms`, title: `Reaktionszeit, ${r.points.length} Tests`, unit: 10, minSpan: 40,
        }), 'mini');
        parts.push(host);
      } else {
        parts.push(h('p.hint', 'Noch kein Reaktionstest – nur Ergebnisse aus dem Tasten-Trainer.'));
      }
      if (r.keys.count) parts.push(h('p.hint.stats-foot', keysText(r.keys.latest)));
      return ui.section('Reaktionszeit', hint, parts);
    }

    function pingBlock(d) {
      const p = d.ping;
      const hint = 'Aus dem Ping-Tester: so lange braucht ein Signal zum Server und zurück, in ms. Weniger ist besser. Zeigt immer deine letzten Messungen, unabhängig vom gewählten Zeitraum.';
      if (!p.count) {
        return ui.section('Ping', hint, miniEmpty('Noch keine Ping-Messung gespeichert. Miss deine Verbindung im Ping-Tester, dann siehst du hier den Verlauf.', 'Zum Ping-Tester', 'ping'));
      }
      const tb = trendBadge(p.trend, { betterText: 'besser geworden', worseText: 'schlechter geworden', sameText: 'gleich' });
      const host = chartHost((w, tip) => drawMini(w, tip, host, p.points, {
        value: (x) => x.ms, fmt: (v, x) => (x ? `${x.name}: ${Math.round(v)} ms` : `${Math.round(v)} ms`), title: `Ping-Verlauf, ${p.points.length} Messungen`, unit: 5, minSpan: 10,
      }), 'mini');
      return ui.section('Ping', hint,
        h('div.stats-mini-kpis',
          miniKpi('Zuletzt', `${p.latest.ms} ms`, `Bester Server: ${p.latest.name}`, tb),
          miniKpi('Bestwert', `${p.best.ms} ms`, `${p.best.name} am ${fmtDay(p.best.at, 'date')}`)),
        host);
    }

    // ---------- Live ----------
    cleanup.push(env.on('sessions.changed', () => { if (me.alive) load(); }));
    cleanup.push(env.on('fortnite.state', () => later(load, 1500)));
    const timer = setInterval(() => { if (me.alive && data?.play?.running) load(); }, 60000);
    cleanup.push(() => clearInterval(timer));

    renderTop();
    await load();
  },

  unmount() {
    if (life) life.alive = false;
    life = null;
    for (const fn of cleanup) { try { fn?.(); } catch { /* weiter */ } }
    cleanup = [];
  },
};
