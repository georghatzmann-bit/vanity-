// Backup save phase: target cards (USB first, other drives, OneDrive, "Speichern unter…"),
// restore code, the silent documents copy and a sticky status panel that turns into the
// success checklist once the backup lives somewhere that survives the reset.
//
//   const save = BackupSave({ ctx, onDone })
//   save.prepare(profile, rev)   – (re)starts for a profile: documents copy, drive list, setup lookup
//   save.enter() · save.focus() · save.confirmLeave() -> Promise<bool> · save.destroy()
import { h, nextId } from '../core/dom.js';
import { icon } from './icons.js';
import { Button } from './button.js';
import { Badge } from './badge.js';
import { gsap, motionOK, richMotion, scrambleText, shake } from '../core/motion.js';
import { formatBytes, formatNumber, joinList } from '../core/format.js';

const POLL_MS = 4000;

function driveLetter(root) {
  const m = /^([A-Za-z]):/.exec(String(root || '')) || /[\\/]([A-Za-z])[\\/]?$/.exec(String(root || ''));
  return m ? `${m[1].toUpperCase()}:` : '';
}

function freeText(d) {
  return Number(d.freeBytes) > 0 ? `${formatBytes(d.freeBytes)} frei` : '';
}

function folderOf(path) {
  const s = String(path || '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i > 0 ? s.slice(0, i) : s;
}

/** Status line: icon + text (+ optional mono detail). tone: ok | warn | err | busy | muted */
function statusLine(tone, text, detail) {
  const ico = { ok: 'check-circle', warn: 'alert', err: 'x-circle', muted: 'info' }[tone];
  return h(
    `div.bk-sline.bk-sline--${tone}`,
    tone === 'busy' ? h('span.spinner.bk-sline__spin', { attrs: { 'aria-hidden': 'true' } }) : icon(ico, { size: 16, strokeWidth: 2 }),
    h('span.bk-sline__text', text),
    detail ? h('span.bk-sline__detail.t-mono', { title: detail }, detail) : null,
  );
}

/** DOM spark burst from the centre of `anchor` (rich motion only). */
function sparks(host, anchor, count = 16) {
  if (!richMotion() || !host || !anchor) return;
  const hr = host.getBoundingClientRect();
  const ar = anchor.getBoundingClientRect();
  const cx = ar.left - hr.left + ar.width / 2;
  const cy = ar.top - hr.top + ar.height / 2;
  for (let i = 0; i < count; i++) {
    const s = h('span.bk-spark', { style: { left: `${cx}px`, top: `${cy}px` } });
    host.append(s);
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.4;
    const d = 36 + Math.random() * 70;
    gsap.fromTo(
      s,
      { x: 0, y: 0, scale: 1, opacity: 1 },
      { x: Math.cos(a) * d, y: Math.sin(a) * d, scale: 0, opacity: 0, duration: 0.7 + Math.random() * 0.4, ease: 'expo.out', onComplete: () => s.remove() },
    );
  }
  const ring = h('span.bk-ring-burst', { style: { left: `${cx}px`, top: `${cy}px` } });
  host.append(ring);
  gsap.fromTo(ring, { scale: 0.3, opacity: 0.9 }, { scale: 3.2, opacity: 0, duration: 0.9, ease: 'expo.out', onComplete: () => ring.remove() });
}

export function BackupSave({ ctx, onDone } = {}) {
  const { api, sound, fx, toast, modal } = ctx;
  const titleId = nextId('bk-save');
  const el = h('section.bk-phase.bk-save', { hidden: true, attrs: { 'aria-labelledby': titleId } });

  let profile = null;
  let rev = -1;
  let disposed = false;
  let drives = null; // Drive[] | null
  let drivesError = null;
  let drivesSig = '';
  let setupInfo = undefined; // undefined = unknown, null = not found, { path }
  let succeeded = false; // success panel shown
  let pollTimer = 0;
  let active = false;
  const states = new Map(); // id -> { state, path, setupCopied, error, reach, short }
  const cardCleanups = new Map(); // id -> cleanup
  const tweens = [];
  const track = (t) => (t && tweens.push(t), t);

  // ---------------------------------------------------------------- layout
  const titleEl = h('h1.bk-save__title', { id: titleId, tabIndex: -1 }, 'Wohin mit der Sicherung?');
  const head = h(
    'header.bk-save__head',
    h('div.t-eyebrow', h('span.bk-live-dot'), 'Letzter Schritt'),
    titleEl,
    h('p.bk-save__lead', 'Am sichersten ist ein USB-Stick – der übersteht jeden Reset. Mehrere Ziele auf einmal sind kein Problem.'),
  );
  const usbList = h('div.bk-targets');
  const moreList = h('div.bk-targets');
  const codeHost = h('div');
  const docsHost = h('div');
  const statusEl = h('aside.bk-status', { attrs: { 'aria-live': 'polite', 'aria-label': 'Status der Sicherung' } });

  const main = h(
    'div.bk-save__main',
    h(
      'section.bk-sec',
      h('header.bk-sec__head', h('h2.bk-sec__title', 'USB-Stick'), Badge({ tone: 'accent', label: 'Empfohlen', icon: 'star' }), h('span.bk-sec__hint', 'Übersteht garantiert jeden Reset')),
      usbList,
    ),
    h('section.bk-sec', h('header.bk-sec__head', h('h2.bk-sec__title', 'Weitere Ziele'), h('span.bk-sec__hint', 'Zusätzlich oder wenn kein Stick da ist')), moreList),
    h('section.bk-sec', h('header.bk-sec__head', h('h2.bk-sec__title', 'Ohne Datei'), h('span.bk-sec__hint', 'Für unterwegs – passt in eine Nachricht')), codeHost),
    docsHost,
  );
  el.append(head, h('div.bk-save__layout', main, statusEl));

  // ---------------------------------------------------------------- state helpers
  const st = (id) => {
    if (!states.has(id)) states.set(id, { state: 'idle' });
    return states.get(id);
  };
  const saved = () => [...states.entries()].filter(([id, s]) => s.state === 'saved' && id !== 'documents');
  const offPc = () => saved().filter(([, s]) => s.reach === 'off');
  const conditional = () => saved().filter(([, s]) => s.reach === 'cond');
  const usbSaves = () => saved().filter(([, s]) => s.kind === 'removable');

  function reachOfPath(path) {
    const letter = driveLetter(path);
    const cloud = (drives || []).find((d) => d.kind === 'cloud' && d.path && String(path).toLowerCase().startsWith(String(d.path).toLowerCase()));
    if (cloud) return 'off';
    if (/^\\\\/.test(String(path))) return 'off';
    if (!letter || !/^[A-Za-z]:/.test(String(path))) return 'off';
    const d = (drives || []).find((x) => driveLetter(x.root) === letter && x.kind !== 'cloud');
    if (!d) return 'off';
    if (d.kind === 'system') return 'local';
    if (d.kind === 'fixed') return 'cond';
    return 'off';
  }

  // ---------------------------------------------------------------- generic target card
  function TargetCard({ id, kind, iconName, title, meta, hint, badge, primary = false, actionLabel, actionIcon, run, reach, short, extra }) {
    const s = st(id);
    s.kind = kind;
    s.short = short;
    const statusSlot = h('div.bk-target__status', { attrs: { 'aria-live': 'polite' } });
    const actionSlot = h('div.bk-target__action');
    const iconEl = h('div.bk-target__icon', icon(iconName));
    const el = h(
      'article.bk-target',
      { class: primary ? 'bk-target--primary beam deco' : '', dataset: { kind, state: s.state } },
      iconEl,
      h(
        'div.bk-target__body',
        h('div.bk-target__head', h('h3.bk-target__title', title), badge || null),
        meta ? h('div.bk-target__meta', meta) : null,
        h('p.bk-target__hint', hint),
        extra || null,
        statusSlot,
      ),
      actionSlot,
    );
    let btn = null;

    function render() {
      const hadFocus = actionSlot.contains(document.activeElement);
      el.dataset.state = s.state;
      btn?.destroy();
      actionSlot.replaceChildren();
      statusSlot.replaceChildren();
      if (s.state === 'saved') {
        btn = Button({ label: 'Im Ordner zeigen', variant: 'ghost', size: 'sm', icon: 'folder', onClick: () => api.shell.showItem(s.path).catch(() => toast.error('Ordner lässt sich nicht öffnen', folderOf(s.path))) });
        statusSlot.append(statusLine('ok', 'Gespeichert', s.path));
        if (kind === 'removable') {
          statusSlot.append(
            s.setupCopied
              ? statusLine('ok', 'Phoenix-Setup liegt mit auf dem Stick')
              : statusLine('warn', 'Kein Phoenix-Setup gefunden – nach dem Reset lädst du Phoenix neu herunter.'),
          );
        }
        if (s.reach === 'local') statusSlot.append(statusLine('warn', `Liegt auf ${driveLetter(s.path) || 'diesem PC'} – wird beim kompletten Reset gelöscht.`));
        if (s.reach === 'cond') statusSlot.append(statusLine('warn', 'Beim Reset ‚Nur das Laufwerk mit Windows‘ wählen, sonst ist sie weg.'));
      } else {
        btn = Button({
          label: s.state === 'error' ? 'Erneut versuchen' : actionLabel,
          variant: primary ? 'primary' : 'secondary',
          size: primary ? 'lg' : 'md',
          icon: s.state === 'error' ? 'refresh' : actionIcon,
          magnetic: primary,
          onClick: go,
        });
        if (s.state === 'saving') {
          btn.setLoading(true);
          statusSlot.append(statusLine('busy', 'Wird gespeichert …'));
        } else if (s.state === 'error') {
          statusSlot.append(statusLine('err', s.error || 'Speichern fehlgeschlagen.'));
        } else if (s.state === 'canceled') {
          statusSlot.append(statusLine('muted', 'Abgebrochen – nichts gespeichert.'));
        }
      }
      actionSlot.append(btn);
      if (hadFocus) btn.focus({ preventScroll: true });
    }

    async function go() {
      if (s.state === 'saving' || !profile) return;
      const myRev = rev;
      s.state = 'saving';
      render();
      try {
        const res = await run();
        if (disposed || myRev !== rev) return;
        if (!res || res.canceled || !res.path) {
          s.state = 'canceled';
        } else {
          Object.assign(s, { state: 'saved', path: res.path, setupCopied: !!res.setupCopied, setupPath: res.setupPath, error: null });
          s.reach = typeof reach === 'function' ? reach(res.path) : reach;
        }
      } catch (err) {
        if (disposed || myRev !== rev) return;
        s.state = 'error';
        s.error = (err && err.message) || 'Speichern fehlgeschlagen.';
      }
      render();
      if (s.state === 'saved') onSaved(el, iconEl, s);
      if (s.state === 'error') {
        sound.play('error');
        track(shake(el));
      }
      renderStatus();
    }

    render();
    return Object.assign(el, { render, go });
  }

  // ---------------------------------------------------------------- targets
  function renderDrives() {
    for (const fn of cardCleanups.values()) fn();
    cardCleanups.clear();
    usbList.replaceChildren();
    moreList.replaceChildren();

    if (drives === null && !drivesError) {
      usbList.append(h('div.bk-target.bk-target--skeleton', h('div.bk-target__icon', h('span.spinner')), h('div.bk-target__body', h('div.bk-target__title', 'Laufwerke werden gesucht …'), h('p.bk-target__hint', 'Einen Moment.'))));
    } else if (drivesError) {
      usbList.append(
        h(
          'div.bk-target.bk-target--empty',
          h('div.bk-target__icon.bk-target__icon--err', icon('x-circle')),
          h('div.bk-target__body', h('h3.bk-target__title', 'Laufwerke nicht lesbar'), h('p.bk-target__hint', drivesError)),
          h('div.bk-target__action', Button({ label: 'Erneut suchen', icon: 'refresh', size: 'md', onClick: () => loadDrives(true) })),
        ),
      );
    }

    const list = drives || [];
    const usb = list.filter((d) => d.kind === 'removable');
    if (drives && !usb.length) {
      const retry = Button({ label: 'Erneut suchen', icon: 'refresh', variant: 'secondary', onClick: () => loadDrives(true) });
      cardCleanups.set('usb-empty', () => retry.destroy());
      usbList.append(
        h(
          'div.bk-target.bk-target--empty',
          h('div.bk-target__icon.bk-target__icon--muted', icon('usb')),
          h(
            'div.bk-target__body',
            h('h3.bk-target__title', 'Kein USB-Stick gefunden'),
            h('p.bk-target__hint', 'Steck einen Stick ein – er taucht hier nach ein paar Sekunden von selbst auf.'),
          ),
          h('div.bk-target__action', retry),
        ),
      );
    }
    usb.forEach((d, i) => {
      const letter = driveLetter(d.root);
      const name = `USB-Stick${letter ? ` ${letter}` : ''}`;
      const setupNote =
        setupInfo === undefined
          ? 'Übersteht jeden Reset – dein Rettungs-Stick für danach.'
          : setupInfo
            ? 'Übersteht jeden Reset. Das Phoenix-Setup kommt gleich mit drauf – so hast du Phoenix nach dem Reset sofort.'
            : 'Übersteht jeden Reset. Kein Phoenix-Setup in Downloads gefunden – nach dem Reset lädst du Phoenix neu herunter.';
      const card = TargetCard({
        id: `drive:${d.root}`,
        kind: 'removable',
        iconName: 'usb',
        title: name,
        meta: [d.label, freeText(d)].filter(Boolean).join(' · '),
        hint: setupNote,
        badge: i === 0 ? Badge({ tone: 'accent', label: 'Beste Wahl', icon: 'sparkles' }) : null,
        primary: i === 0,
        actionLabel: 'Auf Stick speichern',
        actionIcon: 'download',
        reach: 'off',
        short: name,
        run: () => api.profile.saveToDrive(profile, d.root),
      });
      usbList.append(card);
    });

    for (const d of list.filter((x) => x.kind === 'fixed' || x.kind === 'network')) {
      const letter = driveLetter(d.root);
      const net = d.kind === 'network';
      const name = `${net ? 'Netzlaufwerk' : 'Festplatte'}${letter ? ` ${letter}` : ''}`;
      moreList.append(
        TargetCard({
          id: `drive:${d.root}`,
          kind: d.kind,
          iconName: 'harddrive',
          title: name,
          meta: [d.label, freeText(d)].filter(Boolean).join(' · '),
          hint: net
            ? 'Liegt auf einem anderen Gerät im Netzwerk – übersteht den Reset.'
            : 'Bleibt nur erhalten, wenn du beim Reset ‚Nur das Laufwerk mit Windows‘ wählst.',
          actionLabel: 'Hier speichern',
          actionIcon: 'download',
          reach: net ? 'off' : 'cond',
          short: name,
          run: () => api.profile.saveToDrive(profile, d.root),
        }),
      );
    }

    const cloud = list.find((x) => x.kind === 'cloud');
    if (cloud) {
      moreList.append(
        TargetCard({
          id: 'onedrive',
          kind: 'cloud',
          iconName: 'cloud',
          title: cloud.label || 'OneDrive',
          meta: cloud.path ? h('span.t-mono', { title: cloud.path }, cloud.path) : null,
          hint: 'Wird in die Cloud synchronisiert – warte vor dem Reset, bis OneDrive fertig ist.',
          actionLabel: 'In OneDrive speichern',
          actionIcon: 'upload',
          reach: 'off',
          short: 'OneDrive',
          run: () => api.profile.save(profile, 'onedrive'),
        }),
      );
    }

    moreList.append(
      TargetCard({
        id: 'saveas',
        kind: 'saveas',
        iconName: 'folder',
        title: 'Speichern unter …',
        meta: null,
        hint: 'Wähl selbst einen Ort, z. B. eine externe Festplatte oder einen Netzwerkordner.',
        actionLabel: 'Ort wählen …',
        actionIcon: 'folder',
        reach: (path) => reachOfPath(path),
        short: 'eigenen Ort',
        run: () => api.profile.save(profile),
      }),
    );
  }

  // ---------------------------------------------------------------- restore code
  function renderCode() {
    codeHost.replaceChildren();
    const s = st('code');
    s.kind = 'code';
    s.short = 'Wiederherstellungs-Code';
    const box = h('pre.bk-code__box.selectable.t-mono', { tabIndex: 0, attrs: { 'aria-label': 'Wiederherstellungs-Code' } });
    const boxWrap = h('div.bk-code__boxwrap', box);
    const statusSlot = h('div.bk-target__status', { attrs: { 'aria-live': 'polite' } });
    const actionSlot = h('div.bk-code__actions');
    const metaEl = h('span.bk-code__meta.t-num');
    const card = h(
      'article.bk-target.bk-code',
      { dataset: { kind: 'code', state: s.state } },
      h('div.bk-target__icon', icon('key')),
      h(
        'div.bk-target__body',
        h('div.bk-target__head', h('h3.bk-target__title', 'Wiederherstellungs-Code'), metaEl),
        h('p.bk-target__hint', 'Kein Stick zur Hand? Der Code enthält alle Apps und Spiele (ohne Icons).'),
        boxWrap,
        h('p.bk-code__tip', icon('info', { size: 14, strokeWidth: 2 }), 'Schick ihn dir per WhatsApp oder Mail – nach dem Reset einfach einfügen.'),
        statusSlot,
      ),
      actionSlot,
    );
    let btn = null;
    let scr = null;

    function render(reveal = false) {
      const hadFocus = actionSlot.contains(document.activeElement);
      card.dataset.state = s.state;
      btn?.destroy();
      actionSlot.replaceChildren();
      statusSlot.replaceChildren();
      const hasCode = !!s.code;
      boxWrap.hidden = !hasCode;
      card.querySelector('.bk-code__tip').hidden = !hasCode;
      metaEl.textContent = hasCode ? `${formatNumber(s.code.length)} Zeichen` : '';
      if (hasCode && box.dataset.code !== s.code) {
        box.dataset.code = s.code;
        scr?.cancel();
        if (reveal && richMotion() && s.code.length < 6000) scr = scrambleText(box, s.code, { duration: 0.9 });
        else box.textContent = s.code;
      }
      if (!hasCode) {
        btn = Button({ label: s.state === 'error' ? 'Erneut versuchen' : 'Code erzeugen', icon: s.state === 'error' ? 'refresh' : 'key', variant: 'secondary', onClick: generate });
        if (s.state === 'saving') {
          btn.setLoading(true);
          statusSlot.append(statusLine('busy', 'Code wird erzeugt …'));
        }
        if (s.state === 'error') statusSlot.append(statusLine('err', s.error || 'Code konnte nicht erzeugt werden.'));
      } else {
        const copied = s.state === 'saved';
        btn = Button({ label: copied ? 'Nochmal kopieren' : 'Code kopieren', icon: 'copy', variant: copied ? 'ghost' : 'primary', magnetic: !copied, onClick: copy });
        if (copied) statusSlot.append(statusLine('ok', 'In der Zwischenablage – jetzt an dich selbst schicken.'));
        else if (s.state === 'error') statusSlot.append(statusLine('err', s.error || 'Kopieren fehlgeschlagen.'));
        else statusSlot.append(statusLine('muted', 'Zählt als Sicherung, sobald du ihn kopiert hast.'));
      }
      actionSlot.append(btn);
      if (hadFocus) btn.focus({ preventScroll: true });
    }

    async function generate() {
      if (!profile || s.state === 'saving') return;
      const myRev = rev;
      s.state = 'saving';
      render();
      try {
        const code = await api.profile.encode(profile);
        if (disposed || myRev !== rev) return;
        s.code = String(code || '');
        s.state = 'idle';
        render(true);
        sound.play('rise');
      } catch (err) {
        if (disposed || myRev !== rev) return;
        s.state = 'error';
        s.error = (err && err.message) || 'Code konnte nicht erzeugt werden.';
        render();
        sound.play('error');
      }
    }

    async function copy() {
      if (!s.code) return;
      const myRev = rev;
      try {
        await api.clipboard.write(s.code);
        if (disposed || myRev !== rev) return;
        const first = s.state !== 'saved';
        Object.assign(s, { state: 'saved', path: 'Zwischenablage', reach: 'off', error: null });
        render();
        if (first) onSaved(card, card.querySelector('.bk-target__icon'), s);
        else toast.success('Kopiert', 'Der Code ist in der Zwischenablage.');
        renderStatus();
      } catch (err) {
        s.state = 'error';
        s.error = (err && err.message) || 'Kopieren fehlgeschlagen.';
        render();
      }
    }

    // Click into the box selects the whole code (easy manual copy).
    box.addEventListener('focus', () => {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(box);
      sel.removeAllRanges();
      sel.addRange(range);
    });

    render();
    codeHost.append(card);
    cardCleanups.set('code', () => {
      btn?.destroy();
      scr?.cancel();
    });
  }

  // ---------------------------------------------------------------- documents copy (silent)
  function renderDocs() {
    const s = st('documents');
    docsHost.replaceChildren(
      h(
        'div.bk-docs',
        { dataset: { state: s.state } },
        h('span.bk-docs__icon', icon('folder', { size: 18, strokeWidth: 2 })),
        h(
          'div.bk-docs__body',
          h('div.bk-docs__title', 'Kopie auf diesem PC', h('span.bk-docs__sub', ' – wird beim kompletten Reset gelöscht')),
          s.state === 'saved'
            ? h('div.bk-docs__path.t-mono', { title: s.path }, s.path)
            : s.state === 'error'
              ? h('div.bk-docs__path.c-err', s.error || 'Konnte nicht gespeichert werden.')
              : h('div.bk-docs__path', 'Wird automatisch in „Dokumente\\Phoenix“ abgelegt …'),
        ),
        s.state === 'saved'
          ? Badge({ tone: 'ok', label: 'Gespeichert', icon: 'check' })
          : s.state === 'error'
            ? Button({ label: 'Erneut', icon: 'refresh', variant: 'ghost', size: 'sm', onClick: saveDocs })
            : Badge({ tone: 'neutral', label: 'Speichert …', dot: true, live: true }),
      ),
    );
  }

  async function saveDocs() {
    const s = st('documents');
    if (!profile || s.state === 'saving') return;
    const myRev = rev;
    s.state = 'saving';
    renderDocs();
    renderStatus();
    try {
      const res = await api.profile.save(profile, 'documents');
      if (disposed || myRev !== rev) return;
      Object.assign(s, { state: 'saved', path: res && res.path, reach: 'local' });
    } catch (err) {
      if (disposed || myRev !== rev) return;
      Object.assign(s, { state: 'error', error: (err && err.message) || 'Speichern fehlgeschlagen.' });
    }
    renderDocs();
    renderStatus();
  }

  // ---------------------------------------------------------------- status / success panel
  function checkItem(tone, title, hint) {
    const ico = { ok: 'check', warn: 'alert', err: 'x', todo: null, busy: null, next: 'arrow-right', info: 'info' }[tone];
    return h(
      `li.bk-check__item.bk-check__item--${tone}`,
      h('span.bk-check__mark', tone === 'busy' ? h('span.spinner') : ico ? icon(ico, { size: 14, strokeWidth: 2.4 }) : null),
      h('div.bk-check__text', h('div.bk-check__title', title), hint ? h('div.bk-check__hint', hint) : null),
    );
  }

  let statusButtons = [];
  function renderStatus({ celebrate = false } = {}) {
    statusButtons.forEach((b) => b.destroy());
    statusButtons = [];
    const off = offPc();
    const cond = conditional();
    const ok = off.length > 0 || cond.length > 0;
    const docs = st('documents');
    const usb = usbSaves();
    const usbWithSetup = usb.find(([, s]) => s.setupCopied);

    const docsItem =
      docs.state === 'saved'
        ? checkItem('ok', 'Kopie auf diesem PC', 'Dokumente\\Phoenix – wird beim Reset gelöscht')
        : docs.state === 'error'
          ? checkItem('err', 'Kopie auf diesem PC', 'Fehlgeschlagen – nicht schlimm, wenn du extern sicherst.')
          : checkItem('busy', 'Kopie auf diesem PC', 'Wird gespeichert …');

    const setupItem = usbWithSetup
      ? checkItem('ok', 'Setup auf dem Stick', 'Phoenix startest du nach dem Reset direkt vom Stick.')
      : usb.length
        ? checkItem('info', 'Phoenix nach dem Reset neu laden', 'Kein Setup gefunden – lade Phoenix einfach wieder herunter.')
        : ok
          ? checkItem('info', 'Phoenix nach dem Reset neu laden', 'Ohne Stick lädst du Phoenix einfach wieder herunter.')
          : setupInfo
            ? checkItem('todo', 'Setup für danach', 'Kommt beim Speichern automatisch mit auf den USB-Stick.')
            : checkItem('todo', 'Setup für danach', 'Kein Setup in Downloads – nach dem Reset lädst du Phoenix neu.');

    const wasSucceeded = succeeded;
    statusEl.replaceChildren();
    statusEl.classList.toggle('is-success', ok);

    if (!ok) {
      const doneBtn = Button({ label: 'Fertig', variant: 'secondary', block: true, onClick: () => finish() });
      statusButtons.push(doneBtn);
      statusEl.append(
        h('div.bk-status__eyebrow.t-eyebrow', 'Status'),
        h('h2.bk-status__title', 'Noch nicht gesichert'),
        h('p.bk-status__lead', 'Wähl links mindestens ein Ziel, das den Reset übersteht.'),
        h(
          'ul.bk-check',
          checkItem('todo', 'Sicherung außerhalb des PCs', 'Noch offen – USB-Stick, OneDrive oder Code.'),
          docsItem,
          setupItem,
          checkItem('todo', 'Windows zurücksetzen', 'Erst, wenn oben alles abgehakt ist.'),
        ),
        h('div.bk-status__actions', doneBtn, h('p.bk-status__hint', 'Ohne externe Sicherung fragen wir lieber nochmal nach.')),
      );
      return;
    }

    succeeded = true;
    const places = joinList(off.concat(cond).map(([, s]) => s.short));
    const resetBtn = Button({ label: 'Windows-Reset öffnen', icon: 'external', variant: 'primary', size: 'lg', block: true, onClick: openReset });
    const doneBtn = Button({ label: 'Fertig', variant: 'secondary', block: true, onClick: () => finish() });
    statusButtons.push(resetBtn, doneBtn);
    const orb = h('div.bk-status__orb', h('span.bk-status__orb-ring.deco'), icon('shield-check', { size: 30, strokeWidth: 1.9 }), h('span.bk-status__orb-shock'));
    const title = h('h2.bk-status__title.bk-status__title--ok', 'Gesichert.');
    const items = [
      off.length
        ? checkItem('ok', 'Profil gesichert', places)
        : checkItem('warn', 'Profil gesichert – mit Vorbehalt', `${places}: beim Reset ‚Nur das Laufwerk mit Windows‘ wählen.`),
      setupItem,
      docsItem,
      checkItem('next', 'Jetzt kannst du Windows zurücksetzen', 'Einstellungen › System › Wiederherstellung › „PC zurücksetzen“'),
    ];
    const list = h('ul.bk-check', items);
    statusEl.append(
      orb,
      title,
      h('p.bk-status__lead', off.length ? 'Deine Apps und Spiele überleben den Reset.' : 'Sicherer wäre zusätzlich ein USB-Stick oder der Code.'),
      list,
      h('div.bk-status__actions', resetBtn, h('p.bk-status__hint', 'Öffnet die Windows-Einstellungen zum Zurücksetzen.'), doneBtn),
    );

    if (!wasSucceeded || celebrate) {
      if (motionOK()) {
        const rich = richMotion();
        const tl = track(gsap.timeline());
        tl.fromTo(statusEl, { scale: rich ? 0.96 : 1, opacity: 0.4 }, { scale: 1, opacity: 1, duration: 0.7, ease: 'expo.out', clearProps: 'transform,opacity' }, 0)
          .fromTo(orb, { scale: 0.2, rotate: -90, opacity: 0 }, { scale: 1, rotate: 0, opacity: 1, duration: 0.9, ease: 'back.out(2.4)', clearProps: 'transform,opacity' }, 0.05)
          .fromTo(orb.querySelector('.bk-status__orb-shock'), { scale: 0.5, opacity: 1 }, { scale: 3.4, opacity: 0, duration: 1.2, ease: 'expo.out' }, 0.15)
          .fromTo(list.children, { opacity: 0, x: 16 }, { opacity: 1, x: 0, duration: 0.6, ease: 'expo.out', stagger: 0.09, clearProps: 'transform,opacity' }, 0.3)
          .fromTo(list.querySelectorAll('.bk-check__mark'), { scale: 0 }, { scale: 1, duration: 0.6, ease: 'back.out(3)', stagger: 0.09, clearProps: 'transform' }, 0.38);
        if (rich) track(scrambleText(title, 'Gesichert.', { duration: 0.7, delay: 0.1 }));
      }
    }
  }

  async function openReset() {
    try {
      await api.shell.open('ms-settings:recovery');
    } catch (err) {
      toast.error('Einstellungen lassen sich nicht öffnen', 'Öffne sie selbst: Start › Einstellungen › System › Wiederherstellung.');
    }
  }

  function onSaved(card, anchor, s) {
    const first = !succeeded && (offPc().length > 0 || conditional().length > 0);
    sound.play('success');
    sparks(card, anchor, first ? 22 : 14);
    if (motionOK()) {
      track(gsap.fromTo(card, { scale: 1.015 }, { scale: 1, duration: 0.8, ease: 'elastic.out(1, 0.45)', clearProps: 'transform' }));
    }
    if (first) {
      fx.burst();
      fx.setState('success');
    } else {
      fx.pulse(0.7);
    }
    if (s.reach === 'local') toast.warn('Nur auf diesem PC', 'Die Datei liegt auf dem Windows-Laufwerk und wird beim Reset gelöscht.');
  }

  async function confirmLeave() {
    if (offPc().length) return true;
    const cond = conditional();
    if (cond.length) {
      return modal.confirm({
        title: 'Nur in diesem PC gesichert',
        message: `Deine Sicherung liegt auf ${joinList(cond.map(([, s]) => s.short))} – also noch in diesem PC. Sie bleibt nur erhalten, wenn du beim Reset ‚Nur das Laufwerk mit Windows‘ wählst. Sicherer ist ein USB-Stick oder der Code.`,
        confirmLabel: 'Verstanden, beenden',
        cancelLabel: 'Weiter sichern',
        danger: true,
      });
    }
    return modal.confirm({
      title: 'Ohne externe Sicherung beenden?',
      message:
        'Deine Sicherung liegt nur auf diesem PC. Ein kompletter Reset löscht sie – danach weiß Phoenix nicht mehr, was installiert war. Speicher sie auf einem USB-Stick oder kopier den Code.',
      confirmLabel: 'Trotzdem beenden',
      cancelLabel: 'Weiter sichern',
      danger: true,
    });
  }

  async function finish() {
    if (!(await confirmLeave())) return;
    if (!disposed) onDone?.();
  }

  // ---------------------------------------------------------------- data loading
  async function loadDrives(manual = false) {
    try {
      const list = await api.drives.list();
      if (disposed) return;
      const next = Array.isArray(list) ? list : [];
      const sig = next.map((d) => `${d.kind}:${d.root}`).join('|');
      const changed = sig !== drivesSig || drivesError || drives === null;
      drives = next;
      drivesError = null;
      if (changed) {
        const hadUsb = drivesSig.includes('removable:');
        drivesSig = sig;
        renderDrives();
        if (active && motionOK()) {
          const cards = [...usbList.children, ...moreList.children];
          track(gsap.fromTo(cards, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.5, ease: 'expo.out', stagger: 0.04, clearProps: 'opacity,transform' }));
        }
        if (!manual && hadUsb === false && sig.includes('removable:') && rev >= 0 && active) {
          toast.info('USB-Stick erkannt', 'Du kannst die Sicherung jetzt auf den Stick legen.');
        }
      } else if (manual) {
        toast.info('Nichts Neues', 'Kein weiterer Stick gefunden.');
      }
    } catch (err) {
      if (disposed) return;
      if (drives === null || manual) {
        drivesError = (err && err.message) || 'Die Laufwerke konnten nicht gelesen werden.';
        renderDrives();
      }
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (disposed) return;
      const busy = [...states.values()].some((s) => s.state === 'saving');
      if (active && !busy && document.visibilityState === 'visible') await loadDrives(false);
      if (!disposed) schedulePoll();
    }, POLL_MS);
  }

  return {
    el,
    /** Starts (or restarts) the save phase for a profile revision. */
    prepare(nextProfile, nextRev) {
      if (nextRev === rev && profile) return;
      profile = nextProfile;
      rev = nextRev;
      succeeded = false;
      states.clear();
      drives = null;
      drivesError = null;
      drivesSig = '';
      setupInfo = undefined;
      renderDrives();
      renderCode();
      renderDocs();
      renderStatus();
      saveDocs();
      loadDrives(false);
      api.setup
        .find()
        .then((res) => {
          if (disposed || nextRev !== rev) return;
          setupInfo = res && res.path ? res : null;
          renderDrives();
          renderStatus();
        })
        .catch(() => {
          if (disposed || nextRev !== rev) return;
          setupInfo = null;
          renderDrives();
          renderStatus();
        });
    },
    setActive(on) {
      active = !!on;
      if (active) schedulePoll();
      else clearTimeout(pollTimer);
      if (active && succeeded) fx.setState('success');
    },
    enter() {
      if (!motionOK()) return;
      const rich = richMotion();
      const headKids = [...head.children];
      const secs = [...main.querySelectorAll('.bk-sec__head, .bk-target, .bk-docs')];
      const tl = track(gsap.timeline());
      tl.fromTo(headKids, { opacity: 0, y: 18, filter: rich ? 'blur(8px)' : 'none' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.8, ease: 'expo.out', stagger: 0.07, clearProps: 'opacity,transform,filter' }, 0)
        .fromTo(secs, { opacity: 0, x: rich ? 36 : 0, y: rich ? 0 : 10 }, { opacity: 1, x: 0, y: 0, duration: 0.75, ease: 'expo.out', stagger: 0.05, clearProps: 'opacity,transform' }, 0.12)
        .fromTo(statusEl, { opacity: 0, y: 24, scale: rich ? 0.97 : 1 }, { opacity: 1, y: 0, scale: 1, duration: 0.9, ease: 'expo.out', clearProps: 'opacity,transform' }, 0.25);
    },
    focus() {
      titleEl.focus({ preventScroll: true });
    },
    confirmLeave,
    hasOffPc: () => offPc().length > 0,
    destroy() {
      disposed = true;
      clearTimeout(pollTimer);
      for (const fn of cardCleanups.values()) fn();
      statusButtons.forEach((b) => b.destroy());
      tweens.forEach((t) => (typeof t.kill === 'function' ? t.kill() : t.cancel?.()));
      el.querySelectorAll('.btn').forEach((b) => b.destroy?.());
    },
  };
}
