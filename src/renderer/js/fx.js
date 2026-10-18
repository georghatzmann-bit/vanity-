// Spielt die mit Higgsfield gerenderten Clips ab: Intro, Hintergrund-Loop, Übergänge.
// Hier wird nichts selbst animiert – es werden nur die fertigen Videos gestartet und überblendet.

const availability = new Map();

/** Prüft, ob ein Video vorhanden und abspielbar ist. */
export function videoAvailable(src) {
  if (availability.has(src)) return availability.get(src);
  const p = new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'metadata';
    const done = (ok) => { v.removeAttribute('src'); v.load(); resolve(ok); };
    const t = setTimeout(() => done(false), 2500);
    v.addEventListener('loadedmetadata', () => { clearTimeout(t); done(true); }, { once: true });
    v.addEventListener('error', () => { clearTimeout(t); done(false); }, { once: true });
    v.src = src;
  });
  availability.set(src, p);
  return p;
}

const reduced = () => document.body.classList.contains('reduce-motion');

/** Übergang zwischen Cockpit und Tools: Clip läuft über allem, in der Mitte wird die Ansicht getauscht. */
export async function playTransition(swap) {
  const fx = document.getElementById('fx');
  const stage = document.getElementById('stage');
  if (reduced() || !fx || !(await videoAvailable('assets/video/transition.mp4'))) {
    stage.classList.add('fade-out');
    await wait(140);
    await swap();
    stage.classList.remove('fade-out');
    return;
  }
  if (!fx.src) fx.src = 'assets/video/transition.mp4';
  fx.currentTime = 0;
  fx.classList.add('show');
  const swapAt = Number(fx.dataset.swapAt || 0.78); // Sekunde, in der der Clip das Bild ganz füllt
  let swapped = false;
  const doSwap = async () => {
    if (swapped) return;
    swapped = true;
    stage.classList.add('fade-out');
    await swap();
    requestAnimationFrame(() => stage.classList.remove('fade-out'));
  };
  await new Promise((resolve) => {
    const finish = async () => {
      fx.removeEventListener('timeupdate', onTime);
      await doSwap();
      fx.classList.remove('show');
      resolve();
    };
    const onTime = () => { if (fx.currentTime >= swapAt) doSwap(); };
    fx.addEventListener('timeupdate', onTime);
    fx.addEventListener('ended', finish, { once: true });
    fx.addEventListener('error', finish, { once: true });
    setTimeout(finish, 3500); // Sicherheitsnetz
    fx.play().catch(finish);
  });
}

/** Intro beim Start (mit Ton). Klick oder Taste überspringt. */
export function playIntro(settings) {
  return new Promise((resolve) => {
    const box = document.getElementById('intro');
    const v = box.querySelector('video');
    const skip = box.querySelector('button');
    let finished = false;
    const end = () => {
      if (finished) return;
      finished = true;
      box.classList.add('leaving');
      document.removeEventListener('keydown', end);
      setTimeout(() => { box.hidden = true; v.pause(); v.removeAttribute('src'); v.load(); resolve(); }, 450);
    };
    box.hidden = false;
    v.muted = !settings.sound;
    v.volume = Math.min(1, (settings.volume ?? 0.7) * 0.9);
    v.src = 'assets/video/intro.mp4';
    v.addEventListener('ended', end, { once: true });
    v.addEventListener('error', end, { once: true });
    skip.addEventListener('click', end, { once: true });
    box.addEventListener('click', end, { once: true });
    document.addEventListener('keydown', end);
    v.play().catch(() => { v.muted = true; v.play().catch(end); });
    setTimeout(end, 12000);
  });
}

export function setBackgroundPaused(paused) {
  for (const id of ['bg']) {
    const v = document.getElementById(id);
    if (!v) continue;
    if (paused && !v.paused) v.pause();
    if (!paused && v.paused) v.play().catch(() => {});
  }
  document.querySelectorAll('video.loop-media').forEach((v) => {
    // Ein gerade erst eingefügtes Video gilt noch als „paused“, startet aber gleich per autoplay –
    // deshalb autoplay abschalten und immer pause() aufrufen.
    if (paused) { v.autoplay = false; v.pause(); }
    if (!paused && v.paused) v.play().catch(() => {});
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
