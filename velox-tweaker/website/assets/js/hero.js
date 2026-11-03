// The hero: VELOX's real start animation (brand/intro.js, unchanged copy in ../../brand/).
// Browsers block sound until the visitor clicks, so the first run is silent. "Ton an" replays
// the intro from the start with sound (the click unlocks audio); "Nochmal" replays it.
import { VeloxIntro } from '../../brand/intro.js';

const stage = document.getElementById('hero-stage');
const soundBtn = document.getElementById('intro-sound');
const replayBtn = document.getElementById('intro-replay');
const hint = document.getElementById('intro-hint');
const cfg = window.VELOX_SITE || {};

let intro = null;
let soundOn = false;

function say(text) { if (hint) hint.textContent = text; }

function setSoundUi(on) {
  soundOn = on;
  if (!soundBtn) return;
  soundBtn.setAttribute('data-on', on ? 'true' : 'false');
  const label = soundBtn.querySelector('[data-label]');
  if (label) label.textContent = on ? 'Ton ausschalten' : 'Mit Ton abspielen';
}

function start(variant, withSound) {
  if (intro) { try { intro.destroy(); } catch (e) { /* already gone */ } intro = null; }
  try {
    intro = VeloxIntro.mount(stage, {
      variant,
      place: 'hero',
      loader: false,
      sound: withSound,
      muted: withSound ? false : true,
      onMuteChange(m) { setSoundUi(!m); say(m ? 'Ton aus.' : 'Ton an.'); },
    });
    stage.classList.add('is-mounted');
    window.__veloxHero = intro;
    Promise.resolve(intro.ready).then(fit, fit);
  } catch (err) {
    document.documentElement.classList.add('hero-failed');
    if (soundBtn) soundBtn.disabled = true;
    if (replayBtn) replayBtn.disabled = true;
    console.warn('VELOX intro could not start:', err);
  }
}

// The word sits in the middle of the stage; the band under it stays empty once the intro has
// settled. Pull the copy up into that band (CSS reads --word-gap), keeping a 28 px margin.
const hero = stage.closest('.hero');
function fit() {
  if (!intro || !intro.layout) return;
  const L = intro.layout();
  if (!L || !L.ch || !L.cap) return;
  const gap = Math.max(0, Math.round(L.ch - (L.top + L.cap) - 28));
  hero.style.setProperty('--word-gap', gap + 'px');
}
if ('ResizeObserver' in window) new ResizeObserver(() => requestAnimationFrame(fit)).observe(stage);

// Enter / Space on a link or button outside the stage must keep doing what it says. The intro
// listens on window to skip itself on those keys; stopping the event at document keeps it away
// from that listener without touching the link's own default action. Esc and M still reach it.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.querySelector('dialog[open]')) { e.stopPropagation(); return; }   // Esc closes the lightbox
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target;
  if (t && t.closest && t.closest('a, button, summary, input, select, textarea, [tabindex]') && !stage.contains(t)) e.stopPropagation();
});

if (soundBtn) soundBtn.addEventListener('click', () => {
  if (!soundOn) {
    setSoundUi(true);
    say('Läuft mit Ton …');
    start('long', true);
  } else {
    setSoundUi(false);
    if (intro && intro.setMuted) intro.setMuted(true);
    say('Ton aus.');
  }
});
if (replayBtn) replayBtn.addEventListener('click', () => {
  say(soundOn ? 'Läuft mit Ton …' : 'Läuft ohne Ton …');
  start('long', soundOn);
});

// Play the long intro only when the stage is actually on screen (a visit straight to #faq
// gets the settled wordmark instead, and "Nochmal" is there when someone scrolls up).
function boot() {
  if (!('IntersectionObserver' in window)) { start('long', false); return; }
  const io = new IntersectionObserver((entries) => {
    io.disconnect();
    start(entries[0] && entries[0].isIntersecting ? 'long' : 'still', false);
  });
  io.observe(stage);
}
setSoundUi(false);
boot();
