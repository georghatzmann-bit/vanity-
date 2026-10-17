// Static tier: no WebGL. CSS gradient + vignette + CSS embers, the emblem SVG as ghost logo,
// pulses as CSS rings and warps as a CSS radial zoom. Same API surface as the WebGL engine.
import './static.css';
import { emblemSvg } from '../emblem/svg.js';
import { mulberry32 } from '../emblem/raster.js';

export function createStaticLayer(canvas, { reducedMotion = false } = {}) {
  const root = document.createElement('div');
  root.className = 'fx-static is-idle';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `<div class="fx-static__flames"></div><div class="fx-static__emblem">${emblemSvg({ size: 512, fill: 0.12 })}</div><div class="fx-static__vignette"></div>`;
  const rng = mulberry32(7);
  if (!reducedMotion) {
    for (let i = 0; i < 22; i++) {
      const e = document.createElement('span');
      e.className = 'fx-static__ember';
      const x = rng();
      const centre = Math.abs(x - 0.5) < 0.22 ? 0.35 : 0.8;
      e.style.cssText = `left:${(x * 100).toFixed(2)}%;--d:${(7 + rng() * 9).toFixed(2)}s;--delay:${(-rng() * 16).toFixed(2)}s;--dx:${((rng() - 0.5) * 80).toFixed(0)}px;--o:${(centre * (0.4 + rng() * 0.6)).toFixed(2)};transform:scale(${(0.5 + rng()).toFixed(2)})`;
      root.append(e);
    }
  }
  const parent = canvas && canvas.parentNode ? canvas.parentNode : document.body;
  if (canvas && canvas.nextSibling) parent.insertBefore(root, canvas.nextSibling);
  else parent.append(root);
  if (canvas) canvas.style.visibility = 'hidden';
  const emblem = root.querySelector('.fx-static__emblem');
  let state = 'idle';

  const api = {
    root,
    setState(s) {
      root.classList.remove(`is-${state}`);
      state = s;
      root.classList.add(`is-${state}`);
    },
    setProgress(p) {
      root.style.setProperty('--fx-p', p == null ? '0.3' : String(Math.max(0, Math.min(1, p))));
    },
    pulse(strength = 0.6, at = null) {
      if (reducedMotion) return;
      const ring = document.createElement('div');
      ring.className = 'fx-static__ring';
      ring.style.setProperty('--a', String(Math.min(1, 0.3 + strength * 0.7)));
      if (at) {
        ring.style.setProperty('--x', `${at[0]}px`);
        ring.style.setProperty('--y', `${at[1]}px`);
      }
      ring.addEventListener('animationend', () => ring.remove(), { once: true });
      root.append(ring);
    },
    warp(ms) {
      if (reducedMotion) return;
      root.style.setProperty('--warp-ms', `${ms}ms`);
      root.classList.remove('is-warp');
      void root.offsetWidth;
      root.classList.add('is-warp');
      setTimeout(() => root.classList.remove('is-warp'), ms + 50);
    },
    setAnchor(rect) {
      root.classList.toggle('is-anchored', !!rect);
      if (!rect) {
        emblem.style.cssText = '';
        return;
      }
      const s = Math.min(rect.width, rect.height);
      emblem.style.cssText = `left:${rect.left + rect.width / 2}px;top:${rect.top + rect.height / 2}px;width:${s}px;height:${s}px`;
    },
    setIntensity(k) {
      root.style.opacity = String(0.4 + 0.6 * Math.max(0, Math.min(1, k)));
    },
    dispose() {
      root.remove();
      if (canvas) canvas.style.visibility = '';
    },
  };
  return api;
}
