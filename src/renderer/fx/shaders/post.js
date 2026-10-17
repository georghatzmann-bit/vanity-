// Post chain: bloom (PLASMA dual filter), god rays, anamorphic streak, composite.
// The composite enforces the calm / photosensitivity budgets (uFlashCap, scrims) and adds the
// CHROME accents (starburst flare, colour split without red or green).
import { HASH, PALETTE, WORLD } from './common.js';

export const COPY_FS = /* glsl */ `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
void main() { fragColor = vec4(texture(uSrc, vUv).rgb, 1.0); }`;

export const PREFILTER_FS = /* glsl */ `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold, uKnee;
vec3 bright(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  rq = rq * rq / (4.0 * uKnee + 1e-5);
  float w = max(rq, br - uThreshold) / max(br, 1e-5);
  return c * w;
}
void main() {
  vec2 o = uTexel;
  vec3 c = texture(uSrc, vUv).rgb * 4.0;
  c += texture(uSrc, vUv + vec2(-o.x, -o.y)).rgb;
  c += texture(uSrc, vUv + vec2( o.x, -o.y)).rgb;
  c += texture(uSrc, vUv + vec2(-o.x,  o.y)).rgb;
  c += texture(uSrc, vUv + vec2( o.x,  o.y)).rgb;
  c /= 8.0;
  fragColor = vec4(min(bright(c), vec3(40.0)), 1.0);
}`;

export const DOWN_FS = /* glsl */ `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;
void main() {
  vec2 o = uTexel;
  vec3 c = texture(uSrc, vUv).rgb * 4.0;
  c += texture(uSrc, vUv + vec2(-o.x, -o.y)).rgb;
  c += texture(uSrc, vUv + vec2( o.x, -o.y)).rgb;
  c += texture(uSrc, vUv + vec2(-o.x,  o.y)).rgb;
  c += texture(uSrc, vUv + vec2( o.x,  o.y)).rgb;
  fragColor = vec4(c / 8.0, 1.0);
}`;

export const UP_FS = /* glsl */ `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform sampler2D uAdd;
uniform vec2 uTexel;
uniform float uScatter;
void main() {
  vec2 o = uTexel;
  vec3 c = vec3(0.0);
  c += texture(uSrc, vUv + vec2(-2.0 * o.x, 0.0)).rgb;
  c += texture(uSrc, vUv + vec2( 2.0 * o.x, 0.0)).rgb;
  c += texture(uSrc, vUv + vec2(0.0, -2.0 * o.y)).rgb;
  c += texture(uSrc, vUv + vec2(0.0,  2.0 * o.y)).rgb;
  c += texture(uSrc, vUv + vec2(-o.x, -o.y)).rgb * 2.0;
  c += texture(uSrc, vUv + vec2( o.x, -o.y)).rgb * 2.0;
  c += texture(uSrc, vUv + vec2(-o.x,  o.y)).rgb * 2.0;
  c += texture(uSrc, vUv + vec2( o.x,  o.y)).rgb * 2.0;
  c /= 12.0;
  fragColor = vec4(texture(uAdd, vUv).rgb + c * uScatter, 1.0);
}`;

// radial light streaks (god rays) from the emblem; define N
export const RAYS_FS = /* glsl */ `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uC;
uniform float uLen, uAspect;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 delta = (vUv - uC) * uLen / float(N);
  vec2 tc = vUv - delta * hash(vUv * 917.0);
  vec3 acc = vec3(0.0);
  float w = 1.0, ws = 0.0;
  for (int i = 0; i < N; i++) {
    float m = 1.0 - smoothstep(0.10, 0.42, length((tc - uC) * vec2(uAspect, 1.0)));
    acc += texture(uSrc, tc).rgb * w * m;
    ws += w;
    w *= 0.955;
    tc -= delta;
  }
  fragColor = vec4(acc / ws, 1.0);
}`;

// anamorphic horizontal streak; define N
export const STREAK_FS = /* glsl */ `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThresh, uStep, uGain;
vec3 S(vec2 uv) { return max(texture(uSrc, uv).rgb - uThresh, 0.0); }
void main() {
  vec3 acc = S(vUv);
  float ws = 1.0;
  for (int i = 1; i <= N; i++) {
    float w = exp(-float(i) * 2.6 / float(N));
    vec2 o = vec2(float(i) * uTexel.x * uStep, 0.0);
    acc += (S(vUv + o) + S(vUv - o)) * w;
    ws += 2.0 * w;
  }
  fragColor = vec4(acc / ws * uGain, 1.0);
}`;

