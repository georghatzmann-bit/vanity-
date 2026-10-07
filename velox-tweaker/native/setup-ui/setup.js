/* VELOX Setup - installer UI logic (ES module).
 *
 * Talks to VeloxSetup.exe through window.chrome.webview (docs/ARCHITECTURE.md, "Native host & installer"):
 *   page -> setup: ready | drag | minimize | close | browse{dir} | checkRunning
 *                  | install{dir,desktop,startMenu,launch,closeRunning} | uninstall{keepData,closeRunning}
 *                  | launch | openLog | exit | sound{on}
 *   setup -> page: init{version,mode,installedVersion,dir,defaultDir,sizeMB,freeMB,running}
 *                  | folder{dir,error,freeMB} | running{running} | progress{percent,step,file}
 *                  | done{mode,launched} | error{message,hint}
 *
 * The start sequence is brand/intro.js (the long intro "Zündung", with sound; place "header", no loader;
 * uninstalling plays the short one). The done screen of an install / update ends with intro.celebrate() (the
 * re-lock of the word with its own small sound; silent when the intro was muted). Every screen
 * goes into intro.slot under the settled wordmark - one continuous surface: the word never moves, the
 * welcome arrives under it when the intro settles, and the other screens replace each other in the slot.
 * Progress is the kit's tick row (brand/ticks.js). URL: index.html?sound=0|1&mode=uninstall (both optional).
 */
import { VeloxIntro } from './brand/intro.js';
import { VeloxTicks } from './brand/ticks.js';

const $ = (id) => document.getElementById(id);
const body = document.body;
const q = new URLSearchParams(location.search);
const bridge = window.chrome && window.chrome.webview ? window.chrome.webview : null;
const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
if (reduced) body.classList.add('reduced');

const S = {
  screen: 'intro', mode: 'install', version: '', installedVersion: '', dir: '', defaultDir: '',
  sizeMB: 0, freeMB: -1, running: false, inited: false, introDone: false, task: null,
  busy: false, launched: false, keepData: true, lastPct: 0, celebrated: false,
};

function send(type, data) {
  const m = Object.assign({ type }, data || {});
  if (bridge) { try { bridge.postMessage(m); } catch (e) { /* window is closing */ } } else preview(m);
}
const setText = (id, t) => { const el = $(id); if (el) el.textContent = t == null ? '' : String(t); };
function fmtMB(mb) {
  if (mb < 0) return '';
  if (mb >= 1024) return (mb / 1024).toFixed(mb >= 102400 ? 0 : 1).replace('.', ',') + ' GB';
  return Math.max(1, Math.round(mb)) + ' MB';
}

// ================================================================== the intro + the slot
// uninstalling is not a launch: the short variant there; installing and updating get the long one
const uninstallUrl = /uninstall/.test(q.get('mode') || '') || (!bridge && /uninstall/.test(location.hash));
const intro = VeloxIntro.mount($('stage'), {
  variant: uninstallUrl ? 'short' : 'long',
  place: 'header',
  loader: false,
  sound: true,
  muted: q.get('sound') === '0' ? true : undefined,          // the app's "startSound"; otherwise this run's choice
  onMuteChange: (muted) => send('sound', { on: !muted }),
});
intro.slot.appendChild($('screens'));                        // arrives under the word when the intro settles
intro.ready.then(placeChrome);
intro.settled.then(() => {
  S.introDone = true;
  body.classList.add('settled');
  focusPrimary(S.screen);
});
window.addEventListener('pagehide', () => intro.destroy());

/** The title bar's text hangs from the same margin as the word. */
function placeChrome() { try { body.style.setProperty('--m', intro.layout().m + 'px'); } catch (e) { /* not laid out yet */ } }
window.addEventListener('resize', placeChrome);

// a click on the empty intro skips it (keys: Esc / Enter / Space, handled by the intro itself)
$('stage').addEventListener('click', (e) => {
  if (S.introDone || (e.target.closest && e.target.closest('button, .vx-bar'))) return;
  intro.skip();
});

// ================================================================== screens
function show(name) {
  if (S.screen === name) return;
  const prev = document.querySelector('.screen.active');
  const next = document.querySelector('.screen[data-screen="' + name + '"]');
  if (!next) return;
  if (prev) prev.classList.remove('active');
  next.classList.add('active');
  S.screen = name;
  body.setAttribute('data-screen', name);
  $('btn-close').disabled = name === 'progress';
  focusPrimary(name);
}

