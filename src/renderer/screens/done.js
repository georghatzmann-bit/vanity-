// Fertig – summary of the install job (store.installJob.result, merged with earlier attempts when
// this was a retry): honest hero, stat tiles, reboot hint, retry of failed apps, manual download
// links, games CTA, log export. Contract: ARCHITECTURE §10.
import '../styles/screens/done.css';
import { h } from '../core/dom.js';
import { store as appStore } from '../core/store.js';
import { icon, logoMark } from '../components/icons.js';
import { Button } from '../components/button.js';
import { Badge } from '../components/badge.js';
import { AppIcon } from '../components/appCard.js';
import { checkBox } from '../components/checkbox.js';
import { gsap, motionOK, richMotion, revealText, countUp, pop, shake } from '../core/motion.js';
import { formatDuration, formatNumber, plural, joinList } from '../core/format.js';
import { cleanTitle } from '../components/gamesArt.js';

const STATUS = {
  installed: { tone: 'ok', label: 'Installiert', icon: 'check' },
  already: { tone: 'neutral', label: 'War schon da', icon: 'check' },
  failed: { tone: 'err', label: 'Fehlgeschlagen', icon: 'x' },
  skipped: { tone: 'warn', label: 'Übersprungen', icon: 'minus' },
  cancelled: { tone: 'neutral', label: 'Abgebrochen', icon: 'minus' },
};
const NOT_INSTALLED = new Set(['failed', 'skipped', 'cancelled']);

const COPY = {
  success: { eyebrow: 'Fertig', l1: 'Dein PC ist', l2: 'wiedergeboren.' },
  partial: { eyebrow: 'Fast fertig', l1: 'Fast', l2: 'geschafft.' },
  error: { eyebrow: 'Fehlgeschlagen', l1: 'Das hat leider', l2: 'nicht geklappt.' },
  cancelled: { eyebrow: 'Abgebrochen', l1: 'Installation', l2: 'abgebrochen.' },
  empty: { eyebrow: 'Fertig', l1: 'Fast', l2: 'geschafft.' },
};

function splitKey(key) {
  const i = String(key).indexOf(':');
  return i > 0 ? { source: key.slice(0, i), id: key.slice(i + 1) } : { source: 'winget', id: String(key) };
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => (t = setTimeout(() => rej(new Error('timeout')), ms)))]).finally(() => clearTimeout(t));
}

// ---------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------

/** ?screen=done without a finished job: a believable result (mirrors the mock backend's outcomes). */
async function seedResult({ store, api }) {
  const prev = store.get('installJob') || {};
  let cat = null;
  try {
    cat = await withTimeout(api.catalog.get(), 2500);
  } catch {
    /* fall back to whatever the store has */
  }
  const byId = new Map((cat?.items || []).map((i) => [`${i.source}:${String(i.id).toLowerCase()}`, i]));
  let items = Array.isArray(prev.items) && prev.items.length ? prev.items : null;
  if (!items) {
    const profile = store.get('profile');
    const sel = store.get('selection');
    const apps = profile?.apps?.length ? profile.apps.filter((a) => !sel?.size || sel.has(`${a.source}:${a.id}`)) : (cat?.items || []).filter((i) => i.popular && i.source === 'winget');
    items = apps.map((a) => {
      const c = byId.get(`${a.source}:${String(a.id).toLowerCase()}`);
      return { key: `${a.source}:${a.id}`, id: a.id, source: a.source, name: a.name || c?.name || a.id, elevation: c?.elevation || a.elevation || 'unknown', scope: c?.scope || 'unknown', homepage: c?.homepage || null };
    });
  }
  const failKey = items.some((i) => /Logitech/i.test(i.id)) ? null : items[2]?.key;
  const byKey = {};
  let total = 0;
  items.forEach((it, i) => {
    let status = 'installed';
    let message = 'Erfolgreich installiert';
    let code;
    if (/Logitech/i.test(it.id) || it.key === failKey) {
      status = 'failed';
      message = 'Der Installer-Hash stimmt nicht überein (Paket wurde vom Hersteller geändert).';
      code = 0x8a150011;
    } else if (/VCRedist/i.test(it.id)) {
      status = 'already';
      message = 'War bereits installiert';
    }
    const durationMs = status === 'already' ? 1800 : 6000 + ((i * 7919) % 38000);
    total += durationMs;
    byKey[it.key] = { type: 'item-done', key: it.key, status, rebootRequired: /DirectX/i.test(it.id), code, codeHex: code ? '0x8A150011' : undefined, message, durationMs };
  });
  const summary = { installed: 0, already: 0, failed: 0, skipped: 0, cancelled: 0, rebootRequired: false };
  for (const d of Object.values(byKey)) {
    summary[d.status]++;
    if (d.rebootRequired) summary.rebootRequired = true;
  }
  const job = {
    ...prev,
    items,
    links: prev.links || (cat?.items || []).filter((i) => i.source === 'link').slice(0, 2),
    games: prev.games || store.get('profile')?.games || store.get('games') || [],
    started: true,
    seeded: true,
    result: { summary, byKey, durationMs: total, elevation: 'granted' },
  };
  store.set('installJob', job);
  return job;
}

