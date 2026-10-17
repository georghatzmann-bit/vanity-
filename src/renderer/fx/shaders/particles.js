// GPU particles. Every position is an analytic function of the uniforms (no CPU integration):
//   group 0 = emblem particles (sampled along the strokes, order = pen order)
//   group 1 = wordmark particles (order = x, ignite left -> right)
//   group 2 = ambient embers
//   group 3 = pulse puffs (40 per pulse slot, position.x = slot)
// Targets are stored in emblem-local units: target = uAnchor.xy + local * uAnchor.z.
import { FLOW, HASH, PALETTE, WORLD } from './common.js';

export const POINTS_VS = /* glsl */ `
in vec3 position;   // xy local target, z group
in vec4 aSeed;
in vec4 aInfo;      // x order, y burn, z edge, w size
in vec3 aColor;
uniform float uTime, uPx;
uniform vec3 uAnchor;
uniform float uWordDY, uWordH;
uniform float uDiskGrow, uCloudA, uDiskA, uAsm, uAsmW, uAsmJ, uIndet, uFlashW;
uniform float uWordAsm, uWordA;
uniform float uClimaxT, uClimaxAmt, uInhale, uBurnT, uJitter, uDropT;
uniform float uEmberRate, uEmberDir, uEmberA;
uniform vec4 uPulse[4];
out vec3 vCol;
${WORLD}
${HASH}
${PALETTE}
${FLOW}

void main() {
  float t = uTime;
  vec4 s = aSeed;
  float group = position.z;
  vec2 pos = vec2(0.0);
  float alpha = 1.0;
  float size = aInfo.w;
  vec3 col = aColor;
  float yTop = 1.0 / uContent;
  float xEdge = uAspect / uContent;

  if (group > 2.5) {
    // ---------------- pulse puffs ----------------
    int slot = int(position.x + 0.5);
    vec4 P = uPulse[slot];
    float tau = t - P.x;
    if (tau <= 0.0 || tau > 1.6 || P.y <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vCol = vec3(0.0); gl_PointSize = 1.0; return; }
    float a = s.x * TAU;
    float sp = (0.25 + 0.9 * s.y * s.y) * uAnchor.z / 0.45;
    vec2 dir = vec2(cos(a), sin(a));
    pos = P.zw + dir * (0.12 * uAnchor.z / 0.45 + sp * (1.0 - exp(-2.6 * tau)) / 2.6) + vec2(0.0, 0.05 * tau * tau);
    pos += flow(pos * 2.0 + s.zw * 3.0, t) * 0.04 * tau;
    alpha = P.y * pow(1.0 - tau / 1.6, 2.0) * smoothstep(0.0, 0.04, tau);
    col = mix(C_HOT * 1.4, aColor, smoothstep(0.0, 0.5, tau));
  } else if (group > 1.5) {
    // ---------------- ambient embers rising (falling in the error state) ----------------
    float spd = mix(0.045, 0.21, s.y * s.y);
    float span = 2.0 * yTop + 0.7;
    float life = fract(s.x + t * spd / span);
    float xr = s.z * 2.0 - 1.0;
    xr = sign(xr) * pow(abs(xr), 0.7);
    float dir = uEmberDir >= 0.0 ? 1.0 : -1.0;
    vec2 pp = vec2(xr * xEdge * 1.02, dir * (-yTop - 0.35 + life * span));
    pp.x += sin(t * 0.45 * (0.6 + s.w) + s.x * 40.0) * 0.05;
    pp += flow(pp * 1.3 + s.zw * 3.0, t * 0.5) * 0.5;
    pos = pp;
    float density = clamp((uEmberRate * 0.8333 - s.w) * 10.0, 0.0, 1.0);
    alpha = sin(PI * life) * (0.35 + 0.9 * s.w) * uEmberA * density * abs(uEmberDir);
    alpha *= 0.6 + 0.4 * sin(t * (2.0 + 5.0 * s.y) + s.z * 30.0);
    // keep the window centre (where the UI lives) calmer
    alpha *= mix(0.45, 1.0, smoothstep(0.2, 0.75, abs(xr)));
    size *= 0.7 + 0.6 * s.y;
  } else {
    float isWord = group;
    float k = uAnchor.z / 0.45;
    // ---------------- vortex disk around the anchor ----------------
    float r0 = mix(0.80, 2.10, pow(s.y, 0.85));
    float arm = step(0.35, s.z);              // 65 % in three spiral arms, 35 % dust
    float a0 = arm > 0.5
      ? floor(s.x * 3.0) / 3.0 * TAU + (s.w - 0.5) * 0.55 + log(r0) * 2.4
      : s.x * TAU;
    float grow = uDiskGrow;
    float rr = r0 * (0.08 + 0.92 * grow);
    float omega = 1.1 / (0.25 + r0);
    float ang = a0 + omega * t + 2.4 * (1.0 - grow) / (0.2 + r0);
    vec3 dp = vec3(cos(ang) * rr, ((s.z - 0.5) * 0.12 + (s.w - 0.5) * 0.05) * rr, sin(ang) * rr);
    const float EL = 0.46;
    float cy = cos(EL), sy = sin(EL);
    vec3 wv = vec3(dp.x, dp.y * cy + dp.z * sy, dp.z * cy - dp.y * sy);
    float persp = 3.4 / (3.4 + wv.z);
    vec2 disk = uAnchor.xy + wv.xy * persp * k;
    disk += flow(disk * 1.1, t * 0.6) * 0.08 * k;

    // ---------------- flight to target (assembly cursor) ----------------
    float order = aInfo.x;
    float asmv = mix(uAsm, uWordAsm, isWord);
    float W = mix(uAsmW, 0.22, isWord);
    float J = mix(uAsmJ, 0.1, isWord);
    float pr = clamp((asmv - order - s.w * J) / W, 0.0, 1.0) * (1.0 - uIndet);
    float e = pr * pr * (1.6 - 0.6 * pr);
    vec2 target = isWord > 0.5
      ? uAnchor.xy + vec2(0.0, uWordDY * uAnchor.z) + position.xy * uWordH * uAnchor.z
      : uAnchor.xy + position.xy * uAnchor.z;
    vec2 delta = target - disk;
    vec2 nrm = vec2(-delta.y, delta.x);
    float bump = sin(PI * e);
    pos = mix(disk, target, e) - nrm * (0.22 + 0.32 * s.x) * bump;
    pos += flow(pos * 1.4 + vec2(0.0, s.w * 0.6), t * 0.9) * bump * 0.35 * k;
    float landed = step(1.0, pr);
    float landFlash = landed * exp(-max(asmv - order - s.w * J - W, 0.0) / max(uFlashW, 1e-4));
    pos += vec2(sin(t * 3.1 + s.x * 60.0), cos(t * 2.7 + s.y * 50.0)) * 0.0016 * e * k;
    // waiting particles: bigger and dimmer (calm disk), landed: full
    size *= mix(persp * 0.8 * 1.3, 1.0, e);
    float diskA = uDiskA * (arm > 0.5 ? 1.0 : 0.55);
    alpha = clamp((uCloudA * 1.6 - s.w * 0.6), 0.0, 1.0) * mix(diskA, 1.0, e);
    alpha *= mix(1.0, uWordA, isWord);

    // ---------------- climax ----------------
    vec2 rel = pos - uAnchor.xy;
    float tc = uClimaxT;
    pos -= rel * uInhale * 0.07;
    float flare = smoothstep(-0.06, 0.04, tc) * exp(-max(tc, 0.0) * 2.4) * uClimaxAmt;
    pos += rel * flare * mix(0.08 + 0.22 * abs(rel.x) / k, 0.04, isWord);
    float d = length(rel);
    float R = max(tc, 0.0) * 1.7 * k;
    float ring = exp(-pow((d - R) / (0.09 * k), 2.0)) * step(0.0, tc) * exp(-max(tc, 0.0) * 1.5) * uClimaxAmt;
    pos += (rel / (d + 1e-4)) * ring * 0.05 * k;

    // ---------------- pulses push the cloud ----------------
    float pring = 0.0;
    for (int i = 0; i < 4; i++) {
      float tau = t - uPulse[i].x;
      if (tau > 0.0 && tau < 2.0) {
        vec2 pr2 = pos - uPulse[i].zw;
        float pd = length(pr2);
        float g = exp(-pow((pd - tau * 1.4) / 0.08, 2.0)) * exp(-tau * 1.8) * uPulse[i].y;
        pos += pr2 / (pd + 1e-4) * g * 0.035;
        pring += g;
      }
    }

    // ---------------- error: jitter + 8 % drift down ----------------
    pos += (vec2(hash12(s.xy * 91.0 + floor(t * 24.0)), hash12(s.zw * 73.0 + floor(t * 24.0))) - 0.5) * uJitter * k;
    float drop = step(0.92, s.y) * max(uDropT, 0.0);
    pos.y -= drop * (0.05 + 0.12 * s.x) * drop;
    alpha *= 1.0 - smoothstep(1.5, 4.0, drop);

    // ---------------- burn away into embers ----------------
    float rt = max(uBurnT - aInfo.y * 1.05 - isWord * 0.3, 0.0);
    vec2 outw = normalize(target - uAnchor.xy + vec2(0.0, 0.05) + 1e-4);
    pos += (outw * (0.10 + 0.16 * s.z) * rt + vec2((s.z - 0.5) * 0.10 * rt, 0.04 * rt + 0.15 * rt * rt)) * k;
    pos += flow(pos * 2.2 + s.wx * 3.0, t) * min(rt * 1.5, 1.0) * 0.55 * k;
    float burnFlash = step(0.0, uBurnT - aInfo.y * 1.05 - isWord * 0.3) * exp(-rt * 7.0) * step(-50.0, uBurnT);
    alpha *= 1.0 - smoothstep(0.15, 1.55, rt);
    size *= 1.0 - 0.45 * smoothstep(0.0, 1.5, rt);

    // ---------------- colour ----------------
    vec3 diskCol = mix(vec3(0.30, 0.13, 1.0), vec3(0.80, 0.16, 0.92), s.z) * (0.45 + 0.75 * s.w * s.w) * (arm > 0.5 ? 1.0 : 0.45);
    col = mix(diskCol, aColor, smoothstep(0.55, 1.0, e));
    col *= 1.0 + bump * 0.7;
    vec3 hotW = vec3(1.25, 1.1, 1.6);
    col += hotW * (landFlash * 1.0 + flare * 0.15 * (0.3 + aInfo.z) + ring * 0.6 + burnFlash * 0.9 + pring * 0.8);
    float cool = smoothstep(0.0, 1.0, rt);
    col = mix(col, vec3(0.55, 0.16, 0.95) * 0.9, cool * 0.75);
  }

  vec2 clip = pos * uContent / vec2(uAspect, 1.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  float px = size * uPx;
  float fade = clamp(px / 1.3, 0.0, 1.0);    // sub-pixel points fade instead of flickering
  gl_PointSize = max(px, 1.3);
  vCol = col * max(alpha, 0.0) * fade * fade;
}`;