// move focus to the main button only for keyboard users (a mouse user would just see a focus ring)
let keyboardUser = false;
document.addEventListener('keydown', (e) => { if (e.key === 'Tab' || e.key === 'Enter' || e.key === ' ') keyboardUser = true; }, true);
document.addEventListener('mousedown', () => { keyboardUser = false; }, true);
function focusPrimary(name) {
  if (!S.introDone) return;
  if (!keyboardUser) { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return; }
  const id = { welcome: 'btn-install', options: 'btn-install2', done: $('btn-launch').hidden ? 'btn-done-close' : 'btn-launch', error: 'btn-retry', uninstall: 'btn-uninstall' }[name];
  if (!id) return;
  setTimeout(() => { const b = $(id); if (b && S.screen === name) { try { b.focus({ preventScroll: true }); } catch (e) { b.focus(); } } }, 120);
}
const homeScreen = () => (S.mode === 'uninstall' ? 'uninstall' : 'welcome');

// ================================================================== progress: the kit's tick row
let bar = null;
function newBar(host, status) {
  host.replaceChildren();
  return VeloxTicks.mount(host, { status: status || '' });
}
function resetProgress(status) {
  if (bar) bar.destroy();
  bar = newBar($('p-bar'), status);
  S.lastPct = 0;
  setText('p-file', '');
}
/** A finished (all bone) or failed row, frozen, as the trace of the progress on done / error. */
function traceBar(id, pct, text, failed) {
  const b = newBar($(id), '');
  b.seek(pct / 100);
  if (failed) b.fail(text); else b.done(text);
  return b;
}

// ================================================================== screens: content
function applyInit(m) {
  S.version = m.version || ''; S.mode = m.mode || 'install'; S.installedVersion = m.installedVersion || '';
  S.dir = m.dir || ''; S.defaultDir = m.defaultDir || S.dir; S.sizeMB = +m.sizeMB || 0; S.freeMB = m.freeMB == null ? -1 : +m.freeMB;
  S.running = !!m.running; S.inited = true;
  body.classList.toggle('mode-update', S.mode === 'update');
  body.classList.toggle('mode-uninstall', S.mode === 'uninstall');
  setText('tb-ver', S.version);
  setText('tb-title', S.mode === 'uninstall' ? 'VELOX entfernen' : 'VELOX Setup');
  document.title = S.mode === 'uninstall' ? 'VELOX entfernen' : 'VELOX Setup';
  let label = 'Installieren';
  if (S.mode === 'update') {
    const same = S.installedVersion && S.installedVersion === S.version;
    setText('w-title', same ? 'VELOX ist schon installiert.' : 'Eine neue Version von VELOX ist da.');
    setText('w-sub', same ? 'Du kannst VELOX neu installieren. Einstellungen und Sicherungen bleiben.'
      : 'Dauert nur ein paar Sekunden. Einstellungen und Sicherungen bleiben.');
    label = same ? 'Neu installieren' : 'Aktualisieren';
    $('update-note').hidden = same || !S.installedVersion;
    $('btn-browse').disabled = true;
    $('btn-browse').title = 'Ein Update bleibt im bisherigen Ordner.';
  }
  setText('u-from', S.installedVersion); setText('u-to', S.version);
  setText('p-ver', S.version);
  setText('btn-install-label', label); setText('btn-install2-label', label);
  setText('u-sub', S.dir ? 'VELOX wird aus „' + S.dir + '“ entfernt.' : 'VELOX wird von diesem PC entfernt.');
  $('u-sub').title = S.dir;
  updateDir();
  updateRunning();
  if (S.screen === 'intro') show(homeScreen());
}

function updateDir() {
  setText('o-dir', S.dir); $('o-dir').title = S.dir;
  setText('w-dir', S.dir); $('w-dir').title = S.dir;
  setText('p-dir', S.dir); $('p-dir').title = S.dir;
  let size = S.sizeMB ? 'ca. ' + fmtMB(S.sizeMB) : '';
  if (S.freeMB >= 0) size += (size ? ' · ' : '') + fmtMB(S.freeMB) + ' frei';
  setText('w-size', size);
  let space = S.freeMB >= 0 ? fmtMB(S.freeMB) + ' frei' : '';
  if (S.sizeMB) space = 'Braucht ca. ' + fmtMB(S.sizeMB) + (space ? ' · ' + space : '');
  if (S.mode === 'update') space += (space ? ' · ' : '') + 'Ein Update bleibt im bisherigen Ordner.';
  setText('o-space', space);
  const tooSmall = S.freeMB >= 0 && S.sizeMB > 0 && S.freeMB < S.sizeMB;
  if (tooSmall) showDirError('Auf diesem Laufwerk ist nicht genug Platz frei. Wähle bitte einen anderen Ort.');
  else if (!$('o-dir-error').dataset.sticky) showDirError('');
  $('btn-install').disabled = tooSmall; $('btn-install2').disabled = tooSmall;
}
function showDirError(text) { const e = $('o-dir-error'); e.textContent = text; e.hidden = !text; }

