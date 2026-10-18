// Übergänge und Intro – schlicht und kurz, ohne Videos: die Ansicht blendet weich aus und wieder ein.

const reduced = () => document.body.classList.contains('reduce-motion');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wechsel zwischen Cockpit und Tools: kurz ausblenden, Ansicht tauschen, wieder einblenden. */
export async function playTransition(swap) {
  const stage = document.getElementById('stage');
  stage.classList.add('fade-out');
  await wait(reduced() ? 90 : 150);
  try {
    await swap();
  } finally {
    requestAnimationFrame(() => stage.classList.remove('fade-out'));
  }
}

/** Kurzes Intro beim Start (unter 2 Sekunden, ohne Knopf und ohne Ton). */
export function playIntro() {
  return new Promise((resolve) => {
    const box = document.getElementById('intro');
    if (!box || reduced()) { resolve(); return; }
    box.hidden = false;
    setTimeout(() => {
      box.classList.add('leaving');
      setTimeout(() => { box.hidden = true; box.classList.remove('leaving'); resolve(); }, 320);
    }, 1250);
  });
}

/** Früher für die Hintergrund-Videos – es gibt keine mehr. Bleibt, damit ältere Aufrufe nichts kaputt machen. */
export function setBackgroundPaused() {}
