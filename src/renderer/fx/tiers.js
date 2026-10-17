// Quality tiers (spec 4.6), GPU detection, speed probe classification and the runtime governor.

export const TIERS = Object.freeze({
  ultra: Object.freeze({
    name: 'ultra', dprMax: 2, scale: 1, hCap: 1100, plasma: 0.5, oct: 5,
    emblem: 40000, word: 15000, embers: 2400, sparks: 1600, pen: 1200, sizeMul: 1.0, sparkW: 1.0,
    bloom: 6, rays: 40, streak: 24, tunnel: 3, rbTaps: 10, bake: 640, heat: 384,
    fps: { intro: 60, idle: 60, installing: 60, pulse: 60 }, plasmaRate: 60,
  }),
  high: Object.freeze({
    name: 'high', dprMax: 1, scale: 1, hCap: 900, plasma: 0.4, oct: 4,
    emblem: 16000, word: 6000, embers: 1200, sparks: 900, pen: 600, sizeMul: 1.25, sparkW: 1.0,
    bloom: 5, rays: 24, streak: 16, tunnel: 2, rbTaps: 8, bake: 512, heat: 256,
    fps: { intro: 60, idle: 30, installing: 30, pulse: 60 }, plasmaRate: 30,
  }),
  low: Object.freeze({
    name: 'low', dprMax: 1, scale: 0.6, hCap: 600, plasma: 0.26, oct: 3,
    emblem: 6000, word: 2000, embers: 500, sparks: 300, pen: 220, sizeMul: 1.6, sparkW: 1.25,
    bloom: 3, bloomLite: true, rays: 0, streak: 0, tunnel: 1, rbTaps: 4, bake: 384, heat: 192,
    fps: { intro: 30, idle: 10, installing: 10, pulse: 20 }, plasmaRate: 10,
  }),
});

export const TIER_ORDER = ['static', 'low', 'high', 'ultra'];
export const SOFTWARE_RE = /swiftshader|llvmpipe|softpipe|basic render|microsoft basic|\bwarp\b|software/i;
const DEDICATED_RE = /nvidia|geforce|quadro|rtx|gtx|radeon|amd|\bati\b/i;
const INTEGRATED_RE = /intel|uhd|iris|apple|mali|adreno|powervr|vega \d+ graphics|radeon\(tm\) graphics/i;

/** Maps the user setting (store.settings.effects) to the highest allowed tier. */
export function tierForSetting(effects) {
  if (effects === 'off') return 'static';
  if (effects === 'low') return 'low';
  if (effects === 'high') return 'high';
  return 'ultra';
}

export const lowerTier = (a, b) => (TIER_ORDER.indexOf(a) <= TIER_ORDER.indexOf(b) ? a : b);
export const tierBelow = (t) => TIER_ORDER[Math.max(0, TIER_ORDER.indexOf(t) - 1)];

/** Reads the renderer string of a WebGL2 context + optional hint from the Electron main process. */
export function detectGpu(gl, hint) {
  let renderer = '';
  let vendor = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    vendor = String(ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));
  } catch {
    /* ignore */
  }
  const software = !!(hint && hint.software) || SOFTWARE_RE.test(renderer) || (hint && hint.vendorId === 0x1414);
  const dedicatedVendor = hint && (hint.vendorId === 0x10de || hint.vendorId === 0x1002);
  const dedicated = !software && (dedicatedVendor || (DEDICATED_RE.test(renderer) && !INTEGRATED_RE.test(renderer)));
  const hdr = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
  return { renderer: (hint && hint.renderer) || renderer, vendor, software, dedicated, hdr };
}

/** Probe median (ms) -> tier (spec 4.6.3). */
export function tierFromProbe(ms, gpu) {
  if (gpu.software) return ms <= 70 ? 'low' : 'static';
  if (ms <= 8) return 'ultra';
  if (ms <= 14) return 'high';
  if (ms <= 30) return 'low';
  return 'low-slow'; // caller re-probes at 'low' and drops to static if that is too slow as well
}

const STORE_KEY = 'phoenix.fx.tier.v1';
export function loadSavedTier(renderer) {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    return v && v.renderer === renderer && TIER_ORDER.includes(v.tier) ? v.tier : null;
  } catch {
    return null;
  }
}
export function saveTier(renderer, tier) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ renderer, tier, at: Date.now() }));
  } catch {
    /* ignore */
  }
}

/**
 * Runtime governor: rolling window of 60 frame times. If the median exceeds 1.35x the target frame
 * time for 2 s: first lower the render scale in x0.85 steps down to 0.6, then drop one tier.
 * Software renderers drop to 'static' when frames still take longer than ~70 ms.
 * Never steps up during a session.
 */
export class Governor {
  constructor({ software = false } = {}) {
    this.software = software;
    this.buf = new Float32Array(60);
    this.tmp = new Float32Array(60);
    this.n = 0;
    this.i = 0;
    this.badSince = -1;
    this.lastCheck = 0;
    this.scale = 1;
  }
  reset() {
    this.n = 0;
    this.i = 0;
    this.badSince = -1;
  }
  median() {
    const n = this.n;
    if (!n) return 0;
    const t = this.tmp.subarray(0, n);
    t.set(this.buf.subarray(0, n));
    t.sort();
    return t[n >> 1];
  }
  /** Returns null | 'scale' | 'drop' | 'static'. now in ms. */
  sample(ms, targetMs, now) {
    this.buf[this.i] = ms;
    this.i = (this.i + 1) % 60;
    if (this.n < 60) this.n++;
    if (now - this.lastCheck < 250 || this.n < 8) return null;
    this.lastCheck = now;
    const med = this.median();
    // software rasterizers: frames above ~70 ms steal too much CPU from the installs -> static tier
    const limit = this.software ? 70 : targetMs * 1.35;
    if (med <= limit) {
      this.badSince = -1;
      return null;
    }
    if (this.badSince < 0) this.badSince = now;
    if (now - this.badSince < 2000) return null;
    this.reset();
    if (this.software) return 'static';
    if (this.scale > 0.61) {
      this.scale = Math.max(0.6, this.scale * 0.85);
      return 'scale';
    }
    this.scale = 1;
    return 'drop';
  }
}
