// Hyperspace tunnel (WARP warpField + photon core), used only as a 600–800 ms screen transition.
// Drawn additively into the HDR scene. defines: NLAYERS (3 ultra / 2 high / 1 low)
import { HASH, PALETTE } from './common.js';

export const TUNNEL_FS = /* glsl */ `
in vec2 vUv;
out vec4 fragColor;
uniform float uTime, uAspect, uWarpU, uWarpEnv;
uniform vec2 uRes;
${HASH}
${PALETTE}
vec3 plasmaCol(float x) {
  x = sat(x);
  vec3 c = mix(C_INDIGO, C_DEEP, ss(0.0, 0.25, x));
  c = mix(c, C_VIOLET, ss(0.18, 0.50, x));
  c = mix(c, C_MAG, ss(0.52, 0.78, x));
  c = mix(c, C_HOT, ss(0.80, 1.00, x));
  return c;
}
void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);     // height = 1
  float x = uWarpU;
  float r = length(p) + 1e-4;
  float ang = atan(p.y, p.x) + 0.16 * uTime;
  float v = 1.5 + 70.0 * x * x;                   // velocity (rises through the transition)
  float trav = 1.5 * x + 23.3 * x * x * x + uTime * 0.05;
  float px = 1.0 / uRes.y;
  float zb = 0.24 / r;
  float fwz = fwidth(zb) + 1e-5;
  vec3 col = vec3(0.0);
  for (int L = 0; L < NLAYERS; L++) {
    float fl = float(L);
    float N = 64.0 + 76.0 * fl;
    float Rl = 1.0 + 0.55 * fl;
    float w = zb * Rl + trav;
    float sa = ang / TAU * N + fl * 0.37;
    float si = mod(floor(sa), N);
    float sf = fract(sa);
    float h1 = hash12(vec2(si, 11.0 + fl * 7.0));
    float h2 = hash12(vec2(si, 23.0 + fl * 5.0));
    float h3 = hash12(vec2(si, 37.0 + fl * 3.0));
    float period = 1.6 + 2.6 * h2;
    float ww = w / period + h1 * 13.0;
    float cell = floor(ww);
    float fz = fract(ww) * period;
    float hc = hash12(vec2(si * 0.913 + cell * 1.731, cell * 0.37 + fl * 9.1));
    float on = step(0.40, hc);
    float off = 0.5 + (h3 - 0.5) * 0.55;
    float aDist = (sf - off) * TAU / N * r;
    float width = (0.0005 + 0.0021 * sat(r * 2.2)) * (0.55 + 0.9 * hc);
    float wcl = max(width, 0.65 * px);
    float prof = exp(-aDist * aDist / (wcl * wcl)) * (width / wcl);
    float sl = clamp(v * 0.024 * (0.8 + 0.4 * h1), 0.004, period * 0.82);
    float f0 = 0.08 * period;
    float fw = fwz * Rl;
    float head = ss(f0 - fw * 1.5, f0 + fw * 0.5, fz);
    float tl = max(fz - f0, 0.0);
    float tail = exp(-tl / sl * 2.2) * (1.0 - ss(f0 + sl * 0.75, f0 + sl + fw, fz));
    float br = (0.45 + 1.9 * hc * hc * hc) * ss(0.012, 0.12, r) * ss(1.0, 3.0, TAU / N * r * uRes.y);
    vec3 sc = plasmaCol(0.40 + 0.56 * h3);
    if (h2 > 0.94) sc = C_CYAN * 0.9;
    sc = mix(sc, C_HOT, 0.65 * exp(-tl / sl * 6.0));
    col += sc * prof * head * tail * br * on * 1.7;
  }
  // warp-gate rings
  {
    float Rr = 1.15;
    float w = zb * Rr + trav;
    float rp = 2.2;
    float rc = floor(w / rp);
    float rd = (fract(w / rp) - 0.5) * rp;
    float fwr = fwz * Rr;
    float th = 0.013;
    float thc = max(th, fwr * 0.8);
    float ring = exp(-rd * rd / (thc * thc)) * (th / thc);
    float hr = hash11(rc * 3.17 + 1.0);
    float segs = 10.0 + floor(hr * 4.0) * 6.0;
    float sg = fract(ang / TAU * segs + hr * 5.0);
    float dash = ss(0.0, 0.025, sg) * (1.0 - ss(0.60, 0.64, sg));
    ring *= mix(1.0, dash, step(0.3, hr));
    float rb = ss(0.03, 0.24, r) * (1.0 - ss(0.25, 0.9, fwr));
    col += plasmaCol(0.48 + 0.4 * hr) * ring * 2.0 * rb;
  }
  // vanishing point glow (photon core)
  float cg = exp(-r / 0.045) * 0.45 + exp(-r / 0.2) * 0.10;
  col += mix(C_VIOLET, C_LAV, 0.4) * cg * (0.35 + 0.9 * x);
  fragColor = vec4(col * uWarpEnv, 1.0);
}`;
