// "Einrichten": monitors (main monitor, resolution, Hz, rotation, order), Windows settings and own
// programs (VELOX). Pre-filled from the backup (profile.settings) or a fresh-start package.
// Monitor changes are confirmed like in Windows: kept only after "Behalten", else reverted after 15 s.
import '../styles/screens/setup.css';
import { h } from '../core/dom.js';
import { icon } from '../components/icons.js';
import { Button } from '../components/button.js';
import { Toggle } from '../components/toggle.js';
import { Segmented } from '../components/segmented.js';
import { GPU_DRIVERS } from '../core/packages.js';

const ROT_LABEL = { 0: 'Quer', 90: 'Hoch', 180: 'Quer (gedreht)', 270: 'Hoch (gedreht)' };
const REVERT_SECONDS = 15;

export default {
  title: 'Einrichten',
  fxState: 'idle',
  mount(container, ctx) {
    const { api, store, router, modal, toast, sound, fx } = ctx;
    const params = ctx.params || {};
    const profile = store.get('profile');
    const saved = (profile && profile.settings) || null;
    const pkg = profile && profile.package;
    const cleanups = [];
    let alive = true;
    let entries = [];
    let defs = [];
    const pref = new Map(); // id -> { on, value }

    // ------------------------------------------------------------------ layout
    const source = saved && saved.displays && saved.displays.length ? 'Aus deiner Sicherung' : pkg ? `Paket ${pkg[0].toUpperCase()}${pkg.slice(1)}` : 'Dieser PC';
    const head = h(
      'header.su-head',
      { dataset: { stagger: '' } },
      h('div.t-eyebrow', 'Einrichten · ', source),
      h('h1.t-h1', 'Monitore ', h('span.t-grad', '& Windows')),
      h('p.t-lead.c-muted', 'Hauptmonitor, Hz, Auflösung und Drehung – dazu deine Windows-Einstellungen. Nichts wird geändert, bevor du auf „Anwenden“ klickst.'),
    );
    const stage = h('div.su-stage', { attrs: { 'aria-hidden': 'true' } });
    const monList = h('div.su-mons');
    const monStatus = h('p.su-status.c-muted');
    const maxBtn = Button({ label: 'Alle auf max. Hz', icon: 'zap', variant: 'secondary', size: 'sm', magnetic: false, onClick: () => maximizeAll() });
    const applyMonBtn = Button({ label: 'Monitore anwenden', icon: 'monitor', variant: 'primary', autoLoading: true, onClick: () => applyMonitors() });
    cleanups.push(() => maxBtn.destroy?.(), () => applyMonBtn.destroy?.());
    const monSec = h(
      'section.su-card',
      { dataset: { stagger: '' } },
      h('div.su-card__head', h('div.icon-tile', icon('monitor')), h('div', h('h2.t-h3', 'Monitore'), h('p.fs-sm.c-muted', 'Klick auf einen Monitor macht ihn zum Hauptmonitor.')), h('div.su-card__tools', maxBtn)),
      stage,
      monList,
      h('div.su-card__foot', monStatus, applyMonBtn),
    );

    const prefList = h('div.su-prefs');
    const applyPrefBtn = Button({ label: 'Einstellungen anwenden', icon: 'check', variant: 'primary', autoLoading: true, onClick: () => applyPrefs() });
    cleanups.push(() => applyPrefBtn.destroy?.());
    const prefStatus = h('p.su-status.c-muted', 'Nur angehakte Einstellungen werden geändert.');
    const prefSec = h(
      'section.su-card',
      { dataset: { stagger: '' } },
      h('div.su-card__head', h('div.icon-tile', icon('settings')), h('div', h('h2.t-h3', 'Windows-Einstellungen'), h('p.fs-sm.c-muted', 'Keine Tweaks – nur das, was du sonst in den Einstellungen klickst.'))),
      prefList,
      h('div.su-card__foot', prefStatus, applyPrefBtn),
    );

    const extraList = h('div.su-extras');
    const extraSec = h(
      'section.su-card',
      { dataset: { stagger: '' } },
      h('div.su-card__head', h('div.icon-tile', icon('rocket')), h('div', h('h2.t-h3', 'Programme & Treiber'), h('p.fs-sm.c-muted', 'Deine eigenen Tools und der passende Grafiktreiber.'))),
      extraList,
    );

    const doneBtn = Button({ label: 'Fertig', icon: 'check', variant: 'secondary', onClick: () => router.go('home', {}, { transition: 'warp' }) });
    cleanups.push(() => doneBtn.destroy?.());
    container.append(h('div.screen__inner.su', head, monSec, prefSec, extraSec, h('footer.su-foot', doneBtn)));

    // ------------------------------------------------------------------ monitors
    const oriented = (e) => (e.rotation === 90 || e.rotation === 270 ? [e.height, e.width] : [e.width, e.height]);
    const resList = (e) => [...new Map(e.modes.map((m) => [`${m.w}x${m.h}`, m])).values()];
    const hzList = (e) => e.modes.filter((m) => m.w === e.width && m.h === e.height).map((m) => m.hz).sort((a, b) => b - a);

    function renderStage() {
      const rects = entries.map((e) => oriented(e));
      const total = rects.reduce((s, [w]) => s + w, 0) || 1;
      const tallest = Math.max(...rects.map(([, hh]) => hh), 1);
      stage.replaceChildren(
        ...entries.map((e, i) => {
          const [w, hh] = rects[i];
          return h(
            'button.su-screen',
            {
              type: 'button',
              class: e.primary ? 'is-main' : '',
              style: { '--w': (w / total).toFixed(4), '--ar': `${w} / ${hh}`, '--hh': (hh / tallest).toFixed(4) },
              attrs: { 'aria-label': `${e.name} als Hauptmonitor` },
              onClick: () => setMain(i),
            },
            h('span.su-screen__num', String(i + 1)),
            h('span.su-screen__hz', `${e.hz} Hz`),
            e.primary ? h('span.su-screen__main', 'Haupt') : null,
          );
        }),
      );
    }

    function select(options, value, onChange, label) {
      const el = h('select.su-select', { attrs: { 'aria-label': label }, onChange: (ev) => onChange(ev.target.value) }, options.map(([v, text]) => h('option', { value: String(v), selected: String(v) === String(value) }, text)));
      return el;
    }

    function renderMonitors() {
      renderStage();
      monList.replaceChildren(
        ...entries.map((e, i) => {
          const maxHz = Math.max(0, ...hzList(e));
          const wanted = e.wanted && (e.wanted.hz !== e.hz || e.wanted.width !== e.width) ? h('span.su-warn', icon('alert', { size: 14 }), ` Gesichert: ${e.wanted.width}×${e.wanted.height} @ ${e.wanted.hz} Hz – gerade nicht verfügbar (Grafiktreiber fehlt noch?)`) : null;
          return h(
            'div.su-mon',
            { class: e.primary ? 'is-main' : '' },
            h(
              'div.su-mon__id',
              h('span.su-mon__num', String(i + 1)),
              h('div', h('b', e.name), h('span.fs-xs.c-muted', e.fromBackup ? ' · aus Sicherung' : e.monitorId ? ` · ${e.monitorId}` : '')),
              h(
                'label.su-radio',
                h('input', { type: 'radio', name: 'su-main', checked: e.primary, onChange: () => setMain(i) }),
                h('span', 'Hauptmonitor'),
              ),
            ),
            h(
              'div.su-mon__ctl',
              h('label.su-field', h('span', 'Auflösung'), select(resList(e).map((m) => [`${m.w}x${m.h}`, `${m.w} × ${m.h}`]), `${e.width}x${e.height}`, (v) => setRes(i, v), 'Auflösung')),
              h('label.su-field', h('span', 'Bildwiederholrate'), select(hzList(e).map((hz) => [hz, `${hz} Hz${hz === maxHz ? ' (max)' : ''}`]), e.hz, (v) => update(i, { hz: Number(v) }), 'Hz')),
              h('label.su-field', h('span', 'Ausrichtung'), select(Object.entries(ROT_LABEL), e.rotation, (v) => update(i, { rotation: Number(v) }), 'Ausrichtung')),
              h(
                'div.su-field.su-order',
                h('span', 'Position'),
                h('div', h('button.su-mini', { type: 'button', disabled: i === 0, attrs: { 'aria-label': 'Nach links' }, onClick: () => move(i, -1) }, icon('chevron-left', { size: 16 })), h('button.su-mini', { type: 'button', disabled: i === entries.length - 1, attrs: { 'aria-label': 'Nach rechts' }, onClick: () => move(i, 1) }, icon('chevron-right', { size: 16 }))),
              ),
            ),
            wanted,
          );
        }),
      );
    }

    function update(i, patch) {
      entries[i] = { ...entries[i], ...patch };
      if ('rotation' in patch) entries.forEach((e) => ((e.x = null), (e.y = null)));
      sound.play('click');
      renderMonitors();
    }
    function setRes(i, v) {
      const [w, hh] = v.split('x').map(Number);
      const e = entries[i];
      const rates = e.modes.filter((m) => m.w === w && m.h === hh).map((m) => m.hz);
      update(i, { width: w, height: hh, hz: rates.includes(e.hz) ? e.hz : Math.max(...rates), x: null, y: null });
      entries.forEach((x) => ((x.x = null), (x.y = null)));
    }
    function setMain(i) {
      entries = entries.map((e, j) => ({ ...e, primary: i === j }));
      sound.play('click');
      fx?.pulse?.(0.3);
      renderMonitors();
    }
    function move(i, d) {
      const next = [...entries];
      [next[i], next[i + d]] = [next[i + d], next[i]];
      entries = next.map((e) => ({ ...e, x: null, y: null }));
      renderMonitors();
    }
    function maximizeAll() {
      entries = entries.map((e) => ({ ...e, hz: Math.max(e.hz, ...hzList(e)) }));
      renderMonitors();
      toast.info('Maximale Hz gewählt', 'Mit „Monitore anwenden“ übernehmen.');
    }

    async function applyMonitors() {
      if (!entries.length) return;
      const payload = entries.map(({ modes, wanted, ...e }) => e);
      const res = await api.displays.apply(payload).catch((err) => ({ ok: false, error: err.message, previous: null }));
      if (!alive) return;
      if (!res.ok) {
        toast.error('Monitore nicht geändert', res.error || 'Unbekannter Fehler');
        return;
      }
      const keep = await confirmKeep();
      if (!alive) return;
      if (keep) {
        monStatus.textContent = res.restart ? 'Übernommen – ein Neustart schließt es ab.' : 'Übernommen.';
        toast.success('Monitore eingerichtet', res.restart ? 'Ein Neustart schließt es ab.' : 'Gespeichert – bleibt auch nach dem Neustart.');
        fx?.pulse?.(0.8);
      } else if (res.previous) {
        await api.displays.apply(res.previous).catch(() => null);
        monStatus.textContent = 'Zurückgesetzt.';
        await loadMonitors();
      }
    }

    function confirmKeep() {
      let left = REVERT_SECONDS;
      const count = h('b', String(left));
      const handle = modal.open({
        title: 'Monitore so behalten?',
        icon: 'monitor',
        dismissible: false,
        content: h('p', 'Wenn du nichts klickst, wird in ', count, ' Sekunden alles zurückgesetzt.'),
        actions: [
          { label: 'Zurücksetzen', variant: 'secondary', value: false },
          { label: 'Behalten', variant: 'primary', icon: 'check', value: true },
        ],
      });
      const timer = setInterval(() => {
        left -= 1;
        count.textContent = String(left);
        if (left <= 0) handle.close(false);
      }, 1000);
      return handle.closed.then((v) => {
        clearInterval(timer);
        return v === true;
      });
    }

    async function loadMonitors() {
      monStatus.textContent = 'Monitore werden erkannt …';
      try {
        const res = await api.displays.suggest({ saved: saved ? saved.displays : [], maximize: !!pkg || !!params.maximize });
        if (!alive) return;
        entries = res.entries || [];
        monStatus.textContent = entries.length ? `${entries.length} ${entries.length === 1 ? 'Monitor' : 'Monitore'} erkannt.` : 'Keine Monitore gefunden.';
        renderMonitors();
      } catch (err) {
        if (alive) monStatus.textContent = `Monitore konnten nicht gelesen werden: ${err.message}`;
      }
    }

    // ------------------------------------------------------------------ Windows settings
    function prefControl(d, state) {
      if (d.kind === 'bool') return Toggle({ checked: state.value === true, onChange: (v) => ((state.value = v), (state.on = true), sync()) });
      if (d.kind === 'choice') return Segmented({ options: d.choices.map(([value, label]) => ({ value, label })), value: state.value ?? d.choices[0][0], onChange: (v) => ((state.value = v), (state.on = true), sync()), ariaLabel: d.label });
      const out = h('span.su-range__val', String(state.value ?? 10));
      const input = h('input.su-range', { type: 'range', min: d.min, max: d.max, value: state.value ?? 10, onInput: (ev) => ((state.value = Number(ev.target.value)), (state.on = true), (out.textContent = ev.target.value), sync()) });
      return h('div.su-range-wrap', input, out);
    }

    const checks = new Map();
    function sync() {
      for (const [id, box] of checks) box.checked = !!pref.get(id).on;
      const n = [...pref.values()].filter((p) => p.on).length;
      applyPrefBtn.disabled = n === 0;
    }

    function renderPrefs() {
      const groups = new Map();
      for (const d of defs) {
        if (!groups.has(d.group)) groups.set(d.group, []);
        groups.get(d.group).push(d);
      }
      prefList.replaceChildren(
        ...[...groups].map(([group, list]) =>
          h(
            'div.su-group',
            h('div.t-eyebrow', group),
            list.map((d) => {
              const state = pref.get(d.id);
              const box = h('input.su-check', { type: 'checkbox', checked: state.on, attrs: { 'aria-label': `${d.label} übernehmen` }, onChange: (ev) => ((state.on = ev.target.checked), sync()) });
              checks.set(d.id, box);
              return h('div.su-pref', { class: state.from ? 'is-saved' : '' }, box, h('span.su-pref__label', d.label, state.from ? h('span.su-pill', state.from) : null), h('div.su-pref__ctl', prefControl(d, state)));
            }),
          ),
        ),
      );
      sync();
    }

    async function applyPrefs() {
      const values = {};
      for (const [id, p] of pref) if (p.on && p.value !== undefined) values[id] = p.value;
      const res = await api.settings.apply(values, saved ? saved.dpi : []).catch((err) => ({ error: err.message, results: [] }));
      if (!alive) return;
      if (res.error) return toast.error('Einstellungen nicht übernommen', res.error);
      const bad = res.results.filter((r) => !r.ok);
      const names = bad.map((r) => (defs.find((d) => d.id === r.id) || { label: r.id === 'dpi' ? 'Skalierung' : r.id }).label);
      prefStatus.textContent = bad.length ? `Übernommen bis auf: ${names.join(', ')}.` : 'Übernommen. Manches (Explorer, Skalierung) wirkt erst nach Ab- und Anmelden.';
      if (bad.length) toast.warn('Fast alles übernommen', `Nicht geklappt: ${names.join(', ')}`);
      else toast.success('Einstellungen übernommen', 'Manches wirkt erst nach Ab- und Anmelden.');
    }

    async function loadPrefs() {
      try {
        defs = (await api.settings.defs()) || [];
      } catch {
        defs = [];
      }
      if (!alive) return;
      const preset = (saved && saved.prefs) || {};
      const label = saved && pkg ? 'Paket' : 'gesichert';
      for (const d of defs) {
        const has = preset[d.id] !== undefined;
        pref.set(d.id, { on: has, value: has ? preset[d.id] : d.kind === 'bool' ? false : d.kind === 'range' ? 10 : d.choices[0][0], from: has ? label : '' });
      }
      renderPrefs();
    }

    // ------------------------------------------------------------------ programs + driver
    async function loadExtras() {
      const want = new Set((profile && profile.extras) || []);
      const [list, machine] = await Promise.all([api.extras.list().catch(() => []), store.get('machine') ? store.get('machine') : api.system.info().catch(() => null)]);
      if (!alive) return;
      const rows = (list || []).map((x) => {
        const btn = Button({
          label: `${x.name} installieren`,
          icon: 'download',
          variant: want.has(x.id) ? 'primary' : 'secondary',
          autoLoading: true,
          disabled: !x.available,
          onClick: async () => {
            const res = await api.extras.install(x.id).catch((err) => ({ ok: false, error: err.message }));
            if (!alive) return;
            if (res.ok) {
              btn.setLabel?.('Installiert');
              btn.disabled = true;
              toast.success(`${x.name} installiert`, 'Du findest es auf dem Desktop und im Startmenü.');
            } else toast.error(`${x.name} nicht installiert`, res.error || '');
          },
        });
        cleanups.push(() => btn.destroy?.());
        return h('div.su-extra', h('div.icon-tile', icon('flame')), h('div.su-extra__text', h('b', `${x.name} `, h('span.c-muted.fs-xs', x.version)), h('span.fs-sm.c-muted', x.desc)), btn);
      });
      const vendors = [...new Set(((machine && machine.gpus) || []).map((g) => g.vendor).filter((v) => GPU_DRIVERS[v]))];
      for (const v of vendors) {
        const drv = GPU_DRIVERS[v];
        const gpu = machine.gpus.find((g) => g.vendor === v);
        const btn = Button({ label: `${drv.name} öffnen`, icon: 'external', variant: 'secondary', onClick: () => api.shell.open(drv.url) });
        cleanups.push(() => btn.destroy?.());
        rows.push(h('div.su-extra', h('div.icon-tile', icon('gpu')), h('div.su-extra__text', h('b', gpu.name), h('span.fs-sm.c-muted', 'Erst mit dem Grafiktreiber gibt es alle Hz-Stufen. Danach hier nochmal „Monitore anwenden“.')), btn));
      }
      extraList.replaceChildren(...rows);
      extraSec.hidden = rows.length === 0;
    }

    loadMonitors();
    loadPrefs();
    loadExtras();

    return () => {
      alive = false;
      cleanups.forEach((fn) => fn && fn());
    };
  },
};