// defines: F_SHOCK, F_CA, F_RAYS, F_STREAK, F_SPARK, F_FLASH, F_PULSE, F_SCRIM, F_WARP (RB_TAPS)
export const COMPOSITE_FS = /* glsl */ `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uScene, uBloom, uRays, uStreak;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uAnchor;
uniform float uShockR, uShockW, uShockAmp, uShockGlow;
uniform float uCA, uFlash, uFlashCap, uExposure, uBloomAmt, uRaysAmt, uStreakAmt, uIdle, uSpark, uFlare;
uniform float uVig, uGrain, uDesat, uPunch, uPulseSoft;
uniform vec2 uShake;
uniform vec4 uPulse[4];
uniform vec4 uScrim[4];          // canvas px, bottom-left origin: x0, y0, x1, y1
uniform float uScrimAmt, uScrimFeather, uScrimRadius;
uniform float uWarpEnv, uWarpRB;
${WORLD}
${HASH}
${PALETTE}
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
float rbox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
  vec2 uv = vUv + uShake;
  uv = (uv - 0.5) * (1.0 - uPunch) + 0.5;
  vec2 w = toWorld(uv);
  vec2 d = w - uAnchor.xy;
  float dist = length(d);
  vec2 dir = d / (dist + 1e-5);
  vec2 offUv = vec2(0.0);
#if F_SHOCK
  // shockwave refraction: lens-shaped displacement around the ring
  float x = (dist - uShockR) / uShockW;
  float prof = exp(-x * x) * x;
  offUv = -dir * prof * uShockAmp * uContent / vec2(uAspect, 1.0) * 0.5;
#endif
  vec2 suv = uv + offUv;
  vec3 col, bl;
#if F_WARP
  // hyperspace: radial zoom blur towards the centre
  vec2 cen = vec2(0.5);
  col = vec3(0.0);
  for (int i = 0; i < RB_TAPS; i++) {
    float k = float(i) / float(RB_TAPS - 1);
    col += texture(uScene, cen + (suv - cen) * (1.0 - uWarpRB * k * k)).rgb;
  }
  col /= float(RB_TAPS);
  bl = texture(uBloom, suv).rgb;
#elif F_CA
  // on-brand aberration: fringes split into magenta (outer) and cyan-violet (inner), never red/green
  vec2 cd = suv - toUv(uAnchor.xy);
  vec2 ca = cd * uCA * (0.35 + 0.65 * dist * dist);
  vec3 sA = texture(uScene, suv - ca).rgb, sB = texture(uScene, suv).rgb, sC = texture(uScene, suv + ca).rgb;
  col = vec3(sA.r, mix(sB.g, sC.g, 0.5), 0.5 * sA.b + 0.5 * sC.b);
  vec3 bA = texture(uBloom, suv - ca * 1.6).rgb, bB = texture(uBloom, suv).rgb, bC = texture(uBloom, suv + ca * 1.6).rgb;
  bl = vec3(bA.r, mix(bB.g, bC.g, 0.5), 0.5 * bA.b + 0.5 * bC.b);
#else
  col = texture(uScene, suv).rgb;
  bl = texture(uBloom, suv).rgb;
#endif
  col += bl * uBloomAmt;
#if F_RAYS
  col += texture(uRays, suv).rgb * uRaysAmt;
#endif
#if F_STREAK
  col += texture(uStreak, suv).rgb * uStreakAmt * vec3(0.75, 0.62, 1.0);
#endif
#if F_SHOCK
  if (uShockGlow > 0.001) {
    float rg = exp(-x * x * 5.0) * uShockGlow;
    float rgO = exp(-pow((dist - uShockR * 1.012) / uShockW, 2.0) * 5.0) * uShockGlow;
    float rgI = exp(-pow((dist - uShockR * 0.988) / uShockW, 2.0) * 5.0) * uShockGlow;
    col += rgO * C_MAG * 0.9 + rg * C_LAV * 0.8 + rgI * C_CYAN * 0.35;
  }
#endif
#if F_PULSE
  for (int i = 0; i < 4; i++) {
    float tau = uTime - uPulse[i].x;
    if (tau > 0.0 && tau < 2.2) {
      float pd = length(w - uPulse[i].zw);
      float R1 = tau * 1.4, R2 = tau * 0.85;
      float th1 = 0.006 + tau * 0.02, th2 = 0.003 + tau * 0.008;
      vec3 rings = mix(C_LAV, C_HOT, 0.45) * exp(-pow((pd - R1) / th1, 2.0)) * exp(-tau * 2.2) * 1.6
                 + C_VIOLET * exp(-pow((pd - R2) / th2, 2.0)) * exp(-tau * 1.6) * 1.0;
      vec3 soft = C_VIOLET * exp(-pd / 0.35) * exp(-tau * 2.5) * 0.35;
      col += mix(rings, soft, uPulseSoft) * uPulse[i].y;
    }
  }
#endif
#if F_SPARK
  // ignition spark (point + anamorphic line) and CHROME starburst flare
  vec2 sd2 = (uv - toUv(uAnchor.xy)) * vec2(uAspect, 1.0);
  float fr = length(sd2);
  float core = exp(-fr * fr / 0.00015) * 3.0 + exp(-fr / 0.022) * 0.5;
  float line = exp(-abs(sd2.y) / 0.0018) * exp(-abs(sd2.x) / (0.08 + 0.6 * uSpark)) * 1.6;
  col += (core + line) * uSpark * vec3(0.85, 0.75, 1.25);
  float fa = atan(sd2.y, sd2.x);
  float spikes = pow(0.5 + 0.5 * sin(fa * 6.0), 24.0) + 0.6 * pow(0.5 + 0.5 * sin(fa * 13.0 + 1.3), 40.0)
               + 0.35 * pow(0.5 + 0.5 * sin(fa * 31.0 + 0.4), 60.0);
  col += uFlare * (spikes * exp(-fr * 6.5) * 0.8 + exp(-fr * 22.0) * 1.2) * vec3(0.78, 0.64, 1.0);
#endif
#if F_FLASH
  // capped flash: at most +uFlashCap exposure (budget 4.7)
  float fl = min(uFlash, uFlashCap);
  col *= 1.0 + fl;
  col += fl * vec3(1.0, 0.92, 1.15) * exp(-dist * 1.6) * 0.6;
#endif
  col *= uExposure;
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, l * vec3(0.75, 0.72, 1.35), uDesat);
  col = aces(col);
  // vignette + centre scrim (dark centre keeps UI text readable)
  vec2 vv = (vUv - 0.5) * vec2(uAspect / 1.6, 1.0);
  col *= 1.0 - uVig * smoothstep(0.35, 1.05, length(vv) * 1.25);
  float cs = smoothstep(0.15, 0.85, length((vUv - vec2(0.5, 0.52)) * vec2(1.25, 1.6)));
  col *= mix(1.0, 0.35 + 0.65 * cs, uIdle);
#if F_SCRIM
  float dark = 0.0;
  for (int i = 0; i < 4; i++) {
    vec4 R = uScrim[i];
    if (R.z > R.x) {
      float sdist = rbox(gl_FragCoord.xy - (R.xy + R.zw) * 0.5, (R.zw - R.xy) * 0.5, uScrimRadius);
      dark = max(dark, 1.0 - smoothstep(0.0, uScrimFeather, sdist));
    }
  }
  col *= 1.0 - 0.45 * dark * uScrimAmt;
#endif
#if F_WARP
  col = mix(col, col * smoothstep(1.2, 0.2, length(vv) * 1.4), uWarpEnv * 0.5);
#endif
  col = pow(col, vec3(1.0 / 2.2));
  vec3 base = vec3(0.0196, 0.0235, 0.0392);   // #05060A, never pure black
  col = base + col * (1.0 - base);
  float g = hash12(gl_FragCoord.xy + fract(uTime * 7.31) * 517.0) - 0.5;
  col += g * uGrain * (1.0 - 0.6 * col);
  col += (hash12(gl_FragCoord.yx * 1.37 + 11.0) - 0.5) / 255.0;
  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;
