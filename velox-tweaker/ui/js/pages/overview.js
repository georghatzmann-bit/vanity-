// Übersicht: score hero, system cards, stats, top findings, quick tiles.
import { icon } from '../icons.js';
import { h, clear, scoreRing, button, countUp, fmtRelative, fmtNumber, emptyState, stagger, badge, append } from '../ui.js';
import { api } from '../api.js';
import { severityBadge, applyFix } from './advisor.js';

const pick = (...v) => v.find(x => x !== undefined && x !== null && x !== '');

function cleanCpu(n) {
  return String(n || '').replace(/\((R|TM|C)\)/gi, '').replace(/\s+\d+-Core Processor/i, '').replace(/\s+(CPU|Processor)\b/gi, '').replace(/\s+@.*$/, '').replace(/\s+/g, ' ').trim();
}

/**
 * Turns state.profile into display cards. The profile shape is owned by core/Scan.ps1 and not
 * fixed by the contract, so this accepts several plausible spellings for every field.
 */
export function describeProfile(p) {
  if (!p) return null;
  const cpu = p.cpu && typeof p.cpu === 'object' ? p.cpu : {};
  const cpuName = cleanCpu(pick(cpu.name, typeof p.cpu === 'string' ? p.cpu : null, p.cpuName, p.processor)) || 'Unbekannt';
  const cores = pick(cpu.cores, p.cpuCores);
  const threads = pick(cpu.threads, cpu.logical, cpu.logicalProcessors, p.cpuThreads);
  let gpus = Array.isArray(p.gpus) ? p.gpus : Array.isArray(p.gpu) ? p.gpu : p.gpu ? [p.gpu] : [];
  gpus = gpus.map(g => typeof g === 'string' ? { name: g } : g || {});
  const gpu = gpus.find(g => /nvidia|amd|radeon|geforce/i.test((g.vendor || '') + ' ' + (g.name || ''))) || gpus[0] || {};
  const ramObj = p.ram && typeof p.ram === 'object' ? p.ram : {};
  const ramGB = pick(p.ramGB, ramObj.totalGB, ramObj.gb, p.memoryGB, typeof p.ram === 'number' ? p.ram : null);
  const ramSpeed = pick(ramObj.speedMHz, ramObj.speedMhz, ramObj.speed, p.ramSpeedMhz, p.ramSpeed);
  const disks = Array.isArray(p.disks) ? p.disks : Array.isArray(p.drives) ? p.drives : [];
  const sys = disks.find(d => d && (d.system || d.isSystem)) || disks[0] || {};
  const diskType = String(pick(p.systemDisk, sys.media, sys.type, sys.mediaType, '') || '').toLowerCase();
  const diskName = pick(sys.model, sys.name, sys.friendlyName);
  const freeGB = pick(p.systemDriveFreeGB, sys.freeGB);
  const os = p.os && typeof p.os === 'object' ? p.os : {};
  const osName = pick(os.caption, os.name, typeof p.os === 'string' ? p.os : null, p.osName, p.windows && p.windows.caption) || 'Windows';
  const osVer = pick(os.displayVersion, os.version, p.osVersion);
  const build = pick(os.build, p.build, p.osBuild);
  const displays = Array.isArray(p.displays) ? p.displays : Array.isArray(p.monitors) ? p.monitors : p.display ? [p.display] : [];
  const disp = displays.find(d => d && d.primary) || displays[0] || {};
  const hz = pick(disp.currentHz, disp.hz, disp.refreshRate, p.refreshRate, p.hz);
  const maxHz = pick(disp.maxHz, null);
  const res = disp.width && disp.height ? disp.width + ' × ' + disp.height : pick(disp.resolution, null);
  return [
    { key: 'cpu', icon: 'cpu', label: 'Prozessor', value: cpuName, sub: [cores && cores + ' Kerne', threads && threads + ' Threads'].filter(Boolean).join(' · ') || ' ' },
    { key: 'gpu', icon: 'gpu', label: 'Grafikkarte', value: gpu.name || 'Unbekannt', sub: [gpu.vramGB ? gpu.vramGB + ' GB VRAM' : null, gpus.length > 1 ? '+' + (gpus.length - 1) + ' weitere' : null, gpu.driver ? 'Treiber ' + gpu.driver : null].filter(Boolean).join(' · ') || ' ' },
    { key: 'ram', icon: 'ram', label: 'Arbeitsspeicher', value: ramGB ? fmtNumber(Number(ramGB)) + ' GB' + (ramObj.type ? ' ' + ramObj.type : '') : 'Unbekannt', sub: [ramSpeed ? ramSpeed + ' MHz' : null, ramObj.modules ? ramObj.modules + (ramObj.modules === 1 ? ' Modul' : ' Module') : null].filter(Boolean).join(' · ') || ' ' },
    { key: 'disk', icon: 'drive', label: 'Systemlaufwerk', value: diskType === 'ssd' || diskType === 'nvme' ? (sys.bus === 'nvme' ? 'NVMe-SSD' : 'SSD') : diskType === 'hdd' ? 'Festplatte (HDD)' : (diskName || 'Unbekannt'), sub: [diskType ? diskName : null, freeGB !== undefined && freeGB !== null ? fmtNumber(Number(freeGB), 0) + ' GB frei' : null].filter(Boolean).join(' · ') || ' ' },
    { key: 'os', icon: 'windows', label: 'Windows', value: osName, sub: [osVer, build && 'Build ' + build].filter(Boolean).join(' · ') || ' ' },
    { key: 'display', icon: 'monitor', label: 'Bildschirm', value: hz ? hz + ' Hz' : 'Unbekannt', sub: [res, maxHz && hz && maxHz > hz ? 'kann ' + maxHz + ' Hz' : null].filter(Boolean).join(' · ') || ' ', warn: !!(maxHz && hz && maxHz > hz + 5) }
  ];
}

