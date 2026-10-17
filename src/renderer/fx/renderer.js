// WebGL2 renderer (three.js 0.186.1): render targets, per-phase shader variants and the pass order
//   plasma (low res) -> scene: plasma + tunnel + particles + sparks + neon emblem + SDF wordmark (HDR)
//   -> bloom pyramid -> god rays -> anamorphic streak -> composite (caps, scrims, tone curve) -> canvas
// Built from PLASMA's PhoenixFX (passes, RTs, height cap) and WARP's engine discipline (variant cache,
// pre-compile, 8-bit fallback). Only uniforms change per frame – no per-frame allocations.
import * as THREE from 'three';
import { FULLSCREEN_VS, header } from './shaders/common.js';
import { PLASMA_FS } from './shaders/plasma.js';
import { POINTS_VS, POINTS_FS, SPARK_VS, SPARK_FS } from './shaders/particles.js';
import { LOGO_VS, EMBLEM_FS, WORD_FS } from './shaders/logo.js';
import { COPY_FS, PREFILTER_FS, DOWN_FS, UP_FS, RAYS_FS, STREAK_FS, COMPOSITE_FS } from './shaders/post.js';
import { TUNNEL_FS } from './shaders/tunnel.js';
import { P } from './state.js';
import * as BK from './bake.js';
import { HEAT_BOX, WORD_DY, WORD_H } from './emblem/raster.js';

const ADD = {
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  blendEquation: THREE.AddEquation,
  transparent: true,
};
// dst = dst * (1 - a) + rgb (premultiplied "occlusion" for the crisp neon lines)
const OCCL = {
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendEquation: THREE.AddEquation,
  blendSrcAlpha: THREE.ZeroFactor,
  blendDstAlpha: THREE.OneFactor,
  transparent: true,
};

const PL = { REVEAL: 1, HEAT: 2, SHOCK: 4, PULSE: 8, CLIMAX: 16 };
const CO = { SHOCK: 1, CA: 2, RAYS: 4, STREAK: 8, SPARK: 16, FLASH: 32, PULSE: 64, SCRIM: 128, WARP: 256 };
const EM = { CRACK: 1, PEN: 2 };

function tri() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return g;
}
function unitQuad() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  return g;
}
const scene1 = (obj) => {
  const s = new THREE.Scene();
  s.add(obj);
  obj.frustumCulled = false;
  return s;
};

