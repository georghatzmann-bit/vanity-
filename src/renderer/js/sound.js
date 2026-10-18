// Leise, kurze Klänge – nur bei wichtigen Aktionen (Klick auf ein Tool, Erfolg, Fehler). Kein Hover-Ton.

const FILES = {
  click: 'assets/sfx/click.mp3',
  success: 'assets/sfx/success.mp3',
  error: 'assets/sfx/error.mp3',
};

// relative Lautstärke je Klang – bewusst dezent
const LEVEL = { click: 0.35, success: 0.5, error: 0.5 };

const state = { enabled: true, volume: 0.4, cache: {} };

export function configureSound({ enabled, volume }) {
  if (typeof enabled === 'boolean') state.enabled = enabled;
  if (Number.isFinite(volume)) state.volume = Math.min(1, Math.max(0, volume));
}

export function soundState() {
  return { enabled: state.enabled, volume: state.volume };
}

export function sfx(name) {
  if (!state.enabled || !FILES[name]) return; // alte Namen (hover, whoosh) bleiben einfach stumm
  try {
    let base = state.cache[name];
    if (!base) {
      base = new Audio(FILES[name]);
      base.preload = 'auto';
      state.cache[name] = base;
    }
    const a = base.paused ? base : base.cloneNode();
    a.volume = Math.min(1, state.volume * (LEVEL[name] ?? 0.4));
    a.currentTime = 0;
    a.play().catch(() => {});
  } catch { /* ohne Ton weiter */ }
}