export const POINTS_FS = /* glsl */ `
in vec3 vCol;
out vec4 fragColor;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float a = 1.0 - r2;
  fragColor = vec4(vCol * a * a, 1.0);
}`;

// Spark streaks: instanced quads stretched between position(tau) and position(tau - trail).
// kind 0 = ignition sparks (time base uIgniteT), 1 = climax / burst sparks (uBurstT),
// 2 = pen sparks thrown off the neon pen head (emitted when the line reveal passes their rev).
export const SPARK_VS = /* glsl */ `
in vec3 position;   // x along (0 tail .. 1 head), y side (-1..1)
in vec4 iSeed;
in vec4 iInfo;      // x t0 offset (kind 2: rev), y angle, z speed, w width
in vec3 iOrigin;    // xy emblem-local origin, z kind
uniform float uTime, uIgniteT, uBurstT, uSparkFrac, uSparkGain, uIntroT, uPenT0, uPenK, uPenGain;
uniform vec3 uAnchor;
uniform vec2 uRes;
out float vAlong;
out float vSide;
out vec3 vCol;
${WORLD}
${FLOW}
vec2 path(float x, vec2 dir, float v0) {
  const float K = 2.4;
  return dir * v0 / K * (1.0 - exp(-K * x)) + vec2(0.0, 0.09 * x * x);
}
void hide() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vCol = vec3(0.0); vAlong = 0.0; vSide = 0.0; }
void main() {
  float kind = iOrigin.z;
  float tau;
  float gain = 1.0;
  if (kind > 1.5) {
    // pen sparks: emission time from the pen's reveal schedule
    tau = uIntroT - (uPenT0 + iInfo.x * uPenK);
    gain = uPenGain;
  } else if (kind > 0.5) {
    tau = uBurstT - iInfo.x;
    if (iSeed.y > uSparkFrac) { hide(); return; }
    gain = uSparkGain;
  } else {
    tau = uIgniteT - iInfo.x;
  }
  float life = kind > 1.5 ? 0.9 : 3.5;
  if (tau <= 0.0 || tau > life || gain <= 0.0) { hide(); return; }
  float k = uAnchor.z / 0.45;
  vec2 origin = uAnchor.xy + iOrigin.xy * uAnchor.z;
  vec2 dir = vec2(cos(iInfo.y), sin(iInfo.y));
  float v0 = iInfo.z * k;
  float trail = kind > 1.5 ? 0.03 : 0.045 + 0.06 * iSeed.x;
  vec2 head = origin + path(tau, dir, v0);
  vec2 tail = origin + path(max(tau - trail, 0.0), dir, v0);
  vec2 wob = flow(head * 1.6 + iSeed.zw * 4.0, uTime) * 0.12 * min(tau, 1.0) * k;
  head += wob; tail += wob * 0.8;
  vec2 hs = head * uContent / vec2(uAspect, 1.0) * uRes * 0.5;
  vec2 ts = tail * uContent / vec2(uAspect, 1.0) * uRes * 0.5;
  vec2 dd = hs - ts;
  float L = length(dd);
  vec2 dn = L > 1e-3 ? dd / L : vec2(1.0, 0.0);
  vec2 nn = vec2(-dn.y, dn.x);
  float w = iInfo.w * uRes.y / 800.0;
  vec2 ps = mix(ts, hs, position.x) + nn * position.y * w + dn * (position.x * 2.0 - 1.0) * w;
  gl_Position = vec4(ps / (uRes * 0.5), 0.0, 1.0);
  vAlong = position.x;
  vSide = position.y;
  float fade = kind > 1.5
    ? pow(1.0 - tau / life, 1.6)
    : exp(-tau * (1.2 + 1.2 * iSeed.y)) * smoothstep(0.0, 0.02, tau);
  vec3 hot = vec3(1.4, 1.25, 1.8);
  vec3 cool = iSeed.w > 0.97 ? vec3(0.15, 0.85, 1.0) : mix(vec3(0.35, 0.14, 1.0), vec3(0.85, 0.15, 0.95), iSeed.z);
  vCol = mix(hot, cool, smoothstep(0.0, kind > 1.5 ? 0.25 : 0.5, tau)) * fade * 2.2 * gain;
}`;

export const SPARK_FS = /* glsl */ `
in float vAlong;
in float vSide;
in vec3 vCol;
out vec4 fragColor;
void main() {
  float a = pow(clamp(vAlong, 0.0, 1.0), 1.6) * (1.0 - vSide * vSide);
  fragColor = vec4(vCol * a, 1.0);
}`;
