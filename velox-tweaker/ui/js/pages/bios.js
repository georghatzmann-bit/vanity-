// BIOS-Optimierer: what to set in the BIOS for this PC and its games. The backend reads the PC
// (bios-scan, core/Bios.ps1 - read-only, it never writes to the firmware) and returns the facts, the
// checklist with a status per item and the texts of data/bios/recommendations.json. This page shows
// the system card, "X von Y passen schon", the warnings ("Passt dein PC?"), the checklist with the
// steps for this mainboard vendor, "Neustart ins BIOS" (bios-reboot: shutdown /r /fw, BitLocker
// check first), a print view and a QR code that opens the same list on the phone. The phone link
// carries the PC's data only in the URL fragment - see docs/ARCHITECTURE.md "BIOS checklist link format".
import { icon } from '../icons.js';
import { h, clear, button, badge, riskBadge, emptyState, stagger, toast, append, plural, confirmDialog, dialog, checkbox, fmtNumber, skeleton } from '../ui.js';
import { qrSvg } from '../qr.js';

// The checklist page of the VELOX website (velox-tweaker/website/bios.html, GitHub Pages). The one
// place the address lives: change it here if the site moves. The phone page reads the fragment
// (#v=1&p=…) and shows the texts of its copy of data/bios/recommendations.json.
export const VELOX_SITE = 'https://georghatzmann-bit.github.io/vanity-/bios.html';

const LINK_VENDORS = ['asus', 'msi', 'gigabyte', 'asrock'];
const LETTER = { ok: 'o', todo: 't', unknown: 'u' };
const STATUS_ICON = { ok: 'checkCircle', todo: 'alert', unknown: 'info' };
const SEV = { bad: { icon: 'alert', cls: 'is-bad' }, warn: { icon: 'warn', cls: 'is-warn' }, info: { icon: 'info', cls: 'is-info' } };
const STATUS_RANK = { todo: 0, unknown: 1, ok: 2 };

/** Core items: open ones first (games that need them first), then unclear ones, then the done ones. */
export function displayOrder(r) {
  const items = (r.items || []).slice();
  const core = items.filter(i => i.section === 'core').map((it, i) => ({ it, i }))
    .sort((a, b) => (STATUS_RANK[a.it.status] - STATUS_RANK[b.it.status]) || ((b.it.priority === 'high') - (a.it.priority === 'high')) || (a.i - b.i)).map(x => x.it);
  const optional = items.filter(i => i.section !== 'core');
  return { core, optional };
}

const cut = (s, n) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n - 1).trim() + '…' : s; };

/** The phone link (docs/ARCHITECTURE.md "BIOS checklist link format"): everything after the #. */
export function biosLink(r, base = VELOX_SITE) {
  const { core, optional } = displayOrder(r);
  const f = r.facts || {};
  const parts = [
    ['v', '1'],
    ['p', LINK_VENDORS.includes(r.vendor) ? r.vendor : 'generic'],
    ['c', r.cpuVendor === 'amd' || r.cpuVendor === 'intel' ? r.cpuVendor : 'other'],
    ['s', core.concat(optional).map(it => it.code + LETTER[it.status]).join('.')]
  ];
  if ((r.warnings || []).length) parts.push(['w', r.warnings.map(w => w.code).join('.')]);
  if ((r.games || []).length) parts.push(['g', r.games.map(g => g.code).join('.')]);
  const extra = [];
  if (f.board && f.board.model) extra.push(['b', cut(f.board.model, 48)]);
  if (f.bios && f.bios.version) extra.push(['i', cut(f.bios.version, 24)]);
  if (f.bios && f.bios.date) extra.push(['d', String(f.bios.date).replace(/-/g, '')]);
  const build = (list) => base + '#' + list.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  let all = parts.concat(extra);
  // keep the QR code small: the display-only fields go first when it gets long
  while (build(all).length > 300 && all.length > parts.length) all = all.slice(0, -1);
  return build(all);
}

