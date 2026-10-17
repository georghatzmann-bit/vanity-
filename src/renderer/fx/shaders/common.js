// Shared GLSL ES 3.00 chunks. Every pass is a pure function of its uniforms (no feedback state).
// Feature switches are compile-time #defines (variant cache in renderer.js) because software
// rasterizers (SwiftShader, WARP, llvmpipe) execute both sides of uniform branches.

export const FULLSCREEN_VS = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** Prefix for every shader: precision + feature defines ({ F_X: true|false|number }). */
export function header(defs = {}) {
  let s = 'precision highp float;\nprecision highp int;\n';
  for (const k of Object.keys(defs)) {
    const v = defs[k];
    s += `#define ${k} ${typeof v === 'boolean' ? (v ? 1 : 0) : Number.isInteger(v) ? v : Number(v).toFixed(6)}\n`;
  }
  return s;
}

export const HASH = /* glsl */ `
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
`;

// Brand palette (linear RGB). Never orange or red.
export const PALETTE = /* glsl */ `
#define PI 3.14159265359
#define TAU 6.28318530718
const vec3 C_INDIGO = vec3(0.010, 0.008, 0.045);
const vec3 C_DEEP   = vec3(0.055, 0.022, 0.300);
const vec3 C_VIOLET = vec3(0.258, 0.107, 0.922);   // #8B5CF6
const vec3 C_LAV    = vec3(0.386, 0.258, 0.955);   // #A78BFA
const vec3 C_PALE   = vec3(0.723, 0.672, 0.973);   // #DDD6FE
const vec3 C_MAG    = vec3(0.693, 0.064, 0.855);   // #D946EF
const vec3 C_PINK   = vec3(0.807, 0.205, 0.930);   // #E879F9
const vec3 C_HOT    = vec3(1.000, 0.900, 1.000);
const vec3 C_CYAN   = vec3(0.133, 0.807, 0.947);   // #67E8F9
float sat(float x) { return clamp(x, 0.0, 1.0); }
float ss(float a, float b, float x) { return smoothstep(a, b, x); }
// thin-film hue cycle restricted to on-brand hues (cyan, violet, magenta, blue) – CHROME graft
vec3 iriHue(float x) {
  x = fract(x) * 4.0;
  float f = smoothstep(0.0, 1.0, fract(x));
  int i = int(floor(x));
  vec3 a = vec3(0.40, 0.82, 1.00);
  vec3 b = vec3(0.56, 0.38, 1.00);
  vec3 c = vec3(1.00, 0.42, 0.90);
  vec3 d = vec3(0.32, 0.42, 1.00);
  if (i == 0) return mix(a, b, f);
  if (i == 1) return mix(b, c, f);
  if (i == 2) return mix(c, d, f);
  return mix(d, a, f);
}
`;

// World space: screen height = 2 / uContent (y up), x scaled by aspect. uContent < 1 shrinks the
// content on narrow (portrait) windows so the emblem always fits.
export const WORLD = /* glsl */ `
uniform float uAspect, uContent;
vec2 toWorld(vec2 uv) { return (uv * 2.0 - 1.0) * vec2(uAspect, 1.0) / uContent; }
vec2 toUv(vec2 w) { return w * uContent / vec2(uAspect, 1.0) * 0.5 + 0.5; }
`;

// Divergence-free plane-wave flow (PLASMA FLOW, verbatim)
export const FLOW = /* glsl */ `
vec2 flow(vec2 p, float t) {
  vec2 v = vec2(0.0); vec2 k; float ph;
  k = vec2( 2.1,  1.3); ph = dot(k, p) + t * 0.9;        v += cos(ph) * vec2(k.y, -k.x);
  k = vec2(-1.7,  2.6); ph = dot(k, p) + t * 1.1 + 1.3;  v += cos(ph) * vec2(k.y, -k.x) * 0.8;
  k = vec2( 3.9, -2.2); ph = dot(k, p) - t * 1.4 + 2.1;  v += cos(ph) * vec2(k.y, -k.x) * 0.45;
  k = vec2(-4.6, -3.7); ph = dot(k, p) + t * 1.7 + 4.2;  v += cos(ph) * vec2(k.y, -k.x) * 0.3;
  return v * 0.18;
}`;
