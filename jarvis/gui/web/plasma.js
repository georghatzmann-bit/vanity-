/* Jarvis' Energie-Kugel wie im Video "Jarvis Assistant": eine dunkle Glaskugel, in der leuchtende Plasma-Bänder
   kreisen, mit hellem Rand und weichem Schein. Gezeichnet mit WebGL (ein Fragment-Shader, keine Bibliothek).

   Je Zustand eigene Farbe und Unruhe: Bereit ruhig und blau, Zuhören heller und schneller, Nachdenken
   blau-violett mit wirbelnden Bändern, Sprechen pulsiert mit der Stimme, stumm grau, Störung rot.
   Ohne WebGL gibt create() null zurück, dann zeichnet orb.js wie bisher.

   const orb = JarvisPlasma.create(canvas, { size: 'hero' | 'small', visible: () => true });
   orb.state('listening'); orb.level(0.6); orb.pulse(); orb.boot(); orb.gesture('search', true); orb.talk(true);
*/
(function () {
  'use strict';

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => !!(motionQuery && motionQuery.matches);

  // Farbe der Bänder (tint), Tiefe innen (deep), wie viel los ist (energy), Drehtempo (spin), grau (gray)
  const LOOKS = {
    idle: { tint: [0.30, 0.72, 1.00], deep: [0.03, 0.14, 0.42], energy: 0.48, spin: 0.10, gray: 0 },
    listening: { tint: [0.40, 0.88, 1.00], deep: [0.04, 0.20, 0.52], energy: 0.82, spin: 0.22, gray: 0 },
    thinking: { tint: [0.58, 0.62, 1.00], deep: [0.16, 0.08, 0.48], energy: 0.86, spin: 0.55, gray: 0 },
    speaking: { tint: [0.34, 0.82, 1.00], deep: [0.04, 0.17, 0.50], energy: 0.66, spin: 0.26, gray: 0 },
    muted: { tint: [0.55, 0.60, 0.68], deep: [0.07, 0.08, 0.10], energy: 0.22, spin: 0.04, gray: 1 },
    error: { tint: [1.00, 0.42, 0.36], deep: [0.30, 0.04, 0.05], energy: 0.55, spin: 0.12, gray: 0 },
  };

  const VERTEX = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

  const FRAGMENT = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uPhase;
uniform float uLevel;
uniform float uEnergy;
uniform float uFlash;
uniform float uRadius;
uniform float uGray;
uniform vec3 uTint;
uniform vec3 uDeep;

vec3 hash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

// Gradientenrauschen in 3D (Werte etwa -0.7 bis 0.7)
float noise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(hash3(i), f);
  float b = dot(hash3(i + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0));
  float c = dot(hash3(i + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0));
  float d = dot(hash3(i + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0));
  float e = dot(hash3(i + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0));
  float g = dot(hash3(i + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0));
  float h = dot(hash3(i + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0));
  float k = dot(hash3(i + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}

mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }

void main() {
  float scale = min(uRes.x, uRes.y);
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / scale;
  float r = length(p);
  float R = uRadius * (1.0 + 0.03 * uLevel + 0.02 * uFlash);
  vec3 tint = mix(uTint, vec3(dot(uTint, vec3(0.33))), uGray);
  vec3 deep = mix(uDeep, vec3(dot(uDeep, vec3(0.33))), uGray);
  float t = uTime;
  vec3 col = vec3(0.0);
  float alpha = 0.0;

  if (r < R) {
    // Punkt auf der Kugel und ihre Neigung
    vec2 q = p / R;
    float z = sqrt(max(0.0, 1.0 - dot(q, q)));
    vec3 n = vec3(q, z);
    vec3 s = rotX(0.35) * rotY(uPhase) * n;

    // verwirbeltes Rauschen: daraus werden die Plasma-Bänder
    float swirl = 0.55 + 0.45 * uEnergy;
    vec3 w = vec3(noise(s * 1.6 + vec3(0.0, t * 0.11, 0.0)),
                  noise(s * 1.6 + vec3(5.2, 1.3 - t * 0.09, 2.8)),
                  noise(s * 1.6 + vec3(1.7, 9.2, 4.1 + t * 0.07)));
    float f = noise(s * 2.1 + w * (1.8 * swirl) + vec3(0.0, 0.0, t * 0.05));
    float threads = pow(1.0 - abs(2.0 * fract(f * 1.7 + 0.5) - 1.0), 14.0);
    float fine = pow(1.0 - abs(2.0 * fract(noise(s * 3.2 + w * 1.6 - t * 0.08) * 2.0) - 1.0), 22.0);

    // das große S-förmige Band wie im Video
    float bandY = 0.42 * sin(s.x * 2.4 + t * 0.35 + w.y * 1.4) + 0.12 * w.x;
    float dy = s.y - bandY;
    float band = exp(-pow(dy * (7.5 - 2.0 * uEnergy), 2.0)) + 0.28 * exp(-pow(dy * 2.4, 2.0));
    float band2 = exp(-pow((s.y + bandY * 0.8 + 0.2) * 9.0, 2.0)) * 0.35;

    // Funken
    vec3 cell = floor(s * 34.0);
    float spark = step(0.985, fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453));
    spark *= 0.5 + 0.5 * sin(t * 3.0 + dot(cell, vec3(1.7, 2.3, 3.1)));
    vec3 cf = fract(s * 34.0) - 0.5;
    spark *= smoothstep(0.22, 0.0, length(cf));

    float light = threads * (0.42 + 0.5 * uEnergy) + fine * 0.14 + band * (0.95 + 0.55 * uEnergy) + band2;
    light *= 0.65 + 0.35 * z;  // nach hinten dunkler
    light += uLevel * 0.45 * band + uFlash * 0.35;

    float fres = pow(1.0 - z, 2.4);
    vec3 inner = deep * (0.3 + 0.4 * z) + deep * 0.45 * (0.5 + 0.5 * f);
    col = inner + tint * light * 1.15 + mix(tint, vec3(1.0), 0.35) * fres * (0.9 + 0.6 * uEnergy);
    col += vec3(0.9, 0.97, 1.0) * spark * (0.6 + 0.4 * uEnergy);
    // Glanzlicht oben links
    float gloss = exp(-pow(length(q - vec2(-0.38, 0.42)) * 2.6, 2.0));
    col += vec3(0.75, 0.9, 1.0) * gloss * 0.18;
    // weicher Rand gegen Treppen
    float edge = smoothstep(R, R - 1.5 / scale, r);
    alpha = edge;
    col *= edge;
  }

  // Schein um die Kugel: eng und hell, dazu weit und weich
  float d = max(0.0, r - R);
  float glow = exp(-d * (34.0 - 10.0 * uEnergy)) * (0.55 + 0.45 * uEnergy + 0.6 * uLevel + 0.5 * uFlash);
  float haze = exp(-d * 7.0) * (0.16 + 0.12 * uEnergy + 0.2 * uLevel);
  float outside = r < R ? 0.0 : 1.0;
  float fade = smoothstep(0.5, 0.36, r);  // bis zum Rand der Fläche ganz weg: kein Viereck
  vec3 halo = tint * (glow + haze) * outside * fade;
  col += halo;
  alpha = max(alpha, clamp((glow + haze) * outside * fade, 0.0, 1.0));
  gl_FragColor = vec4(col, alpha);
}
`;

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('Shader: ' + info);
    }
    return shader;
  }

  function program(gl) {
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Programm: ' + gl.getProgramInfoLog(prog));
    return prog;
  }

  function create(canvas, options) {
    const opts = options || {};
    const small = opts.size === 'small';
    const visible = typeof opts.visible === 'function' ? opts.visible : () => true;
    let gl = null;
    try {
      gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false,
        stencil: false, powerPreference: 'low-power', preserveDrawingBuffer: !!opts.preserve });
    } catch {
      gl = null;
    }
    if (!gl) return null;
    let prog;
    try {
      prog = program(gl);
    } catch (err) {
      if (window.console) console.warn('Energie-Kugel aus:', err && err.message);
      return null;
    }
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = {};
    ['uRes', 'uTime', 'uPhase', 'uLevel', 'uEnergy', 'uFlash', 'uRadius', 'uGray', 'uTint', 'uDeep'].forEach((name) => {
      loc[name] = gl.getUniformLocation(prog, name);
    });
    const aPos = gl.getAttribLocation(prog, 'aPos');

    const look = Object.assign({}, LOOKS.idle, { tint: LOOKS.idle.tint.slice(), deep: LOOKS.idle.deep.slice() });
    let target = LOOKS.idle;
    let levelTarget = 0;
    let level = 0;
    let flash = 0;
    let hold = 0;
    let boot = 1;
    let phase = 0;
    let time = Math.random() * 40;
    let last = 0;
    let frame = 0;
    let stopped = false;
    let lost = false;

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      try {
        prog = program(gl);
        lost = false;
      } catch {
        stopped = true;
      }
    });

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, small ? 2 : 1.5);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      return [w, h];
    }

    function draw(now) {
      frame = 0;
      if (stopped) return;
      schedule();
      if (lost || document.hidden || !visible() || !canvas.clientWidth) {
        last = now;
        return;
      }
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
      last = now;
      const slow = reduced() ? 0.2 : 1;
      const k = 1 - Math.pow(0.02, dt);
      for (const key of ['energy', 'spin', 'gray']) look[key] = lerp(look[key], target[key], k);
      for (let i = 0; i < 3; i += 1) {
        look.tint[i] = lerp(look.tint[i], target.tint[i], k);
        look.deep[i] = lerp(look.deep[i], target.deep[i], k);
      }
      level = lerp(level, levelTarget, 1 - Math.pow(0.0005, dt));
      flash = Math.max(hold * 0.35, flash * Math.pow(0.06, dt));
      boot = boot * Math.pow(0.01, dt);
      time += dt * slow * (0.6 + 0.8 * look.energy);
      phase += dt * slow * look.spin;
      const [w, h] = resize();
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(loc.uRes, w, h);
      gl.uniform1f(loc.uTime, time);
      gl.uniform1f(loc.uPhase, phase);
      gl.uniform1f(loc.uLevel, clamp(level, 0, 1));
      gl.uniform1f(loc.uEnergy, clamp(look.energy + level * 0.35, 0, 1));
      gl.uniform1f(loc.uFlash, clamp(flash + boot * 0.8, 0, 1.5));
      gl.uniform1f(loc.uRadius, (small ? 0.4 : 0.3) * (1 - boot * 0.35));
      gl.uniform1f(loc.uGray, look.gray);
      gl.uniform3fv(loc.uTint, look.tint);
      gl.uniform3fv(loc.uDeep, look.deep);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function schedule() {
      if (!frame && !stopped) frame = requestAnimationFrame(draw);
    }

    schedule();
    return {
      state(name) {
        target = LOOKS[name] || LOOKS.idle;
      },
      level(v) {
        levelTarget = clamp(Number(v) || 0, 0, 1);
      },
      pulse() {
        flash = 1;
      },
      boot() {
        boot = 1;
      },
      gesture(kind, keep) {
        if (!kind) {
          hold = 0;
          return;
        }
        flash = Math.max(flash, 0.7);
        hold = keep ? 1 : 0;
      },
      talk() {},
      stop() {
        stopped = true;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
      },
    };
  }

  window.JarvisPlasma = { create, LOOKS };
})();
