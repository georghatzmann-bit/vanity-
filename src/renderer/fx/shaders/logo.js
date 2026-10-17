// Neon emblem line layer (WARP emblemLayer) and SDF wordmark (WARP wordLayer + CHROME light sweep),
// each drawn on a bounding quad into the HDR scene with premultiplied "occlusion" blending:
//   dst = dst * (1 - a) + rgb      (a = occlusion: the plasma darkens behind the crisp lines)
import { HASH, PALETTE, WORLD } from './common.js';

export const LOGO_VS = /* glsl */ `
in vec3 position;
uniform vec3 uXf;          // world centre + scale (world units per local unit)
uniform vec2 uExt;         // half extent of the quad in local units
out vec2 vLocal;
${WORLD}
void main() {
  vLocal = position.xy * uExt;
  vec2 w = uXf.xy + vLocal * uXf.z;
  gl_Position = vec4(w * uContent / vec2(uAspect, 1.0), 0.0, 1.0);
}`;

// CHROME vEdge (cheap F2-F1 Voronoi border distance) for the error cracks
const VEDGE = /* glsl */ `
float vEdge(vec2 x) {
  vec2 n = floor(x), f = fract(x);
  float d1 = 8.0, d2 = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 r = g + hash22(n + g) - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return (sqrt(d2) - sqrt(d1)) * 0.5;
}`;

// defines: EMB_EXT, EMB_R, F_CRACK, F_PEN
export const EMBLEM_FS = /* glsl */ `
in vec2 vLocal;
out vec4 fragColor;
uniform float uTime, uPxW;     // world units per device pixel
uniform vec3 uXf;
uniform sampler2D uEmblem;     // r: distance to stroke (local units), g: pen order, b: width factor
uniform sampler2D uHeat;       // g: emblem mask (for the cracks)
uniform vec4 uHeatBox;
uniform float uLineReveal, uLineAlpha, uLineEnergy, uPenHead, uPacket, uGlowAmt, uOccl, uCrack, uHalo;
${WORLD}
${HASH}
${PALETTE}
${VEDGE}
void main() {
  vec2 q = vLocal;
  vec4 e = texture(uEmblem, q / (2.0 * EMB_EXT) + 0.5);
  float px = uPxW / uXf.z;                 // local units per pixel
  float de = e.r, rt = e.g, wf = e.b;
  float P = uLineReveal;
  float rev = ss(rt - 0.002, rt + 0.004, P);
  float hw = max(0.018 * wf, 0.55 * px);
  float core = 1.0 - ss(hw - 0.5 * px, hw + 0.8 * px, de);
  float fall = 1.0 - sat(de / EMB_R);
  float done = ss(0.985, 1.0, P);
  float g1 = exp(-de / max(mix(0.016, 0.026, done), 2.0 * px)) * fall;
  float g2 = fall * fall * fall * done;
  float pulse = 0.85 + 0.15 * sin(rt * 34.0 - uTime * 5.0);
  float packet = pow(0.5 + 0.5 * sin(rt * TAU - uTime * 1.3), 30.0) * uPacket;
  float energy = (1.0 + 2.2 * uLineEnergy) * pulse + packet * 1.6;
  // a faint line (home ghost, early install progress) reads as violet neon, not as grey chalk: the
  // core only turns white-hot as the line gains strength (intro, finished bird, success)
  vec3 coreCol = mix(mix(C_LAV, C_PALE, 0.5) * 1.25, C_HOT * 1.15, ss(0.3, 0.8, uLineAlpha + uLineEnergy));
  vec3 c = coreCol * core + mix(C_VIOLET, C_LAV, 0.35) * g1 * 1.1 * uGlowAmt + C_VIOLET * g2 * 0.32 * uGlowAmt;
  c *= rev * energy * uLineAlpha;
#if F_PEN
  float hp = exp(-pow((P - rt) * 230.0, 2.0)) * step(rt, P + 0.0015) * (1.0 - step(0.9999, P));
  c += (C_HOT * exp(-de / 0.014) * 5.0 + C_LAV * exp(-de / 0.04) * 0.8) * hp * fall * uPenHead;
#endif
  // halo: during the climax a dark band around the lines keeps the bird readable inside the glare
  float halo = (1.0 - ss(hw + 1.0 * px, hw + 0.05, de)) * (1.0 - core);
  float occl = max(core * 0.92, halo * 0.8 * uHalo) * rev * uLineAlpha * uOccl;
#if F_CRACK
  vec2 huv = (q - uHeatBox.xy) / (uHeatBox.zw - uHeatBox.xy);
  float mask = texture(uHeat, huv).g;
  float ve = vEdge(q * 4.2 + vec2(3.7, 1.3));
  float crack = 1.0 - ss(0.0, 0.018 + px * 1.4, ve);
  float grow = ss(length(q * vec2(1.0, 0.8)) - 0.1, length(q * vec2(1.0, 0.8)), uCrack * 1.5);
  float glowC = exp(-ve / 0.05) * 0.25;
  c += C_MAG * (crack * 1.3 + glowC) * sat(mask * 1.4) * grow * uCrack;
#endif
  float edgeFade = ss(EMB_EXT, EMB_EXT - 0.06, max(abs(q.x), abs(q.y)));
  fragColor = vec4(max(c, 0.0) * edgeFade, occl * 0.85 * edgeFade);
}`;