const SYS_SKELETON = [['cpu', 'Prozessor'], ['gpu', 'Grafikkarte'], ['ram', 'Arbeitsspeicher'], ['drive', 'Systemlaufwerk'], ['windows', 'Windows'], ['monitor', 'Bildschirm']];

export default {
  id: 'overview', title: 'Übersicht', icon: 'home', desc: 'Dein PC auf einen Blick', keywords: 'dashboard start home',
  mount(el, ctx) {
    const res = ctx.cache.advisor;
    // ---------- hero
    const ring = scoreRing({ size: 176, stroke: 13, value: null, label: res ? 'von 100' : 'Score' });
    const eyebrow = h('div', { class: 'eyebrow' });
    const headline = h('h2', { class: 'hero-title' });
    const text = h('p', { class: 'hero-text' });
    const metaLine = h('div', { class: 'hero-meta' });
    const cta = button({ label: 'Jetzt analysieren', icon: 'sparkles', variant: 'primary', cls: 'btn-brand btn-lg', onClick: () => ctx.navigate('advisor', { autostart: true }), attrs: { 'data-testid': 'cta-analyze' } });
    const second = button({ label: 'Preset wählen', icon: 'stack', variant: 'secondary', cls: 'btn-lg', onClick: () => ctx.navigate('presets') });
    const hero = h('section', { class: 'card hero spot' }, h('div', { class: 'hero-bg', 'aria-hidden': 'true' }),
      h('div', { class: 'hero-ring' }, ring),
      h('div', { class: 'hero-body' }, eyebrow, headline, text, h('div', { class: 'hero-actions' }, cta, second), metaLine));

    function fillHero() {
      const r = ctx.cache.advisor;
      clear(metaLine);
      if (!r) {
        ring.set(null);
        ring.setLabel('noch offen');
        eyebrow.textContent = 'Noch nicht analysiert';
        headline.textContent = 'Finde heraus, was in deinem PC steckt';
        text.textContent = 'Die Smart-Analyse prüft Hardware, Energieplan, Hintergrunddienste und Fremd-Tweaks – offline und in wenigen Sekunden. Danach bekommst du einen Plan, den du mit einem Klick anwendest.';
        append(metaLine, icon('shieldCheck', 14), h('span', { text: 'Vor jeder Änderung wird automatisch gesichert.' }));
      } else {
        const score = r.planApplied ? r.scoreAfter : r.score;
        ring.setLabel('von 100');
        ring.set(score, r.planApplied ? null : r.scoreAfter);
        eyebrow.textContent = r.planApplied ? 'Leistungs-Score · Plan angewendet' : 'Leistungs-Score';
        headline.textContent = score >= 80 ? 'Stark eingestellt' : score >= 60 ? 'Gut – aber da geht noch was' : 'Dein PC bremst sich selbst aus';
        text.textContent = r.planApplied ? 'Dein Plan ist angewendet. Starte eine neue Analyse, um den genauen Stand zu sehen – oder schau dir die Presets an.' : (r.summary || '');
        const engineName = r.engine === 'claude' ? 'Claude KI' : 'Smart-Analyse';
        append(metaLine, icon(r.planApplied ? 'checkCircle' : 'arrowRight', 14), h('span', { text: r.planApplied ? 'Vorher ' + r.score + ' Punkte · ' + engineName : 'Mit dem Plan: ' + r.scoreAfter + ' Punkte · ' + (r.plan || []).length + ' Vorschläge · ' + engineName }));
        cta.querySelector('.btn-label').textContent = 'Neu analysieren';
      }
    }

    // ---------- system cards
    const sysGrid = h('section', { class: 'sys-grid', 'aria-label': 'System' });
    function fillSys() {
      clear(sysGrid);
      const cards = describeProfile(ctx.state.profile);
      if (!cards) {
        for (const [ic, label] of SYS_SKELETON) {
          sysGrid.appendChild(h('div', { class: 'card sys-card is-loading' },
            h('div', { class: 'sys-icon' }, icon(ic, 20)),
            h('div', { class: 'sys-text' }, h('div', { class: 'sys-label', text: label }),
              ctx.scanning ? h('div', { class: 'skel', style: { width: '80%', height: '14px' } }) : h('div', { class: 'sys-value muted', text: 'Noch nicht erkannt' }),
              ctx.scanning ? h('div', { class: 'skel', style: { width: '50%', height: '10px' } }) : h('div', { class: 'sys-sub', text: 'Wird beim Scan gelesen' }))));
        }
        return;
      }
      for (const c of cards) {
        sysGrid.appendChild(h('div', { class: 'card sys-card spot', 'data-sys': c.key, title: c.value },
          h('div', { class: 'sys-icon' }, icon(c.icon, 20)),
          h('div', { class: 'sys-text' }, h('div', { class: 'sys-label', text: c.label }), h('div', { class: 'sys-value', text: c.value }), h('div', { class: 'sys-sub' + (c.warn ? ' is-warn' : ''), text: c.sub }))));
      }
      stagger(sysGrid);
    }

    // ---------- stats
    const statActive = h('span', { class: 'stat-num', text: '0' });
    const statActiveOf = h('span', { class: 'stat-of' });
    const statBar = h('div', { class: 'mini-bar' }, h('div', { class: 'mini-bar-fill' }));
    const statForeign = h('span', { class: 'stat-num', text: '0' });
    const statForeignSub = h('div', { class: 'stat-sub' });
    const statBackup = h('span', { class: 'stat-num stat-num-sm', text: '…' });
    const statBackupSub = h('div', { class: 'stat-sub', text: ' ' });
    const mkStat = (ic, label, body, sub, onClick, testid) => {
      const card = h('button', { class: 'card stat-card clickable spot', type: 'button', 'data-testid': testid },
        h('div', { class: 'stat-head' }, h('span', { class: 'stat-icon' }, icon(ic, 16)), h('span', { class: 'stat-label', text: label }), icon('arrowRight', 14, 'stat-go')),
        h('div', { class: 'stat-body' }, body), sub);
      card.addEventListener('click', onClick);
      return card;
    };
    const stats = h('section', { class: 'stat-grid' },
      mkStat('sliders', 'Aktive Tweaks', [statActive, statActiveOf], statBar, () => ctx.navigate('tweaks'), 'stat-active'),
      mkStat('undo', 'Fremd-Tweaks', [statForeign], statForeignSub, () => ctx.navigate('detweak'), 'stat-foreign'),
      mkStat('archive', 'Letzte Sicherung', [statBackup], statBackupSub, () => ctx.navigate('backups'), 'stat-backup'));
    function fillStats() {
      const toggles = ctx.toggles().filter(t => ctx.applicable(t));
      const on = toggles.filter(t => ctx.isApplied(t.id)).length;
      countUp(statActive, on);
      statActiveOf.textContent = ' von ' + fmtNumber(toggles.length);
      statBar.firstChild.style.transform = 'scaleX(' + (toggles.length ? on / toggles.length : 0) + ')';
      const scan = ctx.cache.detweak;
      if (scan) { countUp(statForeign, scan.items.length); statForeignSub.textContent = scan.items.length ? 'beim letzten Detweak-Scan gefunden' : 'alles auf Windows-Standard'; }
      else if (typeof ctx.state.foreignCount === 'number') {
        countUp(statForeign, ctx.state.foreignCount);
        statForeignSub.textContent = ctx.state.foreignCount ? 'beim letzten Detweak-Scan gefunden' : 'alles auf Windows-Standard';
      } else {
        const n = Object.values(ctx.state.statuses).filter(s => s === 'custom' || s === 'partial').length;
        countUp(statForeign, n);
        statForeignSub.textContent = n ? 'von anderen Tools geänderte Werte' : 'Detweak-Scan für alle Details';
      }
    }
    async function fillBackup() {
      try {
        if (!ctx.cache.backups) ctx.cache.backups = (await api.backups()).backups || [];
        const b = ctx.cache.backups[0];
        statBackup.textContent = b ? fmtRelative(b.created) : 'Noch keine';
        statBackupSub.textContent = b ? b.label : 'Wird vor jeder Änderung angelegt';
      } catch { statBackup.textContent = '–'; }
    }

    // ---------- findings + tiles
    const findBox = h('div', { class: 'find-list' });
    function fillFindings() {
      clear(findBox);
      const r = ctx.cache.advisor;
      if (!r) {
        findBox.appendChild(emptyState({ icon: 'radar', title: 'Noch keine Befunde', text: 'Starte eine Analyse. Danach siehst du hier die wichtigsten Baustellen deines PCs.', action: button({ label: 'Analyse starten', icon: 'play', variant: 'secondary', size: 'sm', onClick: () => ctx.navigate('advisor', { autostart: true }) }) }));
        return;
      }
      const order = { bad: 0, warn: 1, info: 2, good: 3 };
      const top = (r.findings || []).slice().sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9)).slice(0, 4);
      if (!top.length) { findBox.appendChild(emptyState({ icon: 'checkCircle', title: 'Keine Baustellen', text: 'Die Analyse hat nichts Wichtiges gefunden.' })); return; }
      for (const f of top) {
        findBox.appendChild(h('div', { class: 'find-row sev-' + f.severity },
          severityBadge(f.severity),
          h('div', { class: 'find-text' }, h('div', { class: 'find-title', text: f.title }), h('div', { class: 'find-detail', text: f.detail })),
          f.fix ? button({ label: 'Beheben', size: 'sm', variant: 'ghost', iconRight: 'arrowRight', onClick: () => applyFix(ctx, f.fix) }) : null));
      }
      stagger(findBox);
    }
    const tile = (ic, title, desc, page, opts) => {
      const t = h('button', { class: 'tile spot tilt', type: 'button', 'data-testid': 'tile-' + page },
        h('span', { class: 'tile-icon' }, icon(ic, 20)),
        h('span', { class: 'tile-text' }, h('span', { class: 'tile-title', text: title }), h('span', { class: 'tile-desc', text: desc })),
        icon('arrowRight', 16, 'tile-go'));
      t.addEventListener('click', () => ctx.navigate(page, opts));
      return t;
    };
    const tiles = h('div', { class: 'tile-grid' },
      tile('stack', 'Preset anwenden', 'Fertige Pakete für Gaming, Esport, Laptop …', 'presets'),
      tile('undo', 'Detweak', 'Tweaks anderer Tools sauber zurücksetzen', 'detweak'),
      tile('broom', 'Reinigung', 'Temp-Dateien und Caches löschen', 'cleanup'),
      tile('gamepad', 'Spiele boosten', 'Priorität und Grafikkarte pro Spiel', 'games'));

    append(el, 
      hero,
      h('div', { class: 'section-head' }, h('div', {}, h('h2', { class: 'section-title', text: 'Dein System' }), h('p', { class: 'section-desc', text: 'Erkannt beim letzten Scan. VELOX wählt passende Tweaks automatisch danach aus.' })),
        ctx.state.lastScan ? badge('Gescannt ' + fmtRelative(ctx.state.lastScan), 'neutral', 'clock') : null),
      sysGrid,
      stats,
      h('div', { class: 'split' },
        h('section', { class: 'card pad-24' }, h('div', { class: 'card-head' }, h('h2', { class: 'section-title', text: 'Wichtigste Befunde' }), ctx.cache.advisor ? button({ label: 'Alle ansehen', size: 'sm', variant: 'ghost', iconRight: 'arrowRight', onClick: () => ctx.navigate('advisor') }) : null), findBox),
        h('section', { class: 'card pad-24' }, h('div', { class: 'card-head' }, h('h2', { class: 'section-title', text: 'Schnellzugriff' })), tiles)));
    stagger(el, ':scope > *');

    fillHero(); fillSys(); fillStats(); fillFindings(); fillBackup();
    ctx.on('statuses', fillStats);
    ctx.on('state', () => { fillSys(); fillStats(); });
    ctx.on('scanning', fillSys);
    ctx.on('advisor', () => { fillHero(); fillFindings(); });
    ctx.on('backups', fillBackup);
  }
};