/** Merges this result with earlier attempts (retry) into one honest picture. */
function buildView(job) {
  const prev = job.previous || null;
  const r = job.result || { summary: {}, byKey: {}, durationMs: 0 };
  const byKey = { ...(prev?.byKey || {}), ...(r.byKey || {}) };
  const itemMap = new Map();
  for (const it of [...(prev?.items || []), ...(job.items || [])]) {
    if (!it) continue;
    const key = it.key || `${it.source}:${it.id}`;
    itemMap.set(key, { ...it, key });
  }
  for (const k of Object.keys(byKey)) {
    if (!itemMap.has(k)) {
      const { source, id } = splitKey(k);
      itemMap.set(k, { key: k, id, source, name: id });
    }
  }
  const counts = { installed: 0, already: 0, failed: 0, skipped: 0, cancelled: 0 };
  for (const d of Object.values(byKey)) if (counts[d.status] !== undefined) counts[d.status]++;
  const rebootKeys = Object.values(byKey).filter((d) => d.rebootRequired).map((d) => d.key);
  const items = [...itemMap.values()].filter((it) => byKey[it.key]);
  const ok = counts.installed + counts.already;
  const total = items.length;
  let tone = 'success';
  if (!total) tone = 'empty';
  else if (ok === 0 && counts.failed > 0) tone = 'error';
  else if (counts.failed > 0 || counts.skipped > 0) tone = 'partial';
  else if (counts.cancelled > 0) tone = 'cancelled';
  return {
    byKey,
    items,
    counts,
    ok,
    total,
    tone,
    rebootKeys,
    rebootRequired: !!(r.summary?.rebootRequired || prev?.rebootRequired || rebootKeys.length),
    durationMs: (prev?.durationMs || 0) + (Number(r.durationMs) || 0),
    notInstalled: items.filter((it) => NOT_INSTALLED.has(byKey[it.key].status)),
    links: (job.links || []).filter((l) => l && (l.url || l.homepage)),
    games: job.games || [],
  };
}

function leadText(v) {
  const c = v.counts;
  const notOk = c.failed + c.skipped + c.cancelled;
  switch (v.tone) {
    case 'success':
      return `${plural(v.ok, 'App ist', 'Apps sind')} zurück – in ${formatDuration(v.durationMs)}.${c.already ? ` ${c.already === 1 ? 'Eine davon war' : `${c.already} davon waren`} schon da.` : ''}`;
    case 'partial': {
      const bits = [
        c.failed && (c.failed === 1 ? 'eine hat nicht geklappt' : `${c.failed} haben nicht geklappt`),
        c.cancelled && `${c.cancelled} ${c.cancelled === 1 ? 'wurde' : 'wurden'} abgebrochen`,
        c.skipped && `${c.skipped} ${c.skipped === 1 ? 'wurde' : 'wurden'} übersprungen`,
      ].filter(Boolean);
      const rest = joinList(bits);
      return `${formatNumber(v.ok)} von ${plural(v.total, 'App', 'Apps')} sind drauf, ${rest} – unten kannst du ${notOk === 1 ? 'es' : 'alles'} gleich nochmal versuchen.`;
    }
    case 'error':
      return 'Keine App konnte installiert werden. Oft hilft ein zweiter Versuch – prüf vorher kurz deine Internetverbindung.';
    case 'cancelled':
      if (!v.ok) return 'Du hast abgebrochen, bevor eine App fertig war – es wurde nichts verändert. Unten kannst du alles nachholen.';
      return `${plural(v.ok, 'App ist', 'Apps sind')} drauf, ${c.cancelled === 1 ? 'eine wurde' : `${c.cancelled} wurden`} nach dem Abbruch nicht mehr installiert. Das kannst du unten jederzeit nachholen.`;
    default:
      return v.links.length ? 'Es gab nichts automatisch zu installieren – die restlichen Apps installierst du unten selbst.' : 'Es wurde nichts installiert.';
  }
}

