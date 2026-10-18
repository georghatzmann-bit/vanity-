// Klänge der Oberfläche. Die Dateien stammen aus den Higgsfield-Clips (siehe assets/README.md).

const FILES = {
  hover: 'assets/sfx/hover.mp3',
  click: 'assets/sfx/click.mp3',
  whoosh: 'assets/sfx/whoosh.mp3',
  success: 'assets/sfx/success.mp3',
  error: 'assets/sfx/error.mp3',
};

// relative Lautstärke je Klang (Hover ganz leise)
const LEVEL = { hover: 0.18, click: 0.45, whoosh: 0.7, success: 0.6, error: 0.6 };

const state = { enabled: true, volume: 0.7, cache: {}, lastHover: 0 };

export function configureSound({ enabled, volume }) {
  if (typeof enabled === 'boolean') state.enabled = enabled;
  if (Number.isFinite(volume)) state.volume = Math.min(1, Math.max(0, volume));
}

export function soundState() {
  return { enabled: state.enabled, volume: state.volume };
}

export function sfx(name) {
  if (!state.enabled || !FILES[name]) return;
  if (name === 'hover') {
    const now = performance.now();
    if (now - state.lastHover < 90) return;
    state.lastHover = now;
  }
  try {
    let base = state.cache[name];
    if (!base) {
      base = new Audio(FILES[name]);
      base.preload = 'auto';
      state.cache[name] = base;
    }
    const a = base.paused ? base : base.cloneNode();
    a.volume = Math.min(1, state.volume * (LEVEL[name] ?? 0.5));
    a.currentTime = 0;
    a.play().catch(() => {});
  } catch { /* ohne Ton weiter */ }
}
