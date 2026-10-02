/* ==========================================================================
   Jarvis – Weltlage („Gottes Auge“)
   Eine Satelliten-Erde wie in Google Earth, im Stil von J.A.R.V.I.S.: Python (weltlage.py) holt die
   Meldungen samt Ort, diese Seite fliegt von Ort zu Ort, während Jarvis vorliest.
     weltlage  open | close | loading | news | focus | fly | markets | layer | view | done
   Die Erde zeichnet three.js (vendor/three.min.js, erst beim ersten Öffnen geladen). Die grobe Karte liegt
   in Jarvis (vendor/erde.jpg), feinere Satellitenbilder kommen beim Heranzoomen von EOX (Sentinel-2
   cloudless). Ohne Internet bleibt die grobe Karte. Alle Flächen liegen auf einer Kugel und werden der
   Reihe nach gezeichnet (gröbere zuerst), darum braucht es keinen Tiefenpuffer und nichts flimmert.
   Maus: ziehen verschiebt, Rad zoomt, rechts ziehen dreht und kippt, Doppelklick fliegt hin.
   Texte aus Meldungen kommen nur als Klartext (textContent) auf die Seite.
   ========================================================================== */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const DEG = Math.PI / 180;
  const R_KM = 6371;
  const BASE_URL = 'vendor/erde.jpg';
  const TILE_URL = (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/${z}/${y}/${x}.jpg`;
  const MIN_Z = 4; // darunter reicht die eingebaute Karte (Zoomstufe 3)
  const MAX_Z = 15;
  const MAX_LOADS = 6;
  const MAX_TILES = 380;
  const MAX_SHOWN = 230;
  const MERC_LAT = 85.05112878;
  const MIN_ALT = 0.0005; // etwa 3 km über dem Boden
  const MAX_ALT = 4.2;
  const FOV = 40;
  const PLANES_MAX = 700;
  const motionMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reducedMotion = () => !!(motionMQ && motionMQ.matches);

  let THREE = null;

  // three.js teilt sich die Erde mit der Blaupause: Lädt die es gerade, warten beide auf dieselbe Datei
  function loadThree() {
    if (window.THREE) {
      THREE = window.THREE;
      return Promise.resolve(THREE);
    }
    return new Promise((resolve, reject) => {
      const done = () => {
        if (window.THREE) resolve(THREE = window.THREE);
        else reject(new Error('three.js fehlt'));
      };
      const fail = () => reject(new Error('three.js ließ sich nicht laden'));
      let s = [...document.scripts].find((x) => /vendor\/three\.min\.js$/.test(x.src || ''));
      if (!s) {
        s = document.createElement('script');
        s.src = 'vendor/three.min.js';
        document.head.appendChild(s);
      }
      s.addEventListener('load', done, { once: true });
      s.addEventListener('error', fail, { once: true });
      setTimeout(() => (window.THREE ? done() : null), 0);
      setTimeout(() => (window.THREE ? done() : fail()), 20000);
    });
  }

  // ------------------------------------------------------------------ Mathematik

  const mercLat = (yNorm) => Math.atan(Math.sinh(Math.PI * (1 - 2 * yNorm))) / DEG; // 0 = Norden, 1 = Süden
  const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function toVec(T, lat, lon, r, out) {
    const la = lat * DEG;
    const lo = lon * DEG;
    const c = Math.cos(la);
    const k = r || 1;
    return (out || new T.Vector3()).set(c * Math.sin(lo) * k, Math.sin(la) * k, c * Math.cos(lo) * k);
  }

  function toLatLon(v) {
    const r = Math.max(1e-9, Math.hypot(v.x, v.y, v.z));
    return { lat: Math.asin(clamp(v.y / r, -1, 1)) / DEG, lon: Math.atan2(v.x, v.z) / DEG };
  }

  // Flughöhe, aus der ein Ort mit dieser Ausdehnung gut zu sehen ist (in Erdradien)
  const altFor = (km) => clamp((Number(km) || 300) * 2.4 / R_KM, 0.0012, 3.2);

  // Je näher, desto schräger der Blick (wie ein Flugzeugfenster), aus dem All senkrecht
  function tiltFor(alt) {
    const t = clamp((Math.log10(alt) + 2.6) / 2.6, 0, 1);
    return 1.0 * Math.pow(1 - t, 0.8);
  }

  function tileBounds(z, x, y) {
    const n = 2 ** z;
    return { w: (x / n) * 360 - 180, e: ((x + 1) / n) * 360 - 180, n: mercLat(y / n), s: mercLat((y + 1) / n) };
  }

  // Eine Kachel als gewölbtes Stück Kugel (uv passt genau zum Mercator-Bild der Kachel)
  function tileGeometry(T, z, x, y, segs) {
    const n = 2 ** z;
    const count = (segs + 1) * (segs + 1);
    const pos = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    let p = 0;
    let q = 0;
    for (let j = 0; j <= segs; j++) {
      const la = mercLat((y + j / segs) / n) * DEG;
      const c = Math.cos(la);
      const sy = Math.sin(la);
      for (let i = 0; i <= segs; i++) {
        const lo = (((x + i / segs) / n) * 360 - 180) * DEG;
        pos[p++] = c * Math.sin(lo);
        pos[p++] = sy;
        pos[p++] = c * Math.cos(lo);
        uv[q++] = i / segs;
        uv[q++] = 1 - j / segs;
      }
    }
    const index = [];
    for (let j = 0; j < segs; j++) {
      for (let i = 0; i < segs; i++) {
        const a = j * (segs + 1) + i;
        const c = a + segs + 1;
        index.push(a, c, a + 1, a + 1, c, c + 1);
      }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setAttribute('uv', new T.BufferAttribute(uv, 2));
    g.setIndex(index);
    g.computeBoundingSphere();
    return g;
  }

  function planeShape(T) {
    const s = new T.Shape();
    const pts = [[0, 1], [0.12, 0.55], [0.95, 0.05], [0.95, -0.1], [0.12, 0.1], [0.1, -0.6], [0.38, -0.85],
      [0.38, -0.97], [0, -0.88]];
    s.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
    for (let i = pts.length - 2; i > 0; i--) s.lineTo(-pts[i][0], pts[i][1]);
    s.closePath();
    return new T.ShapeGeometry(s);
  }

  const fmtNum = (v, digits) => Number(v).toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const fmtLat = (v) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? 'N' : 'S'}`;
  const fmtLon = (v) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? 'O' : 'W'}`;
  function fmtAlt(alt) {
    const km = alt * R_KM;
    return km >= 100 ? `${fmtNum(km, 0)} km` : `${fmtNum(km, 1)} km`;
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  const MONTHS = ['JAN', 'FEB', 'MÄR', 'APR', 'MAI', 'JUN', 'JUL', 'AUG', 'SEP', 'OKT', 'NOV', 'DEZ'];
  const DAYS = ['SO', 'MO', 'DI', 'MI', 'DO', 'FR', 'SA'];

  // ------------------------------------------------------------------ Die Ansicht

  function create(opts) {
    const call = opts.call;
    const toast = opts.toast || (() => {});
    const root = $('wl');
    if (!root) return null;
    const el = {
      root,
      stage: $('wlStage'), canvas: $('wlCanvas'), marks: $('wlMarks'), boot: $('wlBoot'),
      target: $('wlTarget'), lat: $('wlLat'), lon: $('wlLon'), alt: $('wlAlt'), clock: $('wlClock'),
      newsTitle: $('wlNewsTitle'), newsCount: $('wlNewsCount'), list: $('wlList'), empty: $('wlEmpty'),
      markets: $('wlMarketList'), marketsBox: $('wlMarkets'), sub: $('wlSub'), status: $('wlStatus'),
      search: $('wlSearch'), searchIn: $('wlSearchIn'), flightsBtn: $('wlFlights'), handsBtn: $('wlHands'),
      closeBtn: $('wlClose'), kinds: root.querySelectorAll('.wl-kinds button'), newsBox: $('wlNewsBox'),
      pill: $('wlPill'),
    };

    let isOpen = false;
    let T = null;
    let renderer = null;
    let scene = null;
    let camera = null;
    let base = null; // die ganze Erde aus erde.jpg
    let holo = null; // Hologramm-Punkte beim Start
    let rings = null;
    let grid = null;
    let atmo = null;
    let planesMesh = null;
    let ready = false;
    let raf = 0;
    let last = 0;
    let clock = 0;
    let fade = 1; // 0 = Hologramm, 1 = Satellitenbild
    let fadeGoal = 1;
    let maxAniso = 1;

    const cam = { lat: 47, lon: 12, alt: 3.0, heading: 0, tiltBias: 0 };
    let flight = null; // laufender Flug zu einem Ort
    let zoomGoal = null;
    let userAt = -1e9;
    let items = [];
    let kind = '';
    let focusIndex = -1;
    let placeName = 'Erde';
    let layers = { flights: false };
    let planes = [];
    let planesAt = 0;
    let planesBusy = false;
    let planesCenter = null;
    let planesNote = '';
    let subTimer = 0;
    let statusTimer = 0;
    let lastSelect = 0;
    let lastReadout = 0;
    let tileErrors = [];
    let marketTimer = 0;
    const tiles = new Map();
    let loads = 0;
    let queue = [];
    let shownKeys = new Set();
    const marks = new Map(); // Meldung -> Markierung

    // ---------------------------------------------------------------- Aufbau

    async function ensure3D() {
      if (ready) return true;
      try {
        T = await loadThree();
      } catch (e) {
        setStatus('Die 3D-Ansicht ließ sich nicht laden.', 0);
        return false;
      }
      if (ready) return true;
      try {
        renderer = new T.WebGLRenderer({ canvas: el.canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
      } catch (e) {
        setStatus('Dieser PC kann die 3D-Erde nicht zeichnen (WebGL fehlt).', 0);
        return false;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setClearColor(0x02060b, 1);
      maxAniso = renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1;
      scene = new T.Scene();
      camera = new T.PerspectiveCamera(FOV, 1, 0.0001, 400);
      buildStars();
      buildAtmosphere();
      buildBase();
      buildHolo();
      buildGrid();
      buildPlanes();
      bindPointer();
      resize();
      ready = true;
      return true;
    }

    // Alles ist "transparent": Dann zeichnet three.js streng nach renderOrder (Sterne, Lichtsaum, Karte,
    // feinere Kacheln, Gitter, Flugzeuge) und nicht erst alles Undurchsichtige.
    function surfaceMaterial(map) {
      return new T.MeshBasicMaterial({ map, depthTest: false, depthWrite: false, transparent: true });
    }

    function buildBase() {
      const geo = tileGeometry(T, 0, 0, 0, 128);
      const mat = surfaceMaterial(null);
      mat.color = new T.Color(0x0a1626);
      mat.opacity = 0;
      base = new T.Mesh(geo, mat);
      base.renderOrder = 0;
      scene.add(base);
      // Pole: Mercator reicht nur bis 85°, darüber zwei Kappen in der Farbe des Kartenrands
      const capN = new T.Mesh(new T.SphereGeometry(1, 64, 4, 0, Math.PI * 2, 0, (90 - MERC_LAT) * DEG),
        new T.MeshBasicMaterial({ color: 0x1b2b48, depthTest: false, depthWrite: false, transparent: true, opacity: 0 }));
      const capS = new T.Mesh(new T.SphereGeometry(1, 64, 4, 0, Math.PI * 2, Math.PI - (90 - MERC_LAT) * DEG, (90 - MERC_LAT) * DEG),
        new T.MeshBasicMaterial({ color: 0xeef1f4, depthTest: false, depthWrite: false, transparent: true, opacity: 0 }));
      capN.renderOrder = capS.renderOrder = 0;
      base.userData.caps = [capN, capS];
      scene.add(capN, capS);
      const img = new Image();
      img.onload = () => {
        const tex = new T.Texture(img);
        tex.anisotropy = maxAniso;
        tex.needsUpdate = true;
        base.material.map = tex;
        base.material.color.set(0xffffff);
        base.material.needsUpdate = true;
        try { // die Kappen in der Farbe der obersten und untersten Bildzeile
          const c = document.createElement('canvas');
          c.width = 64;
          c.height = 64;
          const g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, 0, 0, 64, 64);
          const avg = (row) => {
            const d = g.getImageData(0, row, 64, 1).data;
            const n = d.length / 4;
            let r = 0; let gg = 0; let b = 0;
            for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
            return new T.Color(r / n / 255, gg / n / 255, b / n / 255);
          };
          capN.material.color.copy(avg(0));
          capS.material.color.copy(avg(63));
        } catch (e) { /* Farben bleiben */ }
      };
      img.src = BASE_URL;
    }

    function buildStars() {
      const n = 1800;
      const pos = new Float32Array(n * 3);
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < n; i++) {
        const u = rnd() * 2 - 1;
        const a = rnd() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        pos[i * 3] = s * Math.cos(a) * 150;
        pos[i * 3 + 1] = u * 150;
        pos[i * 3 + 2] = s * Math.sin(a) * 150;
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      const stars = new T.Points(g, new T.PointsMaterial({ color: 0xbfe9ff, size: 1.4, sizeAttenuation: false,
        transparent: true, opacity: 0.55, depthTest: false, depthWrite: false }));
      stars.renderOrder = -10;
      scene.add(stars);
    }

    // Ein Lichtsaum um die Erde: hell, wo der Blick knapp an ihr vorbeigeht
    function buildAtmosphere() {
      const mat = new T.ShaderMaterial({
        uniforms: { glow: { value: new T.Color(0x5fc6ff) }, strength: { value: 0 } },
        vertexShader: `varying vec3 vWorld;
          void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
        fragmentShader: `uniform vec3 glow; uniform float strength; varying vec3 vWorld;
          void main() {
            vec3 dir = normalize(vWorld - cameraPosition);
            float t = -dot(cameraPosition, dir);
            float d = length(cameraPosition + dir * max(t, 0.0));
            float a = clamp(1.0 - (d - 1.0) / 0.075, 0.0, 1.0);
            a = pow(a, 2.6) * step(1.0, d + 0.002);
            gl_FragColor = vec4(glow * a * strength, a * strength);
          }`,
        side: T.BackSide, transparent: true, depthTest: false, depthWrite: false, blending: T.AdditiveBlending,
      });
      atmo = new T.Mesh(new T.SphereGeometry(1.075, 96, 64), mat);
      atmo.renderOrder = -5;
      scene.add(atmo);
    }

    // Das Hologramm vom Start: eine Kugel aus Lichtpunkten mit zwei Ringen
    function buildHolo() {
      const n = 5200;
      const pos = new Float32Array(n * 3);
      const golden = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < n; i++) {
        const y = 1 - (i / (n - 1)) * 2;
        const r = Math.sqrt(1 - y * y);
        const a = golden * i;
        pos[i * 3] = Math.cos(a) * r * 1.004;
        pos[i * 3 + 1] = y * 1.004;
        pos[i * 3 + 2] = Math.sin(a) * r * 1.004;
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      holo = new T.Points(g, new T.PointsMaterial({ color: 0x7fe9ff, size: 2.1, sizeAttenuation: false,
        transparent: true, opacity: 1, depthTest: false, depthWrite: false, blending: T.AdditiveBlending }));
      holo.renderOrder = 40;
      scene.add(holo);
      rings = new T.Group();
      for (const [r, tilt] of [[1.32, 0.42], [1.46, -0.25]]) {
        const pts = [];
        for (let i = 0; i <= 160; i++) {
          const a = (i / 160) * Math.PI * 2;
          pts.push(new T.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
        }
        const line = new T.Line(new T.BufferGeometry().setFromPoints(pts),
          new T.LineBasicMaterial({ color: 0x7fe9ff, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false }));
        line.rotation.x = tilt;
        line.renderOrder = 41;
        rings.add(line);
      }
      scene.add(rings);
    }

    // Längen- und Breitengrade, nur von weit oben und nur auf der sichtbaren Seite
    function buildGrid() {
      const verts = [];
      const push = (a, b) => {
        verts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      };
      for (let lat = -75; lat <= 75; lat += 15) {
        for (let lon = -180; lon < 180; lon += 3) push(toVec(T, lat, lon, 1.0015), toVec(T, lat, lon + 3, 1.0015));
      }
      for (let lon = -180; lon < 180; lon += 15) {
        for (let lat = -84; lat < 84; lat += 3) push(toVec(T, lat, lon, 1.0015), toVec(T, lat + 3, lon, 1.0015));
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(new Float32Array(verts), 3));
      const mat = new T.ShaderMaterial({
        uniforms: { color: { value: new T.Color(0x7fe9ff) }, opacity: { value: 0 } },
        vertexShader: `varying vec3 vWorld;
          void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
        fragmentShader: `uniform vec3 color; uniform float opacity; varying vec3 vWorld;
          void main() { if (dot(normalize(vWorld), cameraPosition) < 1.0) discard; gl_FragColor = vec4(color, opacity); }`,
        transparent: true, depthTest: false, depthWrite: false,
      });
      grid = new T.LineSegments(g, mat);
      grid.renderOrder = 30;
      scene.add(grid);
    }

    function buildPlanes() {
      planesMesh = new T.InstancedMesh(planeShape(T), new T.MeshBasicMaterial({ color: 0xeafcff, transparent: true,
        opacity: 0.95, depthTest: false, depthWrite: false, side: T.DoubleSide }), PLANES_MAX);
      planesMesh.count = 0;
      planesMesh.renderOrder = 60;
      planesMesh.frustumCulled = false;
      scene.add(planesMesh);
    }

    function resize() {
      if (!renderer) return;
      const w = Math.max(1, el.stage.clientWidth);
      const h = Math.max(1, el.stage.clientHeight);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      lastSelect = 0;
    }

    // ---------------------------------------------------------------- Kamera

    const tmp = {};
    function frame() {
      // Ziel auf der Oberfläche, Blick von schräg hinten (Süden, gedreht um die Richtung heading)
      const U = toVec(T, cam.lat, cam.lon, 1, tmp.U || (tmp.U = new T.Vector3()));
      const E = (tmp.E || (tmp.E = new T.Vector3())).set(0, 1, 0).cross(U);
      if (E.lengthSq() < 1e-10) E.set(1, 0, 0);
      E.normalize();
      const N = (tmp.N || (tmp.N = new T.Vector3())).copy(U).cross(E);
      const h = cam.heading;
      const N2 = (tmp.N2 || (tmp.N2 = new T.Vector3())).copy(N).multiplyScalar(Math.cos(h)).addScaledVector(E, Math.sin(h));
      const E2 = (tmp.E2 || (tmp.E2 = new T.Vector3())).copy(E).multiplyScalar(Math.cos(h)).addScaledVector(N, -Math.sin(h));
      return { U, E: E2, N: N2 };
    }

    function placeCamera() {
      const { U, N } = frame();
      const tilt = clamp(tiltFor(cam.alt) + cam.tiltBias, 0, 1.25);
      const back = new T.Vector3().copy(U).multiplyScalar(Math.cos(tilt)).addScaledVector(N, -Math.sin(tilt));
      camera.position.copy(U).addScaledVector(back, cam.alt);
      camera.up.copy(N).multiplyScalar(Math.cos(tilt)).addScaledVector(U, Math.sin(tilt));
      camera.near = Math.max(0.00002, cam.alt * 0.02);
      camera.far = 400;
      camera.updateProjectionMatrix();
      camera.lookAt(U);
      camera.updateMatrixWorld();
    }

    // Von hier nach dort: über einen großen Bogen, bei weiten Strecken erst hoch, dann wieder runter
    function flyTo(lat, lon, alt, ms) {
      if (!T) {
        cam.lat = lat;
        cam.lon = lon;
        cam.alt = alt;
        return;
      }
      const a = toVec(T, cam.lat, cam.lon);
      const b = toVec(T, lat, lon);
      const ang = Math.acos(clamp(a.dot(b), -1, 1));
      const dur = reducedMotion() ? 0.6 : (ms ? ms / 1000 : clamp(1.6 + ang * 1.3 + Math.abs(Math.log(alt / cam.alt)) * 0.18, 1.6, 4.8));
      flight = { a, b, ang, alt0: cam.alt, alt1: alt, hop: Math.max(0, ang * 0.85 - Math.max(cam.alt, alt) * 0.4),
        head0: cam.heading, t: 0, dur };
      zoomGoal = null;
    }

    function stepFlight(dt) {
      if (!flight) return;
      flight.t = Math.min(1, flight.t + dt / flight.dur);
      const e = easeInOut(flight.t);
      let v;
      if (flight.ang < 1e-5) v = flight.b.clone();
      else {
        const s = Math.sin(flight.ang);
        v = flight.a.clone().multiplyScalar(Math.sin((1 - e) * flight.ang) / s).addScaledVector(flight.b, Math.sin(e * flight.ang) / s);
      }
      const ll = toLatLon(v);
      cam.lat = ll.lat;
      cam.lon = ll.lon;
      cam.alt = Math.exp(Math.log(flight.alt0) * (1 - e) + Math.log(flight.alt1) * e) + flight.hop * Math.sin(Math.PI * flight.t);
      cam.heading = flight.head0 * (1 - e);
      if (flight.t >= 1) flight = null;
    }

    function touch() {
      userAt = clock;
      flight = null;
    }

    function panBy(dx, dy) {
      const h = Math.max(1, el.stage.clientHeight);
      const k = (2 * cam.alt * Math.tan((FOV / 2) * DEG)) / h;
      const ch = Math.cos(cam.heading);
      const sh = Math.sin(cam.heading);
      const east = (-dx * ch + dy * sh) * k;
      const north = (dx * sh + dy * ch) * k;
      cam.lat = clamp(cam.lat + north / DEG, -84, 84);
      cam.lon = wrapLon(cam.lon + east / (Math.max(0.05, Math.cos(cam.lat * DEG)) * DEG));
    }

    function zoomBy(factor) {
      // factor > 1 = näher heran
      cam.alt = clamp(cam.alt / factor, MIN_ALT, MAX_ALT);
    }

    function pickGlobe(clientX, clientY) {
      const r = el.canvas.getBoundingClientRect();
      const ndc = new T.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      const ray = new T.Raycaster();
      ray.setFromCamera(ndc, camera);
      const o = ray.ray.origin;
      const d = ray.ray.direction;
      const b = o.dot(d);
      const disc = b * b - (o.dot(o) - 1);
      if (disc < 0) return null;
      const t = -b - Math.sqrt(disc);
      if (t < 0) return null;
      return toLatLon(o.clone().addScaledVector(d, t));
    }

    function bindPointer() {
      const c = el.canvas;
      const pts = new Map();
      let mode = 'pan';
      let pinch = 0;
      c.addEventListener('contextmenu', (e) => e.preventDefault());
      c.addEventListener('pointerdown', (e) => {
        c.setPointerCapture(e.pointerId);
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        mode = e.button === 2 || e.shiftKey ? 'turn' : 'pan';
        if (pts.size === 2) {
          const [a, b] = [...pts.values()];
          pinch = Math.hypot(a.x - b.x, a.y - b.y);
          mode = 'pinch';
        }
        c.classList.add('dragging');
        touch();
      });
      c.addEventListener('pointermove', (e) => {
        if (!pts.has(e.pointerId)) return;
        const prev = pts.get(e.pointerId);
        const dx = e.clientX - prev.x;
        const dy = e.clientY - prev.y;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        touch();
        if (mode === 'pinch' && pts.size >= 2) {
          const [a, b] = [...pts.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (pinch > 0 && d > 0) zoomBy(d / pinch);
          pinch = d;
          return;
        }
        if (mode === 'turn') {
          cam.heading += dx * 0.006;
          cam.tiltBias = clamp(cam.tiltBias + dy * 0.004, -0.9, 0.9);
          return;
        }
        panBy(dx, dy);
      });
      const up = (e) => {
        pts.delete(e.pointerId);
        if (pts.size < 2) pinch = 0;
        if (!pts.size) c.classList.remove('dragging');
      };
      c.addEventListener('pointerup', up);
      c.addEventListener('pointercancel', up);
      c.addEventListener('dblclick', (e) => {
        const hit = pickGlobe(e.clientX, e.clientY);
        if (!hit) return;
        touch();
        placeName = 'Markierung';
        flyTo(hit.lat, hit.lon, clamp(cam.alt * 0.35, MIN_ALT, MAX_ALT), 1400);
      });
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        touch();
        zoomGoal = clamp((zoomGoal || cam.alt) * Math.exp(e.deltaY * 0.0014), MIN_ALT, MAX_ALT);
      }, { passive: false });
    }

    // ---------------------------------------------------------------- Kacheln

    function tileKey(z, x, y) {
      return `${z}/${x}/${y}`;
    }

    // Welche Kacheln gerade gebraucht werden: fein, wo der Blick nah ist, grob am Horizont
    function selectTiles() {
      const C = camera.position;
      const dC = C.length();
      const horizon = Math.acos(clamp(1 / dC, -1, 1));
      const Chat = C.clone().divideScalar(dC);
      const camLL = toLatLon(C);
      const frustum = new T.Frustum().setFromProjectionMatrix(
        new T.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      const scale = el.stage.clientHeight / (2 * Math.tan((FOV / 2) * DEG));
      let threshold = 256 * 1.2 * Math.min(window.devicePixelRatio || 1, 1.5);
      const sphere = new T.Sphere();
      const center = new T.Vector3();
      const corner = new T.Vector3();
      const near = new T.Vector3();
      let wanted = [];
      const visit = (z, x, y) => {
        const b = tileBounds(z, x, y);
        const cLat = (b.n + b.s) / 2;
        const cLon = (b.w + b.e) / 2;
        toVec(T, cLat, cLon, 1, center);
        let radius = 0;
        for (const [la, lo] of [[b.n, b.w], [b.n, b.e], [b.s, b.w], [b.s, b.e]]) {
          radius = Math.max(radius, toVec(T, la, lo, 1, corner).distanceTo(center));
        }
        const alpha = 2 * Math.asin(clamp(radius / 2, 0, 1));
        const off = Math.acos(clamp(center.dot(Chat), -1, 1));
        if (off - alpha > horizon) return; // hinter dem Horizont
        sphere.center.copy(center);
        sphere.radius = radius;
        if (!frustum.intersectsSphere(sphere)) return;
        // Der nächste Punkt der Kachel zur Kamera
        const la = clamp(camLL.lat, b.s, b.n);
        let lo = camLL.lon;
        if (lo < b.w || lo > b.e) {
          const dw = Math.abs(wrapLon(lo - b.w));
          const de = Math.abs(wrapLon(lo - b.e));
          lo = dw < de ? b.w : b.e;
        }
        const dist = Math.max(1e-7, toVec(T, la, lo, 1, near).distanceTo(C));
        const size = Math.max((b.e - b.w) * DEG * Math.cos(cLat * DEG), (b.n - b.s) * DEG);
        const px = (size / dist) * scale;
        const sharper = px > threshold;
        // Bis Zoomstufe 3 zeichnet die eingebaute Karte: feinere Kacheln nur, wo sie schärfer wären
        if (z === MIN_Z - 1 && !sharper) return;
        if (z < MIN_Z || (sharper && z < MAX_Z)) {
          const n2 = x * 2;
          const m2 = y * 2;
          visit(z + 1, n2, m2);
          visit(z + 1, n2 + 1, m2);
          visit(z + 1, n2, m2 + 1);
          visit(z + 1, n2 + 1, m2 + 1);
          return;
        }
        wanted.push({ z, x, y, dist });
      };
      for (let tries = 0; tries < 4; tries++) {
        wanted = [];
        for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) visit(2, x, y);
        if (wanted.length <= MAX_SHOWN) break;
        threshold *= 1.6;
      }
      return wanted;
    }

    function updateTiles(force) {
      const now = performance.now();
      // Im Flug seltener: Was unterwegs gebraucht wird, ist gleich wieder vorbei
      if (!force && now - lastSelect < (flight ? 260 : 120)) return;
      lastSelect = now;
      const wanted = selectTiles();
      const show = new Set();
      const need = [];
      for (const w of wanted) {
        const key = tileKey(w.z, w.x, w.y);
        let t = tiles.get(key);
        if (!t) {
          t = { key, z: w.z, x: w.x, y: w.y, state: 'new', mesh: null, used: now, failedAt: 0 };
          tiles.set(key, t);
        }
        t.used = now;
        if (t.state === 'ready') {
          show.add(key);
          continue;
        }
        if (t.state === 'new' || (t.state === 'error' && now - t.failedAt > 60000)) need.push({ t, dist: w.dist });
        // Bis sie da ist: die nächste fertige gröbere Kachel
        let z = w.z;
        let x = w.x;
        let y = w.y;
        while (z > MIN_Z) {
          z -= 1;
          x >>= 1;
          y >>= 1;
          const parent = tiles.get(tileKey(z, x, y));
          if (parent && parent.state === 'ready') {
            parent.used = now;
            show.add(parent.key);
            break;
          }
        }
      }
      for (const t of tiles.values()) {
        if (t.mesh) t.mesh.visible = show.has(t.key);
      }
      shownKeys = show;
      need.sort((a, b) => a.t.z - b.t.z || a.dist - b.dist);
      queue = need.map((n) => n.t);
      pump();
      evict();
    }

    function pump() {
      while (loads < MAX_LOADS && queue.length) {
        const t = queue.shift();
        if (t.state === 'loading' || t.state === 'ready') continue;
        loadTile(t);
      }
    }

    function loadTile(t) {
      t.state = 'loading';
      loads += 1;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => {
        loads -= 1;
        if (!tiles.has(t.key) || !T) return;
        const tex = new T.Texture(img);
        tex.anisotropy = maxAniso;
        tex.wrapS = tex.wrapT = T.ClampToEdgeWrapping;
        tex.needsUpdate = true;
        const segs = t.z < 6 ? 12 : t.z < 9 ? 8 : 4;
        t.mesh = new T.Mesh(tileGeometry(T, t.z, t.x, t.y, segs), surfaceMaterial(tex));
        t.mesh.renderOrder = t.z;
        t.mesh.visible = false;
        scene.add(t.mesh);
        t.state = 'ready';
        lastSelect = 0; // gleich neu verteilen, damit sie erscheint
        pump();
      };
      img.onerror = () => {
        loads -= 1;
        t.state = 'error';
        t.failedAt = performance.now();
        tileErrors.push(t.failedAt);
        tileErrors = tileErrors.filter((at) => t.failedAt - at < 10000);
        if (tileErrors.length > 8) setStatus('Satellitenbilder nicht erreichbar, Sir. Ich zeige die grobe Karte.', 8000);
        pump();
      };
      img.src = TILE_URL(t.z, t.x, t.y);
    }

    function evict() {
      if (tiles.size <= MAX_TILES) return;
      const old = [...tiles.values()].filter((t) => !shownKeys.has(t.key) && t.state !== 'loading')
        .sort((a, b) => a.used - b.used);
      for (const t of old.slice(0, tiles.size - MAX_TILES)) {
        if (t.mesh) {
          scene.remove(t.mesh);
          t.mesh.geometry.dispose();
          if (t.mesh.material.map) t.mesh.material.map.dispose();
          t.mesh.material.dispose();
        }
        tiles.delete(t.key);
      }
    }

    // ---------------------------------------------------------------- Meldungen

    function setItems(list, title, k) {
      items = Array.isArray(list) ? list : [];
      kind = k || kind;
      focusIndex = -1;
      el.newsTitle.textContent = title || 'Lage';
      renderList();
      renderMarks();
      el.kinds.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind)));
    }

    function renderList() {
      el.list.textContent = '';
      el.empty.hidden = items.length > 0;
      el.newsCount.textContent = items.length ? `${items.length} Meldungen` : '';
      items.forEach((it, i) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wl-item';
        btn.dataset.index = String(i);
        if (it.bild && /^https:\/\//.test(it.bild)) {
          const img = document.createElement('img');
          img.alt = '';
          img.loading = 'lazy';
          img.referrerPolicy = 'no-referrer';
          img.src = it.bild;
          btn.appendChild(img);
        } else {
          const ph = document.createElement('span');
          ph.className = 'wl-thumb';
          btn.appendChild(ph);
        }
        const txt = document.createElement('span');
        txt.className = 'wl-item-text';
        const kicker = document.createElement('small');
        kicker.textContent = [it.ort && it.ort.name, it.oben].filter(Boolean).join(' · ') || 'Ohne Ort';
        const head = document.createElement('b');
        head.textContent = it.titel || '';
        txt.append(kicker, head);
        btn.appendChild(txt);
        btn.addEventListener('click', () => {
          focusItem(i);
          call('weltlage_focus', i).catch(() => {});
        });
        li.appendChild(btn);
        el.list.appendChild(li);
      });
      markList();
    }

    function markList() {
      el.list.querySelectorAll('.wl-item').forEach((b) => {
        const on = Number(b.dataset.index) === focusIndex;
        b.classList.toggle('on', on);
        if (on) b.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
      });
    }

    function renderMarks() {
      el.marks.textContent = '';
      marks.clear();
      items.forEach((it, i) => {
        if (!it.ort) return;
        const m = document.createElement('div');
        m.className = 'wl-mark';
        const dot = document.createElement('i');
        const label = document.createElement('span');
        label.className = 'wl-mark-label';
        const name = document.createElement('b');
        name.textContent = it.ort.iss ? 'ISS · live' : `Ziel · ${it.ort.name}`;
        const title = document.createElement('em');
        title.textContent = it.titel || '';
        label.append(name, title);
        const corners = document.createElement('span');
        corners.className = 'wl-mark-frame';
        m.append(corners, dot, label);
        el.marks.appendChild(m);
        marks.set(i, { el: m, lat: it.ort.lat, lon: it.ort.lon });
      });
    }

    function focusItem(i) {
      if (i < 0 || i >= items.length) return;
      focusIndex = i;
      const it = items[i];
      markList();
      marks.forEach((m, k) => m.el.classList.toggle('on', k === i));
      showSub(it.sprechen || it.titel || '');
      if (it.ort) {
        placeName = it.ort.name;
        touchless();
        flyTo(it.ort.lat, it.ort.lon, altFor(it.ort.km));
      }
    }

    function touchless() {
      userAt = -1e9;
    }

    function showSub(text) {
      clearTimeout(subTimer);
      el.sub.textContent = text;
      el.sub.classList.toggle('on', !!text);
    }

    function renderMarkets(list) {
      el.markets.textContent = '';
      const rows = Array.isArray(list) ? list : [];
      el.marketsBox.hidden = rows.length === 0;
      rows.forEach((m) => {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = m.name;
        const value = document.createElement('b');
        value.textContent = fmtNum(m.wert, m.wert >= 1000 ? 0 : 2);
        const pct = Number(m.prozent) || 0;
        const ch = document.createElement('em');
        ch.className = pct > 0.005 ? 'up' : pct < -0.005 ? 'down' : '';
        ch.textContent = `${pct > 0.005 ? '▲' : pct < -0.005 ? '▼' : '■'} ${fmtNum(Math.abs(pct), 1)} %`;
        ch.title = pct > 0.005 ? 'gestiegen' : pct < -0.005 ? 'gefallen' : 'unverändert';
        li.append(name, value, ch);
        el.markets.appendChild(li);
      });
    }

    function refreshMarkets() {
      call('weltlage_markets').then(renderMarkets).catch(() => {});
    }

    function setStatus(text, ms) {
      clearTimeout(statusTimer);
      el.status.textContent = text || '';
      el.status.classList.toggle('on', !!text);
      if (text && ms) statusTimer = setTimeout(() => setStatus(''), ms);
    }

    // ---------------------------------------------------------------- Flugverkehr

    function setFlights(on) {
      layers.flights = !!on;
      el.flightsBtn.setAttribute('aria-pressed', String(layers.flights));
      if (!layers.flights) {
        planes = [];
        planesMesh && (planesMesh.count = 0);
        planesNote = '';
        setStatus('');
      } else {
        planesAt = 0;
        if (cam.alt > 0.45) setStatus('Flugverkehr: bitte näher heranzoomen (Landesgröße).', 5000);
      }
    }

    function viewBox() {
      const halfLat = clamp((cam.alt * R_KM * 0.8) / 111, 1.2, 19);
      const halfLon = clamp(halfLat / Math.max(0.2, Math.cos(cam.lat * DEG)) * 1.5, 1.5, 29);
      return [cam.lat - halfLat, cam.lon - halfLon, cam.lat + halfLat, cam.lon + halfLon];
    }

    function maybeFetchPlanes() {
      if (!layers.flights || planesBusy || cam.alt > 0.45 || flight) return;
      const now = performance.now();
      const moved = planesCenter ? Math.hypot(planesCenter.lat - cam.lat, (planesCenter.lon - cam.lon) * Math.cos(cam.lat * DEG)) : 1e9;
      const reach = (cam.alt * R_KM * 0.5) / 111;
      if (now - planesAt < 45000 && moved < reach) return;
      planesBusy = true;
      planesAt = now;
      planesCenter = { lat: cam.lat, lon: cam.lon };
      call('weltlage_flights', viewBox()).then((res) => {
        planesBusy = false;
        if (!layers.flights) return;
        const got = (res && Array.isArray(res.planes)) ? res.planes : [];
        planes = got.slice(0, PLANES_MAX).map((p) => ({ ...p }));
        planesNote = res && res.error ? res.error : `Flugverkehr · ${planes.length} Flugzeuge in der Luft`;
        setStatus(planesNote, 6000);
      }).catch(() => {
        planesBusy = false;
      });
    }

    const pm = {};
    function drawPlanes(dt) {
      if (!planesMesh) return;
      if (!layers.flights || cam.alt > 0.6 || !planes.length) {
        planesMesh.count = 0;
        return;
      }
      pm.m = pm.m || new T.Matrix4();
      pm.p = pm.p || new T.Vector3();
      pm.x = pm.x || new T.Vector3();
      pm.y = pm.y || new T.Vector3();
      pm.e = pm.e || new T.Vector3();
      pm.n = pm.n || new T.Vector3();
      pm.z = pm.z || new T.Vector3();
      pm.s = pm.s || new T.Vector3();
      const C = camera.position;
      const size = clamp(cam.alt * 0.0095, 0.000006, 0.012);
      let n = 0;
      for (const p of planes) {
        // weiterfliegen lassen, bis neue Daten kommen
        const k = (Number(p.kurs) || 0) * DEG;
        const step = ((Number(p.tempo) || 0) * dt) / 6371000;
        p.lat = clamp(p.lat + (step * Math.cos(k)) / DEG, -85, 85);
        p.lon = wrapLon(p.lon + (step * Math.sin(k)) / (Math.max(0.05, Math.cos(p.lat * DEG)) * DEG));
        const P = toVec(T, p.lat, p.lon, 1.00002, pm.p);
        if (P.dot(C) < 1.00002) continue; // hinter dem Horizont
        pm.e.set(0, 1, 0).cross(P).normalize();
        pm.n.copy(P).normalize().cross(pm.e);
        pm.y.copy(pm.n).multiplyScalar(Math.cos(k)).addScaledVector(pm.e, Math.sin(k));
        pm.z.copy(P).normalize();
        pm.x.copy(pm.y).cross(pm.z);
        pm.m.makeBasis(pm.x, pm.y, pm.z).scale(pm.s.setScalar(size)).setPosition(P);
        planesMesh.setMatrixAt(n, pm.m);
        n += 1;
        if (n >= PLANES_MAX) break;
      }
      planesMesh.count = n;
      planesMesh.instanceMatrix.needsUpdate = true;
    }

    // ---------------------------------------------------------------- Bild für Bild

    const proj = {};
    function placeMarks() {
      const w = el.stage.clientWidth;
      const h = el.stage.clientHeight;
      const C = camera.position;
      proj.v = proj.v || new T.Vector3();
      const shown = [];
      marks.forEach((m, i) => {
        const P = toVec(T, m.lat, m.lon, 1, proj.v);
        const visible = P.dot(C) > 1.0001;
        if (!visible) {
          m.el.style.opacity = '0';
          return;
        }
        P.project(camera);
        if (P.z > 1 || Math.abs(P.x) > 1.2 || Math.abs(P.y) > 1.2) {
          m.el.style.opacity = '0';
          return;
        }
        m.el.style.opacity = '';
        const x = ((P.x + 1) / 2) * w;
        const y = ((1 - P.y) / 2) * h;
        m.el.style.transform = `translate(${x}px, ${y}px)`;
        shown.push({ m, x, y, on: i === focusIndex });
      });
      // Beschriftungen, die sich überdecken: nur der Punkt (das aktuelle Ziel behält immer seinen Text)
      const taken = [];
      shown.sort((a, b) => Number(b.on) - Number(a.on));
      for (const s of shown) {
        const box = s.on ? { x: s.x + 40, y: s.y - 48, w: 360, h: 56 } : { x: s.x + 12, y: s.y - 12, w: 150, h: 22 };
        const hit = taken.some((t) => box.x < t.x + t.w && t.x < box.x + box.w && box.y < t.y + t.h && t.y < box.y + box.h);
        s.m.el.classList.toggle('quiet', hit && !s.on);
        if (!hit || s.on) taken.push(box);
      }
    }

    function readout(now) {
      if (now - lastReadout < 100) return;
      lastReadout = now;
      el.target.textContent = placeName;
      el.lat.textContent = fmtLat(cam.lat);
      el.lon.textContent = fmtLon(cam.lon);
      el.alt.textContent = fmtAlt(cam.alt);
      const d = new Date();
      el.clock.textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} · ${DAYS[d.getDay()]} ${pad2(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    }

    function loop(now) {
      raf = requestAnimationFrame(loop);
      // Echte Zeit (höchstens eine Viertelsekunde): Flüge dauern auf langsamen PCs nicht länger, sie ruckeln nur
      const dt = Math.min(0.25, last ? (now - last) / 1000 : 0.016);
      last = now;
      clock += dt;
      stepFlight(dt);
      if (zoomGoal != null && !flight) {
        const k = 1 - Math.exp(-dt * 8);
        cam.alt = Math.exp(Math.log(cam.alt) + (Math.log(zoomGoal) - Math.log(cam.alt)) * k);
        if (Math.abs(Math.log(cam.alt / zoomGoal)) < 0.002) zoomGoal = null;
      }
      // Von weit oben dreht sich die Erde langsam, solange niemand sie anfasst
      if (!flight && clock - userAt > 9 && cam.alt > 1.6 && focusIndex < 0 && !reducedMotion()) cam.lon = wrapLon(cam.lon + dt * 2.2);
      fade += (fadeGoal - fade) * (1 - Math.exp(-dt * 2.2));
      const holoA = 1 - fade;
      base.material.opacity = clamp(fade * 1.15, 0, 1);
      base.userData.caps.forEach((cap) => { cap.material.opacity = base.material.opacity; });
      holo.material.opacity = holoA;
      holo.visible = holoA > 0.01;
      holo.rotation.y += dt * 0.25;
      rings.visible = holoA > 0.01;
      rings.children.forEach((r, i) => {
        r.material.opacity = 0.55 * holoA;
        r.rotation.y += dt * (i ? -0.35 : 0.22);
      });
      // Im Lichtsaum (unter etwa 480 km) leuchtet sonst der ganze Himmel: dann schwächer
      atmo.material.uniforms.strength.value = fade * (cam.alt > 0.075 ? 0.95 : 0.45);
      grid.material.uniforms.opacity.value = fade * clamp((cam.alt - 0.8) / 1.6, 0, 1) * 0.16 + holoA * 0.25;
      placeCamera();
      if (fade > 0.3) updateTiles(false);
      drawPlanes(dt);
      maybeFetchPlanes();
      renderer.render(scene, camera);
      placeMarks();
      readout(now);
    }

    // ---------------------------------------------------------------- Öffnen und Schließen

    async function open(data, fromPython) {
      if (opts.onOpen) opts.onOpen();
      const was = isOpen;
      isOpen = true;
      root.hidden = false;
      document.body.classList.add('wl-open');
      requestAnimationFrame(() => root.classList.add('on'));
      if (!fromPython) call('weltlage_active', true).catch(() => {});
      if (data && Array.isArray(data.items) && data.items.length) {
        setItems(data.items, data.title, data.kind);
        if (data.index >= 0) focusIndex = data.index;
      }
      if (!(await ensure3D())) return;
      if (!was) {
        resize();
        // Start: Hologramm, dann die Satelliten-Erde
        el.boot.classList.add('on');
        fade = 0;
        fadeGoal = 0;
        cam.alt = 3.6;
        setTimeout(() => {
          fadeGoal = 1;
          el.boot.classList.remove('on');
          if (focusIndex < 0) flyTo(cam.lat, cam.lon, 2.6, 2400);
        }, reducedMotion() ? 50 : 900);
        refreshMarkets();
        clearInterval(marketTimer);
        marketTimer = setInterval(() => isOpen && refreshMarkets(), 300000);
        cancelAnimationFrame(raf);
        last = 0;
        raf = requestAnimationFrame(loop);
      }
    }

    function close(fromPython) {
      if (!isOpen) return;
      isOpen = false;
      root.classList.remove('on');
      document.body.classList.remove('wl-open');
      clearInterval(marketTimer);
      showSub('');
      setTimeout(() => {
        if (isOpen) return;
        root.hidden = true;
        cancelAnimationFrame(raf);
      }, 260);
      if (!fromPython) call('weltlage_active', false).catch(() => {});
      if (opts.onClose) opts.onClose();
    }

    function handle(ev) {
      const a = ev.action;
      if (a === 'open') {
        open(ev, true);
      } else if (a === 'close') {
        close(true);
      } else if (a === 'loading') {
        if (!isOpen) open(null, true);
        kind = ev.kind || kind;
        el.newsTitle.textContent = ev.title || 'Lage';
        el.newsCount.textContent = 'wird geladen …';
        el.kinds.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind)));
        setStatus('Verbinde mit den Nachrichtendiensten …', 4000);
      } else if (a === 'news') {
        if (!isOpen) open(null, true);
        setItems(ev.items, ev.title, ev.kind);
        setStatus('');
        if (!items.length) setStatus('Keine Meldungen erreichbar.', 6000);
      } else if (a === 'focus') {
        if (!isOpen) open(null, true);
        focusItem(Number(ev.index));
      } else if (a === 'fly') {
        if (!isOpen) open(null, true);
        const o = ev.ort || {};
        if (Number.isFinite(o.lat) && Number.isFinite(o.lon)) {
          placeName = o.name || 'Ziel';
          focusIndex = -1;
          markList();
          marks.forEach((m) => m.el.classList.remove('on'));
          touchless();
          flyTo(o.lat, wrapLon(o.lon), altFor(o.km));
        }
      } else if (a === 'markets') {
        renderMarkets(ev.items);
      } else if (a === 'layer') {
        if (ev.name === 'flights') setFlights(!!ev.on);
      } else if (a === 'view') {
        if (ev.what === 'zoom' && Number(ev.factor) > 0) {
          zoomGoal = clamp(cam.alt * Number(ev.factor), MIN_ALT, MAX_ALT);
          flight = null;
        }
      } else if (a === 'done') {
        subTimer = setTimeout(() => showSub(''), 5000);
      }
    }

    // Handsteuerung (handsteuerung.js): greifen und ziehen verschiebt, zwei Hände zoomen und drehen
    function gesture(g) {
      if (!isOpen || !ready) return;
      touch();
      zoomGoal = null;
      if (g.kind === 'drag') panBy(g.dx, g.dy);
      else if (g.kind === 'zoom') zoomBy(g.factor);
      else if (g.kind === 'twist') cam.heading += g.angle;
    }

    // ---------------------------------------------------------------- Bedienelemente

    if (el.pill) el.pill.addEventListener('click', () => (isOpen ? close(false) : open(null, false)));
    el.closeBtn.addEventListener('click', () => close(false));
    el.flightsBtn.addEventListener('click', () => setFlights(!layers.flights));
    el.handsBtn.addEventListener('click', () => {
      if (opts.onHands) opts.onHands(el.handsBtn.getAttribute('aria-pressed') !== 'true');
    });
    el.kinds.forEach((b) => b.addEventListener('click', () => {
      el.kinds.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      call('weltlage_briefing', b.dataset.kind).catch(() => toast('Das ging gerade nicht.', 'error'));
    }));
    el.search.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = el.searchIn.value.trim();
      if (!q) return;
      setStatus(`Suche ${q} …`, 4000);
      call('weltlage_fly', q).then((res) => {
        if (res && res.ok && res.ort) {
          handle({ action: 'fly', ort: res.ort });
          setStatus('');
          el.searchIn.blur();
        } else setStatus((res && res.error) || 'Nicht gefunden.', 5000);
      }).catch(() => setStatus('Die Suche ging gerade nicht.', 5000));
    });
    window.addEventListener('resize', () => isOpen && resize());
    document.addEventListener('keydown', (e) => {
      if (!isOpen || e.defaultPrevented) return;
      const tag = (e.target && e.target.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      const step = 60;
      const keys = {
        Escape: () => close(false),
        '+': () => { zoomGoal = clamp(cam.alt / 1.8, MIN_ALT, MAX_ALT); },
        '-': () => { zoomGoal = clamp(cam.alt * 1.8, MIN_ALT, MAX_ALT); },
        ArrowLeft: () => panBy(step, 0),
        ArrowRight: () => panBy(-step, 0),
        ArrowUp: () => panBy(0, step),
        ArrowDown: () => panBy(0, -step),
        f: () => setFlights(!layers.flights),
      };
      const fn = keys[e.key];
      if (fn) {
        e.preventDefault();
        touch();
        fn();
      }
    });

    // Was Jarvis sonst sagt ("Kurs auf Tokio, Sir."), steht kurz unten in der Mitte
    function say(text) {
      if (!isOpen || !text) return;
      showSub(String(text));
      subTimer = setTimeout(() => showSub(''), 9000);
    }

    return {
      handle, gesture, say, open: () => open(null, false), close: () => close(false), isOpen: () => isOpen,
      setHands: (on) => el.handsBtn.setAttribute('aria-pressed', String(!!on)),
      flights: () => layers.flights,
    };
  }

  // ------------------------------------------------------------------ Vorschau ohne Python (?demo&weltlage)

  const DEMO_ITEMS = [
    { titel: 'Regierungsbildung in Schweden geht in die nächste Runde', oben: 'Skandinavien', ort: { name: 'Stockholm', lat: 59.33, lon: 18.07, km: 20 } },
    { titel: 'Neue Mietgesetze scheitern im spanischen Parlament', oben: 'Wohnungsnot', ort: { name: 'Madrid', lat: 40.417, lon: -3.704, km: 30 } },
    { titel: 'Brücke in Kiew nach Angriff gesperrt', oben: 'Krieg gegen die Ukraine', ort: { name: 'Kiew', lat: 50.45, lon: 30.52, km: 30 } },
    { titel: 'Raumschiff erreicht die ISS in Rekordzeit', oben: 'Raumfahrt', ort: { name: 'Raumstation ISS', lat: 30, lon: 10, km: 12000 } },
    { titel: 'Frankreichs Regierung legt Sparhaushalt vor', oben: 'Haushalt', ort: { name: 'Paris', lat: 48.857, lon: 2.352, km: 30 } },
    { titel: 'Tag der Deutschen Einheit: Feier in Bremen', oben: 'Feiertag', ort: { name: 'Bremen', lat: 53.08, lon: 8.8, km: 20 } },
    { titel: 'Zwischenwahlen: Republikaner unter Druck', oben: 'USA', ort: { name: 'Washington', lat: 38.897, lon: -77.036, km: 25 } },
  ].map((it, i) => ({ id: `demo-${i}`, satz: '', bild: '', link: '', zeit: '', sprechen: `${it.titel}.`, ...it }));

  function demoPlanes(box) {
    const [s, w, n, e] = box;
    const out = [];
    let seed = Math.round((s + 90) * 1000 + (w + 180) * 7);
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 260; i++) {
      out.push({ id: `d${i}`, ruf: `JRV${100 + i}`, lat: s + rnd() * (n - s), lon: w + rnd() * (e - w),
        hoehe: 9000 + rnd() * 3000, tempo: 210 + rnd() * 50, kurs: rnd() * 360 });
    }
    return out;
  }

  function demoApi(push) {
    let timer = 0;
    const brief = (k) => {
      clearInterval(timer);
      push({ type: 'weltlage', action: 'loading', kind: k, title: k === 'deutschland' ? 'Lage · Deutschland' : 'Lage · Welt' });
      setTimeout(() => {
        const items = k === 'deutschland' ? DEMO_ITEMS.filter((it) => /Bremen/.test(it.ort.name)) : DEMO_ITEMS;
        push({ type: 'weltlage', action: 'news', kind: k, items, title: k === 'deutschland' ? 'Lage · Deutschland' : 'Lage · Welt' });
        let i = 0;
        const next = () => {
          if (i >= items.length) {
            clearInterval(timer);
            push({ type: 'weltlage', action: 'done' });
            return;
          }
          push({ type: 'weltlage', action: 'focus', index: i });
          push({ type: 'message', role: 'jarvis', text: items[i].sprechen });
          i += 1;
        };
        next();
        timer = setInterval(next, 7000);
      }, 500);
      return Promise.resolve('Lagebericht, Sir.');
    };
    return {
      weltlage_state: () => Promise.resolve({ active: false, items: [], kind: '', index: -1, busy: false, title: 'Gottes Auge', hands_allowed: true }),
      weltlage_active: () => Promise.resolve(true),
      weltlage_briefing: (k) => brief(k || 'welt'),
      weltlage_focus: (i) => {
        clearInterval(timer);
        push({ type: 'weltlage', action: 'focus', index: i });
        return Promise.resolve(true);
      },
      weltlage_stop: () => {
        clearInterval(timer);
        return Promise.resolve(true);
      },
      weltlage_fly: (q) => {
        const places = { tokio: ['Tokio', 35.68, 139.69, 40], paris: ['Paris', 48.857, 2.352, 30], berlin: ['Berlin', 52.52, 13.405, 35],
          'new york': ['New York', 40.713, -74.006, 35], münchen: ['München', 48.137, 11.575, 25] };
        const hit = places[String(q || '').trim().toLowerCase()];
        return Promise.resolve(hit ? { ok: true, ort: { name: hit[0], lat: hit[1], lon: hit[2], km: hit[3] }, error: '' }
          : { ok: false, ort: null, error: `„${q}“ finde ich nicht.` });
      },
      weltlage_markets: () => Promise.resolve([
        { name: 'DAX', wert: 25231.2, prozent: 1.17, einheit: 'Punkte' },
        { name: 'S&P 500', wert: 7724.43, prozent: 0.76, einheit: 'Punkte' },
        { name: 'Bitcoin', wert: 75399.77, prozent: -0.05, einheit: 'Euro' },
      ]),
      weltlage_flights: (box) => Promise.resolve({ planes: demoPlanes(box), error: '', age: 0 }),
      demoBriefing: brief,
    };
  }

  window.JarvisWeltlage = { create, demoApi, DEMO_ITEMS, tileBounds, altFor, mercLat };
})();