/** Steps for a vendor and platform (same rule the phone page uses). */
export function stepsFor(item, vendor, cpu) {
  const s = item.steps || {};
  const pick = (list, fallback) => {
    if (Array.isArray(list)) return list;
    if (list && typeof list === 'object') return list[cpu] || list.any || fallback();
    return fallback();
  };
  const generic = () => pick(s.generic, () => []);
  const own = vendor !== 'generic' && !!s[vendor];
  return { steps: own ? pick(s[vendor], generic) : generic(), own };
}

const fmtDateDe = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? m[3] + '.' + m[2] + '.' + m[1] : ''; };
const cleanCpu = (n) => String(n || '').replace(/\((R|TM|C)\)/gi, '').replace(/\s+\d+-Core Processor/i, '').replace(/\s+(CPU|Processor)\b/gi, '').replace(/\s+@.*$/, '').replace(/\s+/g, ' ').trim();

export default {
  id: 'bios', title: 'BIOS', icon: 'board', desc: 'Was du im BIOS für deine Spiele einstellen solltest', keywords: 'bios uefi mainboard xmp expo docp resizable bar rebar secure boot tpm csm pbo curve optimizer x3d bitlocker',
  mount(el, ctx) {
    let res = ctx.cache.bios || null;
    let scanning = false;
    const open = new Set();   // expanded item ids (survive a re-render)

    // ---------------------------------------------------------------- hero
    const countNum = h('span', { class: 'bs-count-num', 'data-testid': 'bios-count', text: '–' });
    const countOf = h('span', { class: 'bs-count-of' });
    const countSub = h('p', { class: 'bs-count-sub' });
    const rebootBtn = button({ label: 'Neustart ins BIOS', icon: 'restart', variant: 'primary', cls: 'btn-brand', onClick: () => reboot(), attrs: { 'data-testid': 'bios-reboot' } });
    const phoneBtn = button({ label: 'Aufs Handy', icon: 'qr', variant: 'secondary', onClick: () => showQr(), attrs: { 'data-testid': 'bios-qr', title: 'Die Liste per QR-Code aufs Handy holen – praktisch, während der PC im BIOS ist' } });
    const printBtn = button({ label: 'Drucken', icon: 'printer', variant: 'secondary', onClick: () => printList(), attrs: { 'data-testid': 'bios-print', title: 'Liste drucken oder als PDF speichern' } });
    const rescanBtn = button({ label: 'Neu prüfen', icon: 'refresh', variant: 'ghost', size: 'sm', onClick: () => scan(true), attrs: { 'data-testid': 'bios-rescan' } });
    const rebootNote = h('p', { class: 'bs-reboot-note', 'data-testid': 'bios-reboot-note', hidden: true });
    const hero = h('section', { class: 'card bs-hero', 'aria-label': 'BIOS-Check' },
      h('div', { class: 'bs-hero-main' },
        h('div', { class: 'bs-count' },
          h('span', { class: 'eyebrow', text: 'BIOS-Check' }),
          h('div', { class: 'bs-count-line' }, countNum, countOf),
          countSub),
        h('div', { class: 'bs-hero-side' },
          h('p', { class: 'bs-intro', text: 'VELOX ändert nichts im BIOS – es liest nur aus und zeigt dir, was du selbst einstellen kannst.' }),
          h('div', { class: 'bs-actions' }, rebootBtn, phoneBtn, printBtn),
          rebootNote)),
      h('div', { class: 'bs-hero-foot' }, h('span', { class: 'bs-scanned muted' }), rescanBtn));

    // ---------------------------------------------------------------- body parts
    const sys = h('section', { class: 'bs-sys', 'aria-label': 'Dein System', 'data-testid': 'bios-system' });
    const warnBox = h('section', { class: 'card bs-warn-card', 'aria-label': 'Passt dein PC?', 'data-testid': 'bios-warnings' });
    const coreList = h('div', { class: 'bs-list', 'data-testid': 'bios-list' });
    const optList = h('div', { class: 'bs-list', 'data-testid': 'bios-optional' });
    const hiddenBox = h('details', { class: 'bs-hidden', 'data-testid': 'bios-hidden' });
    const keyLine = h('p', { class: 'bs-key' });
    const printHead = h('header', { class: 'bs-print-head', 'aria-hidden': 'true' });

    append(el,
      printHead,
      hero,
      h('div', { class: 'section-head' }, h('div', {}, h('h2', { class: 'section-title', text: 'Dein System' }), h('p', { class: 'section-desc', text: 'Was VELOX über Mainboard, BIOS und Hardware gelesen hat.' }))),
      sys,
      h('div', { class: 'section-head' }, h('div', {}, h('h2', { class: 'section-title', text: 'Passt dein PC?' }), h('p', { class: 'section-desc', text: 'Wichtige Hinweise, bevor du ins BIOS gehst.' }))),
      warnBox,
      h('div', { class: 'section-head' }, h('div', {}, h('h2', { class: 'section-title', text: 'Deine Checkliste' }), keyLine)),
      h('section', { class: 'card bs-list-card' }, coreList),
      h('div', { class: 'section-head bs-opt-head' }, h('div', {}, h('h2', { class: 'section-title', text: 'Optional – für Fortgeschrittene' }), h('p', { class: 'section-desc', text: 'Bringt etwas mehr, braucht aber Zeit zum Testen oder hilft nur bei bestimmten Problemen.' }))),
      h('section', { class: 'card bs-list-card' }, optList),
      hiddenBox);
    stagger(el, ':scope > *');

    // ---------------------------------------------------------------- render
    function texts() { return (res && res.texts) || { items: [], warnings: [], vendors: {}, statusLabels: {}, riskLabels: {}, general: {} }; }
    function itemText(id) { return (texts().items || []).find(i => i.id === id) || null; }
    function vendorInfo() { const v = texts().vendors || {}; return v[res && res.vendor] || v.generic || {}; }
    function statusLabel(it, txt) { return ((txt && txt.statusText) || {})[LETTER[it.status]] || (texts().statusLabels || {})[LETTER[it.status]] || it.status; }

    function render() {
      if (!res) { renderEmpty(); return; }
      el.classList.remove('is-loading');
      const s = res.summary || { ok: 0, total: 0, todo: 0, unknown: 0 };
      countNum.textContent = String(s.ok);
      countOf.textContent = ' von ' + s.total;
      countSub.textContent = s.total ? (s.ok === s.total ? 'Alles passt – dein BIOS ist gut eingestellt.' : [s.todo ? plural(s.todo, 'Punkt fehlt', 'Punkte fehlen') : null, s.unknown ? s.unknown + ' unklar – im BIOS prüfen' : null].filter(Boolean).join(' · ')) : 'Für deinen PC gibt es nichts zu prüfen.';
      countSub.classList.toggle('is-todo', !!s.todo);
      el.querySelector('.bs-scanned').textContent = res.scanned ? 'Gelesen ' + fmtTime(res.scanned) : '';
      const rb = res.reboot || {};
      rebootBtn.disabled = !rb.available;
      rebootBtn.title = rb.available ? 'Der PC startet neu und öffnet direkt das BIOS' : (rb.reason || '');
      rebootNote.hidden = !!rb.available;
      rebootNote.textContent = rb.available ? '' : (rb.reason || '');
      renderSys();
      renderWarnings();
      const v = vendorInfo();
      keyLine.className = 'section-desc bs-key';
      clear(keyLine);
      append(keyLine, 'BIOS öffnen: beim Start ', h('strong', { text: v.biosKey || 'Entf oder F2' }), ' drücken. ', v.advanced || '', ' ', v.save || '');
      const { core, optional } = displayOrder(res);
      renderList(coreList, core, 'Für deinen PC gibt es hier nichts zu tun.');
      renderList(optList, optional, 'Keine optionalen Punkte für deinen PC.');
      renderHidden();
      renderPrintHead();
    }

    function renderEmpty() {
      el.classList.toggle('is-loading', scanning);
      countNum.textContent = '–'; countOf.textContent = ''; countSub.textContent = scanning ? 'Lese Mainboard, BIOS und Hardware …' : 'Noch nicht geprüft.';
      rebootBtn.disabled = true; phoneBtn.disabled = true; printBtn.disabled = true;
      clear(sys);
      if (scanning) { for (let i = 0; i < 6; i++) sys.appendChild(h('div', { class: 'card bs-fact is-loading' }, skeleton(3))); }
      clear(warnBox); clear(coreList); clear(optList);
      if (!scanning) coreList.appendChild(emptyState({ icon: 'board', title: 'Noch nicht geprüft', text: 'VELOX liest Mainboard, BIOS und Hardware aus – das dauert nur ein paar Sekunden.', action: button({ label: 'Jetzt prüfen', icon: 'search', variant: 'secondary', size: 'sm', onClick: () => scan(true) }) }));
    }

    function fact(key, ic, label, value, subs, state) {
      return h('div', { class: 'card bs-fact' + (state ? ' is-' + state : ''), 'data-fact': key },
        h('div', { class: 'bs-fact-head' }, icon(ic, 16), h('span', { class: 'bs-fact-label', text: label })),
        h('div', { class: 'bs-fact-value', text: value || 'Unbekannt', title: value || '' }),
        h('div', { class: 'bs-fact-subs' }, (subs || []).filter(Boolean).map(x => typeof x === 'string' ? h('span', { text: x }) : x)));
    }
    function pill(text, tone) { return h('span', { class: 'bs-pill' + (tone ? ' is-' + tone : ''), text }); }

    function renderSys() {
      const f = res.facts || {};
      const b = f.board || {}; const bi = f.bios || {}; const c = f.cpu || {}; const r = f.ram || {}; const g = f.gpu || {}; const fw = f.firmware || {};
      const ramVal = r.totalGB ? fmtNumber(r.totalGB) + ' GB' + (r.type && r.type !== 'unknown' ? ' ' + r.type : '') : 'Unbekannt';
      const speed = r.configuredMHz ? (r.ratedMHz > r.configuredMHz + 100 ? r.configuredMHz + ' von ' + r.ratedMHz + ' MHz' : r.partMHz > r.configuredMHz + 100 ? r.configuredMHz + ' MHz (gebaut für ' + r.partMHz + ')' : r.configuredMHz + ' MHz') : null;
      const prof = r.profile === 'on' ? pill('RAM-Profil an', 'ok') : r.profile === 'off' ? pill('RAM-Profil aus', 'todo') : pill('RAM-Profil unklar');
      const rebar = g.rebar === 'on' ? pill('Resizable BAR an', 'ok') : g.rebar === 'off' ? pill('Resizable BAR aus', 'todo') : pill('Resizable BAR unklar');
      const mode = fw.mode === 'uefi' ? 'UEFI' : fw.mode === 'legacy' ? 'Legacy (CSM)' : 'Unbekannt';
      const onOff = (v, on, off) => v === 'on' ? pill(on, 'ok') : v === 'off' ? pill(off, 'todo') : null;
      const tpm = f.tpm || {}; const bl = (f.bitlocker || {}).state;
      clear(sys);
      append(sys,
        fact('board', 'board', 'Mainboard', [b.vendorName, b.model].filter(Boolean).join(' '), []),
        fact('bios', 'chip', 'BIOS', bi.version ? 'Version ' + bi.version : 'Unbekannt', [bi.date ? 'vom ' + fmtDateDe(bi.date) : null, typeof bi.ageMonths === 'number' && bi.ageMonths >= 24 ? pill(bi.ageMonths + ' Monate alt', 'todo') : null, bi.vendor || null]),
        fact('cpu', 'cpu', 'Prozessor', cleanCpu(c.name), [c.x3d ? pill(c.x3d === 'locked' ? 'X3D, gesperrt' : c.x3d === 'dual' ? 'X3D, zwei Chiplets' : 'X3D') : null, (c.tags || []).includes('raptor-lake') ? pill('13./14. Generation') : null]),
        fact('ram', 'ram', 'Arbeitsspeicher', ramVal, [speed, r.modules ? plural(r.modules, 'Riegel', 'Riegel') : null, prof, r.dualChannel === 'yes' ? pill('Dual-Channel', 'ok') : r.dualChannel === 'no' ? pill('Single-Channel', 'todo') : null]),
        fact('gpu', 'gpu', 'Grafikkarte', g.name, [(g.tags || []).length ? rebar : null]),
        fact('boot', 'shieldCheck', 'Start & Sicherheit', mode, [onOff(fw.secureBoot, 'Secure Boot an', 'Secure Boot aus'), tpm.state === 'on' ? pill('TPM ' + (tpm.version || '2.0'), 'ok') : tpm.state === 'off' ? pill('TPM aus', 'todo') : tpm.state === 'old' ? pill('TPM ' + tpm.version, 'todo') : null, bl === 'on' ? pill('BitLocker an') : bl === 'suspended' ? pill('BitLocker pausiert') : null]));
    }

    function renderWarnings() {
      clear(warnBox);
      const ws = res.warnings || [];
      const byId = new Map((texts().warnings || []).map(w => [w.id, w]));
      if (!ws.length) {
        warnBox.appendChild(h('div', { class: 'bs-ok-line' }, icon('checkCircle', 18), h('span', { text: 'Alles im grünen Bereich: kein altes BIOS, kein Legacy-Start, kein BitLocker-Stolperstein.' })));
        return;
      }
      for (const w of ws) {
        const t = byId.get(w.id) || {};
        const sev = SEV[w.severity] || SEV.info;
        let act = null;
        if (w.id === 'bitlocker') act = h('a', { class: 'btn btn-secondary btn-sm', href: (texts().general || {}).recoveryUrl || 'https://aka.ms/myrecoverykey', target: '_blank', rel: 'noopener noreferrer' }, icon('key', 15), h('span', { class: 'btn-label', text: 'Schlüssel finden' }));
        else if (w.tweak && ctx.byId.get(w.tweak)) act = button({ label: 'In VELOX ansehen', size: 'sm', variant: 'ghost', iconRight: 'arrowRight', onClick: () => ctx.navigate('tweaks', { query: ctx.byId.get(w.tweak).name }) });
        warnBox.appendChild(h('div', { class: 'bs-warn ' + sev.cls, 'data-warning': w.id },
          h('span', { class: 'bs-warn-icon' }, icon(sev.icon, 18)),
          h('div', { class: 'bs-warn-text' }, h('strong', { text: t.title || w.id }), h('p', { text: t.text || '' }), w.detail ? h('p', { class: 'bs-warn-detail', text: w.detail }) : null),
          act));
      }
    }

    function renderList(box, list, emptyText) {
      clear(box);
      if (!list.length) { box.appendChild(h('p', { class: 'bs-empty muted', text: emptyText })); return; }
      for (const it of list) box.appendChild(row(it));
    }

    function row(it) {
      const txt = itemText(it.id) || { title: it.id, steps: {} };
      const detailId = 'bs-d-' + it.id;
      const isOpen = open.has(it.id);
      const head = h('button', { class: 'bs-head', type: 'button', 'aria-expanded': String(isOpen), 'aria-controls': detailId },
        h('span', { class: 'bs-status is-' + it.status, 'data-status': it.status }, icon(STATUS_ICON[it.status] || 'info', 14), h('span', { text: statusLabel(it, txt) })),
        h('span', { class: 'bs-title', text: txt.title }),
        h('span', { class: 'bs-badges' },
          (it.neededBy || []).length ? badge('Wichtig für ' + it.neededBy.join(', '), 'info', 'gamepad') : null,
          riskBadge(txt.risk || 'safe')),
        icon('chevronDown', 16, 'bs-chev'));
      const v = vendorInfo();
      const { steps, own } = stepsFor(txt, res.vendor, res.cpuVendor);
      const verified = own && (txt.verified || []).includes(res.vendor);
      const detail = h('div', { class: 'bs-detail', id: detailId, hidden: !isOpen },
        h('p', { class: 'bs-why', text: txt.why || '' }),
        txt.info ? h('p', { class: 'bs-info', text: txt.info }) : null,
        steps.length ? h('div', { class: 'bs-steps-wrap' },
          h('div', { class: 'bs-steps-title', text: own ? 'So geht’s bei ' + (v.name || 'deinem Mainboard') : 'So geht’s (allgemein)' }),
          h('ol', { class: 'bs-steps' }, steps.map(s => h('li', { text: s }))),
          verified ? null : h('p', { class: 'bs-path-note', text: (texts().general || {}).pathNote || 'Menünamen können je nach BIOS-Version anders heißen.' })) : null);
      const art = h('article', { class: 'bs-item' + (isOpen ? ' is-open' : ''), 'data-id': it.id, 'data-status': it.status },
        head,
        it.note ? h('p', { class: 'bs-note', text: it.note }) : null,
        detail);
      head.addEventListener('click', () => {
        const now = head.getAttribute('aria-expanded') !== 'true';
        head.setAttribute('aria-expanded', String(now));
        detail.hidden = !now;
        art.classList.toggle('is-open', now);
        if (now) open.add(it.id); else open.delete(it.id);
      });
      return art;
    }

    function renderHidden() {
      clear(hiddenBox);
      const list = (res.hidden || []).map(x => ({ x, t: itemText(x.id) })).filter(y => y.t);
      hiddenBox.hidden = !list.length;
      if (!list.length) return;
      hiddenBox.appendChild(h('summary', { text: 'Passt nicht zu deinem PC (' + list.length + ')' }));
      hiddenBox.appendChild(h('ul', {}, list.map(({ x, t }) => h('li', {}, h('strong', { text: t.title }), h('span', { text: ' – ' + x.reason })))));
    }

    function renderPrintHead() {
      clear(printHead);
      const f = res.facts || {};
      let qr = null;
      try { qr = qrSvg(biosLink(res), { label: 'QR-Code zur Checkliste' }); } catch { qr = null; }
      append(printHead,
        h('div', { class: 'bs-print-text' },
          h('h1', { text: 'VELOX – BIOS-Checkliste' }),
          h('p', { text: [f.board && [f.board.vendorName, f.board.model].filter(Boolean).join(' '), f.bios && f.bios.version ? 'BIOS ' + f.bios.version + (f.bios.date ? ' vom ' + fmtDateDe(f.bios.date) : '') : null].filter(Boolean).join(' · ') }),
          h('p', { text: 'BIOS öffnen: ' + (vendorInfo().biosKey || 'Entf oder F2') + ' beim Start drücken. Erstellt am ' + new Date().toLocaleDateString('de-DE') + '.' })),
        qr ? h('div', { class: 'bs-print-qr' }, qr, h('span', { text: 'Mit dem Handy scannen' })) : null);
    }

    function fmtTime(iso) {
      const d = new Date(iso);
      if (isNaN(d)) return '';
      return d.toLocaleDateString('de-DE') + ', ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
    }

    // ---------------------------------------------------------------- actions
    async function scan(manual) {
      if (scanning) return;
      scanning = true;
      if (!res) renderEmpty();
      rescanBtn.disabled = true;
      let job = null;
      try { job = await ctx.runJob('bios-scan', {}, { overlay: false, quiet: true, quietBusy: !manual }); } finally { scanning = false; rescanBtn.disabled = false; }
      if (!el.isConnected) return;
      if (job && job.status === 'done' && job.result) {
        res = job.result;
        ctx.cache.bios = res;
        phoneBtn.disabled = false; printBtn.disabled = false;
        render();
        if (manual) toast({ type: 'ok', title: 'BIOS neu geprüft', text: res.summary ? res.summary.ok + ' von ' + res.summary.total + ' Punkten passen schon.' : '' });
        // the Übersicht shows board + RAM profile from the profile, which the scan just refreshed
        ctx.refreshState && ctx.refreshState();
      } else render();
    }

    function showQr() {
      if (!res) return;
      const url = biosLink(res);
      let svg;
      try { svg = qrSvg(url, { label: 'QR-Code: BIOS-Checkliste fürs Handy' }); } catch (e) { toast({ type: 'error', title: 'QR-Code geht nicht', text: e.message }); return; }
      const urlBox = h('code', { class: 'bs-url', 'data-testid': 'bios-link', text: url });
      let entry;
      const copy = button({ label: 'Link kopieren', icon: 'file', variant: 'secondary', onClick: async () => {
        try { await navigator.clipboard.writeText(url); toast({ type: 'ok', title: 'Link kopiert' }); }
        catch { const r = document.createRange(); r.selectNodeContents(urlBox); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast({ type: 'info', title: 'Link markiert', text: 'Drück Strg+C zum Kopieren.' }); }
      } });
      const close = button({ label: 'Fertig', variant: 'primary', onClick: () => entry.close(true) });
      entry = dialog({
        title: 'Checkliste aufs Handy', icon: 'phone',
        text: 'Scanne den Code mit der Kamera deines Handys. Die Liste öffnet sich auf der VELOX-Website – so hast du die Schritte vor Augen, während der PC im BIOS ist.',
        body: h('div', { class: 'bs-qr-body' },
          h('div', { class: 'bs-qr-tile', 'data-testid': 'bios-qr-code' }, svg),
          h('div', { class: 'bs-qr-side' },
            h('p', { class: 'bs-qr-privacy' }, icon('lock', 14), h('span', { text: 'Im Link stehen nur Kürzel wie „RAM-Profil: fehlt“ und dein Mainboard-Modell – nach dem #-Zeichen. Diesen Teil schickt kein Browser an einen Server.' })),
            urlBox)),
        footer: [copy, close]
      });
    }

    function printList() {
      if (!res) return;
      // every step is in the print view, collapsed or not (bios.css @media print)
      renderPrintHead();
      try { window.print(); } catch { toast({ type: 'error', title: 'Drucken geht hier nicht' }); }
    }

    async function reboot() {
      if (!res || !(res.reboot || {}).available) return;
      const bl = (res.reboot || {}).bitlocker;
      const url = (texts().general || {}).recoveryUrl || 'https://aka.ms/myrecoverykey';
      let pause = true;
      const parts = [];
      if (bl === 'on') {
        parts.push(h('div', { class: 'bs-dlg-warn' }, icon('key', 18), h('div', {},
          h('strong', { text: 'BitLocker ist an' }),
          h('p', { text: 'Wenn du im BIOS TPM, Secure Boot oder CSM änderst, fragt Windows beim nächsten Start vielleicht nach dem 48-stelligen Wiederherstellungsschlüssel. Du findest ihn auf dem Handy unter:' }),
          h('a', { class: 'bs-dlg-link', href: url, target: '_blank', rel: 'noopener noreferrer', text: url.replace(/^https:\/\//, '') }))));
        parts.push(checkbox({ checked: true, label: 'BitLocker für diesen einen Neustart pausieren (empfohlen)', desc: 'Danach schaltet es sich von selbst wieder ein.', onChange: (v) => { pause = v; }, cls: 'bs-dlg-pause' }));
      } else if (bl === 'unknown') {
        parts.push(h('p', { class: 'bs-dlg-note muted', text: 'VELOX konnte nicht prüfen, ob BitLocker an ist. Falls ja: Den Wiederherstellungsschlüssel findest du unter ' + url.replace(/^https:\/\//, '') + '.' }));
      }
      parts.push(h('p', { class: 'bs-dlg-note muted', text: 'Tipp: Hol dir vorher die Liste aufs Handy („Aufs Handy“). Weißt du im BIOS nicht weiter: „Load Optimized Defaults“ setzt alles auf Werkseinstellung.' }));
      const ok = await confirmDialog({
        title: 'Jetzt ins BIOS neu starten?', icon: 'restart',
        text: 'Speichere vorher alles, was offen ist. Windows startet 10 Sekunden nach dem Bestätigen neu und öffnet direkt das BIOS.' + (ctx.mode.simulate ? ' Im Testmodus wird der Neustart nur protokolliert.' : ''),
        body: h('div', { class: 'stack-12' }, parts),
        confirmLabel: 'Neu starten ins BIOS'
      });
      if (!ok) return;
      await ctx.runJob('bios-reboot', { suspendBitLocker: bl === 'on' && pause }, {});
    }

    render();
    // first visit: read the PC - right away, or as soon as a running job (the start-up scan) is done
    if (!res) {
      if (ctx.busy) { scanning = true; renderEmpty(); scanning = false; }
      ctx.whenIdle(() => { if (el.isConnected && !res) scan(false); });
    }
    ctx.on('busy', () => { if (!ctx.busy && !res && !scanning && el.isConnected) render(); });
  }
};
