// In-app splash: the brand start sequence (brand/intro.js, a byte-identical copy of the kit).
//
//   Started by VELOX.exe (?from=host, or bootstrap.mode.hosted): the host has already played the
//   intro with its sound. Here only its end pose: `still` + `handedOver` (no sound, no second
//   intro), faded out when the first data is in.
//   Started by Start.bat (Edge app window): the full intro on the first start of a VERSION, the
//   short one otherwise. Sound only when settings.startSound allows it; M / the sound button
//   write that same setting. When Edge blocks autoplay the intro says "Ton: klicken" and the first
//   click replays it with sound (the kit does that).
//
// "Seen" lives in settings.introSeen (the backend's settings.json): the app's origin carries a
// random port, so localStorage is a new, empty store on every start. localStorage is still
// written and read (wrapped in try/catch) as a second opinion. Contract: ARCHITECTURE.md §11.
import { VeloxIntro } from '../brand/intro.js';

const SEEN_KEY = 'velox.intro.seen';
const HOSTED_KEY = 'velox.hosted';
const FALLBACK_MS = 700;      // no bootstrap by then: start a silent short intro anyway
const FADE_MS = 220;

// ---- URL hints from VELOX.exe, read once and removed from the address bar (t stays for api.js)
const params = new URLSearchParams(location.search);
let hostedHint = params.get('from') === 'host';
const soundHint = params.get('sound') === 'on' ? true : params.get('sound') === 'off' ? false : null;
try {
  if (hostedHint) sessionStorage.setItem(HOSTED_KEY, '1');
  else hostedHint = sessionStorage.getItem(HOSTED_KEY) === '1';   // a reload inside VELOX.exe
} catch { /* storage blocked */ }
if (params.has('from') || params.has('sound')) {
  params.delete('from'); params.delete('sound');
  const q = params.toString();
  try { history.replaceState(history.state, '', location.pathname + (q ? '?' + q : '') + location.hash); } catch { /* ignore */ }
}

function localSeen() { try { return localStorage.getItem(SEEN_KEY) || ''; } catch { return ''; } }
function markLocalSeen(v) { try { localStorage.setItem(SEEN_KEY, v); } catch { /* ignore */ } }

const el = () => document.getElementById('splash');
const stage = () => document.getElementById('splash-stage');

let intro = null;
let info = { hosted: false, variant: null, sound: false };
let fallbackTimer = 0;
let finishing = null;
let disposed = false;
let scan = null;              // the app's own progress lines in the intro's slot (hosted only)
let saveFn = null;
const preview = { busy: false, intro: null };   // Einstellungen → replay

function mount(opts) {
  if (intro || disposed || !stage()) return;
  intro = VeloxIntro.mount(stage(), Object.assign({ place: 'hero' }, opts));
  info.variant = intro.variant;
  el().dataset.variant = intro.variant;
  el().dataset.hosted = String(info.hosted);
}

