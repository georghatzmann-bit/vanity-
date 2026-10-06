// Generates every brand drawing from geometry.mjs:
//   glyphs.js (data module for intro.js), wordmark*.svg, mark.svg, app-icon.svg,
//   mark-16.svg (pixel master), lockup.svg.
// Run: node brand/src/build.mjs   (no dependencies)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORD, GLYPHS, LARGE, SMALL, SHEAR, SHEAR_DEG, glyphPieces, toPath, extentAt, wordWidth, split, sheared } from './geometry.mjs';
import { fitMark, fitVectorMark } from './pixelfit.mjs';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const C = { ink: '#0C0D0F', tile: '#1A1B1F', key: '#45484F', bone: '#ECE9E2', signal: '#FF5A1F' };
const r2 = (n) => Math.round(n * 100) / 100;
const write = (name, s) => { fs.writeFileSync(path.join(OUT, name), s); console.log('wrote', name, s.length, 'B'); };

function letters(master) {
  return WORD.map(({ ch, x }) => {
    const p = glyphPieces(ch, master);
    return {
      ch, x, w: GLYPHS[ch].w,
      top: toPath(p.top, x, master.offset), bot: toPath(p.bot, x, 0), topRaw: toPath(p.top, x, 0),
      // what the cut line meets, measured just inside each half
      exTop: extentAt(p.top, master.cutTop - 0.5, x, 0), exBot: extentAt(p.bot, master.cutBot + 0.5, x, 0),
    };
  });
}
const L = letters(LARGE), S = letters(SMALL);
const W = r2(wordWidth(LARGE)), WS = r2(wordWidth(SMALL));

