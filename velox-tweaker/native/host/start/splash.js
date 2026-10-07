// VELOX.exe start screen: brand/intro.js while the PowerShell backend starts, then the hand-over to the app.
//
// URL (set by HostForm.cs): splash.html?v=<VERSION>&variant=long|short|still&sound=1|0&test=1|0
//   variant  settings.json "introMode": long (the default, every launch) | short | off -> still (no animation,
//            no sound); still also when the screen comes back for an error after the app was already shown
//            (no second intro). 'full' (1.2.x) is read as long; anything else is long as well.
//   sound    settings.json "startSound" (VELOX.exe reads it; 0 = mounted muted)
// Messages (JSON, docs/ARCHITECTURE.md section 11):
//   host -> page  mode{test} · status{text} · starting{text} · ready · error{title,message,log,canTest}
//   page -> host  splash-ready · retry · test · openlog
//                 sound{on}       the user pressed M / the sound button (the host forwards it to the app)
//                 handover{ms}    answer to "ready": how long the hand-over will still take
//                 continue        the hand-over is done (intro.done() resolved): navigate now
import { VeloxIntro } from './brand/intro.js';

const q = new URLSearchParams(location.search);
const wv = window.chrome && window.chrome.webview;
const $ = (id) => document.getElementById(id);
function send(type, extra) {
  try { if (wv) wv.postMessage(Object.assign({ type }, extra || {})); } catch (e) { /* the host is navigating away */ }
}

const version = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(q.get('v') || '') ? q.get('v') : '';
const variant = ['short', 'still'].includes(q.get('variant')) ? q.get('variant') : 'long';
const soundOn = q.get('sound') !== '0';
document.body.classList.toggle('test', q.get('test') === '1');

const stage = $('stage');
const intro = VeloxIntro.mount(stage, {
  variant,
  place: 'hero',
  loader: true,
  muted: !soundOn,                              // settings.json decides, not this origin's localStorage
  labels: version ? 'Version ' + version : null,
  statusText: 'VELOX wird gestartet …',
  onMuteChange: (muted) => send('sound', { on: !muted }),
});

// the Testmodus label sits on the same margin as the word
function placeMode() { try { document.body.style.setProperty('--m', intro.layout().m + 'px'); } catch (e) { /* not laid out yet */ } }
intro.ready.then(placeMode);
window.addEventListener('resize', placeMode);

// ---------------------------------------------------------------- slot content (hint / error)
const hint = $('hint'), err = $('error');
let failed = false, leaving = false, slowTimer = 0;
function armSlow() {
  clearTimeout(slowTimer);
  slowTimer = setTimeout(() => { if (!failed && !leaving) { intro.slot.appendChild(hint); hint.hidden = false; } }, 6000);
}
function clearSlot() { hint.hidden = true; err.hidden = true; if (hint.parentNode === intro.slot) document.body.appendChild(hint); if (err.parentNode === intro.slot) document.body.appendChild(err); }

function showError(m) {
  failed = true;
  clearTimeout(slowTimer);
  intro.skip();                                // never make someone wait for the strike to read an error
  clearSlot();
  $('err-title').textContent = String(m.title || 'VELOX konnte nicht starten');
  $('err-text').textContent = String(m.message || '');
  const log = $('err-log');
  log.textContent = String(m.log || '');
  $('b-test').hidden = !m.canTest;
  intro.slot.appendChild(err);
  err.hidden = false;
  document.body.classList.remove('failed');
  void err.offsetWidth;                        // restart the arrival animation on a second error
  document.body.classList.add('failed');
  log.scrollTop = log.scrollHeight;
  setTimeout(() => { try { $('b-retry').focus({ preventScroll: true }); } catch (e) { /* gone */ } }, 50);
}

function starting(text) {
  failed = false;
  clearSlot();
  document.body.classList.remove('failed');
  intro.status(String(text || 'VELOX wird gestartet …'));
  armSlow();
}

// ---------------------------------------------------------------- hand-over
// intro.done() waits for `calm` (the end of the light sweep: 2.55 s into the long intro, the settle in the
// others; at once after a skip), then plays the 430 ms hand-over. Before the intro's clock runs (boot, the
// sound scheduled 250 ms ahead) the whole intro is still ahead: BOOT_MS covers that lead.
const BOOT_MS = 450;
let atRest = false;
intro.settled.then(() => { atRest = true; });
function remainingMs() {
  const T = intro.timeline();
  const rest = atRest ? 0 : intro.startedAt == null ? (T.calm || 0) + BOOT_MS : Math.max(0, (T.calm || 0) - (performance.now() - intro.startedAt));
  return Math.round(rest + VeloxIntro.HANDOVER.total);
}
function ready() {
  if (leaving || failed) return;
  leaving = true;
  clearTimeout(slowTimer);
  clearSlot();
  send('handover', { ms: remainingMs() });
  intro.done().then(() => send('continue'), () => send('continue'));
}
window.addEventListener('pagehide', () => intro.destroy());

// ---------------------------------------------------------------- messages
function handle(m) {
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'mode': document.body.classList.toggle('test', !!m.test); break;
    case 'status': if (!failed) intro.status(String(m.text || '')); break;
    case 'starting': leaving = false; starting(m.text); break;
    case 'ready': ready(); break;
    case 'error': leaving = false; showError(m); break;
  }
}
if (wv) wv.addEventListener('message', (e) => handle(e.data));
$('b-retry').addEventListener('click', () => send('retry'));
$('b-test').addEventListener('click', () => send('test'));
$('b-log').addEventListener('click', () => send('openlog'));
document.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });

window.__veloxSplash = handle;   // tests
window.__intro = intro;
armSlow();
send('splash-ready');
