// Scramble-decode text (PLASMA hud.js decode(), verbatim algorithm). Pure function of t, so DOM
// overlays (tagline "DEIN PC. WIEDERGEBOREN.", boot HUD with real system data) stay in sync with
// the FX timeline.
//   decode(text, t, t0, cps = 60, win = 6, salt = 0) -> { s, done, typing }

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=<>/\\|{}[]$@';
const hash = (a, b) => {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Typing head with a scramble window trailing behind it. */
export function decode(text, t, t0, cps = 60, win = 6, salt = 0) {
  if (t < t0) return { s: '', done: false, typing: false };
  const head = (t - t0) * cps;
  const frame = Math.floor(t * 30);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (i >= head) break;
    const ch = text[i];
    if (ch === ' ' || ch === '·' || ch === '.' || i < head - win) {
      out += ch;
      continue;
    }
    out += GLYPHS[Math.floor(hash(i + salt * 131, frame) * GLYPHS.length)];
  }
  return { s: out, done: head >= text.length + win, typing: head < text.length + win };
}