// defines: TEXT_ASPECT, TEXT_SPREAD (texels), TEXT_H (texels)
export const WORD_FS = /* glsl */ `
in vec2 vLocal;                 // word-height units, x in [-aspect/2, aspect/2]
out vec4 fragColor;
uniform float uTime, uPxW;
uniform vec3 uXf;
uniform sampler2D uText;
uniform float uWordA, uWordWipe, uSweep, uWordIgnite, uWordGlow;
${WORLD}
${HASH}
${PALETTE}
float textSD(vec2 q) {
  vec2 uv = vec2(q.x / TEXT_ASPECT + 0.5, 0.5 - q.y);
  if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) return 0.5;
  float v = texture(uText, uv).r;
  return (0.5 - v) * 2.0 * TEXT_SPREAD / TEXT_H;   // + outside, in word-height units
}
void main() {
  vec2 q = vLocal;
  float px = uPxW / uXf.z;
  float d = textSD(q);
  float cov = 1.0 - ss(-0.7 * px, 0.7 * px, d);
  float dd = max(d, 0.0);
  float dmax = TEXT_SPREAD / TEXT_H;                 // the SDF saturates here: fade the glow out before
  float glow = (exp(-dd / 0.045) * 0.55 + exp(-dd / 0.11) * 0.1) * smoothstep(dmax * 0.98, dmax * 0.55, dd);
  float wx = q.x / TEXT_ASPECT + 0.5;               // 0..1 left -> right
  // ignition wipe (left -> right) with a hot front
  float vis = ss(wx - 0.05, wx + 0.005, uWordWipe);
  float front = exp(-pow((wx - uWordWipe) * 22.0, 2.0)) * step(uWordWipe, 1.02);
  float gy = sat(q.y * 1.6 + 0.5);
  vec3 fill = mix(C_LAV * 1.1, vec3(1.0, 0.95, 1.0) * 1.55, gy);
  // CHROME light sweep: slanted bright band travelling left -> right
  float sw = mix(-0.25, 1.25, uSweep);
  float band = exp(-pow((wx + q.y * 0.12 - sw) * 9.0, 2.0)) * step(0.001, uSweep) * (1.0 - step(0.999, uSweep));
  // thin-film edge shimmer (cyan / violet / magenta only)
  float rim = exp(-abs(d) / max(0.012, 1.5 * px)) * (1.0 - cov * 0.6) * smoothstep(dmax * 0.9, dmax * 0.5, dd);
  vec3 iri = iriHue(wx * 1.3 - q.y * 0.4 + uTime * 0.12);
  vec3 c = fill * cov * (1.0 + band * 2.2 + uWordIgnite * 1.4)
         + mix(C_VIOLET, C_LAV, 0.3) * glow * uWordGlow * (0.6 + 1.6 * uWordIgnite)
         + iri * rim * (0.35 + 1.2 * band) * 0.8
         + C_HOT * front * (cov * 2.0 + glow * 1.5) * 1.2;
  c *= vis * uWordA;
  fragColor = vec4(max(c, 0.0), cov * vis * uWordA * 0.85);
}`;