function toneOf(job) {
  return job && job.result ? buildView(job).tone : 'success';
}

// ---------------------------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------------------------

export default {
  title: 'Fertig',
  // Evaluated by the router after mount, so a seeded result is already in the store.
  fxState: () => (toneOf(appStore.get('installJob')) === 'error' ? 'error' : 'success'),
  async mount(container, ctx) {
    const { api, store, router, fx, sound, toast } = ctx;
    container.classList.add('screen--done');
    const cleanups = [];
    const tweens = new Set();
    const keep = (t) => (t && tweens.add(t), t);

    let job = store.get('installJob');
    if (!job || !job.result) job = await seedResult(ctx);
    const v = buildView(job);
    const copy = COPY[v.tone];
    const rich = richMotion();
    const mo = motionOK();

    // ---- emblem ------------------------------------------------------------------------------
    const badgeIcon = { success: 'check', partial: 'alert', error: 'x', cancelled: 'minus', empty: 'check' }[v.tone];
    const centerMark = v.tone === 'error' ? h('div.dn__mark', icon('x', { size: 64, strokeWidth: 2 })) : logoMark({ size: 96, className: 'dn__logo' });
    const disc = h('div.dn__disc', centerMark);
    const badge = h('div.dn__badge', icon(badgeIcon, { size: 22, strokeWidth: 2.5 }));
    const shocks = h('div.dn__shocks');
    const sparks = h('div.dn__sparks');
    const rings = [h('div.dn__ring.dn__ring--1.deco'), h('div.dn__ring.dn__ring--2.deco'), h('div.dn__ring.dn__ring--3')];
    const emblem = h('div.dn__emblem', { attrs: { 'aria-hidden': 'true' } }, h('div.dn__rays.deco'), ...rings, shocks, disc, badge, sparks);

    // ---- hero text -----------------------------------------------------------------------------
    const line1 = h('span.dn__line', copy.l1);
    const line2 = h(`span.dn__line${v.tone === 'error' ? '.dn__line--err' : '.t-grad.t-shine.deco'}`, copy.l2);
    const title = h('h1.dn__title', line1, line2);
    const eyebrow = h('div.t-eyebrow.dn__eyebrow', { dataset: { stagger: '' } }, h('span.dn__dot'), copy.eyebrow);
    const lead = h('p.dn__lead', { dataset: { stagger: '' } }, leadText(v));

    // ---- actions ------------------------------------------------------------------------------------
    const goHome = () => {
      router.resetHistory();
      router.go('home', {}, { transition: 'warp' });
    };
    const saveLog = async () => {
      try {
        const res = await api.log.export();
        const path = res && res.path;
        toast.success('Protokoll gespeichert', path || 'Auf dem Desktop', {
          duration: 9000,
          action: path
            ? {
                label: 'Im Ordner zeigen',
                onClick: () => api.shell.showItem(path).catch((err) => toast.error('Ordner lässt sich nicht öffnen', err.message)),
              }
            : undefined,
        });
      } catch (err) {
        toast.error('Speichern hat nicht geklappt', err.message);
      }
    };

    const buttons = [];
    const mainAction = h('div.dn__action.dn__action--main');
    if (v.games.length) {
      const names = v.games.map((g) => g.title && cleanTitle(g.title)).filter(Boolean);
      const list = names.length <= 2 ? joinList(names) : `${names.slice(0, 2).join(', ')} und ${names.length - 2} weitere`;
      const gamesBtn = Button({ label: 'Weiter zu deinen Spielen', icon: 'gamepad', iconRight: 'arrow-right', variant: 'primary', size: 'xl', onClick: () => router.go('games', {}, { transition: 'warp' }) });
      buttons.push(gamesBtn);
      mainAction.append(gamesBtn, h('p.dn__hint', `${list} – PHOENIX öffnet die Installation direkt im Launcher.`));
    } else {
      const homeBtn = Button({ label: 'Zur Startseite', icon: 'arrow-left', variant: 'primary', size: 'lg', onClick: goHome });
      buttons.push(homeBtn);
      const homeHint = { error: 'Du kannst es später jederzeit nochmal versuchen.', partial: 'Den Rest kannst du auch später nachholen.', cancelled: 'Den Rest kannst du auch später nachholen.' }[v.tone] || 'Alles erledigt – zurück zum Anfang.';
      mainAction.append(homeBtn, h('p.dn__hint', homeHint));
    }
    const logBtn = Button({ label: 'Protokoll speichern', icon: 'file', variant: 'secondary', autoLoading: true, onClick: saveLog });
    buttons.push(logBtn);
    const secondary = h('div.dn__action-row', h('div.dn__action', logBtn, h('p.dn__hint', 'Alle Details als Textdatei – praktisch für den Support.')));
    if (v.games.length) {
      const homeBtn = Button({ label: 'Zur Startseite', icon: 'arrow-left', variant: 'ghost', onClick: goHome });
      buttons.push(homeBtn);
      secondary.append(h('div.dn__action', homeBtn, h('p.dn__hint', 'Spiele später? Geht jederzeit.')));
    }
    cleanups.push(() => buttons.forEach((b) => b.destroy()));

    const hero = h(
      'section.dn__hero',
      h('div.dn__emblem-wrap', { dataset: { stagger: '' } }, emblem),
      h('div.dn__hero-text', eyebrow, title, lead, h('div.dn__actions', { dataset: { stagger: '' } }, mainAction, secondary)),
    );

    // ---- stats ------------------------------------------------------------------------------------------
    const c = v.counts;
    const extra = [c.skipped && `${c.skipped} übersprungen`, c.cancelled && `${c.cancelled} abgebrochen`].filter(Boolean);
    const timed = Object.values(v.byKey).filter((d) => d.status !== 'cancelled' && d.durationMs > 0);
    const avg = timed.length ? timed.reduce((a, d) => a + d.durationMs, 0) / timed.length : 0;
    const statDefs = [
      { key: 'installed', label: 'Installiert', icon: 'check-circle', tone: c.installed ? 'ok' : 'muted', value: c.installed, hint: c.installed ? 'Neu auf deinem PC' : 'Diesmal nichts Neues' },
      { key: 'already', label: 'War schon da', icon: 'layers', tone: 'muted', value: c.already, hint: 'Bereits auf deinem PC' },
      {
        key: 'failed',
        label: 'Fehlgeschlagen',
        icon: 'x-circle',
        tone: c.failed ? 'err' : 'muted',
        value: c.failed,
        hint: c.failed ? (extra.length ? `Dazu ${joinList(extra)}` : 'Unten nochmal versuchen') : extra.length ? joinList(extra) : 'Alles hat geklappt',
      },
      { key: 'duration', label: 'Dauer', icon: 'clock', tone: 'accent', value: v.durationMs, duration: true, hint: avg ? `Etwa ${formatDuration(avg)} pro App` : 'Gesamte Installationszeit' },
    ];
    const statEls = statDefs.map((d) => {
      const val = h('div.dn__stat-value.t-num', d.duration ? formatDuration(0) : '0');
      const el = h(
        `div.dn__stat.dn__stat--${d.tone}`,
        { dataset: { stat: d.key } },
        h('div.dn__stat-top', h('span.dn__stat-icon', icon(d.icon, { size: 18, strokeWidth: 2 })), h('span.dn__stat-label', d.label)),
        val,
        h('p.dn__stat-hint', d.hint),
      );
      return { el, val, def: d };
    });
    // Nothing ran (only links/games were selected): four zero tiles would just be noise.
    const stats = v.total ? h('section.dn__stats', { dataset: { stagger: '' }, attrs: { 'aria-label': 'Ergebnis' } }, statEls.map((s) => s.el)) : null;

    // ---- reboot ------------------------------------------------------------------------------------------
    let reboot = null;
    if (v.rebootRequired) {
      const names = v.rebootKeys.map((k) => v.items.find((i) => i.key === k)?.name).filter(Boolean);
      reboot = h(
        'section.dn__reboot',
        { dataset: { stagger: '' }, attrs: { role: 'status' } },
        h('div.dn__reboot-icon', icon('power', { size: 22, strokeWidth: 2 })),
        h(
          'div.dn__reboot-body',
          h('div.dn__reboot-title', 'Starte den PC neu, sobald du fertig bist – einige Programme brauchen das.'),
          h('p.dn__reboot-text', `${names.length ? `Betrifft: ${joinList(names)}. ` : ''}Kein Stress – erst, wenn du hier alles erledigt hast.`),
        ),
        h('span.dn__reboot-tag', 'Neustart nötig'),
      );
    }

    // ---- not installed (retry) -------------------------------------------------------------------------
    let failPanel = null;
    const selected = new Set(v.notInstalled.map((it) => it.key));
    if (v.notInstalled.length) {
      // Real initial labels: Button only renders a label element when it starts with text (sync() updates it).
      const retryBtn = Button({ label: 'Erneut versuchen', icon: 'refresh', variant: 'primary', onClick: () => retry() });
      const toggleAll = Button({ label: 'Keine auswählen', variant: 'ghost', size: 'sm', magnetic: false, onClick: () => setAll(selected.size !== v.notInstalled.length) });
      buttons.push(retryBtn, toggleAll);
      const retryHint = h('p.dn__hint');
      const rowRefs = [];
      const list = h(
        'ul.dn__fail-list',
        v.notInstalled.map((it) => {
          const d = v.byKey[it.key];
          const meta = STATUS[d.status] || STATUS.failed;
          const input = h('input.checkbox__input', { type: 'checkbox', checked: true, attrs: { 'aria-label': `${it.name} erneut versuchen` } });
          const row = h(
            'label.dn__fail-row.is-checked',
            input,
            checkBox(),
            AppIcon({ name: it.name, icon: it.icon, homepage: it.homepage, size: 40 }),
            h(
              'div.dn__fail-body',
              h('div.dn__fail-name', it.name),
              // Main only says "Abgebrochen" for cancelled items – the badge already does; explain instead.
              h('div.dn__fail-msg', d.status === 'cancelled' ? 'Nach dem Abbruch nicht mehr installiert' : d.message || 'Installation fehlgeschlagen'),
              d.codeHex ? h('div.dn__fail-meta', h('span.dn__code.t-mono', { title: 'Fehlercode von winget – hilft bei der Suche nach der Ursache' }, `Code ${d.codeHex}`)) : null,
            ),
            Badge(meta),
          );
          input.addEventListener('change', () => {
            row.classList.toggle('is-checked', input.checked);
            if (input.checked) selected.add(it.key);
            else selected.delete(it.key);
            sound.play(input.checked ? 'click' : 'hover');
            pop(row.querySelector('.checkbox__box'));
            sync();
          });
          rowRefs.push({ key: it.key, input, row });
          return h('li', row);
        }),
      );
      function sync() {
        const n = selected.size;
        retryBtn.setLabel(n ? `${plural(n, 'App', 'Apps')} erneut versuchen` : 'Erneut versuchen');
        retryBtn.setDisabled(n === 0);
        retryHint.textContent = n ? 'Installiert nur die ausgewählten Apps noch einmal – der Rest bleibt, wie er ist.' : 'Wähle oben mindestens eine App aus.';
        toggleAll.setLabel(n === v.notInstalled.length ? 'Keine auswählen' : 'Alle auswählen');
      }
      function setAll(on) {
        for (const r of rowRefs) {
          r.input.checked = on;
          r.row.classList.toggle('is-checked', on);
          if (on) selected.add(r.key);
          else selected.delete(r.key);
        }
        sync();
      }
      const tc = c.failed ? 'Nicht installiert' : 'Noch offen';
      failPanel = h(
        'section.card.dn__panel.dn__fail',
        { dataset: { stagger: '' } },
        h(
          'header.dn__panel-head',
          h(`div.icon-tile${c.failed ? '.icon-tile--danger' : '.icon-tile--muted'}`, icon(c.failed ? 'alert' : 'clock')),
          h('div.dn__panel-titles', h('h2.dn__panel-title', tc, h('span.dn__count', String(v.notInstalled.length))), h('p.dn__hint', 'Wähle aus, was PHOENIX nochmal versuchen soll.')),
          toggleAll,
        ),
        list,
        h('footer.dn__panel-foot', retryBtn, retryHint),
      );
      sync();
    }

    function retry() {
      const items = [...selected]
        .map((k) => v.items.find((i) => i.key === k))
        .filter(Boolean)
        .map(({ key, id, source, name, elevation, scope, homepage, icon: ic }) => ({ key, id, source, name, elevation: elevation || 'unknown', scope: scope || 'unknown', homepage, icon: ic }));
      if (!items.length) return;
      store.set('installJob', {
        items,
        links: job.links || [],
        games: job.games || [],
        previous: { byKey: v.byKey, items: v.items, durationMs: v.durationMs, rebootRequired: v.rebootRequired },
      });
      router.go('install', {}, { transition: 'warp' });
    }

    // ---- manual links -------------------------------------------------------------------------------------
    let linkPanel = null;
    if (v.links.length) {
      linkPanel = h(
        'section.card.dn__panel.dn__manual',
        { dataset: { stagger: '' } },
        h(
          'header.dn__panel-head',
          h('div.icon-tile', icon('link')),
          h(
            'div.dn__panel-titles',
            h('h2.dn__panel-title', 'Diese Apps installierst du selbst', h('span.dn__count', String(v.links.length))),
            h('p.dn__hint', 'Dafür gibt es kein stilles Installationspaket – die Download-Seite öffnet sich in deinem Browser.'),
          ),
        ),
        h(
          'ul.dn__link-list',
          v.links.map((l) => {
            const url = l.url || `https://${l.homepage}`;
            const state = h('span.dn__link-state');
            const btn = Button({
              label: 'Download-Seite öffnen',
              iconRight: 'external',
              variant: 'secondary',
              size: 'sm',
              magnetic: false,
              onClick: async () => {
                try {
                  await api.shell.open(url);
                  state.replaceChildren(Badge({ tone: 'neutral', label: 'Geöffnet', icon: 'check' }));
                  pop(state);
                } catch (err) {
                  toast.error('Link lässt sich nicht öffnen', err.message);
                }
              },
            });
            buttons.push(btn);
            let host = '';
            try {
              host = new URL(url).hostname.replace(/^www\./, '');
            } catch {
              host = l.homepage || '';
            }
            return h(
              'li.dn__link-row',
              AppIcon({ name: l.name, homepage: l.homepage, size: 40 }),
              h('div.dn__link-body', h('div.dn__link-name', l.name, state), h('div.dn__link-desc', l.desc || host), h('div.dn__link-host.t-mono', host)),
              btn,
            );
          }),
        ),
      );
    }

    // ---- all results ---------------------------------------------------------------------------------------
    let allPanel = null;
    if (v.items.length) {
      const order = { failed: 0, skipped: 1, cancelled: 2, installed: 3, already: 4 };
      const sorted = [...v.items].sort((a, b) => order[v.byKey[a.key].status] - order[v.byKey[b.key].status] || a.name.localeCompare(b.name, 'de'));
      allPanel = h(
        'details.dn__all',
        { dataset: { stagger: '' } },
        h(
          'summary.dn__all-sum',
          h('span.dn__all-icon', icon('list', { size: 18, strokeWidth: 2 })),
          h('span.dn__all-text', h('span.dn__all-title', 'Alle Apps im Überblick'), h('span.dn__hint', 'Was installiert wurde, was schon da war und was nicht geklappt hat')),
          h('span.dn__count', String(v.items.length)),
          h('span.dn__all-chev', icon('chevron-down', { size: 18, strokeWidth: 2 })),
        ),
        h(
          'ul.dn__all-grid',
          sorted.map((it) => {
            const d = v.byKey[it.key];
            // The badge already names the status – the meta line adds what it does not say.
            const meta = {
              installed: d.durationMs ? `in ${formatDuration(d.durationMs)}` : 'Neu installiert',
              already: 'Nichts zu tun',
              failed: d.codeHex ? `Code ${d.codeHex}` : 'Details oben',
              skipped: 'Nicht ausgeführt',
              cancelled: 'Nach dem Abbruch',
            }[d.status] || '';
            return h(
              `li.dn__all-item.dn__all-item--${d.status}`,
              AppIcon({ name: it.name, icon: it.icon, homepage: it.homepage, size: 30 }),
              h('div.dn__all-body', h('div.dn__all-name', { title: it.name }, it.name), h('div.dn__all-meta', meta)),
              Badge(STATUS[d.status] || STATUS.failed),
            );
          }),
        ),
      );
    }

    const panels = [failPanel, linkPanel].filter(Boolean);
    const inner = h(
      `div.screen__inner.dn.dn--${v.tone}`,
      hero,
      stats,
      reboot,
      panels.length ? h(`div.dn__cols${panels.length === 1 ? '.dn__cols--single' : ''}`, panels) : null,
      allPanel,
      h('div.sr-only', { attrs: { 'aria-live': 'polite' } }, `${copy.l1} ${copy.l2} ${leadText(v)}`),
    );
    container.append(inner);

    // ---- choreography ------------------------------------------------------------------------------------
    keep(revealText(line1, { delay: 0.3 }));
    keep(revealText(line2, { delay: 0.48 }));

    const statDelay = mo ? 0.75 : 0;
    if (stats) statEls.forEach((s, i) => {
      const fmt = s.def.duration ? (x) => formatDuration(x) : undefined;
      keep(countUp(s.val, s.def.value, { delay: statDelay + i * 0.08, duration: s.def.duration ? 1.6 : 1.3, format: fmt }));
    });

    function burstShocks() {
      if (!rich) return;
      const tone = v.tone === 'error' ? 'err' : 'accent';
      [0, 0.18, 0.4].forEach((d, i) => {
        const ring = h(`div.dn__shock.dn__shock--${i === 1 && v.tone === 'success' ? 'ok' : tone}`);
        shocks.append(ring);
        keep(gsap.fromTo(ring, { scale: 0.55, opacity: 0.95 }, { scale: 1.9 + i * 0.35, opacity: 0, duration: 1.4, delay: d, ease: 'expo.out', onComplete: () => ring.remove() }));
      });
    }

    function burstSparks() {
      if (!rich || v.tone === 'error' || v.tone === 'cancelled') return;
      const n = 22;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.25;
        const dist = 120 + Math.random() * 110;
        const sp = h('span.dn__spark');
        sparks.append(sp);
        gsap.set(sp, { rotation: (a * 180) / Math.PI + 90 });
        keep(
          gsap.fromTo(
            sp,
            { x: 0, y: 0, opacity: 1, scaleY: 0.4 },
            {
              x: Math.cos(a) * dist,
              y: Math.sin(a) * dist,
              opacity: 0,
              scaleY: 1.4,
              duration: 0.9 + Math.random() * 0.6,
              delay: 0.05 + Math.random() * 0.12,
              ease: 'expo.out',
              onComplete: () => sp.remove(),
            },
          ),
        );
      }
    }

    if (mo) {
      const tl = gsap.timeline({ delay: 0.18 });
      tl.fromTo(disc, { scale: 0.35, opacity: 0, filter: rich ? 'blur(16px)' : 'none' }, { scale: 1, opacity: 1, filter: 'blur(0px)', duration: 1.2, ease: 'elastic.out(1, 0.62)', clearProps: 'filter' })
        .fromTo(centerMark, { y: 34, opacity: 0, scale: 0.8 }, { y: 0, opacity: 1, scale: 1, duration: 1, ease: 'expo.out', clearProps: 'transform' }, 0.12)
        .fromTo(rings, { scale: 0.5, opacity: 0 }, { scale: 1, opacity: 1, duration: 1.1, stagger: 0.08, ease: 'expo.out', clearProps: 'transform,opacity' }, 0.04)
        .fromTo(badge, { scale: 0, rotation: -60 }, { scale: 1, rotation: 0, duration: 0.75, ease: 'back.out(2.4)', clearProps: 'transform' }, 0.6)
        .add(() => {
          burstShocks();
          burstSparks();
          if (v.tone === 'error') {
            sound.error();
            keep(shake(disc));
          } else if (v.tone !== 'cancelled') {
            sound.success();
            fx.burst({ count: v.tone === 'success' ? 260 : 140 });
          }
        }, 0.32);
      if (rich && stats) {
        tl.fromTo(statEls.map((s) => s.el), { rotationX: -65, y: 24, opacity: 0, transformPerspective: 900, transformOrigin: '50% 0%' }, { rotationX: 0, y: 0, opacity: 1, duration: 0.95, stagger: 0.08, ease: 'expo.out', clearProps: 'transform,opacity' }, 0.55);
      }
      keep(tl);
    } else if (v.tone === 'error') {
      sound.error();
    } else if (v.tone !== 'cancelled') {
      sound.success();
    }

    return () => {
      for (const t of tweens) t?.kill?.();
      cleanups.forEach((fn) => fn());
    };
  },
};