export const splash = {
  get intro() { return intro; },
  get info() { return Object.assign({ mounted: !!intro, muted: intro ? intro.muted : null, preview: !!preview.intro }, info); },
  get previewIntro() { return preview.intro; },

  /** Page start (before /api/bootstrap): VELOX.exe's hand-over pose at once, else wait briefly. */
  early() {
    if (hostedHint) {
      info.hosted = true;
      mount({ variant: 'still', handedOver: true, sound: false });
      return;
    }
    fallbackTimer = setTimeout(() => {
      // the backend is slow to answer: a modest, silent short intro (the settings are not known yet)
      if (!intro) mount({ variant: 'short', sound: false, statusText: 'Daten werden geladen' });
    }, FALLBACK_MS);
  },

  /**
   * After the first /api/bootstrap: picks the variant and the sound from the real settings.
   * save(partial) persists settings (POST /api/settings) without a toast.
   */
  configure(data, save) {
    clearTimeout(fallbackTimer);
    saveFn = save;
    const settings = (data && data.settings) || {};
    const version = String((data && data.app && data.app.version) || '');
    const mode = (data && data.mode) || {};
    // VELOX.exe passes the start screen's last mute choice once (&sound=on|off): keep it
    let startSound = settings.startSound !== false;
    if (soundHint !== null && soundHint !== startSound) { startSound = soundHint; save({ startSound }); }
    if (intro) return;                                     // already showing (hosted hint or fallback)
    const labels = version ? 'Version ' + version : null;
    if (hostedHint || mode.hosted) {
      info.hosted = true;
      mount({ variant: 'still', handedOver: true, sound: false, labels });
      return;
    }
    const seen = settings.introSeen === version || localSeen() === version;
    const variant = !version || seen ? 'short' : 'full';
    info.sound = startSound;
    mount({
      variant, labels,
      sound: true, muted: !startSound,                     // muted: the button says "Ton aus", M turns it on
      reducedMotion: settings.motion === 'reduced' ? true : 'auto',
      statusText: 'Bereit',
      onMuteChange: (muted) => { info.sound = !muted; if (saveFn) saveFn({ startSound: !muted }); },
    });
    if (variant === 'full' && version) {
      markLocalSeen(version);
      if (settings.introSeen !== version) save({ introSeen: version });
    }
  },

  /** First-run scan: show what is happening under the word. */
  scanStart() {
    if (!intro) mount({ variant: 'short', sound: false });
    if (!intro) return;
    if (info.hosted) {
      // the intro's own loader is already handed over: the app's lines go into its slot
      if (!scan) {
        const status = document.createElement('span'); status.textContent = 'Hardware wird erkannt …';
        const pct = document.createElement('span'); pct.className = 'splash-scan-pct';
        const row = document.createElement('div'); row.className = 'splash-scan-row'; row.append(status, pct);
        const fill = document.createElement('div'); fill.className = 'pbar-fill';
        const bar = document.createElement('div'); bar.className = 'pbar'; bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-label', 'Systemanalyse');
        bar.appendChild(fill);
        const hint = document.createElement('p'); hint.className = 'splash-hint';
        hint.textContent = 'Beim ersten Start dauert das ein paar Sekunden. Es wird nichts verändert.';
        const box = document.createElement('div'); box.className = 'splash-scan'; box.setAttribute('role', 'status');
        box.append(row, bar, hint);
        intro.slot.appendChild(box);
        scan = { status, pct, fill, bar };
      }
    } else {
      intro.status('Hardware wird erkannt …');
    }
  },

  /** Job progress of the first-run scan. */
  update(job) {
    if (!intro || !job) return;
    const p = Math.max(0, Math.min(1, Number(job.progress) || 0));
    if (scan) {
      if (job.step) scan.status.textContent = job.step;
      scan.pct.textContent = Math.round(p * 100) + ' %';
      const v = Math.max(0.02, p);
      scan.fill.style.transform = 'scaleX(' + v + ')';
      scan.bar.style.setProperty('--p', String(v));
      scan.bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    } else {
      if (job.step) intro.status(job.step);
      intro.progress(p);
    }
  },

  /**
   * The app is ready: the intro's hand-over (it waits until the intro has settled - never cut
   * short), then a short fade, then destroy(). Resolves when #splash is hidden.
   */
  finish() {
    if (finishing) return finishing;
    clearTimeout(fallbackTimer);
    const root = el();
    finishing = (async () => {
      if (!intro) mount({ variant: 'still', handedOver: true, sound: false });
      if (intro) {
        intro.progress(null);
        try { await intro.done(); } catch { /* fade anyway */ }
      }
      if (root && !root.hidden) {
        root.classList.add('gone');
        await new Promise((r) => setTimeout(r, FADE_MS));
        root.hidden = true;
      }
      splash.dispose();
    })();
    return finishing;
  },

  /** Error / ended screens: no intro, no timers, no key listener, no audio context left behind. */
  dispose() {
    disposed = true;
    clearTimeout(fallbackTimer);
    if (intro) { try { intro.destroy(); } catch { /* ignore */ } intro = null; }
    scan = null;
  },

  /**
   * Einstellungen → "Startanimation abspielen": the full intro once more over the app, with the
   * sound if settings.startSound allows it (the click is the gesture, so autoplay is allowed).
   * Esc / Überspringen jump to the end; then the usual hand-over and fade.
   */
  async preview(settings) {
    const root = el();
    if (!root || !stage() || preview.busy) return;
    preview.busy = true;
    const app = document.getElementById('app');
    const active = document.activeElement;
    app.setAttribute('inert', '');
    root.hidden = false;
    root.classList.remove('gone');
    root.dataset.preview = 'true';
    const s = settings || {};
    const p = VeloxIntro.mount(stage(), {
      variant: 'full', place: 'hero', sound: true, muted: s.startSound === false, statusText: 'Bereit',
      reducedMotion: s.motion === 'reduced' ? true : 'auto',
      onMuteChange: (muted) => { if (saveFn) saveFn({ startSound: !muted }); },
    });
    preview.intro = p;
    try { await p.done(); } catch { /* fade anyway */ }
    root.classList.add('gone');
    await new Promise((r) => setTimeout(r, FADE_MS));
    p.destroy();
    preview.intro = null;
    root.hidden = true;
    delete root.dataset.preview;
    if (!document.querySelector('.layer')) app.removeAttribute('inert');
    if (active && active.focus) active.focus({ preventScroll: true });
    preview.busy = false;
  },

  hide() {
    splash.dispose();
    const root = el();
    if (root) root.hidden = true;
  }
};