export class FxRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} tier  TIERS entry
   * @param {object} o     { context (WebGL2RenderingContext), onError(msg) }
   */
  constructor(canvas, tier, { context = null, onError = null } = {}) {
    this.canvas = canvas;
    this.tier = tier;
    this.onError = onError;
    this.failed = null;
    this.scaleMul = 1;
    this.plasmaKey = new Float32Array(24);
    this.plasmaValid = false;
    const r = new THREE.WebGLRenderer({
      canvas,
      context: context || undefined,
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    r.autoClear = false;
    r.setPixelRatio(1);
    r.debug.onShaderError = (gl, program, vs, fs) => {
      const log = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)].filter(Boolean).join('\n').trim();
      this.failed = log || 'shader compile/link failed';
      if (this.onError) this.onError(`PHOENIX FX shader error:\n${this.failed.slice(0, 1500)}`);
    };
    this.r = r;
    this.gl = r.getContext();
    const gl = this.gl;
    this.hdr = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    this.rtType = this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.cam = new THREE.Camera();
    this.quad = new THREE.Mesh(tri());
    this.quadScene = scene1(this.quad);
    this.rts = [];
    this._textures();
    this._uniforms();
    this._materials();
    this._particles();
    this._logo();
    this.size = { cssW: 0, cssH: 0, dpr: 1, W: 0, H: 0 };
  }

  // ---------------------------------------------------------------------------------------------
  _textures() {
    const t = this.tier;
    const bakeData = BK.emblemBakeTexData(t.bake, THREE.DataUtils.toHalfFloat, true);
    const emb = new THREE.DataTexture(bakeData, t.bake, t.bake, THREE.RGBAFormat, THREE.HalfFloatType);
    const heat = BK.heat(t.heat);
    const heatTex = new THREE.DataTexture(heat.data, heat.w, heat.h, THREE.RGBAFormat, THREE.UnsignedByteType);
    const wm = BK.wordmark();
    const text = new THREE.DataTexture(wm.data, wm.W, wm.H, THREE.RedFormat, THREE.UnsignedByteType);
    text.unpackAlignment = 1;
    for (const tex of [emb, heatTex, text]) {
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
    }
    this.tex = { emb, heat: heatTex, text };
    this.wm = wm;
  }

  _uniforms() {
    const v = (x) => ({ value: x });
    // One shared uniform dictionary: every pass is a separate render() call, so values that differ
    // per pass (uTime for the quantised plasma, uXf for the two logo quads, uSrc for bloom levels)
    // are simply set right before that pass.
    this.U = {
      uTime: v(0), uAspect: v(1), uContent: v(1), uRes: v(new THREE.Vector2(1, 1)),
      uAnchor: v(new THREE.Vector3(0, 0, 0.45)), uHeatBox: v(new THREE.Vector4(HEAT_BOX.x0, HEAT_BOX.y0, HEAT_BOX.x1, HEAT_BOX.y1)),
      uHeat: v(this.tex.heat), uEmblem: v(this.tex.emb), uText: v(this.tex.text),
      uPulse: v(new Float32Array(16)),
      // plasma
      uReveal: v(0), uRim: v(0), uSwirl: v(1), uIntensity: v(1), uIdle: v(0), uHeatAmt: v(0), uWordHeat: v(0),
      uShock: v(0), uShockR: v(0), uClimax: v(0), uFill: v(0), uFlameY: v(-0.52), uHue: v(0.5), uDesat: v(0),
      // particles
      uPx: v(1), uWordDY: v(WORD_DY), uWordH: v(WORD_H), uDiskGrow: v(1), uCloudA: v(0), uDiskA: v(0.3), uAsm: v(0),
      uAsmW: v(0.3), uAsmJ: v(0.1), uIndet: v(0), uFlashW: v(0.05), uWordAsm: v(0), uWordA: v(0), uClimaxT: v(-100),
      uClimaxAmt: v(0), uInhale: v(0), uBurnT: v(-100), uJitter: v(0), uDropT: v(-100), uEmberRate: v(1), uEmberDir: v(1), uEmberA: v(0),
      // sparks
      uIgniteT: v(-100), uBurstT: v(-100), uSparkFrac: v(1), uSparkGain: v(0), uIntroT: v(-100), uPenT0: v(0), uPenK: v(1), uPenGain: v(0),
      // logo
      uXf: v(new THREE.Vector3(0, 0, 0.45)), uExt: v(new THREE.Vector2(1, 1)), uPxW: v(0.002),
      uLineReveal: v(0), uLineAlpha: v(0), uLineEnergy: v(0), uPenHead: v(0), uPacket: v(0), uGlowAmt: v(1), uOccl: v(1), uCrack: v(0),
      uWordA: v(0), uWordWipe: v(0), uSweep: v(0), uWordIgnite: v(0), uWordGlow: v(1),
      // tunnel
      uWarpU: v(0), uWarpEnv: v(0),
      // post
      uSrc: v(null), uAdd: v(null), uTexel: v(new THREE.Vector2()), uThreshold: v(this.hdr ? 0.55 : 0.5), uKnee: v(0.35),
      uScatter: v(0.85), uC: v(new THREE.Vector2(0.5, 0.5)), uLen: v(0.6), uThresh: v(1), uStep: v(1), uGain: v(1),
      uScene: v(null), uBloom: v(null), uRays: v(null), uStreak: v(null),
      uShockW: v(0.1), uShockAmp: v(0), uShockGlow: v(0), uCA: v(0), uFlash: v(0), uFlashCap: v(0.6), uExposure: v(1),
      uBloomAmt: v(1), uRaysAmt: v(0), uStreakAmt: v(0), uSpark: v(0), uFlare: v(0), uVig: v(0.55), uGrain: v(0.04),
      uPunch: v(0), uPulseSoft: v(0), uShake: v(new THREE.Vector2()), uScrim: v(new Float32Array(16)), uScrimAmt: v(0),
      uScrimFeather: v(40), uScrimRadius: v(14), uWarpRB: v(0),
    };
  }

  _raw(vs, fs, defs = {}, extra = {}) {
    const head = header(defs);
    return new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: head + vs,
      fragmentShader: head + fs,
      uniforms: this.U,
      depthTest: false,
      depthWrite: false,
      ...extra,
    });
  }

  _materials() {
    const t = this.tier;
    this.mats = [];
    const keep = (m) => (this.mats.push(m), m);
    this.mCopy = keep(this._raw(FULLSCREEN_VS, COPY_FS));
    this.mPre = keep(this._raw(FULLSCREEN_VS, PREFILTER_FS));
    this.mDown = keep(this._raw(FULLSCREEN_VS, DOWN_FS));
    this.mUp = keep(this._raw(FULLSCREEN_VS, UP_FS));
    this.mRays = t.rays ? keep(this._raw(FULLSCREEN_VS, RAYS_FS, { N: t.rays })) : null;
    this.mStreak = t.streak ? keep(this._raw(FULLSCREEN_VS, STREAK_FS, { N: t.streak })) : null;
    this.mTunnel = keep(this._raw(FULLSCREEN_VS, TUNNEL_FS, { NLAYERS: t.tunnel }, ADD));
    this.vPlasma = new Map();
    this.vComp = new Map();
    this.vEmb = new Map();
  }

  plasmaMat(key) {
    let m = this.vPlasma.get(key);
    if (!m) {
      m = this._raw(FULLSCREEN_VS, PLASMA_FS, {
        OCT: this.tier.oct,
        F_REVEAL: !!(key & PL.REVEAL), F_HEAT: !!(key & PL.HEAT), F_SHOCK: !!(key & PL.SHOCK), F_PULSE: !!(key & PL.PULSE), F_CLIMAX: !!(key & PL.CLIMAX),
      });
      this.vPlasma.set(key, m);
    }
    return m;
  }

  compMat(key) {
    let m = this.vComp.get(key);
    if (!m) {
      m = this._raw(FULLSCREEN_VS, COMPOSITE_FS, {
        F_SHOCK: !!(key & CO.SHOCK), F_CA: !!(key & CO.CA), F_RAYS: !!(key & CO.RAYS), F_STREAK: !!(key & CO.STREAK),
        F_SPARK: !!(key & CO.SPARK), F_FLASH: !!(key & CO.FLASH), F_PULSE: !!(key & CO.PULSE), F_SCRIM: !!(key & CO.SCRIM),
        F_WARP: !!(key & CO.WARP), RB_TAPS: this.tier.rbTaps,
      });
      this.vComp.set(key, m);
    }
    return m;
  }

  embMat(key) {
    let m = this.vEmb.get(key);
    if (!m) {
      m = this._raw(LOGO_VS, EMBLEM_FS, { EMB_EXT: BK.EMB_EXT, EMB_R: BK.EMB_R, F_CRACK: !!(key & EM.CRACK), F_PEN: !!(key & EM.PEN) }, OCCL);
      this.vEmb.set(key, m);
    }
    return m;
  }

  _particles() {
    const t = this.tier;
    const p = BK.particles(t);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p.position, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(p.seed, 4));
    g.setAttribute('aInfo', new THREE.BufferAttribute(p.info, 4));
    g.setAttribute('aColor', new THREE.BufferAttribute(p.color, 3));
    this.mPoints = this._raw(POINTS_VS, POINTS_FS, {}, ADD);
    this.mats.push(this.mPoints);
    this.points = new THREE.Points(g, this.mPoints);
    this.pointsScene = scene1(this.points);
    this.pCount = p.count;
    this.emberStart = p.emberStart;

    const s = BK.sparks(t);
    const sg = new THREE.InstancedBufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0]), 3));
    sg.setIndex([0, 1, 2, 2, 1, 3]);
    sg.setAttribute('iSeed', new THREE.InstancedBufferAttribute(s.iSeed, 4));
    sg.setAttribute('iInfo', new THREE.InstancedBufferAttribute(s.iInfo, 4));
    sg.setAttribute('iOrigin', new THREE.InstancedBufferAttribute(s.iOrigin, 3));
    sg.instanceCount = s.count;
    this.mSparks = this._raw(SPARK_VS, SPARK_FS, {}, ADD);
    this.mats.push(this.mSparks);
    this.sparks = new THREE.Mesh(sg, this.mSparks);
    this.sparksScene = scene1(this.sparks);
    this.geoms = [g, sg];
  }

  _logo() {
    const wm = this.wm;
    this.mWord = this._raw(LOGO_VS, WORD_FS, { TEXT_ASPECT: wm.aspect, TEXT_SPREAD: wm.SPREAD, TEXT_H: wm.H }, OCCL);
    this.mats.push(this.mWord);
    const q = unitQuad();
    this.embMesh = new THREE.Mesh(q, this.embMat(0));
    this.embScene = scene1(this.embMesh);
    this.wordMesh = new THREE.Mesh(q, this.mWord);
    this.wordScene = scene1(this.wordMesh);
    this.geoms.push(q, this.quad.geometry);
  }

  _rt(w, h) {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), {
      type: this.rtType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    this.rts.push(rt);
    return rt;
  }

  /** cssW/cssH: canvas CSS size, dpr: devicePixelRatio. Recreates render targets when the size changes. */
  resize(cssW, cssH, dpr, scaleMul = this.scaleMul) {
    const t = this.tier;
    const d = Math.min(dpr || 1, t.dprMax) * t.scale * scaleMul;
    let bw = cssW * d;
    let bh = cssH * d;
    const cap = Math.min(1, t.hCap / Math.max(1, bh));
    bw = Math.max(2, Math.round(bw * cap));
    bh = Math.max(2, Math.round(bh * cap));
    const S = this.size;
    if (S.W === bw && S.H === bh && S.cssW === cssW && S.cssH === cssH) return false;
    this.scaleMul = scaleMul;
    S.cssW = cssW;
    S.cssH = cssH;
    S.dpr = dpr;
    S.W = bw;
    S.H = bh;
    this.r.setSize(bw, bh, false);
    for (const rt of this.rts) rt.dispose();
    this.rts.length = 0;
    const aspect = bw / bh;
    const ph = Math.max(8, Math.min(cssH * (dpr || 1), 1100) * t.plasma * scaleMul);
    this.rtPlasma = this._rt(ph * aspect, ph);
    this.rtScene = this._rt(bw, bh);
    this.down = [];
    this.up = [];
    let w = bw / 2;
    let h = bh / 2;
    for (let i = 0; i < t.bloom; i++) {
      this.down.push(this._rt(w, h));
      this.up.push(this._rt(w, h));
      w /= 2;
      h /= 2;
    }
    this.rtRays = t.rays ? this._rt(bw / 4, bh / 4) : null;
    this.rtStreak = t.streak ? this._rt(bw / 8, bh / 8) : null;
    this.rtStreakA = t.streak ? this._rt(bw / 8, bh / 8) : null;
    this.plasmaValid = false;
    return true;
  }

  _pass(mat, target) {
    this.quad.material = mat;
    this.r.setRenderTarget(target);
    this.r.render(this.quadScene, this.cam);
  }

  // ---------------------------------------------------------------------------------------------
  plasmaKeyFor(F) {
    const p = F.p;
    let k = 0;
    if (p[P.reveal] < 3.25 || p[P.rim] > 0.001) k |= PL.REVEAL;
    if (p[P.heatAmt] > 0.002 || p[P.wordHeat] > 0.002 || p[P.fill] > 0.002) k |= PL.HEAT;
    if (F.shock > 0.002) k |= PL.SHOCK;
    if (F.pulseActive) k |= PL.PULSE;
    if (p[P.plasmaClimax] > 0.002) k |= PL.CLIMAX;
    return k;
  }

  compKeyFor(F) {
    const p = F.p;
    const t = this.tier;
    let k = 0;
    if (F.shockAmp > 1e-4 || F.shockGlow > 1e-3) k |= CO.SHOCK;
    if (p[P.ca] > 0.0025) k |= CO.CA;
    if (t.rays && p[P.raysAmt] > 0.004) k |= CO.RAYS;
    if (t.streak && p[P.streakAmt] > 0.004) k |= CO.STREAK;
    if (p[P.spark] > 0.001 || p[P.flare] > 0.001) k |= CO.SPARK;
    if (F.flash > 0.001) k |= CO.FLASH;
    if (F.pulseActive) k |= CO.PULSE;
    if (F.scrimCount > 0 && p[P.scrimAmt] > 0.01) k |= CO.SCRIM;
    if (F.warpRB > 0.001 || F.warpEnv > 0.001) k |= CO.WARP;
    return k;
  }

  embKeyFor(F) {
    const p = F.p;
    return (p[P.crack] > 0.002 ? EM.CRACK : 0) | (p[P.penHead] > 0.01 && p[P.lineReveal] < 0.9999 ? EM.PEN : 0);
  }

  /** Compiles the variants for the given frames ahead of time (KHR_parallel_shader_compile when available). */
  async precompile(keys, { async = true } = {}) {
    const list = [];
    for (const k of keys.plasma) list.push(this.plasmaMat(k));
    for (const k of keys.comp) list.push(this.compMat(k));
    for (const k of keys.emb) list.push(this.embMat(k));
    list.push(this.mCopy, this.mPre, this.mDown, this.mUp, this.mTunnel);
    if (this.mRays) list.push(this.mRays);
    if (this.mStreak) list.push(this.mStreak);
    for (const m of list) {
      this.quad.material = m;
      if (async && this.r.compileAsync) await this.r.compileAsync(this.quadScene, this.cam);
      else this.r.compile(this.quadScene, this.cam);
    }
    if (async && this.r.compileAsync) {
      await this.r.compileAsync(this.pointsScene, this.cam);
      await this.r.compileAsync(this.sparksScene, this.cam);
      await this.r.compileAsync(this.wordScene, this.cam);
    } else {
      this.r.compile(this.pointsScene, this.cam);
      this.r.compile(this.sparksScene, this.cam);
      this.r.compile(this.wordScene, this.cam);
    }
  }

  // ---------------------------------------------------------------------------------------------
  /** Renders frame F (from state.evaluate) to the canvas. env: { aspect, content }. */
  render(F, env) {
    if (!this.rtScene) return;
    const U = this.U;
    const p = F.p;
    const S = this.size;
    const t = this.tier;
    const aspect = S.W / S.H;
    U.uAspect.value = aspect;
    U.uContent.value = env.content;
    U.uPulse.value.set(F.pulses);

    // 1) plasma (low res, cached while nothing changes – idle caching, spec 4.6.7)
    const pk = this.plasmaKeyFor(F);
    const key = this.plasmaKey;
    const vals = this._pv || (this._pv = new Float32Array(24));
    vals[0] = F.plasmaT;
    vals[1] = p[P.reveal];
    vals[2] = p[P.rim];
    vals[3] = p[P.swirl];
    vals[4] = p[P.intensity];
    vals[5] = p[P.idle];
    vals[6] = p[P.heatAmt];
    vals[7] = p[P.wordHeat];
    vals[8] = F.shock;
    vals[9] = F.shockR;
    vals[10] = p[P.plasmaClimax];
    vals[11] = p[P.fill];
    vals[12] = p[P.flameY];
    vals[13] = p[P.hue];
    vals[14] = p[P.desat];
    vals[15] = p[P.ancX];
    vals[16] = p[P.ancY];
    vals[17] = p[P.ancS];
    vals[18] = aspect;
    vals[19] = env.content;
    vals[20] = pk;
    vals[21] = F.pulseActive ? F.t : 0;
    let same = this.plasmaValid;
    for (let i = 0; i < 22 && same; i++) same = key[i] === vals[i];
    if (!same) {
      key.set(vals);
      this.plasmaValid = true;
      U.uTime.value = F.plasmaT;
      U.uAnchor.value.set(p[P.ancX], p[P.ancY], p[P.ancS]);
      U.uReveal.value = p[P.reveal];
      U.uRim.value = p[P.rim];
      U.uSwirl.value = p[P.swirl];
      U.uIntensity.value = p[P.intensity];
      U.uIdle.value = p[P.idle];
      U.uHeatAmt.value = p[P.heatAmt];
      U.uWordHeat.value = p[P.wordHeat];
      U.uShock.value = F.shock;
      U.uShockR.value = F.shockR;
      U.uClimax.value = p[P.plasmaClimax];
      U.uFill.value = p[P.fill];
      U.uFlameY.value = p[P.flameY];
      U.uHue.value = p[P.hue];
      U.uDesat.value = p[P.desat];
      this._pass(this.plasmaMat(pk), this.rtPlasma);
    }

    // 2) scene (HDR): plasma upsampled + tunnel + particles + sparks + emblem + wordmark
    U.uTime.value = F.t;
    U.uSrc.value = this.rtPlasma.texture;
    this._pass(this.mCopy, this.rtScene);
    if (F.warpTunnel > 0.002) {
      U.uWarpU.value = F.warpU;
      U.uWarpEnv.value = F.warpTunnel;
      U.uRes.value.set(S.W, S.H);
      this._pass(this.mTunnel, this.rtScene);
    }
    U.uAnchor.value.set(p[P.ancX], p[P.ancY], p[P.ancS]);
    U.uPx.value = S.H / 800;
    const cloud = p[P.cloudA] > 0.002 || (p[P.wordA] > 0.002 && p[P.wordAsm] > 0);
    const embers = p[P.emberA] > 0.002;
    if (cloud || embers || F.pulseActive) {
      U.uDiskGrow.value = p[P.diskGrow];
      U.uCloudA.value = p[P.cloudA];
      U.uDiskA.value = p[P.diskA];
      U.uAsm.value = p[P.asm];
      U.uAsmW.value = p[P.asmW];
      U.uAsmJ.value = p[P.asmJ];
      U.uIndet.value = p[P.indet];
      U.uFlashW.value = p[P.flashW];
      U.uWordAsm.value = p[P.wordAsm];
      U.uWordA.value = p[P.wordA];
      U.uClimaxT.value = F.climaxT;
      U.uClimaxAmt.value = F.climaxAmt;
      U.uInhale.value = F.inhale;
      U.uBurnT.value = F.burnT;
      U.uJitter.value = p[P.jitter];
      U.uDropT.value = F.dropT;
      U.uEmberRate.value = p[P.emberRate];
      U.uEmberDir.value = p[P.emberDir];
      U.uEmberA.value = p[P.emberA];
      const g = this.points.geometry;
      if (cloud) g.setDrawRange(0, this.pCount);
      else g.setDrawRange(this.emberStart, this.pCount - this.emberStart);
      this.r.setRenderTarget(this.rtScene);
      this.r.render(this.pointsScene, this.cam);
    }
    const sparksOn =
      (F.igniteT > 0 && F.igniteT < 4) || (F.sparkGain > 0 && F.burstT > -0.05 && F.burstT < 3.7) || (F.penGain > 0 && F.introT > 0);
    if (sparksOn) {
      U.uIgniteT.value = F.igniteT;
      U.uBurstT.value = F.burstT;
      U.uSparkFrac.value = F.sparkFrac;
      U.uSparkGain.value = F.sparkGain;
      U.uIntroT.value = F.introT;
      U.uPenT0.value = F.penT0;
      U.uPenK.value = F.penK;
      U.uPenGain.value = F.penGain;
      U.uRes.value.set(S.W, S.H);
      this.r.setRenderTarget(this.rtScene);
      this.r.render(this.sparksScene, this.cam);
    }
    U.uPxW.value = 2 / (env.content * S.H);
    if (p[P.lineAlpha] > 0.003 || p[P.crack] > 0.003) {
      U.uXf.value.set(p[P.embX], p[P.embY], p[P.embS]);
      U.uExt.value.set(BK.EMB_EXT, BK.EMB_EXT);
      U.uLineReveal.value = p[P.lineReveal];
      U.uLineAlpha.value = p[P.lineAlpha];
      U.uLineEnergy.value = p[P.lineEnergy];
      U.uPenHead.value = p[P.penHead];
      U.uPacket.value = p[P.packet];
      U.uGlowAmt.value = p[P.glowAmt];
      U.uOccl.value = p[P.occl];
      U.uCrack.value = p[P.crack];
      this.embMesh.material = this.embMat(this.embKeyFor(F));
      this.r.setRenderTarget(this.rtScene);
      this.r.render(this.embScene, this.cam);
    }
    if (p[P.wordAlpha] > 0.003) {
      U.uXf.value.set(p[P.wordX], p[P.wordY], p[P.wordH]);
      U.uExt.value.set(this.wm.aspect * 0.5 + 0.2, 0.7);
      U.uWordA.value = p[P.wordAlpha];
      U.uWordWipe.value = p[P.wordWipe];
      U.uSweep.value = p[P.sweep];
      U.uWordIgnite.value = p[P.wordIgnite];
      U.uWordGlow.value = p[P.wordGlow];
      this.r.setRenderTarget(this.rtScene);
      this.r.render(this.wordScene, this.cam);
    }

    // 3) bloom pyramid
    const L = this.down.length;
    U.uSrc.value = this.rtScene.texture;
    U.uTexel.value.set(1 / this.rtScene.width, 1 / this.rtScene.height);
    this._pass(this.mPre, this.down[0]);
    for (let i = 1; i < L; i++) {
      U.uSrc.value = this.down[i - 1].texture;
      U.uTexel.value.set(1 / this.down[i - 1].width, 1 / this.down[i - 1].height);
      this._pass(this.mDown, this.down[i]);
    }
    let src = this.down[L - 1];
    for (let i = L - 2; i >= 0; i--) {
      U.uSrc.value = src.texture;
      U.uAdd.value = this.down[i].texture;
      U.uTexel.value.set(1 / src.width, 1 / src.height);
      this._pass(this.mUp, this.up[i]);
      src = this.up[i];
    }

    // 4) god rays from the emblem + anamorphic streak
    const ck = this.compKeyFor(F);
    const cx = ((p[P.ancX] * env.content) / aspect) * 0.5 + 0.5;
    const cy = p[P.ancY] * env.content * 0.5 + 0.5;
    if (ck & CO.RAYS) {
      U.uSrc.value = this.down[Math.min(1, L - 1)].texture;
      U.uC.value.set(cx, cy);
      this._pass(this.mRays, this.rtRays);
    }
    if (ck & CO.STREAK) {
      const s2 = this.down[Math.min(2, L - 1)];
      U.uSrc.value = s2.texture;
      U.uTexel.value.set(1 / s2.width, 1 / s2.height);
      U.uThresh.value = 2.0;
      U.uStep.value = 1.0;
      U.uGain.value = 3.0;
      this._pass(this.mStreak, this.rtStreakA);
      U.uSrc.value = this.rtStreakA.texture;
      U.uTexel.value.set(1 / this.rtStreakA.width, 1 / this.rtStreakA.height);
      U.uThresh.value = 0.0;
      U.uStep.value = 4.0;
      U.uGain.value = 2.0;
      this._pass(this.mStreak, this.rtStreak);
    }

    // 5) composite to the canvas
    U.uScene.value = this.rtScene.texture;
    U.uBloom.value = this.up[0].texture;
    U.uRays.value = this.rtRays ? this.rtRays.texture : this.up[0].texture;
    U.uStreak.value = this.rtStreak ? this.rtStreak.texture : this.up[0].texture;
    U.uRes.value.set(S.W, S.H);
    U.uShockR.value = F.shockR * p[P.ancS] / 0.45;
    U.uShockW.value = F.shockW * p[P.ancS] / 0.45;
    U.uShockAmp.value = F.shockAmp;
    U.uShockGlow.value = F.shockGlow;
    U.uCA.value = p[P.ca];
    U.uFlash.value = F.flash;
    U.uFlashCap.value = F.flashCap;
    U.uExposure.value = p[P.exposure];
    U.uBloomAmt.value = p[P.bloomAmt] / L;
    U.uRaysAmt.value = p[P.raysAmt];
    U.uStreakAmt.value = p[P.streakAmt];
    U.uIdle.value = p[P.idle] * p[P.scrimAmt];
    U.uSpark.value = p[P.spark];
    U.uFlare.value = p[P.flare];
    U.uVig.value = p[P.vig];
    U.uGrain.value = p[P.grain];
    U.uDesat.value = 0;
    U.uPunch.value = F.punch;
    U.uPulseSoft.value = F.pulseSoft;
    U.uShake.value.set(F.shakeX / Math.max(1, S.cssW), -F.shakeY / Math.max(1, S.cssH));
    const sx = S.W / Math.max(1, S.cssW);
    const sy = S.H / Math.max(1, S.cssH);
    const sc = U.uScrim.value;
    for (let i = 0; i < 4; i++) {
      const x = F.scrims[i * 4];
      const y = F.scrims[i * 4 + 1];
      const w = F.scrims[i * 4 + 2];
      const h = F.scrims[i * 4 + 3];
      sc[i * 4] = x * sx;
      sc[i * 4 + 1] = (S.cssH - y - h) * sy;
      sc[i * 4 + 2] = i < F.scrimCount ? (x + w) * sx : 0;
      sc[i * 4 + 3] = (S.cssH - y) * sy;
    }
    U.uScrimAmt.value = p[P.scrimAmt];
    U.uScrimFeather.value = 40 * sx;
    U.uScrimRadius.value = 14 * sx;
    U.uWarpEnv.value = F.warpEnv;
    U.uWarpRB.value = F.warpRB;
    this._pass(this.compMat(ck), null);
    void t;
  }

  /** Renders n frames of F and returns the median GPU-synced frame time (ms). */
  probe(F, env, n = 12, budgetMs = 600) {
    const gl = this.gl;
    const px = new Uint8Array(4);
    this.render(F, env); // warm-up (shader compile)
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const times = [];
    const start = performance.now();
    for (let i = 0; i < n; i++) {
      this.plasmaValid = false;
      const t0 = performance.now();
      this.render(F, env);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      times.push(performance.now() - t0);
      if (performance.now() - start > budgetMs && times.length >= 3) break;
    }
    times.sort((a, b) => a - b);
    return times[times.length >> 1];
  }

  get memory() {
    return { textures: this.r.info.memory.textures, geometries: this.r.info.memory.geometries, programs: this.r.info.programs ? this.r.info.programs.length : 0 };
  }

  dispose() {
    for (const rt of this.rts) rt.dispose();
    this.rts.length = 0;
    for (const m of this.mats) m.dispose();
    for (const m of this.vPlasma.values()) m.dispose();
    for (const m of this.vComp.values()) m.dispose();
    for (const m of this.vEmb.values()) m.dispose();
    for (const g of this.geoms) g.dispose();
    for (const k of Object.keys(this.tex)) this.tex[k].dispose();
    this.r.dispose();
    this.rtScene = null;
  }
}
