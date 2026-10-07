// =============================================================================
// MeshBuilder: viele einfache Formen zu EINER Form mit Farben pro Ecke verschmelzen
// =============================================================================
// Wofür? Jedes Mesh kostet einen Zeichen-Aufruf. Eine Figur aus 60 Kisten und
// Kugeln wäre langsam. Der Builder klebt alle Teile eines Körperteils (z. B.
// Oberkörper + Gürtel + Rucksack) zu einer Form zusammen; die Farbe steckt in
// jeder Ecke ("vertex colors"). Alle Figuren teilen sich dann EIN Material.
//
//   const b = new MeshBuilder();
//   b.box(0.3, 0.2, 0.1, '#FF0000', 0, 1, 0);          // Breite, Höhe, Tiefe, Farbe, Lage
//   b.cylinder(0.05, 0.04, 0.4, '#00FF00', 0, 0.5, 0);  // Radius oben/unten, Höhe
//   b.push(0, 1.5, 0, 0.2); … b.pop();                   // Teile relativ zu einem Punkt (gedreht)
//   const geometry = b.build();
//
// Nur beim Aufbau benutzen (legt Listen an) – nie pro Bild.
// =============================================================================
import * as THREE from 'three';

// Einheits-Formen (einmal angelegt, nie entsorgt): werden beim Einfügen skaliert
const unit = new Map();
function unitShape(key, make) {
  let g = unit.get(key);
  if (!g) {
    g = make();
    if (g.index) {
      const flat = g.toNonIndexed();
      g.dispose();
      g = flat;
    }
    unit.set(key, g);
  }
  return g;
}

const _m = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _c = new THREE.Color();