const svg = (vb, body, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"${extra}>\n  <title>VELOX</title>\n  ${body}\n</svg>\n`;
const word = (ls, fg, accent) => ls.map((l, i) => `<path fill="${fg}" d="${l.top}"/><path fill="${i === 0 ? accent : fg}" d="${l.bot}"/>`).join('\n  ');

write('wordmark.svg', svg(`0 0 ${W} 100`, word(L, C.bone, C.signal), ` width="${r2(W * 2)}" height="200"`));
write('wordmark-light.svg', svg(`0 0 ${W} 100`, word(L, C.ink, C.signal), ` width="${r2(W * 2)}" height="200"`));
// small master: drawn on the 16 px grid (1 unit = 0.16 px); viewBox height 100 -> render at 16 px or 32 px
write('wordmark-small.svg', svg(`0 0 ${WS} 100`, word(S, C.bone, C.signal), ` width="${r2(WS * 0.16)}" height="16"`));
write('wordmark-small-light.svg', svg(`0 0 ${WS} 100`, word(S, C.ink, C.signal), ` width="${r2(WS * 0.16)}" height="16"`));

// ---- the mark: the wordmark's V, lifted out unchanged
const V = L[0];
const vw = 84 + 100 * SHEAR + LARGE.offset;
write('mark.svg', svg(`0 0 ${r2(vw)} 100`, `<path fill="${C.bone}" d="${V.top}"/><path fill="${C.signal}" d="${V.bot}"/>`, ` width="${r2(vw * 2)}" height="200"`));

// ---- app icon: V on a lifted tile with a 1 px keyline at 64 px (the tile must separate on a dark taskbar)
function tile(T, k = T / 80) {           // keyline: 3.2 units at 256; 1 px in the per-size exports
  const rad = T * 0.22;
  const s = 0.60 * T / 100;            // cap height = 60 % of the tile
  const tx = (T - vw * s) / 2 - 1.0 * s, ty = (T - 100 * s) / 2;
  return `<rect x="${k / 2}" y="${k / 2}" width="${T - k}" height="${T - k}" rx="${r2(rad - k / 2)}" fill="${C.tile}" stroke="${C.key}" stroke-width="${k}"/>\n  ` +
    `<g transform="translate(${r2(tx)} ${r2(ty)}) scale(${Math.round(s * 10000) / 10000})"><path fill="${C.bone}" d="${V.top}"/><path fill="${C.signal}" d="${V.bot}"/></g>`;
}
write('app-icon.svg', svg('0 0 256 256', tile(256), ' width="256" height="256"'));

// per-size vector icons for 32-256 px exports (keyline exactly 1 px, or 3 px at 256)
for (const N of [32, 40, 48, 64, 96, 128, 256]) {
  fs.mkdirSync(path.join(OUT, 'src', 'fit'), { recursive: true });
  const body = N <= 48 ? fitVectorMark(N, C, SHEAR) : svg(`0 0 ${N} ${N}`, tile(N, N >= 256 ? 3 : N >= 96 ? 2 : 1), ` width="${N}" height="${N}"`);
  fs.writeFileSync(path.join(OUT, 'src', 'fit', `app-icon-${N}.svg`), body);
}

// ---- pixel masters (hard pixels, cut and offset on whole pixels)
const fits = {};
for (const N of [16, 20, 24, 32]) fits[N] = fitMark(N, C);
write('mark-16.svg', fits[16].svg);
fs.mkdirSync(path.join(OUT, 'src', 'fit'), { recursive: true });
for (const N of [20, 24, 32]) fs.writeFileSync(path.join(OUT, 'src', 'fit', `mark-${N}.svg`), fits[N].svg);

// ---- lockup: icon tile + wordmark, cap height of the word = 46 % of the tile
{
  const T = 128, gap = 36, cap = 58, s = cap / 100, ty = (T - cap) / 2;
  const body = `<g>${tile(T)}</g>\n  <g transform="translate(${T + gap} ${ty}) scale(${s})">\n  ${word(L, C.bone, C.signal)}\n  </g>`;
  const total = r2(T + gap + W * s);
  write('lockup.svg', svg(`0 0 ${total} ${T}`, body, ` width="${r2(total * 2)}" height="${T * 2}"`));
}

// ---- data module for intro.js (settled lower halves; tops WITHOUT the offset - the intro applies it)
const yc = (LARGE.cutTop + LARGE.cutBot) / 2;
const data = {
  w: W, h: 100, cutTop: LARGE.cutTop, cutBot: LARGE.cutBot, offset: LARGE.offset, shear: Math.round(SHEAR * 1e6) / 1e6, shearDeg: SHEAR_DEG,
  cutLo: r2(Math.min(L[0].exBot.lo, L[0].exTop.lo + LARGE.offset)),
  cutHi: r2(Math.max(L[4].exBot.hi, L[4].exTop.hi + LARGE.offset)),
  letters: L.map((l, i) => ({
    ch: l.ch,
    cx: r2((Math.min(l.exBot.lo, l.exTop.lo) + Math.max(l.exBot.hi, l.exTop.hi)) / 2),
    lo: r2(Math.min(l.exBot.lo, l.exTop.lo)), hi: r2(Math.max(l.exBot.hi, l.exTop.hi)),
    mass: r2((l.exTop.mass + l.exBot.mass) / 2),       // material the cut runs through (drives the click level)
    top: l.topRaw, bot: l.bot, signal: i === 0,
  })),
};
void yc;
write('glyphs.js', '// GENERATED by src/build.mjs from src/geometry.mjs - do not edit by hand.\n' +
  '// VELOX "Versatz" letterforms: cap height 100 units, cut band ' + LARGE.cutTop + '..' + LARGE.cutBot + ', shear ' + SHEAR_DEG + ' deg, offset +' + LARGE.offset + '.\n' +
  'export const GLYPHS = ' + JSON.stringify(data) + ';\n');
console.log('word width', W, 'small', WS, 'V width', r2(vw), 'cut', data.cutLo, data.cutHi);
console.log(data.letters.map((l) => `${l.ch} cx=${l.cx} lo=${l.lo} hi=${l.hi} mass=${l.mass}`).join('\n'));
void split; void sheared;