function updateRunning() {
  $('running-note').hidden = !(S.running && S.mode === 'update');
  $('u-running').hidden = !S.running;
}

let confirmCb = null;
function confirmRunning(kind, onOk) {
  setText('c-title', 'VELOX läuft gerade');
  setText('c-text', kind === 'uninstall'
    ? 'Damit VELOX entfernt werden kann, wird es jetzt geschlossen. Falls VELOX gerade etwas an Windows ändert, warte lieber, bis es fertig ist.'
    : 'Damit es weitergehen kann, wird VELOX jetzt kurz geschlossen. Falls VELOX gerade etwas an Windows ändert, warte lieber, bis es fertig ist.');
  $('confirm').hidden = false;
  confirmCb = onOk;
  setTimeout(() => $('c-ok').focus(), 30);
}
function closeConfirm(ok) {
  const cb = confirmCb; confirmCb = null;
  $('confirm').hidden = true;
  if (ok && cb) cb();
}

function startInstall() {
  if (S.busy) return;
  const go = () => {
    S.busy = true;
    S.task = S.mode === 'update' ? 'update' : 'install';
    setText('p-title', S.task === 'update' ? 'VELOX wird aktualisiert' : 'VELOX wird installiert');
    resetProgress('Vorbereiten');
    show('progress');
    send('install', { dir: S.dir, desktop: $('o-desktop').checked, startMenu: $('o-startmenu').checked, launch: $('o-launch').checked, closeRunning: true });
  };
  if (S.running) confirmRunning('install', go); else go();
}

function startUninstall() {
  if (S.busy) return;
  const go = () => {
    S.busy = true;
    S.task = 'uninstall';
    S.keepData = $('u-keep').checked;
    setText('p-title', 'VELOX wird entfernt');
    resetProgress('Vorbereiten');
    show('progress');
    send('uninstall', { keepData: S.keepData, closeRunning: true });
  };
  if (S.running) confirmRunning('uninstall', go); else go();
}

let doneTimer = 0;
function onDone(m) {
  S.busy = false;
  S.launched = !!m.launched;
  const mode = m.mode || S.task || 'install';
  const update = S.task === 'update';
  if (mode === 'uninstall') {
    setText('d-title', 'VELOX wurde entfernt.');
    setText('d-sub', S.keepData ? 'Deine Einstellungen und Sicherungen sind noch da, falls du VELOX wieder installierst.' : 'Auch die Einstellungen und Sicherungen sind gelöscht.');
    $('d-hint').hidden = true;
    $('btn-launch').hidden = true;
  } else {
    setText('d-title', update ? 'Fertig. VELOX ist auf dem neuesten Stand.' : 'Fertig. VELOX ist installiert.');
    if (S.launched) setText('d-sub', 'VELOX startet gerade. Viel Spaß!');
    else setText('d-sub', $('o-desktop').checked ? 'Du findest VELOX auf dem Desktop und im Startmenü.' : ($('o-startmenu').checked ? 'Du findest VELOX im Startmenü.' : 'Du findest VELOX in „' + S.dir + '“.'));
    $('d-hint').hidden = update;
    $('btn-launch').hidden = S.launched;
  }
  // with "VELOX starten" gone, "Schließen" becomes the primary action
  $('btn-done-close').classList.toggle('primary', $('btn-launch').hidden);
  const word = mode === 'uninstall' ? 'Entfernt' : update ? 'Aktualisiert' : 'Installiert';
  const finish = () => {
    traceBar('d-bar', 100, word);
    show('done');
    // the finish: the word re-locks (streak, snap, sweep) with its small sound - only for a new VELOX on the
    // PC, not for a removal. celebrate() waits for the intro's settle and plays nothing while muted.
    if (mode !== 'uninstall') { S.celebrated = true; intro.celebrate().catch(() => {}); }
  };
  clearTimeout(doneTimer);
  if (S.screen === 'progress' && bar && !reduced) {
    // the row runs out to 100 %, then turns all bone (the orange tick goes away), a beat, then the done screen
    bar.set(1);
    doneTimer = setTimeout(() => {
      bar.done(word);
      doneTimer = setTimeout(finish, 420);
    }, 360);
  } else finish();
}

function onError(m) {
  S.busy = false;
  clearTimeout(doneTimer);
  const fromProgress = S.screen === 'progress';
  setText('e-msg', m.message || 'Etwas ist unerwartet schiefgelaufen.');
  setText('e-hint', m.hint || 'Versuche es noch einmal. Hilft das nicht, starte den PC neu und probiere es dann erneut.');
  $('confirm').hidden = true;
  if (fromProgress) traceBar('e-bar', S.lastPct, 'Abgebrochen bei ' + Math.round(S.lastPct) + ' %', true);
  else $('e-bar').replaceChildren();
  if (bar && fromProgress) bar.fail('Abgebrochen');
  show('error');
}