export class MeshBuilder {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.colors = [];
    this.stack = [new THREE.Matrix4()];
  }

  /** Lage für die folgenden Teile (relativ zur aktuellen): verschieben, drehen, skalieren. */
  push(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    const top = this.stack[this.stack.length - 1];
    _local.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
    this.stack.push(top.clone().multiply(_local));
    return this;
  }

  pop() {
    if (this.stack.length > 1) this.stack.pop();
    return this;
  }

  /** Eine fertige Form (BufferGeometry) mit Farbe einfügen. Lage: x,y,z, Drehung rx,ry,rz, Größe sx,sy,sz. */
  add(geometry, color, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    _local.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
    _m.copy(this.stack[this.stack.length - 1]).multiply(_local);
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    _n.getNormalMatrix(_m);
    _c.set(color);
    const flip = _m.determinant() < 0; // gespiegelt → Dreiecke umdrehen (sonst innen sichtbar)
    for (let i = 0; i < pos.count; i += 3) {
      for (let k = 0; k < 3; k++) {
        const idx = flip && k > 0 ? i + 3 - k : i + k;
        _v.fromBufferAttribute(pos, idx).applyMatrix4(_m);
        this.positions.push(_v.x, _v.y, _v.z);
        if (nor) _v.fromBufferAttribute(nor, idx).applyMatrix3(_n).normalize();
        else _v.set(0, 1, 0);
        this.normals.push(_v.x, _v.y, _v.z);
        this.colors.push(_c.r, _c.g, _c.b);
      }
    }
    if (g !== geometry) g.dispose();
    return this;
  }

  /** Kiste (Mitte bei x,y,z). */
  box(w, h, d, color, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
    return this.add(unitShape('box', () => new THREE.BoxGeometry(1, 1, 1)), color, x, y, z, rx, ry, rz, w, h, d);
  }

  /** Zylinder entlang Y (Mitte bei x,y,z); rTop/rBottom = Radius oben/unten; seg = Ecken. */
  cylinder(rTop, rBottom, h, color, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, seg = 8, sx = 1, sz = 1) {
    const r = Math.max(rTop, rBottom, 1e-6);
    const key = `cyl${(rTop / r).toFixed(3)}:${(rBottom / r).toFixed(3)}:${seg}`;
    const g = unitShape(key, () => new THREE.CylinderGeometry(rTop / r, rBottom / r, 1, seg));
    return this.add(g, color, x, y, z, rx, ry, rz, r * sx, h, r * sz);
  }

  /** Kugel bzw. Ellipsoid (Radien rx, ry, rz). */
  sphere(radiusX, radiusY, radiusZ, color, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, ws = 10, hs = 7) {
    const g = unitShape(`sph${ws}:${hs}`, () => new THREE.SphereGeometry(1, ws, hs));
    return this.add(g, color, x, y, z, rx, ry, rz, radiusX, radiusY, radiusZ);
  }

  /** Halbkugel (obere Hälfte, Grundfläche bei y). part = Anteil von oben (1 = halbe Kugel, 1.2 = etwas mehr). */
  dome(radiusX, radiusY, radiusZ, color, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, part = 1, ws = 10, hs = 5) {
    const key = `dome${ws}:${hs}:${part.toFixed(2)}`;
    const g = unitShape(key, () => new THREE.SphereGeometry(1, ws, hs, 0, Math.PI * 2, 0, (Math.PI / 2) * part));
    return this.add(g, color, x, y, z, rx, ry, rz, radiusX, radiusY, radiusZ);
  }

  /** Kegel entlang Y (Spitze oben). */
  cone(r, h, color, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, seg = 6) {
    const g = unitShape(`cone${seg}`, () => new THREE.ConeGeometry(1, 1, seg));
    return this.add(g, color, x, y, z, rx, ry, rz, r, h, r);
  }

  /** Ring (Torus) in der XY-Ebene: Radius r, Dicke t. */
  torus(r, t, color, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, arc = Math.PI * 2, seg = 14) {
    const key = `tor${(t / r).toFixed(3)}:${arc.toFixed(3)}:${seg}`;
    const g = unitShape(key, () => new THREE.TorusGeometry(1, t / r, 5, seg, arc));
    return this.add(g, color, x, y, z, rx, ry, rz, r, r, r);
  }

  /**
   * "Schlauch" aus Ringen (z. B. Oberkörper): rings = [{ y, w, d, z?, color? }] von unten nach oben.
   * Jeder Ring ist ein abgerundetes Achteck (Breite w, Tiefe d). Die Farbe eines Rings gilt
   * für das Band bis zum nächsten Ring. caps = Deckel unten/oben. skip = Seiten, die fehlen
   * (5 = die vordere Seite, −Z), z. B. für einen offenen Mantel.
   */
  loft(rings, color, caps = true, skip = null) {
    const seg = 8;
    const pts = (r) => {
      const out = [];
      const z0 = r.z ?? 0;
      // Achteck mit abgeflachten Ecken (gegen den Uhrzeigersinn von oben)
      const hw = r.w / 2;
      const hd = r.d / 2;
      const cw = hw * (r.round ?? 0.62);
      const cd = hd * (r.round ?? 0.62);
      out.push([hw, z0 + cd], [cw, z0 + hd], [-cw, z0 + hd], [-hw, z0 + cd], [-hw, z0 - cd], [-cw, z0 - hd], [cw, z0 - hd], [hw, z0 - cd]);
      return out;
    };
    const top = this.stack[this.stack.length - 1];
    _n.getNormalMatrix(top);
    const tri = (a, b, c, col) => {
      // Flächen-Normale (flach) – ein Band ist eine Fläche
      const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2];
      const bx = c[0] - a[0], by = c[1] - a[1], bz = c[2] - a[2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      _c.set(col);
      for (const p of [a, b, c]) {
        _v.set(p[0], p[1], p[2]).applyMatrix4(top);
        this.positions.push(_v.x, _v.y, _v.z);
        _v.set(nx, ny, nz).applyMatrix3(_n).normalize();
        this.normals.push(_v.x, _v.y, _v.z);
        this.colors.push(_c.r, _c.g, _c.b);
      }
    };
    for (let i = 0; i < rings.length - 1; i++) {
      const r0 = rings[i];
      const r1 = rings[i + 1];
      const p0 = pts(r0);
      const p1 = pts(r1);
      const col = r0.color ?? color;
      for (let s = 0; s < seg; s++) {
        if (skip && skip.includes(s)) continue;
        const n = (s + 1) % seg;
        const a = [p0[s][0], r0.y, p0[s][1]];
        const b = [p0[n][0], r0.y, p0[n][1]];
        const c = [p1[n][0], r1.y, p1[n][1]];
        const d = [p1[s][0], r1.y, p1[s][1]];
        // außen sichtbar: Punkte von außen gesehen gegen den Uhrzeigersinn
        tri(a, c, b, col);
        tri(a, d, c, col);
      }
    }
    if (caps) {
      for (const [ring, up] of [[rings[0], false], [rings[rings.length - 1], true]]) {
        const p = pts(ring);
        const center = [0, ring.y, ring.z ?? 0];
        const col = up ? rings[rings.length - 2].color ?? color : ring.color ?? color;
        for (let s = 0; s < seg; s++) {
          const n = (s + 1) % seg;
          const a = [p[s][0], ring.y, p[s][1]];
          const b = [p[n][0], ring.y, p[n][1]];
          if (up) tri(center, b, a, col);
          else tri(center, a, b, col);
        }
      }
    }
    return this;
  }

  /** Anzahl der Dreiecke bisher. */
  get triangles() {
    return this.positions.length / 9;
  }

  /** Fertige Form (BufferGeometry mit position, normal, color). */
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
