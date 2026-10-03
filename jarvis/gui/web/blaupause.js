/* ==========================================================================
   Jarvis – Blueprint (früher Blaupause)
   3D-Modelle als Hologramm, wie in Tony Starks Werkstatt: dunkler Raum, leuchtende Linien, Projektor mit
   Lichtkegel und Funken, Scan-Linie, Leuchten (Bloom). Auf Wunsch weiter als Zeichnung auf Blaupausen-Papier.
   Python (blaupause.py) hält das Modell und schickt Ereignisse:
     blueprint  open | close | scene | op | busy | done | view | export | library | saved | render (Blender)
   Diese Seite zeichnet es mit three.js (vendor/three.min.js, erst beim ersten Öffnen geladen):
   als leuchtendes Hologramm (Holo, Standard), in echten Farben (Echt) oder als weiße Zeichnung (Papier).
   Jedes Teil baut sich mit einem Laser von unten nach oben auf. Maus: ziehen dreht, Rad zoomt,
   rechts ziehen verschiebt, Klick wählt ein Teil, Doppelklick holt es heran. Finger: einer dreht,
   zwei zoomen und verschieben. Dazu Maßlinien, Beschriftung, Explosionsansicht, STL-Export und Blender:
   „Foto“ zeigt Fortschritt und Bild aus Blender, „Blender“ öffnet das Modell dort.
   Texte aus dem Modell kommen nur als Klartext (textContent) auf die Seite.
   ========================================================================== */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const rad = (d) => (Number(d) || 0) * Math.PI / 180;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HOT = '#ffcf6e';
  const motionMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reducedMotion = () => !!(motionMQ && motionMQ.matches);

  let THREE = null;
  let loading = null;

  // three.js erst laden, wenn die Blaupause zum ersten Mal aufgeht (600 KB, das Hauptfenster bleibt schnell)
  function loadThree() {
    if (THREE) return Promise.resolve(THREE);
    if (window.THREE) {
      THREE = window.THREE;
      return Promise.resolve(THREE);
    }
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/three.min.js';
        s.onload = () => {
          THREE = window.THREE;
          if (THREE) resolve(THREE);
          else reject(new Error('three.js fehlt'));
        };
        s.onerror = () => {
          loading = null;
          reject(new Error('three.js ließ sich nicht laden'));
        };
        document.head.appendChild(s);
      });
    }
    return loading;
  }

  // ------------------------------------------------------------------ Formen

  // Quader mit abgerundeten Kanten, wie RoundedBoxGeometry aus den three.js-Beispielen (ohne Texturkoordinaten):
  // Ein fein unterteilter Würfel, dessen Randpunkte auf Viertelkreise um die inneren Kanten geschoben werden.
  function roundedBox(T, w, h, d, r) {
    const seg = 5;
    const geo = new T.BoxGeometry(1, 1, 1, seg, seg, seg).toNonIndexed();
    const pos = geo.attributes.position.array;
    const nor = geo.attributes.normal.array;
    const half = 0.5 / seg;
    const bx = w / 2 - r;
    const by = h / 2 - r;
    const bz = d / 2 - r;
    const n = new T.Vector3();
    for (let i = 0; i < pos.length; i += 3) {
      const sx = Math.sign(pos[i]);
      const sy = Math.sign(pos[i + 1]);
      const sz = Math.sign(pos[i + 2]);
      n.set(pos[i] - sx * half, pos[i + 1] - sy * half, pos[i + 2] - sz * half).normalize();
      pos[i] = bx * sx + n.x * r;
      pos[i + 1] = by * sy + n.y * r;
      pos[i + 2] = bz * sz + n.z * r;
      nor[i] = n.x;
      nor[i + 1] = n.y;
      nor[i + 2] = n.z;
    }
    return geo;
  }

  function geometryFor(T, p) {
    const m = Array.isArray(p.masse) ? p.masse : [];
    const n = (i, d) => (Number.isFinite(Number(m[i])) && Number(m[i]) > 0 ? Number(m[i]) : d);
    try {
      switch (p.form) {
        case 'quader': {
          const w = n(0, 0.5);
          const h = n(1, 0.5);
          const d = n(2, 0.5);
          const r = Math.min(Number(p.rundung) || 0, w / 2, h / 2, d / 2);
          return r > 0.0005 ? roundedBox(T, w, h, d, r) : new T.BoxGeometry(w, h, d);
        }
        case 'kugel': return new T.SphereGeometry(n(0, 0.3), 40, 24);
        case 'zylinder': return new T.CylinderGeometry(Math.max(0, Number(m[0]) || 0), Math.max(0, Number(m[1]) || 0) || 0.0001,
          n(2, 0.5), 48, 1);
        case 'kegel': return new T.ConeGeometry(n(0, 0.2), n(1, 0.5), 48);
        case 'ring': return new T.TorusGeometry(n(0, 0.4), n(1, 0.05), 20, 72);
        case 'kapsel': return new T.CapsuleGeometry(n(0, 0.15), n(1, 0.5), 10, 28);
        case 'drehkoerper': {
          const pts = (p.profil || []).map(([r, y]) => new T.Vector2(Math.max(0, Number(r) || 0), Number(y) || 0));
          return pts.length >= 2 ? new T.LatheGeometry(pts, 64) : null;
        }
        case 'extrusion': {
          const pts = (p.umriss || []).map(([x, y]) => new T.Vector2(Number(x) || 0, Number(y) || 0));
          if (pts.length < 3) return null;
          const depth = Number(p.tiefe) || 0.1;
          const bevel = Math.min(Number(p.fase) || 0, depth / 3);
          const shape = new T.Shape(pts);
          for (const hole of Array.isArray(p.loecher) ? p.loecher : []) {
            const hp = (Array.isArray(hole) ? hole : []).map(([x, y]) => new T.Vector2(Number(x) || 0, Number(y) || 0));
            if (hp.length >= 3) shape.holes.push(new T.Path(hp));
          }
          const geo = new T.ExtrudeGeometry(shape, {
            depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 3, curveSegments: 16,
          });
          geo.translate(0, 0, -depth / 2);
          return geo;
        }
        case 'rohr': {
          const pts = (p.pfad || []).map(([x, y, z]) => new T.Vector3(Number(x) || 0, Number(y) || 0, Number(z) || 0));
          if (pts.length < 2) return null;
          const curve = new T.CatmullRomCurve3(pts, false, 'centripetal');
          return new T.TubeGeometry(curve, Math.max(24, pts.length * 12), Number(p.radius) || 0.03, 14, false);
        }
        default: return null;
      }
    } catch {
      return null;
    }
  }

  // Die Lage eines Teils (ohne Explosion und ohne Drehung des ganzen Modells)
  function partMatrix(T, p) {
    const m = new T.Matrix4();
    const d = p.dreh || [0, 0, 0];
    const s = p.skala || [1, 1, 1];
    m.compose(new T.Vector3(...(p.pos || [0, 0, 0]).map(Number)),
      new T.Quaternion().setFromEuler(new T.Euler(rad(d[0]), rad(d[1]), rad(d[2]), 'XYZ')),
      new T.Vector3(...s.map((v) => Number(v) || 1)));
    return m;
  }

  // ------------------------------------------------------------------ Darstellung

  const LOOKS = {
    // Weiße Zeichnung auf Blaupause
    blau: { edge: '#f4f8ff', edgeOpacity: 0.92, face: '#ffffff', faceOpacity: 0.035, rim: 0.32, scan: 0, additive: false, tint: 0 },
    // Leuchtendes Hologramm, die Farben ins Blaue gezogen
    holo: { edge: '#9eeaff', edgeOpacity: 0.7, face: '#6fd6ff', faceOpacity: 0.035, rim: 0.7, scan: 0.6, additive: true, tint: 0.78 },
    // Echte Farben und Material
    echt: { edge: '#0b1d36', edgeOpacity: 0.22 },
  };

  const VERT = `
    #include <clipping_planes_pars_vertex>
    varying vec3 vN;
    varying vec3 vV;
    varying float vY;
    void main() {
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vec4 mvPosition = viewMatrix * worldPos;
      vN = normalize(mat3(modelMatrix) * normal);
      vV = normalize(cameraPosition - worldPos.xyz);
      vY = worldPos.y;
      gl_Position = projectionMatrix * mvPosition;
      #include <clipping_planes_vertex>
    }`;
  const FRAG = `
    #include <clipping_planes_pars_fragment>
    uniform vec3 uColor;
    uniform float uOpacity;
    uniform float uRim;
    uniform float uScan;
    uniform float uTime;
    uniform float uSel;
    uniform float uDim;
    uniform float uTop;
    varying vec3 vN;
    varying vec3 vV;
    varying float vY;
    void main() {
      #include <clipping_planes_fragment>
      float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
      float rim = pow(f, 2.0);
      // feine Linien wie bei einem Projektor, ein helles Band läuft alle paar Sekunden durchs Modell
      float lines = 1.0 - uScan * 0.35 * (0.5 + 0.5 * sin(gl_FragCoord.y * 1.7 - uTime * 5.0));
      float h = max(uTop, 0.5) + 0.8;
      float sweep = uScan * smoothstep(0.09, 0.0, abs(vY - (mod(uTime * 0.55, h) - 0.4)));
      float flick = 1.0 - uScan * 0.04 * (0.5 + 0.5 * sin(uTime * 37.0 + vY * 9.0));
      vec3 col = mix(uColor, vec3(1.0, 0.72, 0.32), uSel * 0.9);
      float a = (uOpacity + rim * uRim + sweep * 0.28 + uSel * 0.14) * lines * flick * (1.0 - uDim * 0.82);
      gl_FragColor = vec4(col * (0.55 + rim * 0.9 + sweep * 1.1), clamp(a, 0.0, 1.0));
    }`;

  // ------------------------------------------------------------------ Leuchten (Bloom)
  // Das Bild erst in eine Textur, helle Stellen herausziehen, zweimal weichzeichnen (halbe und viertel Größe) und
  // wieder darüberlegen. Dazu ein leichtes Vignettieren. Ohne Erweiterungen von three.js, damit nichts nachzuladen ist.
  const QUAD_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
  const BRIGHT_FRAG = `
    uniform sampler2D tDiffuse; uniform float uThreshold; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = max(c.r, max(c.g, c.b));
      gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + 0.35, l), 1.0);
    }`;
  const BLUR_FRAG = `
    uniform sampler2D tDiffuse; uniform vec2 uDir; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
      c += texture2D(tDiffuse, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
      c += texture2D(tDiffuse, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
      c += texture2D(tDiffuse, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
      c += texture2D(tDiffuse, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
      gl_FragColor = vec4(c, 1.0);
    }`;
  const COMPOSE_FRAG = `
    uniform sampler2D tScene; uniform sampler2D tGlow1; uniform sampler2D tGlow2;
    uniform float uStrength; uniform float uVignette; uniform float uTime; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tScene, vUv).rgb;
      c += texture2D(tGlow1, vUv).rgb * uStrength + texture2D(tGlow2, vUv).rgb * uStrength * 1.4;
      vec2 d = vUv - 0.5;
      c *= 1.0 - uVignette * smoothstep(0.25, 0.85, length(d * vec2(1.25, 1.0)));
      float grain = fract(sin(dot(vUv * (uTime + 1.0), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
      gl_FragColor = vec4(c + grain * 0.012, 1.0);
    }`;

  function makeGlow(T, renderer) {
    const webgl2 = !!(renderer.capabilities && renderer.capabilities.isWebGL2);
    const target = (w, h, samples) => {
      const rt = new T.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), { samples: webgl2 ? samples : 0 });
      rt.texture.encoding = T.sRGBEncoding; // three.js rechnet dann wie auf dem Bildschirm
      return rt;
    };
    let w = 1;
    let h = 1;
    let full = target(1, 1, 4);
    let half = [target(1, 1, 0), target(1, 1, 0)];
    let quarter = [target(1, 1, 0), target(1, 1, 0)];
    const cam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new T.Mesh(new T.PlaneGeometry(2, 2));
    const pass = new T.Scene();
    pass.add(quad);
    const bright = new T.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader: BRIGHT_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: 0.7 } } });
    const blur = new T.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tDiffuse: { value: null }, uDir: { value: new T.Vector2() } } });
    const compose = new T.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader: COMPOSE_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tScene: { value: null }, tGlow1: { value: null }, tGlow2: { value: null }, uStrength: { value: 0.9 },
        uVignette: { value: 0.55 }, uTime: { value: 0 } } });
    function draw(material, into) {
      quad.material = material;
      renderer.setRenderTarget(into);
      renderer.render(pass, cam);
    }
    function blurInto(src, pair, rw, rh) {
      blur.uniforms.tDiffuse.value = src.texture;
      blur.uniforms.uDir.value.set(1 / rw, 0);
      draw(blur, pair[1]);
      blur.uniforms.tDiffuse.value = pair[1].texture;
      blur.uniforms.uDir.value.set(0, 1 / rh);
      draw(blur, pair[0]);
    }
    return {
      setSize(width, height) {
        w = Math.max(1, Math.round(width));
        h = Math.max(1, Math.round(height));
        full.setSize(w, h);
        for (const rt of half) rt.setSize(Math.ceil(w / 2), Math.ceil(h / 2));
        for (const rt of quarter) rt.setSize(Math.ceil(w / 4), Math.ceil(h / 4));
      },
      render(world, camera, time, strength, threshold) {
        bright.uniforms.uThreshold.value = threshold;
        renderer.setRenderTarget(full);
        renderer.clear();
        renderer.render(world, camera);
        bright.uniforms.tDiffuse.value = full.texture;
        draw(bright, half[0]);
        blurInto(half[0], half, Math.ceil(w / 2), Math.ceil(h / 2));
        blur.uniforms.tDiffuse.value = half[0].texture;
        blur.uniforms.uDir.value.set(2 / Math.ceil(w / 2), 0);
        draw(blur, quarter[1]);
        blur.uniforms.tDiffuse.value = quarter[1].texture;
        blur.uniforms.uDir.value.set(0, 1 / Math.ceil(h / 4));
        draw(blur, quarter[0]);
        blurInto(quarter[0], quarter, Math.ceil(w / 4), Math.ceil(h / 4));
        compose.uniforms.tScene.value = full.texture;
        compose.uniforms.tGlow1.value = half[0].texture;
        compose.uniforms.tGlow2.value = quarter[0].texture;
        compose.uniforms.uStrength.value = strength;
        compose.uniforms.uTime.value = time % 100;
        draw(compose, null);
      },
      dispose() {
        for (const rt of [full, ...half, ...quarter]) rt.dispose();
        for (const m of [bright, blur, compose]) m.dispose();
        quad.geometry.dispose();
      },
    };
  }

  function fmtLen(units, scale) {
    // scale: Meter pro Einheit (aus "groesse_m"), sonst Einheiten
    if (!scale) return (Math.round(units * 100) / 100).toFixed(2).replace('.', ',') + ' E';
    const m = units * scale;
    if (m >= 1) return m.toFixed(2).replace('.', ',') + ' m';
    if (m >= 0.1) return (m * 100).toFixed(1).replace('.', ',') + ' cm';
    return Math.round(m * 1000) + ' mm';
  }

  // B × H × T in einer Einheit, nach der größten Seite gewählt
  function fmtSize(values, scale) {
    const top = Math.max(...values);
    if (!scale) return values.map((v) => v.toFixed(2).replace('.', ',')).join(' × ') + ' E';
    const meters = top * scale;
    const [unit, f, digits] = meters >= 1 ? ['m', 1, 2] : meters >= 0.1 ? ['cm', 100, 1] : ['mm', 1000, 0];
    return values.map((v) => (v * scale * f).toFixed(digits).replace('.', ',')).join(' × ') + ' ' + unit;
  }

  function today() {
    const d = new Date();
    return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear();
  }

  // ------------------------------------------------------------------ STL für den 3D-Drucker

  function stlFromParts(T, parts, scene) {
    const tris = [];
    const box = new T.Box3();
    const geos = [];
    for (const p of parts) {
      if (p.versteckt) continue;
      const geo = geometryFor(T, p);
      if (!geo) continue;
      geo.applyMatrix4(partMatrix(T, p));
      geo.computeBoundingBox();
      box.union(geo.boundingBox);
      geos.push(geo);
    }
    // Maßstab: echte Größe, wenn bekannt (groesse_m = Höhe), sonst 1 Einheit = 100 mm. z zeigt nach oben.
    const height = Math.max(1e-6, box.max.y - box.min.y);
    const mm = scene && Number(scene.groesse_m) > 0 ? (Number(scene.groesse_m) * 1000) / height : 100;
    const a = new T.Vector3();
    const b = new T.Vector3();
    const c = new T.Vector3();
    const conv = (v) => [(v.x - (box.min.x + box.max.x) / 2) * mm, -(v.z - (box.min.z + box.max.z) / 2) * mm, (v.y - box.min.y) * mm];
    for (const geo of geos) {
      const pos = geo.getAttribute('position');
      const index = geo.getIndex();
      const count = index ? index.count : pos.count;
      for (let i = 0; i < count; i += 3) {
        const ia = index ? index.getX(i) : i;
        const ib = index ? index.getX(i + 1) : i + 1;
        const ic = index ? index.getX(i + 2) : i + 2;
        a.fromBufferAttribute(pos, ia);
        b.fromBufferAttribute(pos, ib);
        c.fromBufferAttribute(pos, ic);
        tris.push([conv(a), conv(b), conv(c)]);
      }
      geo.dispose();
    }
    const buf = new ArrayBuffer(84 + tris.length * 50);
    const view = new DataView(buf);
    const head = 'Jarvis Blueprint ' + String((scene && scene.name) || '').slice(0, 50);
    for (let i = 0; i < Math.min(80, head.length); i += 1) view.setUint8(i, head.charCodeAt(i) & 0x7f);
    view.setUint32(80, tris.length, true);
    let o = 84;
    for (const [p, q, r] of tris) {
      const ux = q[0] - p[0]; const uy = q[1] - p[1]; const uz = q[2] - p[2];
      const vx = r[0] - p[0]; const vy = r[1] - p[1]; const vz = r[2] - p[2];
      let nx = uy * vz - uz * vy; let ny = uz * vx - ux * vz; let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      for (const v of [nx, ny, nz, ...p, ...q, ...r]) {
        view.setFloat32(o, v, true);
        o += 4;
      }
      view.setUint16(o, 0, true);
      o += 2;
    }
    return buf;
  }

  function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let out = '';
    for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(out);
  }

  // ==================================================================
  //   Die Ansicht
  // ==================================================================

  function create(opts) {
    const call = opts.call;
    const toast = opts.toast || (() => {});
    const el = {
      body: document.body,
      bp: $('bp'),
      stage: $('bpStage'),
      canvas: $('bpCanvas'),
      overlay: $('bpOverlay'),
      labels: $('bpLabels'),
      scan: $('bpScan'),
      empty: $('bpEmpty'),
      gizmo: $('bpGizmo'),
      back: $('bpBack'),
      name: $('bpName'),
      chip: $('bpChip'),
      chipText: $('bpChipText'),
      tree: $('bpTree'),
      treeEmpty: $('bpTreeEmpty'),
      partCount: $('bpPartCount'),
      look: $('bpLook'),
      views: $('bpViews'),
      spin: $('bpSpin'),
      explode: $('bpExplode'),
      labelsBtn: $('bpLabelsBtn'),
      dims: $('bpDims'),
      bigger: $('bpBigger'),
      smaller: $('bpSmaller'),
      undo: $('bpUndo'),
      redo: $('bpRedo'),
      sel: $('bpSel'),
      selName: $('bpSelName'),
      selInfo: $('bpSelInfo'),
      swatches: $('bpSwatches'),
      selFocus: $('bpSelFocus'),
      selHide: $('bpSelHide'),
      selRemove: $('bpSelRemove'),
      say: $('bpSay'),
      cmd: $('bpCmd'),
      input: $('bpInput'),
      send: $('bpSend'),
      chips: $('bpChips'),
      blockName: $('bpBlockName'),
      blockSize: $('bpBlockSize'),
      blockParts: $('bpBlockParts'),
      blockDate: $('bpBlockDate'),
      newBtn: $('bpNew'),
      save: $('bpSave'),
      exportBtn: $('bpExport'),
      libBtn: $('bpLibraryBtn'),
      lib: $('bpLibrary'),
      libList: $('bpLibList'),
      libEmpty: $('bpLibEmpty'),
      libClose: $('bpLibClose'),
      folder: $('bpFolder'),
      pill: $('bpPill'),
      mic: $('bpMic'),
      micText: $('bpMicText'),
      render: $('bpRender'),
      blender: $('bpBlender'),
      photo: $('bpPhoto'),
      photoHead: $('bpPhotoHead'),
      photoImg: $('bpPhotoImg'),
      photoWait: $('bpPhotoWait'),
      photoState: $('bpPhotoState'),
      photoBar: $('bpPhotoBar'),
      photoInfo: $('bpPhotoInfo'),
      photoMeta: $('bpPhotoMeta'),
      photoClose: $('bpPhotoClose'),
      photoFolder: $('bpPhotoFolder'),
      photoBlender: $('bpPhotoBlender'),
      photoAgain: $('bpPhotoAgain'),
    };
    if (!el.bp) return null;

    // Was Python hält (Kopie) und wie es gerade aussieht
    let scene = { name: '', beschreibung: '', teile: [] };
    let selected = '';
    let busy = false;
    let isOpen = false;
    let closeTimer = 0;
    const view = { look: 'holo', spin: false, explode: false, labels: false, dims: true, isolate: null, focus: null };

    // three.js
    let T = null;
    let renderer = null;
    let world = null;
    let camera = null;
    let model = null; // alle Teile, dreht sich als Ganzes
    let floor = null;
    let laser = null;
    let raycaster = null;
    let glow = null; // Leuchten (Bloom) für Holo und Echt
    let sparks = null; // Funken im Lichtkegel
    let frame = 0;
    let last = 0;
    let clock = 0;
    const objs = new Map(); // id -> { part, group, solid, edges, plane, born, box (lokal), center, offset }
    const ctl = { target: null, theta: 0.7, phi: 1.12, radius: 6, goal: null, touched: -1e9 };
    const turn = { y: 0, x: 0, goalY: 0, goalX: 0 };
    let explodeNow = 0;
    let fitAfter = 0;
    const pendingViews = []; // Ansichtsbefehle, die vor dem Laden von three.js kamen
    let fitFrac = 1; // wie viel der Bildhöhe frei ist (zwischen Kopf, Fuß und Seitenteilen)

    // ------------------------------------------------------------ Aufbau

    async function ensure3D() {
      if (renderer) return true;
      try {
        T = await loadThree();
      } catch (err) {
        toast('Die 3D-Ansicht ließ sich nicht laden: ' + err.message, 'error');
        return false;
      }
      try {
        renderer = new T.WebGLRenderer({ canvas: el.canvas, antialias: true, alpha: true });
      } catch {
        toast('Dieser PC kann gerade kein WebGL (3D im Fenster). Grafiktreiber aktualisieren hilft meist.', 'error');
        return false;
      }
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      renderer.setClearColor(0x000000, 0);
      renderer.localClippingEnabled = true;
      if ('outputEncoding' in renderer) renderer.outputEncoding = T.sRGBEncoding;
      try {
        glow = makeGlow(T, renderer);
      } catch {
        glow = null; // dann eben ohne Leuchten
      }
      world = new T.Scene();
      camera = new T.PerspectiveCamera(35, 1, 0.01, 500);
      ctl.target = new T.Vector3(0, 0.8, 0);
      ctl.goal = { target: ctl.target.clone(), theta: ctl.theta, phi: ctl.phi, radius: ctl.radius };
      raycaster = new T.Raycaster();
      // Licht (nur für "Echt" wichtig)
      world.add(new T.HemisphereLight(0xe3f0ff, 0x1d3550, 0.95));
      const key = new T.DirectionalLight(0xffffff, 1.15);
      key.position.set(3, 5, 4);
      const rim = new T.DirectionalLight(0x9fd0ff, 0.45);
      rim.position.set(-4, 2, -3);
      world.add(key, rim);
      model = new T.Group();
      world.add(model);
      buildFloor();
      // Laser, der ein neues Teil von unten nach oben aufbaut
      laser = new T.Mesh(new T.RingGeometry(0.98, 1, 64), new T.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending,
      }));
      laser.rotation.x = -Math.PI / 2;
      world.add(laser);
      new ResizeObserver(resize).observe(el.stage);
      resize();
      bindPointer();
      return true;
    }

    function disposeTree(root) {
      root.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
          if (m.map) m.map.dispose();
          m.dispose();
        });
      });
    }

    // Weicher runder Punkt für die Funken
    function sparkTexture() {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.35, 'rgba(160,230,255,0.55)');
      grad.addColorStop(1, 'rgba(120,210,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      return new T.CanvasTexture(c);
    }

    const HOLO = 0x6fd6ff;
    const FLOOR_VERT = 'varying vec2 vP; void main(){ vP = (modelMatrix * vec4(position, 1.0)).xz; ' +
      'gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';

    // Der Projektor im Hologramm-Raum: Raster, das zur Mitte hin aufleuchtet, Ringe mit drehenden Bögen,
    // ein Lichtkegel nach oben und Funken, die darin aufsteigen
    function buildHoloFloor() {
      const color = new T.Color(HOLO);
      const shared = { uColor: { value: color }, uTime: { value: 0 } };
      const grid = new T.Mesh(new T.PlaneGeometry(14, 14), new T.ShaderMaterial({
        uniforms: shared, vertexShader: FLOOR_VERT, transparent: true, depthWrite: false, blending: T.AdditiveBlending,
        extensions: { derivatives: true },
        fragmentShader: `uniform vec3 uColor; uniform float uTime; varying vec2 vP;
          void main(){
            vec2 q = vP * 2.5; vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
            float fine = 1.0 - min(min(g.x, g.y), 1.0);
            vec2 Q = vP * 0.5; vec2 G = abs(fract(Q - 0.5) - 0.5) / fwidth(Q);
            float major = 1.0 - min(min(G.x, G.y), 1.0);
            float r = length(vP);
            float pulse = 0.65 + 0.35 * sin(r * 2.6 - uTime * 1.5);
            float a = (fine * 0.07 + major * 0.2) * smoothstep(6.5, 1.0, r) * pulse;
            gl_FragColor = vec4(uColor, a);
          }`,
      }));
      grid.rotation.x = -Math.PI / 2;
      floor.add(grid);
      const disc = new T.Mesh(new T.PlaneGeometry(4.6, 4.6), new T.ShaderMaterial({
        uniforms: shared, vertexShader: FLOOR_VERT, transparent: true, depthWrite: false, blending: T.AdditiveBlending,
        extensions: { derivatives: true },
        fragmentShader: `uniform vec3 uColor; uniform float uTime; varying vec2 vP;
          float ring(float r, float c, float w){ return smoothstep(w, 0.0, abs(r - c)); }
          void main(){
            float r = length(vP); float a = atan(vP.y, vP.x) / 6.28318 + 0.5;
            float v = ring(r, 1.42, 0.014) * 0.95 + ring(r, 1.49, 0.006) * 0.5 + ring(r, 0.42, 0.01) * 0.55;
            v += ring(r, 1.64, 0.02) * step(0.45, fract(a * 5.0 + uTime * 0.05)) * 0.75;
            v += ring(r, 1.84, 0.01) * step(0.62, fract(a * 16.0 - uTime * 0.09)) * 0.6;
            v += ring(r, 2.02, 0.005) * step(0.3, fract(a * 48.0 + uTime * 0.02)) * 0.35;
            v += step(0.9, fract(a * 72.0)) * step(1.52, r) * step(r, 1.58) * 0.75;
            v += smoothstep(1.4, 0.0, r) * 0.08;
            v += ring(r, mod(uTime * 0.7, 2.3), 0.06) * 0.22 * smoothstep(2.3, 0.2, r);
            gl_FragColor = vec4(uColor, v * smoothstep(2.3, 2.05, r));
          }`,
      }));
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.002;
      floor.add(disc);
      const H = 2.8;
      const cone = new T.Mesh(new T.CylinderGeometry(1.3, 1.42, H, 72, 1, true), new T.ShaderMaterial({
        uniforms: { ...shared, uH: { value: H } }, transparent: true, depthWrite: false, side: T.DoubleSide,
        blending: T.AdditiveBlending,
        vertexShader: 'uniform float uH; varying float vH; varying float vA; void main(){ vH = position.y / uH + 0.5; ' +
          'vA = atan(position.z, position.x); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `uniform vec3 uColor; uniform float uTime; varying float vH; varying float vA;
          void main(){
            float streak = 0.55 + 0.45 * sin(vA * 37.0 + uTime * 0.6) * sin(vA * 11.0 - uTime * 0.35);
            float a = 0.085 * pow(1.0 - vH, 2.2) * streak;
            gl_FragColor = vec4(uColor, a);
          }`,
      }));
      cone.position.y = H / 2;
      floor.add(cone);
      // Funken: steigen langsam im Lichtkegel auf
      const N = 240;
      const pos = new Float32Array(N * 3);
      const speed = new Float32Array(N);
      for (let i = 0; i < N; i += 1) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * 1.3;
        pos[i * 3] = Math.cos(a) * r;
        pos[i * 3 + 1] = Math.random() * H;
        pos[i * 3 + 2] = Math.sin(a) * r;
        speed[i] = 0.05 + Math.random() * 0.18;
      }
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(pos, 3));
      const points = new T.Points(geo, new T.PointsMaterial({
        size: 0.045, map: sparkTexture(), color: HOLO, transparent: true, opacity: 0.75, depthWrite: false,
        blending: T.AdditiveBlending, sizeAttenuation: true,
      }));
      floor.add(points);
      sparks = { points, speed, H };
      floor.userData.uniforms = shared;
    }

    function buildFloor() {
      if (floor) {
        world.remove(floor);
        disposeTree(floor);
      }
      floor = new T.Group();
      sparks = null;
      // Hologramm und Echt: dunkler Raum im Bild selbst (für das Leuchten), Papier: das Blatt dahinter scheint durch
      renderer.setClearColor(view.look === 'blau' ? 0x000000 : 0x03070c, view.look === 'blau' ? 0 : 1);
      renderer.toneMapping = view.look === 'echt' ? T.ACESFilmicToneMapping : T.NoToneMapping;
      world.environment = view.look === 'echt' ? studioEnvironment() : null;
      if (view.look === 'holo') {
        buildHoloFloor();
        world.add(floor);
        return;
      }
      const look = view.look;
      const color = look === 'holo' ? 0x7fd8ff : look === 'echt' ? 0x9fb6d6 : 0xffffff;
      const grid = new T.GridHelper(8, 32, color, color);
      grid.material.transparent = true;
      grid.material.opacity = look === 'blau' ? 0.16 : 0.22;
      grid.material.depthWrite = false;
      floor.add(grid);
      // Projektorringe am Boden mit Teilstrichen
      for (const [r, o] of [[1.4, 0.55], [1.9, 0.3], [2.6, 0.16]]) {
        const ring = new T.Mesh(new T.RingGeometry(r - 0.006, r, 128), new T.MeshBasicMaterial({
          color, transparent: true, opacity: o, side: T.DoubleSide, depthWrite: false,
          blending: look === 'holo' ? T.AdditiveBlending : T.NormalBlending,
        }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.001;
        floor.add(ring);
      }
      const ticks = [];
      for (let i = 0; i < 72; i += 1) {
        const a = (i / 72) * Math.PI * 2;
        const r1 = 1.4;
        const r2 = i % 6 === 0 ? 1.52 : 1.46;
        ticks.push(Math.cos(a) * r1, 0.002, Math.sin(a) * r1, Math.cos(a) * r2, 0.002, Math.sin(a) * r2);
      }
      const tg = new T.BufferGeometry();
      tg.setAttribute('position', new T.Float32BufferAttribute(ticks, 3));
      const tickLines = new T.LineSegments(tg, new T.LineBasicMaterial({ color, transparent: true, opacity: 0.6 }));
      tickLines.name = 'ticks';
      floor.add(tickLines);
      if (look === 'holo') {
        // Lichtkegel des Projektors
        const cone = new T.Mesh(new T.CylinderGeometry(1.2, 1.45, 2.4, 64, 1, true), new T.ShaderMaterial({
          transparent: true, depthWrite: false, side: T.DoubleSide, blending: T.AdditiveBlending,
          uniforms: { uColor: { value: new T.Color(0x7fd8ff) } },
          vertexShader: 'varying float vH; void main(){ vH = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
          fragmentShader: 'uniform vec3 uColor; varying float vH; void main(){ float a = 0.09 * (1.0 - smoothstep(-1.2, 1.2, vH)); gl_FragColor = vec4(uColor, a); }',
        }));
        cone.position.y = 1.2;
        floor.add(cone);
      }
      if (look === 'echt') {
        // weicher Schatten unter dem Modell
        const c = document.createElement('canvas');
        c.width = c.height = 128;
        const g = c.getContext('2d');
        const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
        grad.addColorStop(0, 'rgba(0,10,30,0.55)');
        grad.addColorStop(1, 'rgba(0,10,30,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, 128, 128);
        const shadow = new T.Mesh(new T.PlaneGeometry(2.6, 2.6), new T.MeshBasicMaterial({
          map: new T.CanvasTexture(c), transparent: true, depthWrite: false,
        }));
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.y = 0.003;
        floor.add(shadow);
      }
      world.add(floor);
    }

    let studio = null;
    function studioEnvironment() {
      if (studio) return studio;
      const pmrem = new T.PMREMGenerator(renderer);
      const env = new T.Scene();
      env.add(new T.Mesh(new T.BoxGeometry(14, 9, 14), new T.MeshBasicMaterial({ color: 0x0d1724, side: T.BackSide })));
      const box = new T.BoxGeometry(1, 1, 1);
      for (const [color, x, y, z, sx, sy, sz] of [
        [0xffffff, 0, 4.3, 0, 7, 0.1, 3.5], [0x9fd8ff, -6.8, 1.6, 0, 0.1, 3.4, 7], [0xffd6a8, 6.8, 1.2, 1.2, 0.1, 2.4, 4.5],
        [0x6fb8ff, 0, 1.2, -6.8, 6, 1.6, 0.1],
      ]) {
        const m = new T.Mesh(box, new T.MeshBasicMaterial({ color }));
        m.position.set(x, y, z);
        m.scale.set(sx, sy, sz);
        env.add(m);
      }
      studio = pmrem.fromScene(env, 0.04).texture;
      pmrem.dispose();
      return studio;
    }

    function resize() {
      if (!renderer) return;
      const w = Math.max(1, el.stage.clientWidth);
      const h = Math.max(1, el.stage.clientHeight);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      // Die Mitte des Bildes in die Mitte der freien Fläche zwischen Teilen, Steuerung, Kopf und Fuß
      const stage = el.stage.getBoundingClientRect();
      const left = document.querySelector('.bp-parts');
      const right = document.querySelector('.bp-controls');
      const top = document.querySelector('.bp-top');
      const foot = document.querySelector('.bp-foot');
      let dx = 0;
      let dy = 0;
      fitFrac = Math.min(1, w / h);
      if (getComputedStyle(el.stage).position === 'absolute' && left && right && top && foot) {
        const l = left.getBoundingClientRect().right - stage.left;
        const r = right.getBoundingClientRect().left - stage.left;
        const t = top.getBoundingClientRect().bottom - stage.top;
        const b = foot.getBoundingClientRect().top - stage.top;
        dx = (l + r) / 2 - w / 2;
        dy = (t + b) / 2 - h / 2;
        fitFrac = clamp(Math.min(b - t, r - l) / h, 0.25, 1);
      }
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) camera.setViewOffset(w, h, -dx, -dy, w, h);
      else camera.clearViewOffset();
      camera.updateProjectionMatrix();
      if (glow) glow.setSize(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
    }

    // ------------------------------------------------------------ Teile

    function materialsFor(p, plane) {
      const look = LOOKS[view.look] || LOOKS.blau;
      const planes = plane ? [plane] : [];
      let solid;
      if (view.look === 'echt') {
        const kind = p.material || 'metall';
        const color = new T.Color(p.farbe || '#9ab');
        solid = new T.MeshStandardMaterial({
          color,
          metalness: kind === 'metall' ? 0.75 : kind === 'glas' ? 0.1 : 0.05,
          roughness: kind === 'metall' ? 0.32 : kind === 'glas' ? 0.05 : 0.75,
          transparent: kind === 'glas' || kind === 'holo',
          opacity: kind === 'glas' ? 0.38 : kind === 'holo' ? 0.55 : 1,
          emissive: kind === 'leuchten' ? color : new T.Color(0x000000),
          emissiveIntensity: kind === 'leuchten' ? 0.8 : 0,
          envMapIntensity: 1.6,
          side: T.DoubleSide,
          clippingPlanes: planes,
        });
      } else {
        const base = new T.Color(look.face);
        if (look.tint) base.lerp(new T.Color(p.farbe || look.face), 1 - look.tint);
        if (p.material === 'leuchten') base.lerp(new T.Color(p.farbe || '#fff'), 0.5);
        solid = new T.ShaderMaterial({
          uniforms: {
            uColor: { value: base },
            uOpacity: { value: look.faceOpacity * (p.material === 'glas' ? 0.5 : p.material === 'leuchten' ? 3 : 1) },
            uRim: { value: look.rim },
            uScan: { value: look.scan },
            uTime: { value: 0 },
            uSel: { value: 0 },
            uDim: { value: 0 },
            uTop: { value: 2 },
          },
          vertexShader: VERT,
          fragmentShader: FRAG,
          transparent: true,
          depthWrite: false,
          side: T.DoubleSide,
          blending: look.additive ? T.AdditiveBlending : T.NormalBlending,
          clipping: true,
          clippingPlanes: planes,
        });
      }
      const edgeColor = view.look === 'holo' && p.material === 'leuchten' ? new T.Color(p.farbe || look.edge).lerp(new T.Color('#ffffff'), 0.4)
        : new T.Color(look.edge);
      const edges = new T.LineBasicMaterial({
        color: edgeColor, transparent: true, opacity: look.edgeOpacity, depthWrite: false,
        blending: look.additive ? T.AdditiveBlending : T.NormalBlending, clippingPlanes: planes,
      });
      return { solid, edges };
    }

    function paint(o) {
      const sel = o.part.id === selected;
      const dim = view.focus && !view.focus.has(o.part.id);
      if (o.solid.material.uniforms) {
        o.solid.material.uniforms.uSel.value = sel ? 1 : 0;
        o.solid.material.uniforms.uDim.value = dim ? 1 : 0;
      } else {
        o.solid.material.emissive = sel ? new T.Color(HOT) : o.part.material === 'leuchten' ? new T.Color(o.part.farbe) : new T.Color(0);
        o.solid.material.emissiveIntensity = sel ? 0.35 : o.part.material === 'leuchten' ? 0.8 : 0;
        o.solid.material.opacity = dim ? 0.15 : (o.part.material === 'glas' ? 0.38 : o.part.material === 'holo' ? 0.55 : 1);
        o.solid.material.transparent = dim || o.part.material === 'glas' || o.part.material === 'holo';
      }
      const look = LOOKS[view.look] || LOOKS.blau;
      o.edges.material.color = new T.Color(sel ? HOT : look.edge);
      o.edges.material.opacity = dim ? look.edgeOpacity * 0.18 : sel ? 1 : look.edgeOpacity;
    }

    function addPart(p, animate) {
      const geo = geometryFor(T, p);
      if (!geo) return null;
      geo.computeBoundingBox();
      const group = new T.Group();
      const plane = animate && !reducedMotion() ? new T.Plane(new T.Vector3(0, -1, 0), -100) : null;
      const mats = materialsFor(p, plane);
      const solid = new T.Mesh(geo, mats.solid);
      solid.userData.partId = p.id;
      const edges = new T.LineSegments(new T.EdgesGeometry(geo, 24), mats.edges);
      group.add(solid, edges);
      group.position.set(...p.pos);
      group.rotation.set(rad(p.dreh[0]), rad(p.dreh[1]), rad(p.dreh[2]), 'XYZ');
      group.scale.set(...p.skala);
      group.updateMatrix();
      const box = geo.boundingBox.clone().applyMatrix4(group.matrix);
      const o = {
        part: p, group, solid, edges, plane, born: clock, box, center: box.getCenter(new T.Vector3()),
        base: group.position.clone(), offset: new T.Vector3(),
      };
      group.visible = !p.versteckt && (!view.isolate || view.isolate.has(p.id));
      model.add(group);
      objs.set(p.id, o);
      paint(o);
      return o;
    }

    function removePart(id) {
      const o = objs.get(id);
      if (!o) return;
      model.remove(o.group);
      o.solid.geometry.dispose();
      o.edges.geometry.dispose();
      o.solid.material.dispose();
      o.edges.material.dispose();
      objs.delete(id);
    }

    function restyle() {
      if (!T) return;
      for (const o of objs.values()) {
        o.solid.material.dispose();
        o.edges.material.dispose();
        const mats = materialsFor(o.part, o.plane);
        o.solid.material = mats.solid;
        o.edges.material = mats.edges;
        paint(o);
      }
      buildFloor();
    }

    // Python schickt das ganze Modell: nur ändern, was anders ist
    function sync(next, animateNew) {
      scene = { name: String(next.name || ''), beschreibung: String(next.beschreibung || ''),
        groesse_m: Number(next.groesse_m) || 0, teile: Array.isArray(next.teile) ? next.teile : [] };
      if (T) {
        const ids = new Set(scene.teile.map((p) => p.id));
        for (const id of [...objs.keys()]) if (!ids.has(id)) removePart(id);
        for (const p of scene.teile) {
          const o = objs.get(p.id);
          if (o && JSON.stringify(o.part) === JSON.stringify(p)) continue;
          if (o) removePart(p.id);
          addPart(p, animateNew && !o);
        }
        layoutExplode();
      }
      if (selected && !scene.teile.some((p) => p.id === selected)) selected = '';
      renderPanels();
    }

    function applyOp(op) {
      if (!op || typeof op !== 'object') return;
      if (op.op === 'neu') {
        sync({ name: op.name, beschreibung: op.beschreibung, groesse_m: op.groesse_m, teile: [] }, false);
        view.isolate = null;
        view.focus = null;
        return;
      }
      if (op.op === 'name') {
        scene.name = String(op.name || scene.name);
        scene.beschreibung = String(op.beschreibung || scene.beschreibung);
        if (op.groesse_m) scene.groesse_m = Number(op.groesse_m) || scene.groesse_m;
        renderPanels();
        return;
      }
      if (op.op === 'teil' && op.teil && op.teil.id) {
        const at = scene.teile.findIndex((p) => p.id === op.teil.id);
        if (at >= 0) scene.teile[at] = op.teil;
        else scene.teile.push(op.teil);
        if (T) {
          const was = objs.has(op.teil.id);
          removePart(op.teil.id);
          addPart(op.teil, !was);
          layoutExplode();
          fitAfter = clock + 0.15;
        }
        renderPanels();
        return;
      }
      if (op.op === 'entfernen') {
        scene.teile = scene.teile.filter((p) => p.id !== op.id);
        if (T) removePart(op.id);
        if (selected === op.id) selected = '';
        layoutExplode();
        renderPanels();
      }
    }

    // ------------------------------------------------------------ Explosionsansicht

    let topCache = { n: -1, y: 2 };
    function modelTop() {
      if (topCache.n !== objs.size + scene.teile.length) {
        const b = modelBox(false, false);
        topCache = { n: objs.size + scene.teile.length, y: Number.isFinite(b.max.y) ? b.max.y : 2 };
      }
      return topCache.y;
    }

    function modelBox(onlyVisible, withOffset) {
      const box = new T.Box3();
      for (const o of objs.values()) {
        if (onlyVisible && !o.group.visible) continue;
        const b = o.box.clone();
        if (withOffset) b.translate(o.offset.clone().multiplyScalar(explodeNow));
        box.union(b);
      }
      return box;
    }

    function layoutExplode() {
      topCache.n = -1;
      if (!T || !objs.size) return;
      const all = modelBox(false, false);
      const C = all.getCenter(new T.Vector3());
      const R = Math.max(0.3, all.getSize(new T.Vector3()).length() / 2);
      const groups = new Map();
      for (const o of objs.values()) {
        const key = o.part.gruppe || o.part.id;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(o);
      }
      let n = 0;
      let stacked = 0;
      for (const members of groups.values()) {
        const gb = new T.Box3();
        for (const o of members) gb.union(o.box);
        const gc = gb.getCenter(new T.Vector3());
        const dg = gc.clone().sub(C);
        if (dg.length() < R * 0.12) {
          // in der Mitte (symmetrische Baugruppen): abwechselnd nach oben und unten, jede auf eigener Höhe
          const level = Math.floor(stacked / 2) + 1;
          dg.set(0, (stacked % 2 === 0 ? 1 : -0.75) * level * R * 0.55, 0);
          stacked += 1;
        } else {
          dg.normalize().multiplyScalar(R * 0.65);
        }
        for (const o of members) {
          const dp = o.center.clone().sub(gc);
          const spread = members.length > 1 && dp.length() > 1e-4 ? dp.normalize().multiplyScalar(R * 0.22) : new T.Vector3();
          o.offset.copy(dg).add(spread);
        }
        n += 1;
      }
    }

    // ------------------------------------------------------------ Kamera

    function fit(ids, instant) {
      if (!T || !objs.size) return;
      const amount = view.explode ? 1 : 0; // auf das Endbild einpassen, nicht auf den Zwischenstand
      let box = new T.Box3();
      for (const o of objs.values()) {
        if (ids && ids.size ? !ids.has(o.part.id) : !o.group.visible) continue;
        box.union(o.box.clone().translate(o.offset.clone().multiplyScalar(amount)));
      }
      box = box.applyMatrix4(model.matrixWorld);
      if (box.isEmpty()) return;
      const size = box.getSize(new T.Vector3()).length();
      const center = box.getCenter(new T.Vector3());
      const dist = (size / 2) / (Math.tan(rad(camera.fov / 2)) * fitFrac) * 1.02;
      ctl.goal.target.copy(center);
      ctl.goal.radius = clamp(dist, 0.3, 60);
      if (instant) {
        ctl.target.copy(center);
        ctl.radius = ctl.goal.radius;
      }
    }

    const SIDES = {
      perspektive: [0.7, 1.12], vorne: [0, Math.PI / 2], hinten: [Math.PI, Math.PI / 2], seite: [Math.PI / 2, Math.PI / 2],
      rechts: [Math.PI / 2, Math.PI / 2], links: [-Math.PI / 2, Math.PI / 2], oben: [0, 0.02], unten: [0, Math.PI - 0.02],
    };

    function camTo(side) {
      const s = SIDES[side] || SIDES.perspektive;
      // auf dem kürzesten Weg drehen
      let theta = s[0];
      while (theta - ctl.goal.theta > Math.PI) theta -= Math.PI * 2;
      while (ctl.goal.theta - theta > Math.PI) theta += Math.PI * 2;
      ctl.goal.theta = theta;
      ctl.goal.phi = s[1];
      turn.goalX = 0;
      fit(null);
      markSide(side);
    }

    function markSide(side) {
      for (const b of el.views.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.side === side));
    }

    // ------------------------------------------------------------ Maus und Finger

    function bindPointer() {
      const pts = new Map();
      let moved = 0;
      let mode = '';
      let pinch = 0;
      let mid = null;
      const c = el.canvas;
      c.addEventListener('contextmenu', (e) => e.preventDefault());
      c.addEventListener('pointerdown', (e) => {
        c.setPointerCapture(e.pointerId);
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        moved = 0;
        mode = e.button === 2 || e.shiftKey || e.button === 1 ? 'pan' : 'rotate';
        if (pts.size === 2) {
          const [a, b] = [...pts.values()];
          pinch = Math.hypot(a.x - b.x, a.y - b.y);
          mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          mode = 'pinch';
        }
        c.classList.add('dragging');
        ctl.touched = clock;
      });
      c.addEventListener('pointermove', (e) => {
        if (!pts.has(e.pointerId)) {
          hover(e);
          return;
        }
        const prev = pts.get(e.pointerId);
        const dx = e.clientX - prev.x;
        const dy = e.clientY - prev.y;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        moved += Math.abs(dx) + Math.abs(dy);
        ctl.touched = clock;
        if (mode === 'pinch' && pts.size >= 2) {
          const [a, b] = [...pts.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (pinch > 0 && d > 0) ctl.goal.radius = clamp(ctl.goal.radius * (pinch / d), 0.3, 60);
          pinch = d;
          const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          if (mid) pan(m.x - mid.x, m.y - mid.y);
          mid = m;
          return;
        }
        if (mode === 'pan') {
          pan(dx, dy);
          return;
        }
        ctl.goal.theta -= dx * 0.0085;
        ctl.goal.phi = clamp(ctl.goal.phi - dy * 0.0085, 0.02, Math.PI - 0.02);
        markSide('');
      });
      const up = (e) => {
        if (!pts.has(e.pointerId)) return;
        pts.delete(e.pointerId);
        if (pts.size < 2) {
          pinch = 0;
          mid = null;
          if (pts.size === 1) mode = 'rotate';
        }
        if (!pts.size) c.classList.remove('dragging');
        if (moved < 6 && e.type === 'pointerup') pick(e, false);
      };
      c.addEventListener('pointerup', up);
      c.addEventListener('pointercancel', up);
      c.addEventListener('dblclick', (e) => pick(e, true));
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        ctl.goal.radius = clamp(ctl.goal.radius * Math.exp(e.deltaY * 0.0011), 0.3, 60);
        ctl.touched = clock;
      }, { passive: false });
    }

    // Handsteuerung (handsteuerung.js): greifen und ziehen dreht, zwei Hände zoomen, wie mit der Maus
    function gesture(g) {
      if (!isOpen || !ctl.goal) return;
      ctl.touched = clock;
      if (g.kind === 'drag') {
        ctl.goal.theta -= g.dx * 0.0085;
        ctl.goal.phi = clamp(ctl.goal.phi - g.dy * 0.0085, 0.02, Math.PI - 0.02);
        markSide('');
      } else if (g.kind === 'zoom' && g.factor > 0) {
        ctl.goal.radius = clamp(ctl.goal.radius / g.factor, 0.3, 60);
      } else if (g.kind === 'twist') {
        ctl.goal.theta -= g.angle;
      }
    }

    function pan(dx, dy) {
      const h = Math.max(1, el.stage.clientHeight);
      const scale = (2 * ctl.radius * Math.tan(rad(camera.fov / 2))) / h;
      const right = new T.Vector3().setFromMatrixColumn(camera.matrix, 0);
      const upv = new T.Vector3().setFromMatrixColumn(camera.matrix, 1);
      ctl.goal.target.addScaledVector(right, -dx * scale).addScaledVector(upv, dy * scale);
    }

    function hit(e) {
      const r = el.canvas.getBoundingClientRect();
      const ndc = new T.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const solids = [...objs.values()].filter((o) => o.group.visible).map((o) => o.solid);
      const found = raycaster.intersectObjects(solids, false);
      return found.length ? found[0].object.userData.partId : '';
    }

    let hoverAt = 0;
    function hover(e) {
      if (!T || clock - hoverAt < 0.05) return;
      hoverAt = clock;
      el.canvas.classList.toggle('hovering', !!hit(e));
    }

    function pick(e, close) {
      if (!T) return;
      const id = hit(e);
      select(id, true);
      if (close && id) focus(new Set([id]));
    }

    // ------------------------------------------------------------ Auswahl, Fokus

    function select(id, tell) {
      selected = id && objs.has(id) ? id : '';
      for (const o of objs.values()) paint(o);
      renderSelection();
      renderTree();
      if (tell) call('blueprint_select', selected).catch(() => {});
    }

    function focus(ids) {
      view.focus = ids && ids.size ? ids : null;
      for (const o of objs.values()) paint(o);
      fit(view.focus);
      ctl.touched = clock;
    }

    function isolate(ids) {
      view.isolate = ids && ids.size ? ids : null;
      view.focus = null;
      for (const o of objs.values()) {
        o.group.visible = !o.part.versteckt && (!view.isolate || view.isolate.has(o.part.id));
        paint(o);
      }
      fit(view.isolate);
    }

    // ------------------------------------------------------------ Zeichnen

    function loop(now) {
      frame = requestAnimationFrame(loop);
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
      last = now;
      clock += dt;
      const k = 1 - Math.exp(-dt * 7);
      // Kamera weich nachführen
      ctl.theta += (ctl.goal.theta - ctl.theta) * k;
      ctl.phi += (ctl.goal.phi - ctl.phi) * k;
      ctl.radius += (ctl.goal.radius - ctl.radius) * k;
      ctl.target.lerp(ctl.goal.target, k);
      const sp = Math.sin(ctl.phi);
      camera.position.set(
        ctl.target.x + ctl.radius * sp * Math.sin(ctl.theta),
        ctl.target.y + ctl.radius * Math.cos(ctl.phi),
        ctl.target.z + ctl.radius * sp * Math.cos(ctl.theta),
      );
      camera.lookAt(ctl.target);
      // Modell drehen (Befehl "Dreh es" und Dauerdrehen)
      if (view.spin && !reducedMotion()) turn.goalY += dt * 0.45;
      turn.y += (turn.goalY - turn.y) * k;
      turn.x += (turn.goalX - turn.x) * k;
      model.rotation.set(turn.x, turn.y, 0);
      model.updateMatrixWorld(true);
      // Explosion
      const want = view.explode ? 1 : 0;
      explodeNow += (want - explodeNow) * (1 - Math.exp(-dt * 5));
      // Teile: Lage, Aufbau mit dem Laser, Zeit für die Scanlinien
      let newest = null;
      const top = objs.size ? modelTop() : 2;
      for (const o of objs.values()) {
        o.group.position.copy(o.base).addScaledVector(o.offset, explodeNow);
        if (o.plane) {
          const t = clamp((clock - o.born) / 0.75, 0, 1);
          const wb = o.box.clone().translate(o.offset.clone().multiplyScalar(explodeNow)).applyMatrix4(model.matrixWorld);
          const y = wb.min.y + (wb.max.y - wb.min.y + 0.02) * (1 - Math.pow(1 - t, 2));
          o.plane.constant = y;
          if (t < 1) newest = { y, box: wb };
          else {
            o.plane = null;
            o.solid.material.clippingPlanes = [];
            o.edges.material.clippingPlanes = [];
            o.solid.material.needsUpdate = true;
            o.edges.material.needsUpdate = true;
          }
        }
        if (o.solid.material.uniforms) {
          o.solid.material.uniforms.uTime.value = clock;
          o.solid.material.uniforms.uTop.value = top;
        }
      }
      if (newest) {
        const s = newest.box.getSize(new T.Vector3());
        const c = newest.box.getCenter(new T.Vector3());
        laser.position.set(c.x, newest.y, c.z);
        laser.scale.setScalar(Math.max(0.05, Math.hypot(s.x, s.z) * 0.62));
        laser.material.opacity = 0.9;
        laser.material.color.set(view.look === 'holo' ? 0x7fd8ff : view.look === 'echt' ? 0xffcf6e : 0xffffff);
      } else {
        laser.material.opacity *= 0.85;
      }
      const ticks = floor.getObjectByName('ticks');
      if (ticks && !reducedMotion()) ticks.rotation.y += dt * 0.12;
      if (floor.userData.uniforms && !reducedMotion()) floor.userData.uniforms.uTime.value = clock;
      if (sparks && !reducedMotion()) {
        const attr = sparks.points.geometry.attributes.position;
        for (let i = 0; i < sparks.speed.length; i += 1) {
          let y = attr.array[i * 3 + 1] + sparks.speed[i] * dt;
          if (y > sparks.H) y -= sparks.H;
          attr.array[i * 3 + 1] = y;
        }
        attr.needsUpdate = true;
      }
      // Nach neuen Teilen das Bild nachführen, solange Georg nicht selbst dreht
      if (fitAfter && clock > fitAfter) {
        fitAfter = 0;
        if (clock - ctl.touched > 4) fit(view.focus || view.isolate);
      }
      if (glow && view.look !== 'blau') glow.render(world, camera, clock, view.look === 'holo' ? 0.7 : 0.4, view.look === 'holo' ? 0.72 : 0.85);
      else renderer.render(world, camera);
      drawOverlay();
      drawGizmo();
      reportView();
    }

    // Den Blickwinkel aufs Modell an Jarvis melden: "Render das" fotografiert dann genau so.
    // Azimut 0 = von vorne, 90 = von rechts; Höhe in Grad über dem Boden (Drehung des Modells eingerechnet).
    let viewSent = { az: null, el: 0, checked: -10 };
    function reportView() {
      if (clock - viewSent.checked < 0.5) return;
      viewSent.checked = clock;
      const sp = Math.sin(ctl.phi);
      const d = new T.Vector3(sp * Math.sin(ctl.theta), Math.cos(ctl.phi), sp * Math.cos(ctl.theta));
      d.applyQuaternion(new T.Quaternion().setFromEuler(new T.Euler(turn.x, turn.y, 0)).invert());
      const az = Math.atan2(d.x, d.z) * 180 / Math.PI;
      const el = Math.asin(clamp(d.y, -1, 1)) * 180 / Math.PI;
      const moved = viewSent.az === null ? 999 : Math.abs(((az - viewSent.az + 540) % 360) - 180) + Math.abs(el - viewSent.el);
      if (moved < 2) return;
      viewSent.az = az;
      viewSent.el = el;
      call('blueprint_view', { azimut: Math.round(az * 10) / 10, hoehe: Math.round(el * 10) / 10 }).catch(() => {});
    }

    function start() {
      if (!frame && renderer) {
        last = 0;
        frame = requestAnimationFrame(loop);
      }
    }

    function stop() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }

    function project(v) {
      const p = v.clone().project(camera);
      return { x: (p.x + 1) / 2 * el.stage.clientWidth, y: (1 - p.y) / 2 * el.stage.clientHeight, z: p.z };
    }

    function svgEl(name, attrs, text) {
      const n = document.createElementNS(SVG_NS, name);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
      if (text) n.textContent = text;
      return n;
    }

    // Maßlinien und Beschriftung über dem Bild
    let tagEls = new Map();
    function drawOverlay() {
      const nodes = [];
      const scale = scaleMeters();
      if (view.dims && objs.size && explodeNow < 0.05 && !view.focus && el.stage.clientWidth >= 520) {
        const box = modelBox(true, false).applyMatrix4(model.matrixWorld);
        if (!box.isEmpty()) {
          const size = box.getSize(new T.Vector3());
          const centerS = project(box.getCenter(new T.Vector3()));
          const P = (x, y, z) => project(new T.Vector3(x ? box.max.x : box.min.x, y ? box.max.y : box.min.y, z ? box.max.z : box.min.z));
          const mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
          // Breite: die untere Kante entlang x, die auf dem Bild am weitesten unten liegt
          const widths = [0, 1].map((z) => [P(0, 0, z), P(1, 0, z)]).sort((u, v) => mid(v[0], v[1]).y - mid(u[0], u[1]).y);
          // Tiefe: die untere Kante entlang z, am weitesten rechts
          const depths = [0, 1].map((x) => [P(x, 0, 0), P(x, 0, 1)]).sort((u, v) => mid(v[0], v[1]).x - mid(u[0], u[1]).x);
          // Höhe: die senkrechte Kante, die am weitesten rechts steht
          const heights = [[0, 0], [0, 1], [1, 0], [1, 1]].map(([x, z]) => [P(x, 0, z), P(x, 1, z)])
            .sort((u, v) => mid(v[0], v[1]).x - mid(u[0], u[1]).x);
          nodes.push(...dimension(widths[0][0], widths[0][1], centerS, 'B ' + fmtLen(size.x, scale)));
          nodes.push(...dimension(depths[0][0], depths[0][1], centerS, 'T ' + fmtLen(size.z, scale)));
          nodes.push(...dimension(heights[0][0], heights[0][1], centerS, 'H ' + fmtLen(size.y, scale)));
        }
      }
      // Beschriftung: Baugruppen (sonst Teile), bei Explosion oder auf Wunsch
      const want = (view.labels || explodeNow > 0.5) && objs.size;
      const seen = new Set();
      if (want) {
        const groups = new Map();
        for (const o of objs.values()) {
          if (!o.group.visible) continue;
          const key = o.part.gruppe || o.part.name;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(o);
        }
        const list = [...groups.entries()].slice(0, 16);
        const placed = [];
        const cs = project(modelBox(true, true).applyMatrix4(model.matrixWorld).getCenter(new T.Vector3()));
        for (const [name, members] of list) {
          const gb = new T.Box3();
          for (const o of members) gb.union(o.box.clone().translate(o.offset.clone().multiplyScalar(explodeNow)));
          gb.applyMatrix4(model.matrixWorld);
          const p = project(gb.getCenter(new T.Vector3()));
          if (p.z > 1) continue;
          let dx = p.x - cs.x;
          let dy = p.y - cs.y;
          const len = Math.hypot(dx, dy) || 1;
          dx /= len;
          dy /= len;
          const lx = p.x + dx * 64;
          const ly = p.y + dy * 44 - 6;
          nodes.push(svgEl('circle', { cx: p.x, cy: p.y, r: 2.5, class: 'arrow' }));
          let tag = tagEls.get(name);
          if (!tag) {
            tag = document.createElement('span');
            tag.className = 'bp-tag' + (members[0].part.gruppe ? '' : ' dim');
            tag.textContent = name;
            el.labels.appendChild(tag);
            tagEls.set(name, tag);
          }
          seen.add(name);
          const w = tag.offsetWidth;
          const x = Math.round(dx < 0 ? lx - w : lx);
          let y = Math.round(ly - 10);
          // nicht übereinander: so lange verschieben, bis Platz ist
          for (let tries = 0; tries < 10; tries += 1) {
            const clash = placed.find((r) => x < r.x + r.w + 6 && x + w + 6 > r.x && y < r.y + 24 && y + 24 > r.y);
            if (!clash) break;
            y = dy < 0 ? clash.y - 26 : clash.y + 26;
          }
          placed.push({ x, y, w });
          nodes.push(svgEl('polyline', { points: `${p.x},${p.y} ${dx < 0 ? x + w : x},${y + 11}`, class: 'leader' }));
          tag.style.transform = `translate(${x}px, ${y}px)`;
          tag.style.opacity = '1';
        }
      }
      for (const [name, tag] of tagEls) {
        if (!seen.has(name)) {
          tag.remove();
          tagEls.delete(name);
        }
      }
      el.overlay.replaceChildren(...nodes);
    }

    function dimension(p, q, center, text) {
      if (p.z > 1 || q.z > 1) return [];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      if (len < 30) return [];
      let nx = -(q.y - p.y) / len;
      let ny = (q.x - p.x) / len;
      const mx = (p.x + q.x) / 2;
      const my = (p.y + q.y) / 2;
      if ((mx - center.x) * nx + (my - center.y) * ny < 0) {
        nx = -nx;
        ny = -ny;
      }
      const off = 26;
      const a = { x: p.x + nx * off, y: p.y + ny * off };
      const b = { x: q.x + nx * off, y: q.y + ny * off };
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      const arrow = (pt, dir) => {
        const s = 8;
        const w = 3;
        return svgEl('polygon', {
          points: `${pt.x},${pt.y} ${pt.x + dir * ux * s - uy * w},${pt.y + dir * uy * s + ux * w} ${pt.x + dir * ux * s + uy * w},${pt.y + dir * uy * s - ux * w}`,
          class: 'arrow',
        });
      };
      let angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      const tx = (a.x + b.x) / 2 + nx * 12;
      const ty = (a.y + b.y) / 2 + ny * 12;
      return [
        svgEl('line', { x1: p.x + nx * 4, y1: p.y + ny * 4, x2: p.x + nx * (off + 6), y2: p.y + ny * (off + 6) }),
        svgEl('line', { x1: q.x + nx * 4, y1: q.y + ny * 4, x2: q.x + nx * (off + 6), y2: q.y + ny * (off + 6) }),
        svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y }),
        arrow(a, 1),
        arrow(b, -1),
        svgEl('text', {
          x: tx, y: ty, class: 'dim-text', 'text-anchor': 'middle', 'dominant-baseline': 'middle',
          transform: `rotate(${angle.toFixed(1)} ${tx} ${ty})`,
        }, text),
      ];
    }

    // Kleine Achsen unten (x rot, y grün, z blau), wie in jedem CAD-Programm
    function drawGizmo() {
      const g = el.gizmo.getContext('2d');
      const s = el.gizmo.width;
      g.clearRect(0, 0, s, s);
      const q = camera.quaternion.clone().invert();
      const rot = new T.Quaternion().setFromEuler(new T.Euler(turn.x, turn.y, 0));
      const axes = [['x', [1, 0, 0], '#ff8a80'], ['y', [0, 1, 0], '#b9f6ca'], ['z', [0, 0, 1], '#82b1ff']]
        .map(([n, v, col]) => {
          const p = new T.Vector3(...v).applyQuaternion(rot).applyQuaternion(q);
          return { n, p, col };
        })
        .sort((a, b) => a.p.z - b.p.z);
      const c = s / 2;
      g.lineWidth = 2;
      g.font = '600 11px ui-monospace, Consolas, monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (const a of axes) {
        const x = c + a.p.x * 30;
        const y = c - a.p.y * 30;
        g.strokeStyle = a.col;
        g.globalAlpha = a.p.z < -0.2 ? 0.45 : 1;
        g.beginPath();
        g.moveTo(c, c);
        g.lineTo(x, y);
        g.stroke();
        g.fillStyle = a.col;
        g.fillText(a.n.toUpperCase(), c + a.p.x * 40, c - a.p.y * 40);
      }
      g.globalAlpha = 1;
    }

    function scaleMeters() {
      const h = Number(scene.groesse_m) || 0;
      if (!h || !objs.size) return 0;
      const box = modelBox(false, false);
      const units = box.max.y - box.min.y;
      return units > 1e-6 ? h / units : 0;
    }

    // ------------------------------------------------------------ Seitenteile

    function renderPanels() {
      el.name.textContent = scene.name || (busy ? 'Konstruiere …' : 'Neue Konstruktion');
      el.name.title = scene.beschreibung || '';
      const n = scene.teile.length;
      el.partCount.textContent = n ? String(n) : '';
      el.treeEmpty.hidden = n > 0;
      el.empty.hidden = n > 0 || busy;
      el.blockName.textContent = scene.name || '–';
      el.blockParts.textContent = String(n);
      el.blockDate.textContent = today();
      if (T && n) {
        const size = modelBox(false, false).getSize(new T.Vector3());
        el.blockSize.textContent = fmtSize([size.x, size.y, size.z], scaleMeters());
      } else {
        el.blockSize.textContent = '–';
      }
      renderTree();
      renderSelection();
    }

    const shownInTree = new Set();
    function renderTree() {
      const groups = new Map();
      for (const p of scene.teile) {
        const key = p.gruppe || '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      }
      const items = [];
      for (const [name, parts] of groups) {
        if (name && groups.size > 1) {
          const h = document.createElement('li');
          h.className = 'grp';
          h.textContent = name;
          items.push(h);
        }
        for (const p of parts) {
          const li = document.createElement('li');
          const b = document.createElement('button');
          b.type = 'button';
          if (p.versteckt) b.classList.add('hidden-part');
          b.setAttribute('aria-current', String(p.id === selected));
          const dot = document.createElement('span');
          dot.className = 'dot';
          dot.style.background = p.farbe || '#fff';
          const nm = document.createElement('span');
          nm.className = 'name';
          nm.textContent = p.name || p.id;
          const form = document.createElement('span');
          form.className = 'form';
          form.textContent = p.form;
          b.append(dot, nm, form);
          if (shownInTree.has(p.id)) b.style.animation = 'none';
          shownInTree.add(p.id);
          b.title = (p.name || p.id) + (p.versteckt ? ' (ausgeblendet)' : '') + ': klicken wählt, doppelt klicken holt heran';
          b.addEventListener('click', () => select(p.id === selected ? '' : p.id, true));
          b.addEventListener('dblclick', () => {
            select(p.id, true);
            focus(new Set([p.id]));
          });
          li.appendChild(b);
          items.push(li);
        }
      }
      el.tree.replaceChildren(...items);
    }

    const SWATCHES = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#f5f5f5', '#9e9e9e', '#212121', '#ffc107', '#7fd8ff'];
    let removeArmed = 0;
    function renderSelection() {
      const p = scene.teile.find((x) => x.id === selected);
      el.sel.hidden = !p;
      if (!p) return;
      el.selName.textContent = p.name || p.id;
      const o = objs.get(p.id);
      let info = p.form + (p.gruppe ? ' · ' + p.gruppe : '') + ' · ' + (p.material || 'metall');
      if (o && T) {
        const s = o.box.getSize(new T.Vector3());
        const sc = scaleMeters();
        info += '\n' + fmtSize([s.x, s.y, s.z], sc);
      }
      el.selInfo.textContent = info;
      el.selInfo.style.whiteSpace = 'pre-line';
      el.selHide.textContent = p.versteckt ? 'Einblenden' : 'Ausblenden';
      el.swatches.replaceChildren(...SWATCHES.map((c) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.style.background = c;
        b.title = 'Farbe ' + c;
        b.setAttribute('aria-label', 'Farbe ' + c);
        b.addEventListener('click', () => edit(p.id, { farbe: c }));
        return b;
      }));
      el.selRemove.classList.remove('armed');
      el.selRemove.textContent = 'Entfernen';
      removeArmed = 0;
    }

    async function edit(id, changes) {
      try {
        const next = await call('blueprint_edit', id, changes);
        if (next && next.scene) sync(next.scene, false);
      } catch {
        toast('Jarvis ist gerade nicht verbunden.', 'error');
      }
    }

    function setBusy(on, text) {
      busy = !!on;
      el.chip.dataset.state = busy ? 'busy' : scene.teile.length ? 'ready' : 'idle';
      el.chipText.textContent = busy ? 'Konstruiert' : scene.teile.length ? 'Fertig' : 'Bereit';
      el.scan.hidden = !busy;
      if (el.pill) el.pill.dataset.state = busy ? 'busy' : 'idle';
      mic();
      if (busy && text) say('Konstruiere: „' + text + '“ …');
      renderPanels();
    }

    function say(text) {
      if (text) el.say.textContent = String(text);
    }

    // Hört Jarvis gerade zu? Am offenen Blueprint redet Georg ohne "Hey Jarvis" weiter (app.js meldet Zustand
    // und Gespräch). Nie nur Farbe: immer ein Wort dazu.
    let micState = 'idle';
    let micTalking = false;
    function mic(state, talking) {
      if (state !== undefined) micState = String(state || 'idle');
      if (talking !== undefined) micTalking = !!talking;
      if (!el.mic) return;
      const listening = micState === 'listening';
      const working = micState === 'thinking' || busy;
      el.mic.dataset.state = listening ? 'listening' : working ? 'working' : 'idle';
      el.micText.textContent = listening ? 'Ich höre zu' : micState === 'speaking' ? 'Spricht'
        : working ? 'Arbeitet' : micTalking ? 'Sprich einfach' : 'Sag „Jarvis“';
    }

    // ------------------------------------------------------------ Befehle aus Python

    async function applyView(ev) {
      switch (ev.what) {
        case 'explode':
          view.explode = !!ev.on;
          el.explode.setAttribute('aria-pressed', String(view.explode));
          setTimeout(() => fit(view.focus || view.isolate), 120);
          break;
        case 'spin':
          view.spin = !!ev.on;
          el.spin.setAttribute('aria-pressed', String(view.spin));
          break;
        case 'rotate':
          if (ev.axis === 'x') turn.goalX = clamp(turn.goalX + rad(ev.degrees), -Math.PI / 2, Math.PI / 2);
          else turn.goalY += rad(ev.degrees);
          break;
        case 'zoom':
          ctl.goal.radius = clamp(ctl.goal.radius * (Number(ev.factor) || 1), 0.3, 60);
          ctl.touched = clock;
          break;
        case 'camera':
          camTo(ev.side);
          break;
        case 'reset':
          view.focus = null;
          view.isolate = null;
          turn.goalX = 0;
          turn.goalY = Math.round(turn.goalY / (Math.PI * 2)) * Math.PI * 2;
          for (const o of objs.values()) {
            o.group.visible = !o.part.versteckt;
            paint(o);
          }
          camTo('perspektive');
          break;
        case 'look':
          setLook(ev.mode);
          break;
        case 'labels':
          view.labels = !!ev.on;
          el.labelsBtn.setAttribute('aria-pressed', String(view.labels));
          break;
        case 'focus': {
          const ids = new Set((ev.ids || []).map(String));
          if (ids.size === 1) select([...ids][0], false);
          focus(ids);
          break;
        }
        case 'isolate':
          isolate(new Set((ev.ids || []).map(String)));
          break;
        default:
      }
    }

    function setLook(mode) {
      const m = { draht: 'blau', blau: 'blau', papier: 'blau', holo: 'holo', echt: 'echt' }[mode] || 'holo';
      view.look = m;
      el.bp.dataset.look = m;
      for (const b of el.look.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.look === m));
      restyle();
    }

    async function exportStl() {
      if (!T || !scene.teile.length) {
        toast('Auf dem Tisch liegt noch nichts.', 'info');
        return;
      }
      const buf = stlFromParts(T, scene.teile, scene);
      try {
        const r = await call('blueprint_export', scene.name || 'Blueprint', toBase64(buf));
        if (r && r.ok) {
          toast('STL gespeichert: ' + r.path, 'ok');
          say('Die STL-Datei liegt im Blueprint-Ordner, Sir. Bereit für den 3D-Drucker.');
        } else {
          toast((r && r.error) || 'Der Export ging nicht.', 'error');
        }
      } catch {
        // Ohne Jarvis: die Datei direkt herunterladen
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([buf], { type: 'model/stl' }));
        a.download = (scene.name || 'blaupause').replace(/[^\wäöüß-]+/gi, '-') + '.stl';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }
    }

    function showLibrary(items) {
      const list = Array.isArray(items) ? items : [];
      photoHide();
      el.lib.hidden = false;
      el.libEmpty.hidden = list.length > 0;
      el.libList.replaceChildren(...list.map((it) => {
        const li = document.createElement('li');
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'open';
        const b = document.createElement('b');
        b.textContent = it.name;
        const s = document.createElement('small');
        s.textContent = it.teile + ' Teile' + (it.gespeichert ? ' · ' + String(it.gespeichert).replace('T', ' ') : '');
        open.append(b, s);
        open.addEventListener('click', async () => {
          try {
            const next = await call('blueprint_load', it.datei);
            if (next && next.scene) {
              sync(next.scene, true);
              fitAfter = clock + 0.3;
              el.lib.hidden = true;
              say(it.name + ' liegt auf dem Tisch, Sir.');
            } else {
              toast('Der Blueprint ließ sich nicht laden.', 'error');
            }
          } catch {
            toast('Jarvis ist gerade nicht verbunden.', 'error');
          }
        });
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'bp-btn danger';
        del.textContent = '×';
        del.title = 'Löschen (zweimal klicken)';
        del.setAttribute('aria-label', it.name + ' löschen');
        let armed = 0;
        del.addEventListener('click', async () => {
          if (Date.now() - armed > 3000) {
            armed = Date.now();
            del.classList.add('armed');
            toast('Nochmal klicken, um „' + it.name + '“ zu löschen.', 'info');
            return;
          }
          try {
            await call('blueprint_delete', it.datei);
            library();
          } catch {
            toast('Das ging gerade nicht.', 'error');
          }
        });
        li.append(open, del);
        return li;
      }));
    }

    async function library() {
      try {
        showLibrary(await call('blueprint_library'));
      } catch {
        showLibrary([]);
      }
    }

    function handle(ev) {
      if (!ev || typeof ev !== 'object') return;
      switch (ev.action) {
        case 'open':
          open(ev, true);
          break;
        case 'close':
          close(true);
          break;
        case 'scene':
          if (ev.scene) sync(ev.scene, true);
          if (typeof ev.selected === 'string') select(ev.selected, false);
          fitAfter = clock + 0.2;
          break;
        case 'op':
          applyOp(ev.op);
          break;
        case 'busy':
          setBusy(true, ev.text);
          if (!isOpen) open(null, true);
          break;
        case 'done':
          setBusy(false);
          if (ev.scene) sync(ev.scene, false);
          if (ev.ok) {
            if (ev.said) say(ev.said);
            fitAfter = clock + 0.2;
          } else if (ev.cancelled) {
            say('Angehalten, Sir.');
          } else {
            el.chip.dataset.state = 'error';
            el.chipText.textContent = 'Fehler';
            say('Das ging leider nicht: ' + (ev.error || 'unbekannter Fehler'));
          }
          break;
        case 'view':
          if (renderer) applyView(ev);
          else pendingViews.push(ev);
          break;
        case 'export':
          exportStl();
          break;
        case 'library':
          if (!isOpen) open(null, true);
          showLibrary(ev.items);
          break;
        case 'saved':
          toast('Gespeichert: ' + (ev.name || 'Blueprint'), 'ok');
          break;
        case 'render':
          photoEvent(ev);
          break;
        default:
      }
    }

    // ------------------------------------------------------------ Foto aus Blender

    // Python schickt render: install | start | progress | done | error | cancelled (Foto), blend | opened (Blender)
    let photoBusy = false;
    const PHOTO_INFO = 'Mit Grafikkarte dauert es Sekunden, nur mit Prozessor bis zu zwei Minuten. Sie können derweil weiterbauen.';

    function duration(s) {
      const n = Math.max(0, Math.round(Number(s) || 0));
      return n < 60 ? n + ' s' : Math.floor(n / 60) + ' min' + (n % 60 ? ' ' + (n % 60) + ' s' : '');
    }

    function deviceName(d) {
      const text = String(d || '');
      if (!text) return '';
      if (/^CPU/i.test(text)) return 'Prozessor';
      const inner = text.match(/\((.+)\)/);
      return 'Grafikkarte' + (inner ? ' ' + inner[1] : '');
    }

    function photoShow(waiting) {
      el.lib.hidden = true;
      el.photo.hidden = false;
      el.photoWait.hidden = !waiting;
      el.photoImg.hidden = waiting;
      el.photoAgain.disabled = photoBusy;
      stop(); // das Foto deckt das Modell zu: die Grafikkarte gehört solange Blender
    }

    function photoHide() {
      if (el.photo.hidden) return;
      el.photo.hidden = true;
      if (isOpen) start();
    }

    function photoProgress(text, percent, info) {
      el.photoState.textContent = text;
      el.photoBar.hidden = false;
      el.photoBar.dataset.state = percent == null ? 'wait' : 'run';
      const p = clamp(Number(percent) || 0, 0, 100);
      el.photoBar.firstElementChild.style.width = percent == null ? '' : p + '%';
      el.photoBar.setAttribute('aria-valuenow', String(Math.round(p)));
      if (info != null) el.photoInfo.textContent = info;
    }

    function renderBusy(on, percent) {
      photoBusy = on;
      el.render.dataset.state = on ? 'busy' : '';
      el.render.textContent = on ? (percent == null ? 'Foto …' : 'Foto ' + Math.round(percent) + ' %') : 'Foto';
      el.photoAgain.disabled = on;
    }

    async function photoDone(ev) {
      el.photoHead.textContent = ev.name || scene.name || 'Foto';
      try {
        const r = await call('blueprint_photo');
        if (!r || !r.ok || !/^data:image\/(?:jpeg|png);base64,/.test(String(r.src || ''))) throw new Error((r && r.error) || '');
        el.photoImg.src = r.src;
        const device = deviceName(r.device || ev.device);
        const took = Number(r.seconds || ev.seconds) > 0 ? 'Gerendert in ' + duration(r.seconds || ev.seconds) : '';
        const meta = [took, device, 'liegt im Blueprint-Ordner unter „Fotos“'].filter(Boolean).join(' · ');
        el.photoMeta.textContent = meta.charAt(0).toUpperCase() + meta.slice(1);
        photoShow(false);
      } catch (err) {
        photoShow(true);
        photoProgress('Das Foto ließ sich nicht anzeigen', null, (err && err.message) || 'Es liegt trotzdem im Ordner „Fotos“.');
        el.photoBar.hidden = true;
      }
    }

    function photoEvent(ev) {
      const blend = ev.kind === 'blend';
      switch (ev.state) {
        case 'install':
          renderBusy(true);
          if (blend) {
            toast('Blender wird installiert. Das dauert ein paar Minuten.', 'info');
            break;
          }
          photoShow(true);
          photoProgress('Blender wird installiert …', null, 'Einmalig, dauert ein paar Minuten. Windows fragt vielleicht nach Ihrer Erlaubnis.');
          break;
        case 'start':
          renderBusy(true, 0);
          el.photoHead.textContent = ev.name || scene.name || 'Foto';
          photoShow(true);
          photoProgress('Blender rendert …', 0, PHOTO_INFO);
          break;
        case 'progress': {
          if (ev.note === 'kerne') {
            // Blender lädt seine Rechenkerne (auf der Grafikkarte beim ersten Mal langsam)
            renderBusy(true);
            photoProgress('Blender bereitet das Rendern vor …', null,
              'Beim ersten Mal kann das ein paar Minuten dauern, danach geht es schnell.');
            break;
          }
          const p = clamp(Number(ev.percent) || 0, 0, 100);
          renderBusy(true, p);
          const rest = Number(ev.rest);
          photoProgress('Blender rendert … ' + Math.round(p) + ' %', p, rest > 0 ? 'Noch etwa ' + duration(rest) + '.' : null);
          break;
        }
        case 'done':
          renderBusy(false);
          photoDone(ev);
          break;
        case 'error':
          renderBusy(false);
          el.blender.disabled = false;
          if (blend) {
            toast('Blender: ' + (ev.error || 'Das ging nicht.'), 'error');
            break;
          }
          photoShow(true);
          photoProgress('Das ging nicht', null, ev.error || 'Einzelheiten stehen im Protokoll.');
          el.photoBar.hidden = true;
          break;
        case 'cancelled':
          renderBusy(false);
          el.blender.disabled = false;
          photoHide();
          break;
        case 'blend':
          renderBusy(false);
          el.blender.disabled = true;
          toast('Blender öffnet sich gleich mit dem Modell.', 'info');
          break;
        case 'opened':
          el.blender.disabled = false;
          toast('In Blender geöffnet. Die Datei liegt im Blueprint-Ordner unter „Blender“.', 'ok');
          break;
        default:
      }
    }

    async function renderPhoto() {
      if (photoBusy) {
        photoShow(true);
        return;
      }
      if (!scene.teile.length) {
        toast('Auf dem Tisch liegt noch nichts.', 'info');
        return;
      }
      try {
        say(await call('blueprint_render'));
      } catch {
        toast('Im Demo-Modus gibt es kein Blender.', 'info');
      }
    }

    async function openBlender() {
      if (!scene.teile.length) {
        toast('Auf dem Tisch liegt noch nichts.', 'info');
        return;
      }
      try {
        say(await call('blueprint_blender'));
      } catch {
        toast('Im Demo-Modus gibt es kein Blender.', 'info');
      }
    }

    // ------------------------------------------------------------ Öffnen und Schließen

    async function open(data, fromPython) {
      clearTimeout(closeTimer);
      if (opts.onOpen) opts.onOpen();
      const was = isOpen;
      isOpen = true;
      el.bp.hidden = false;
      el.bp.classList.remove('closing');
      if (!was && !reducedMotion()) {
        el.bp.classList.add('opening');
        setTimeout(() => el.bp.classList.remove('opening'), 260);
      }
      el.body.dataset.view = 'blueprint';
      if (opts.onView) opts.onView('blueprint');
      if (!fromPython) call('blueprint_active', true).catch(() => {});
      let state = data;
      if ((!state || !state.scene) && !fromPython) {
        try {
          state = await call('blueprint_state');
        } catch {
          state = null;
        }
      }
      if (state && state.scene) {
        sync(state.scene, false);
        if (typeof state.selected === 'string') selected = state.selected;
        setBusy(!!state.busy);
      }
      renderPanels();
      if (!(await ensure3D())) return;
      if (!objs.size && scene.teile.length) {
        // Erst jetzt ist three.js da: alles zeichnen, was inzwischen auf dem Tisch liegt
        sync(scene, true);
        select(selected, false);
        fit(null, true);
        camTo('perspektive');
      }
      while (pendingViews.length) applyView(pendingViews.shift());
      resize();
      start();
      if (!was) setTimeout(() => el.input.focus({ preventScroll: true }), 280);
    }

    function close(fromPython) {
      if (!isOpen) return;
      isOpen = false;
      el.lib.hidden = true;
      el.photo.hidden = true;
      el.bp.classList.add('closing');
      closeTimer = setTimeout(() => {
        if (isOpen) return;
        el.bp.hidden = true;
        el.bp.classList.remove('closing');
        stop();
      }, 170);
      el.body.dataset.view = 'hud';
      if (opts.onView) opts.onView('hud');
      if (!fromPython) call('blueprint_active', false).catch(() => {});
    }

    // ------------------------------------------------------------ Knöpfe

    el.back.addEventListener('click', () => close(false));
    if (el.pill) el.pill.addEventListener('click', () => open(null, false));
    el.look.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-look]');
      if (b) setLook(b.dataset.look);
    });
    el.views.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-side]');
      if (b && T) camTo(b.dataset.side);
    });
    const toggle = (btn, key, after) => btn.addEventListener('click', () => {
      view[key] = !view[key];
      btn.setAttribute('aria-pressed', String(view[key]));
      if (after) after();
    });
    toggle(el.spin, 'spin');
    toggle(el.explode, 'explode', () => setTimeout(() => fit(view.focus || view.isolate), 120));
    toggle(el.labelsBtn, 'labels');
    toggle(el.dims, 'dims');
    const scaleBy = (factor) => send(factor > 1 ? 'Mach das größer' : 'Mach das kleiner');
    el.bigger.addEventListener('click', () => scaleBy(1.25));
    el.smaller.addEventListener('click', () => scaleBy(0.8));
    el.undo.addEventListener('click', async () => {
      try {
        say(await call('blueprint_undo', false));
      } catch {
        toast('Jarvis ist gerade nicht verbunden.', 'error');
      }
    });
    el.redo.addEventListener('click', async () => {
      try {
        say(await call('blueprint_undo', true));
      } catch {
        toast('Jarvis ist gerade nicht verbunden.', 'error');
      }
    });
    el.selFocus.addEventListener('click', () => {
      if (selected) focus(new Set([selected]));
    });
    el.selHide.addEventListener('click', () => {
      const p = scene.teile.find((x) => x.id === selected);
      if (p) edit(p.id, { versteckt: !p.versteckt });
    });
    el.selRemove.addEventListener('click', () => {
      if (!selected) return;
      if (Date.now() - removeArmed > 3500) {
        removeArmed = Date.now();
        el.selRemove.classList.add('armed');
        el.selRemove.textContent = 'Wirklich?';
        return;
      }
      edit(selected, { entfernen: true });
    });
    el.newBtn.addEventListener('click', () => send('Neuer Blueprint'));
    el.save.addEventListener('click', async () => {
      try {
        const r = await call('blueprint_save', scene.name || '');
        toast(r && r.ok ? 'Gespeichert: ' + r.name : (r && r.error) || 'Speichern ging nicht.', r && r.ok ? 'ok' : 'error');
      } catch {
        toast('Jarvis ist gerade nicht verbunden.', 'error');
      }
    });
    el.exportBtn.addEventListener('click', exportStl);
    el.render.addEventListener('click', renderPhoto);
    el.photoAgain.addEventListener('click', renderPhoto);
    el.blender.addEventListener('click', openBlender);
    el.photoBlender.addEventListener('click', openBlender);
    el.photoClose.addEventListener('click', photoHide);
    el.photoFolder.addEventListener('click', async () => {
      try {
        const ok = await call('blueprint_folder', 'Fotos');
        toast(ok ? 'Der Fotos-Ordner öffnet sich.' : 'Das ging nicht.', ok ? 'ok' : 'error');
      } catch {
        toast('Im Demo-Modus öffnet sich kein Ordner.', 'info');
      }
    });
    el.libBtn.addEventListener('click', () => (el.lib.hidden ? library() : (el.lib.hidden = true)));
    el.libClose.addEventListener('click', () => { el.lib.hidden = true; });
    el.folder.addEventListener('click', async () => {
      try {
        const ok = await call('blueprint_folder');
        toast(ok ? 'Der Blueprint-Ordner öffnet sich.' : 'Das ging nicht.', ok ? 'ok' : 'error');
      } catch {
        toast('Im Demo-Modus öffnet sich kein Ordner.', 'info');
      }
    });

    // Die Befehlszeile: geht an Jarvis wie Gesprochenes (bei offener Blaupause zuerst ans Modell)
    async function send(text) {
      const t = String(text || '').trim();
      if (!t) return;
      try {
        await call('send_text', t);
      } catch {
        toast('Jarvis ist gerade nicht verbunden.', 'error');
      }
    }
    el.input.addEventListener('input', () => { el.send.disabled = !el.input.value.trim(); });
    el.cmd.addEventListener('submit', (e) => {
      e.preventDefault();
      const t = el.input.value.trim();
      if (!t) return;
      el.input.value = '';
      el.send.disabled = true;
      send(t);
    });
    el.chips.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) send(b.textContent);
    });

    document.addEventListener('keydown', (e) => {
      if (!isOpen || e.defaultPrevented) return;
      if (e.key === 'Escape') {
        if (!el.photo.hidden) photoHide();
        else if (!el.lib.hidden) el.lib.hidden = true;
        else close(false);
        e.preventDefault();
        return;
      }
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(String(e.target && e.target.tagName));
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        (e.shiftKey ? el.redo : el.undo).click();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        el.redo.click();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const keys = {
        r: () => el.spin.click(), e: () => el.explode.click(), l: () => el.labelsBtn.click(), m: () => el.dims.click(),
        f: () => (selected ? focus(new Set([selected])) : fit(null)), 1: () => camTo('perspektive'), 2: () => camTo('vorne'),
        3: () => camTo('seite'), 4: () => camTo('oben'), '+': () => el.bigger.click(), '-': () => el.smaller.click(),
        Delete: () => el.selRemove.click(),
      };
      const fn = keys[e.key];
      if (fn && T) {
        e.preventDefault();
        fn();
      }
    });

    renderPanels();
    return { handle, gesture, open: () => open(null, false), close: () => close(false), isOpen: () => isOpen, say, mic };
  }

  // ==================================================================
  //   Demo ohne Jarvis: eine Aufklärungsdrohne, die sich Teil für Teil aufbaut
  // ==================================================================

  function demoScene() {
    const P = [];
    const add = (p) => P.push(Object.assign({ dreh: [0, 0, 0], skala: [1, 1, 1], material: 'metall' }, p));
    const oct = [];
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      oct.push([Math.round(Math.cos(a) * 0.36 * 1000) / 1000, Math.round(Math.sin(a) * 0.36 * 1000) / 1000]);
    }
    add({ id: 'rumpf', name: 'Rumpfplatte', gruppe: 'Rumpf', form: 'extrusion', umriss: oct, tiefe: 0.12, fase: 0.02,
      pos: [0, 0.55, 0], dreh: [90, 0, 0], farbe: '#cfd8dc' });
    add({ id: 'haube', name: 'Haube', gruppe: 'Rumpf', form: 'kugel', masse: [0.3], skala: [1, 0.42, 1], pos: [0, 0.62, 0],
      farbe: '#90a4ae', material: 'glas' });
    add({ id: 'reaktor', name: 'Energiekern', gruppe: 'Rumpf', form: 'zylinder', masse: [0.08, 0.08, 0.04], pos: [0, 0.73, 0],
      farbe: '#7fd8ff', material: 'leuchten' });
    add({ id: 'akku', name: 'Akku', gruppe: 'Elektronik', form: 'quader', masse: [0.3, 0.09, 0.46], rundung: 0.02, pos: [0, 0.44, 0],
      farbe: '#37474f', material: 'matt' });
    // Kühlrippen hinten: eine Platte mit Schlitzen (extrusion mit loecher)
    const slots = [-0.075, -0.025, 0.025, 0.075].map((x) => [[x - 0.012, -0.03], [x + 0.012, -0.03], [x + 0.012, 0.03], [x - 0.012, 0.03]]);
    add({ id: 'kuehlung', name: 'Kühlrippen', gruppe: 'Elektronik', form: 'extrusion', umriss: [[-0.12, -0.05], [0.12, -0.05], [0.12, 0.05], [-0.12, 0.05]],
      loecher: slots, tiefe: 0.012, fase: 0.004, pos: [0, 0.47, -0.235], farbe: '#546e7a' });
    add({ id: 'anzeige', name: 'Statusanzeige', gruppe: 'Elektronik', form: 'quader', masse: [0.1, 0.012, 0.05], rundung: 0.005,
      pos: [0, 0.69, -0.17], farbe: '#7fd8ff', material: 'leuchten' });
    add({ id: 'platine', name: 'Flugsteuerung', gruppe: 'Elektronik', form: 'quader', masse: [0.22, 0.02, 0.22], pos: [0, 0.505, 0],
      farbe: '#2e7d32', material: 'matt' });
    const corners = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
    corners.forEach(([sx, sz], i) => {
      const n = i + 1;
      const yaw = sx * sz > 0 ? -45 : 45;
      add({ id: `arm_${n}`, name: `Arm ${n}`, gruppe: 'Arme', form: 'quader', masse: [0.62, 0.05, 0.08], rundung: 0.022,
        pos: [sx * 0.42, 0.55, sz * 0.42], dreh: [0, yaw, 0], farbe: '#455a64' });
      add({ id: `motor_${n}`, name: `Motor ${n}`, gruppe: 'Antrieb', form: 'zylinder', masse: [0.075, 0.075, 0.12],
        pos: [sx * 0.74, 0.6, sz * 0.74], farbe: '#b0bec5' });
      add({ id: `nabe_${n}`, name: `Nabe ${n}`, gruppe: 'Antrieb', form: 'kegel', masse: [0.035, 0.05], pos: [sx * 0.74, 0.685, sz * 0.74],
        farbe: '#eceff1' });
      add({ id: `rotor_${n}_a`, name: `Rotor ${n}`, gruppe: 'Antrieb', form: 'quader', masse: [0.56, 0.008, 0.05],
        pos: [sx * 0.74, 0.67, sz * 0.74], dreh: [0, 20 + i * 35, 0], farbe: '#263238', material: 'matt' });
      add({ id: `schutz_${n}`, name: `Rotorschutz ${n}`, gruppe: 'Antrieb', form: 'ring', masse: [0.31, 0.012], pos: [sx * 0.74, 0.67, sz * 0.74],
        dreh: [90, 0, 0], farbe: '#cfd8dc' });
      add({ id: `licht_${n}`, name: sz > 0 ? `Frontlicht ${n}` : `Rücklicht ${n}`, gruppe: 'Lichter', form: 'kugel', masse: [0.025],
        pos: [sx * 0.74, 0.52, sz * 0.74], farbe: sz > 0 ? '#7fd8ff' : '#ff5252', material: 'leuchten' });
    });
    add({ id: 'gimbal', name: 'Gimbal', gruppe: 'Kamera', form: 'ring', masse: [0.1, 0.014], pos: [0, 0.34, 0.26], farbe: '#90a4ae' });
    add({ id: 'kamera', name: 'Kamera', gruppe: 'Kamera', form: 'kugel', masse: [0.085], pos: [0, 0.34, 0.26], farbe: '#263238' });
    add({ id: 'linse', name: 'Linse', gruppe: 'Kamera', form: 'zylinder', masse: [0.045, 0.05, 0.05], pos: [0, 0.34, 0.34],
      dreh: [90, 0, 0], farbe: '#7fd8ff', material: 'glas' });
    add({ id: 'halter', name: 'Kamerahalter', gruppe: 'Kamera', form: 'zylinder', masse: [0.02, 0.02, 0.12], pos: [0, 0.42, 0.26],
      farbe: '#607d8b' });
    for (const sx of [-1, 1]) {
      add({ id: `kufe_${sx > 0 ? 'r' : 'l'}`, name: `Kufe ${sx > 0 ? 'rechts' : 'links'}`, gruppe: 'Fahrwerk', form: 'rohr',
        pfad: [[0, 0.4, -0.32], [0.05, 0.12, -0.36], [0.05, 0.03, -0.24], [0.05, 0.03, 0.24], [0.05, 0.12, 0.36], [0, 0.4, 0.32]]
          .map(([x, y, z]) => [x * sx, y, z]),
        radius: 0.018, pos: [sx * 0.26, 0, 0], farbe: '#78909c' });
    }
    add({ id: 'antenne', name: 'Antenne', gruppe: 'Elektronik', form: 'zylinder', masse: [0.008, 0.008, 0.26], pos: [0.14, 0.82, -0.2],
      dreh: [-12, 0, 0], farbe: '#b0bec5' });
    add({ id: 'antenne_spitze', name: 'Antennenspitze', gruppe: 'Elektronik', form: 'kugel', masse: [0.018], pos: [0.14, 0.95, -0.23],
      farbe: '#ff5252', material: 'leuchten' });
    return { name: 'Aufklärungsdrohne MK II', beschreibung: 'Quadrocopter mit Kamera-Gimbal, Rotorschutz und Kufen.',
      groesse_m: 0.36, teile: P };
  }

  // Wie blaupause.py, nur im Browser: für den Demo-Modus und die Bildschirmfotos
  function demoApi(push) {
    let scene = { name: '', beschreibung: '', teile: [] };
    let selected = '';
    let busy = false;
    const undo = [];
    const ev = (action, data) => push(Object.assign({ type: 'blueprint', action }, data || {}));
    const state = () => ({ scene: JSON.parse(JSON.stringify(scene)), selected, busy, active: true });
    const build = (text) => {
      if (busy) return;
      busy = true;
      undo.push(JSON.parse(JSON.stringify(scene)));
      const full = demoScene();
      scene = { name: full.name, beschreibung: full.beschreibung, groesse_m: full.groesse_m, teile: [] };
      ev('busy', { text, fresh: true });
      ev('op', { op: { op: 'neu', name: full.name, beschreibung: full.beschreibung, groesse_m: full.groesse_m } });
      full.teile.forEach((p, i) => setTimeout(() => {
        scene.teile.push(p);
        ev('op', { op: { op: 'teil', teil: p } });
        if (i === full.teile.length - 1) {
          busy = false;
          ev('done', Object.assign({ ok: true, said: `${full.name} steht, Sir: ${full.teile.length} Teile.` }, state()));
        }
      }, 120 + i * 90));
    };
    const local = (t) => {
      const n = t.toLowerCase();
      if (/explosion|zerleg|auseinander/.test(n)) return ev('view', { what: 'explode', on: true }) || 'Explosionsansicht, Sir.';
      if (/zusammen/.test(n)) return ev('view', { what: 'explode', on: false }) || 'Wieder zusammengesetzt, Sir.';
      if (/^dreh/.test(n)) return ev('view', { what: 'rotate', axis: 'y', degrees: Number((n.match(/(\d+) ?grad/) || [])[1]) || 45 }) || 'Gedreht, Sir.';
      if (/zoom (rein|ran)|näher/.test(n)) return ev('view', { what: 'zoom', factor: 0.7 }) || 'Näher heran, Sir.';
      if (/zoom raus|weiter weg/.test(n)) return ev('view', { what: 'zoom', factor: 1.45 }) || 'Etwas Abstand, Sir.';
      if (/größer|kleiner/.test(n)) {
        const f = /größer/.test(n) ? 1.25 : 0.8;
        undo.push(JSON.parse(JSON.stringify(scene)));
        for (const p of scene.teile) {
          p.skala = p.skala.map((s) => s * f);
          p.pos = [p.pos[0] * f, p.pos[1] * f, p.pos[2] * f];
        }
        ev('scene', state());
        return `Das Modell ist jetzt ${Math.round(Math.abs(f - 1) * 100)} Prozent ${f > 1 ? 'größer' : 'kleiner'}, Sir.`;
      }
      if (/leere blaupause/.test(n)) {
        undo.push(JSON.parse(JSON.stringify(scene)));
        scene = { name: '', beschreibung: '', teile: [] };
        ev('scene', state());
        return 'Der Tisch ist frei, Sir.';
      }
      if (/generier|bau|konstruier|erstell|drohne|helm/.test(n)) {
        build(t);
        return 'Sehr wohl, Sir. Ich konstruiere es. Sehen Sie zu.';
      }
      return '';
    };
    return {
      handles: (t) => local(t),
      api: {
        blueprint_state: () => Promise.resolve(state()),
        blueprint_active: () => Promise.resolve(true),
        blueprint_select: (id) => {
          selected = String(id || '');
          return Promise.resolve(scene.teile.find((p) => p.id === selected) || null);
        },
        blueprint_edit: (id, changes) => {
          undo.push(JSON.parse(JSON.stringify(scene)));
          if (changes && changes.entfernen) scene.teile = scene.teile.filter((p) => p.id !== id);
          else scene.teile = scene.teile.map((p) => (p.id === id ? Object.assign({}, p, changes) : p));
          return Promise.resolve(state());
        },
        blueprint_undo: (redo) => {
          if (redo || !undo.length) return Promise.resolve('Da gibt es nichts, Sir.');
          scene = undo.pop();
          ev('scene', state());
          return Promise.resolve('Rückgängig gemacht, Sir.');
        },
        blueprint_cancel: () => Promise.resolve(false),
        blueprint_save: () => Promise.resolve({ ok: true, name: scene.name || 'Blueprint', path: 'Demo' }),
        blueprint_library: () => Promise.resolve([{ name: 'Aufklärungsdrohne MK II', datei: 'drohne.json', teile: 41, gespeichert: '2026-10-02T16:10' },
          { name: 'Arc-Reaktor', datei: 'arc-reaktor.json', teile: 18, gespeichert: '2026-10-01T21:40' }]),
        blueprint_load: () => {
          scene = demoScene();
          return Promise.resolve(state());
        },
        blueprint_delete: () => Promise.resolve(true),
        blueprint_export: () => Promise.reject(new Error('Demo')),
        blueprint_folder: () => Promise.reject(new Error('Demo')),
        blueprint_render: () => {
          if (!window.JarvisDemoPhoto) return Promise.reject(new Error('Demo'));
          ev('render', { state: 'start', kind: 'foto', name: scene.name });
          [18, 46, 73, 100].forEach((p, i) => setTimeout(() => ev('render', { state: 'progress', kind: 'foto', percent: p,
            rest: (3 - i) * 2 }), 300 + i * 300));
          setTimeout(() => ev('render', { state: 'done', kind: 'foto', name: scene.name }), 1500);
          return Promise.resolve('Ich rendere es, Sir.');
        },
        blueprint_photo: () => (window.JarvisDemoPhoto
          ? Promise.resolve({ ok: true, src: window.JarvisDemoPhoto })
          : Promise.reject(new Error('Demo'))),
        blueprint_blender: () => Promise.reject(new Error('Demo')),
        blueprint_view: (v) => {
          window.JarvisDemoView = v; // für Tests: der zuletzt gemeldete Blickwinkel
          return Promise.resolve(true);
        },
      },
      build,
      load: () => {
        scene = demoScene();
        return state();
      },
    };
  }

  window.JarvisBlaupause = { create, demoScene, demoApi, stlFromParts, geometryFor };
})();