// ================================================================== messages from VeloxSetup.exe
function onMessage(m) {
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'init': applyInit(m); break;
    case 'running': S.running = !!m.running; updateRunning(); break;
    case 'folder':
      if (m.error) { $('o-dir-error').dataset.sticky = '1'; showDirError(m.error); }
      else {
        delete $('o-dir-error').dataset.sticky;
        S.dir = m.dir || S.dir;
        S.freeMB = m.freeMB == null ? -1 : +m.freeMB;
        updateDir();
      }
      break;
    case 'progress': {
      if (S.screen !== 'progress' && S.screen !== 'done') { S.busy = true; resetProgress(''); show('progress'); }
      if (!bar) resetProgress('');
      const p = Math.max(0, Math.min(100, +m.percent || 0));
      S.lastPct = p;
      bar.set(p / 100);
      if (m.step) bar.status(String(m.step).replace(/\s*…$/, ''));
      setText('p-file', m.file || '');
      break;
    }
    case 'done': onDone(m); break;
    case 'error': onError(m); break;
  }
}
if (bridge) {
  bridge.addEventListener('message', (e) => {
    let d = e.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (err) { d = null; } }
    onMessage(d);
  });
}

// ================================================================== input
const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
$('titlebar').addEventListener('mousedown', (e) => {
  if (e.button !== 0 || (e.target.closest && e.target.closest('[data-nodrag]'))) return;
  e.preventDefault();
  send('drag');
});
on('btn-min', () => send('minimize'));
on('btn-close', () => { if (!S.busy) send('close'); });
on('btn-install', startInstall);
on('btn-install2', startInstall);
on('btn-options', () => show('options'));
on('btn-back', () => show('welcome'));
on('btn-browse', () => send('browse', { dir: S.dir }));
on('btn-launch', () => send('launch'));
on('btn-done-close', () => send('exit'));
on('btn-log', () => send('openLog'));
on('btn-err-close', () => send('exit'));
on('btn-retry', () => { send('checkRunning'); show(homeScreen()); });
on('btn-uninstall', startUninstall);
on('btn-u-cancel', () => send('close'));
on('c-ok', () => closeConfirm(true));
on('c-cancel', () => closeConfirm(false));
$('confirm').addEventListener('mousedown', (e) => { if (e.target === $('confirm')) closeConfirm(false); });

document.addEventListener('keydown', (e) => {
  if (!S.introDone) return;                       // Esc / Enter / Space skip the intro (brand/intro.js)
  if (e.key === 'Escape') {
    if (!$('confirm').hidden) { closeConfirm(false); return; }
    if (S.screen === 'options') show('welcome');
  }
  // keep keyboard focus inside the confirm dialog while it is open
  if (e.key === 'Tab' && !$('confirm').hidden) {
    const a = $('c-ok'), b = $('c-cancel');
    if (document.activeElement !== a && document.activeElement !== b) { e.preventDefault(); a.focus(); }
    else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
    else if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
  }
});
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('dragstart', (e) => e.preventDefault());
// Ctrl+wheel must not zoom the installer
window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });

// ================================================================== preview without VeloxSetup.exe
// Opening index.html in a normal browser shows a believable demo instead of a dead page.
let demo = null;
function preview(m) {
  const reply = (x, delay) => setTimeout(() => onMessage(x), delay || 0);
  switch (m.type) {
    case 'ready': {
      const mode = /uninstall/.test(location.hash) ? 'uninstall' : (/update/.test(location.hash) ? 'update' : 'install');
      reply({ type: 'init', version: '1.3.0', mode, installedVersion: mode === 'update' ? '1.2.2' : '', dir: 'C:\\Program Files\\VELOX', defaultDir: 'C:\\Program Files\\VELOX', sizeMB: 3, freeMB: 182000, running: false }, 30);
      break;
    }
    case 'browse': reply({ type: 'folder', dir: 'D:\\Programme\\VELOX', error: '', freeMB: 512000 }, 200); break;
    case 'install': case 'uninstall': {
      let p = 0;
      clearInterval(demo);
      demo = setInterval(() => {
        p = Math.min(100, p + 2 + Math.random() * 5);
        onMessage({ type: 'progress', percent: p, step: p < 80 ? 'Dateien werden kopiert …' : 'Verknüpfungen werden angelegt …', file: p < 80 ? 'ui/js/pages/file-' + Math.round(p) + '.js' : '' });
        if (p >= 100) { clearInterval(demo); onMessage({ type: 'done', mode: m.type, launched: false }); }
      }, 90);
      break;
    }
  }
}

// ================================================================== start
send('ready');

// test hook (read-only state for the UI tests; harmless in production)
window.__veloxSetup = { state: S, intro, bar: () => bar, show };
