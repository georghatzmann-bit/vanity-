// PLASMA field (PLASMA PHOENIX PLASMA_FS, adapted): domain-warped fbm + ridged strands, vortex shear
// around the emblem anchor, rising flames whose height is a uniform, heat injected from the emblem /
// wordmark silhouettes, ignition reveal front, pulse rings. Rendered at low resolution.
import { HASH, PALETTE, WORLD } from './common.js';

// Ashima / Stefan Gustavson 3D simplex noise (MIT) – verbatim
export const SIMPLEX = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

// defines: OCT (int), F_REVEAL, F_HEAT, F_SHOCK, F_PULSE, F_CLIMAX
export const PLASMA_FS = /* glsl */ `
in vec2 vUv;
out vec4 fragColor;
uniform float uTime;
uniform vec3 uAnchor;          // world centre (xy) + emblem scale (z, 0.45 = boot size)
uniform vec4 uHeatBox;         // heat texture box in emblem-local units (x0, y0, x1, y1)
uniform float uReveal, uRim, uSwirl, uIntensity, uIdle, uHeatAmt, uWordHeat, uShock, uShockR, uClimax, uFill;
uniform float uFlameY, uHue, uDesat;
uniform vec4 uPulse[4];        // t0, amp, cx, cy (world)
uniform sampler2D uHeat;       // r: emblem heat (soft), g: emblem mask, b: word heat, a: word mask
${WORLD}
${HASH}
${PALETTE}
${SIMPLEX}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < OCT; i++) {
    s += a * snoise(p);
    p = p * 2.03 + vec3(1.7, -1.3, 0.9);
    a *= 0.5;
  }
  return s;
}
float ridged(vec3 p) {
  float s = 0.0, a = 0.55, prev = 1.0;
  for (int i = 0; i < OCT; i++) {
    float n = 1.0 - abs(snoise(p));
    n *= n;
    s += n * a * prev;
    prev = n;
    p = p * 2.07 + vec3(3.1, -1.7, 2.3);
    a *= 0.5;
  }
  return s;
}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
vec3 ramp(float e, float hue) {
  vec3 indigo  = vec3(0.035, 0.012, 0.140);
  vec3 deep    = vec3(0.120, 0.035, 0.480);
  vec3 violet  = vec3(0.290, 0.100, 0.980);
  vec3 magenta = vec3(0.720, 0.080, 0.900);
  vec3 hot     = vec3(1.000, 0.860, 1.250);
  vec3 c = mix(indigo, deep, smoothstep(0.03, 0.30, e));
  c = mix(c, mix(violet, magenta, hue), smoothstep(0.25, 0.90, e));
  // calm looks (idle / home): flame tips stay violet-magenta instead of clipping to white hot spots
  c = mix(c, hot, smoothstep(1.10, 2.6, e) * (1.0 - 0.6 * smoothstep(0.9, 1.0, uIdle)));
  return c;
}

void main() {
  float t = uTime;
  vec2 p = toWorld(vUv);
  float k = uAnchor.z / 0.45;
  vec2 c = (p - uAnchor.xy) / max(k, 0.05);
  const float SQ = 0.7;                       // perspective disk metric (matches the particle disk)
  vec2 ce = vec2(c.x, c.y / SQ);
  float r = length(ce);
  float ang = uSwirl * (0.55 / (r + 0.25) + t * 0.16);
  vec2 cr = rot(ang) * ce;
  cr.y *= SQ;
  vec2 pp = mix(cr, c, uIdle * 0.85);
#if F_SHOCK
  float sd = length(c);
  pp *= 1.0 - uShock * 0.25 * exp(-pow((sd - uShockR) / 0.35, 2.0));
#endif
  // flames rise: vertically stretched domain scrolling downwards
  vec3 P = vec3(pp.x * 0.85, pp.y * 0.55 - t * mix(0.16, 0.12, uIdle), t * 0.045);
  vec2 q = vec2(fbm(P * 0.8), fbm(P * 0.8 + vec3(5.2, 1.3, 2.8)));
  vec3 Pw = P + vec3(q * 1.15, 0.0);
  float cloud = clamp(0.5 + 0.65 * fbm(Pw * 1.15 + vec3(0.0, 0.0, 0.07 * t)), 0.0, 1.0);
  float strands = ridged(Pw * 1.7 + vec3(0.0, -t * 0.22, t * 0.06));

  // envelopes: vortex ring around the emblem (intro) vs. flames at the bottom + edges (idle)
  float yb = p.y * uContent;                  // -1 = bottom edge of the window
  float envV = smoothstep(0.28, 0.85, r) * (1.0 - smoothstep(1.1, 2.6, r));
  float flame = smoothstep(uFlameY + 0.58, uFlameY - 0.58, yb + 0.55 * (cloud - 0.5));
  float edge = smoothstep(0.45, 1.4, length(p * uContent * vec2(0.58, 1.0)));
  float top = 1.0 - 0.45 * smoothstep(0.2, 1.0, yb);
  float env = mix(max(envV * 0.9, flame), edge * 0.7 + flame * 0.75, uIdle) * top;

  float soft = pow(cloud, 2.6) * 1.5;
  float fil = pow(strands, 3.2) * 2.6 * smoothstep(0.30, 0.70, cloud);
  float e = (soft + fil) * env;

#if F_HEAT
  // heat from the emblem / wordmark: flames licking up off the bird
  vec2 lc = (p - uAnchor.xy) / uAnchor.z;
  vec2 huv = (lc - uHeatBox.xy) / (uHeatBox.zw - uHeatBox.xy);
  vec2 hoff = vec2(q.x * 0.03, -0.026 - 0.05 * cloud);
  vec4 h1 = texture(uHeat, huv + hoff);
  vec4 h2 = texture(uHeat, huv + hoff * 2.4 + vec2(0.0, -0.025));
  vec4 hm = texture(uHeat, huv);
  e += uHeatAmt * (h1.r * (0.15 + 0.9 * soft) + h2.r * fil * 0.9);
  e += uWordHeat * (h1.b * (0.15 + 0.9 * soft) + h2.b * fil * 0.9);
  e += (uFill * hm.g + uWordHeat * 0.5 * hm.a) * (0.22 + 0.9 * soft + 1.1 * fil);
#endif

#if F_PULSE
  for (int i = 0; i < 4; i++) {
    float tau = t - uPulse[i].x;
    if (tau > 0.0 && tau < 2.6) {
      float d = length(p - uPulse[i].zw);
      e += uPulse[i].y * exp(-pow((d - tau * 1.4) / 0.16, 2.0)) * exp(-tau * 1.3) * (0.35 + soft + fil) * 0.9;
    }
  }
#endif

  float hue = clamp(uHue + q.y * 1.6, 0.0, 1.0);
#if F_REVEAL
  // ignition: noisy expanding front with a white-hot rim
  float rr = length(c * vec2(0.85, 1.2)) + 0.30 * (cloud - 0.5);
  float reveal = smoothstep(uReveal, uReveal - 0.45, rr);
  float rim = exp(-pow((rr - uReveal) / 0.035, 2.0)) * uRim * (0.3 + strands);
  e *= reveal;
#endif
  e *= uIntensity;
  // calm looks: soft knee on the highlights – single filaments must not flare up behind the UI
  e = mix(e, e / (1.0 + 0.22 * e), smoothstep(0.9, 1.0, uIdle));
  vec3 col = ramp(e, hue) * e;
#if F_REVEAL
  col += rim * vec3(0.55, 0.30, 1.5) * 1.5 * uIntensity;
#endif
#if F_CLIMAX
  col += uClimax * fil * env * vec3(1.1, 0.9, 1.6);
#endif
  // error look: drain the colour into a cool indigo grey (never red)
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, l * vec3(0.75, 0.72, 1.35), uDesat);
  fragColor = vec4(col, 1.0);
}`;
