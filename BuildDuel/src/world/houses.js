// =============================================================================
// Häuser aus Kisten (begehbar): Wände mit Tür und Fenstern, Decke, Dach,
// bei zwei Stockwerken eine Treppe (Schräge) nach oben
// =============================================================================
// buildHouse(batch, spec) legt alle Teile über den Baukasten (staticBatch.js) an:
// Kollision pro Kiste, Grafik als EIN Mesh für die ganze Karte.
//
// Ein Haus wird zuerst "lokal" gedacht: u = Breite (0..W), v = Tiefe (0..D),
// die Tür liegt vorn bei v = D. rotation (0..3) dreht das Haus in 90°-Schritten:
//   0 = Tür nach Süden (+Z), 1 = Osten (+X), 2 = Norden (−Z), 3 = Westen (−X).
// Alle Maße stehen oben in HOUSE (m) – passend zur Figur (1,8 m hoch, 0,8 m breit).
// =============================================================================

export const HOUSE = Object.freeze({
  wall: 0.3, // Wand-Dicke
  floorHeight: 3.6, // Höhe eines Stockwerks
  slab: 0.3, // Dicke der Decke zwischen den Stockwerken
  baseLift: 0.15, // Fußboden liegt so hoch über dem Gelände (kleine Stufe)
  doorWidth: 1.7,
  doorHeight: 2.6,
  windowWidth: 1.4,
  windowSill: 1.0,
  windowTop: 2.3,
  stairRun: 4.8, // Treppe: so lang (Steigung 3,6 / 4,8 ≈ 37° – begehbar)
  stairWidth: 1.4,
  stairGap: 0.9, // Abstand der Treppe zur Seitenwand (man kommt unten vor die Treppe)
  holeExtra: 0.5, // Loch in der Decke etwas breiter als die Treppe (Kopf stößt nicht an)
  railHeight: 1.0,
  parapet: 0.6, // Rand auf dem Flachdach
});

/**
 * @param {object} batch   createStaticBatch(...)
 * @param {object} spec    { cx, cz, y (Gelände-Höhe), width, depth, floors (1|2), rotation (0..3),
 *                           style: 'desert'|'wood', colors: { wall, trim, roof, accent } }
 * @returns {object} Haus: { cx, cz, y, floorY: [...], width, depth, rotation, bounds, door, chestSpots, lootSpots }
 */
export function buildHouse(batch, spec) {
  const H = HOUSE;
  const W = spec.width;
  const D = spec.depth;
  const r = ((spec.rotation ?? 0) % 4 + 4) % 4;
  const floors = spec.floors ?? 1;
  const T = H.wall;
  const FH = H.floorHeight;
  const y0 = spec.y;
  const floorTop = y0 + H.baseLift;
  const colors = spec.colors;
  const data = { kind: 'house', blocksBullets: true };

  // lokal (u, v) → Welt (x, z)
  const toWorld = (u, v) => {
    const a = u - W / 2;
    const b = v - D / 2;
    switch (r) {
      case 1: return [spec.cx + b, spec.cz - a];
      case 2: return [spec.cx - a, spec.cz - b];
      case 3: return [spec.cx - b, spec.cz + a];
      default: return [spec.cx + a, spec.cz + b];
    }
  };
  const box = (u0, y1, v0, u1, y2, v1, color, opts = {}) => {
    const [ax, az] = toWorld(u0, v0);
    const [bx, bz] = toWorld(u1, v1);
    return batch.addBox(
      { x: Math.min(ax, bx), y: Math.min(y1, y2), z: Math.min(az, bz) },
      { x: Math.max(ax, bx), y: Math.max(y1, y2), z: Math.max(az, bz) },
      { color, data, ...opts },
    );
  };
  // lokale Richtung (0 = +u, 1 = +v, 2 = −u, 3 = −v) → Welt-Richtung (0 = +X, 1 = +Z, 2 = −X, 3 = −Z)
  const worldDir = (localDir) => (localDir - r + 4) % 4;

  // --- Fußboden ---------------------------------------------------------------------------
  box(0, y0 - 0.4, 0, W, floorTop, D, colors.trim);

  // --- Wände je Stockwerk ----------------------------------------------------------------
  // Wand entlang u (bei v = vPos) bzw. entlang v (bei u = uPos) mit Öffnungen
  function wallAlongU(v0, v1, a0, a1, yb, yt, openings, color) {
    let a = a0;
    const sorted = openings.slice().sort((p, q) => p.from - q.from);
    for (const o of sorted) {
      if (o.from > a) box(a, yb, v0, o.from, yt, v1, color);
      if (o.bottom > 0) box(o.from, yb, v0, o.to, yb + o.bottom, v1, color);
      if (o.top < yt - yb) box(o.from, yb + o.top, v0, o.to, yt, v1, color);
      a = o.to;
    }
    if (a < a1) box(a, yb, v0, a1, yt, v1, color);
  }
  function wallAlongV(u0, u1, a0, a1, yb, yt, openings, color) {
    let a = a0;
    const sorted = openings.slice().sort((p, q) => p.from - q.from);
    for (const o of sorted) {
      if (o.from > a) box(u0, yb, a, u1, yt, o.from, color);
      if (o.bottom > 0) box(u0, yb, o.from, u1, yb + o.bottom, o.to, color);
      if (o.top < yt - yb) box(u0, yb + o.top, o.from, u1, yt, o.to, color);
      a = o.to;
    }
    if (a < a1) box(u0, yb, a, u1, yt, a1, color);
  }
  const win = (center) => ({ from: center - H.windowWidth / 2, to: center + H.windowWidth / 2, bottom: H.windowSill, top: H.windowTop });
  const doorU = W / 2;
  const door = { from: doorU - H.doorWidth / 2, to: doorU + H.doorWidth / 2, bottom: 0, top: H.doorHeight };

  for (let f = 0; f < floors; f++) {
    const yb = floorTop + f * FH;
    const yt = floorTop + (f + 1) * FH;
    // vorn (v = D): Tür unten, oben zwei Fenster
    const front = f === 0 ? [door] : [win(W * 0.27), win(W * 0.73)];
    if (f === 0 && W >= 10) front.push(win(W * 0.17));
    wallAlongU(D - T, D, 0, W, yb, yt, front.filter((o) => o.from > T + 0.2 && o.to < W - T - 0.2 &&
      !(o !== door && o.to > door.from - 0.4 && o.from < door.to + 0.4)), colors.wall);
    // hinten (v = 0): Fenster (unten nicht über der Treppe)
    const back = f === 0 && floors > 1 ? [win(W * 0.78)] : [win(W * 0.3), win(W * 0.7)];
    wallAlongU(0, T, 0, W, yb, yt, back.filter((o) => o.from > T + 0.2 && o.to < W - T - 0.2), colors.wall);
    // Seiten (u = 0 und u = W), zwischen vorn und hinten
    wallAlongV(0, T, T, D - T, yb, yt, [win(D * 0.55)].filter((o) => o.from > T + 0.2 && o.to < D - T - 0.2), colors.wall);
    wallAlongV(W - T, W, T, D - T, yb, yt, [win(D * 0.5)].filter((o) => o.from > T + 0.2 && o.to < D - T - 0.2), colors.wall);
    // Fenster-Rahmen (nur Grafik): dünne Kanten in der Akzent-Farbe über der Tür
    if (f === 0 && colors.accent) {
      box(door.from - 0.25, floorTop + H.doorHeight + 0.15, D, door.to + 0.25, floorTop + H.doorHeight + 0.3, D + 0.9, colors.accent, { collide: false });
    }
  }

  // --- Decke(n), Treppe -------------------------------------------------------------------
  const stairStart = T + H.stairGap;
  const stairEnd = stairStart + H.stairRun;
  const holeU = stairEnd;
  const holeV = T + H.stairWidth + H.holeExtra;
  const floorY = [floorTop];
  for (let f = 1; f < floors; f++) {
    const top = floorTop + f * FH;
    const bottom = top - H.slab;
    floorY.push(top);
    // Decke mit Loch über der Treppe (Treppe hinten links: u klein, v klein)
    box(holeU, bottom, T, W - T, top, D - T, colors.trim);
    box(T, bottom, holeV, holeU, top, D - T, colors.trim);
    // Treppe: Schräge von unten bis zur Decke, steigt Richtung +u
    const yStair = floorTop + (f - 1) * FH;
    const [ax, az] = toWorld(stairStart, T);
    const [bx, bz] = toWorld(stairEnd, T + H.stairWidth);
    batch.addSlope({
      minX: Math.min(ax, bx), maxX: Math.max(ax, bx), minZ: Math.min(az, bz), maxZ: Math.max(az, bz),
      baseY: yStair, rise: FH, dir: worldDir(0), thickness: 0.25,
    }, { color: colors.stairs ?? colors.trim, data });
    // Geländer oben am Loch (lässt den Ausgang am oberen Ende frei)
    box(T, top, holeV - 0.08, holeU - 1.2, top + H.railHeight, holeV, colors.trim);
  }

  // --- Dach ----------------------------------------------------------------------------------
  const roofY = floorTop + floors * FH;
  if (spec.style === 'wood') {
    // flache Decke + Pyramiden-Dach
    box(0, roofY - H.slab, 0, W, roofY, D, colors.trim);
    const [ax, az] = toWorld(-0.4, -0.4);
    const [bx, bz] = toWorld(W + 0.4, D + 0.4);
    batch.addSlope({
      minX: Math.min(ax, bx), maxX: Math.max(ax, bx), minZ: Math.min(az, bz), maxZ: Math.max(az, bz),
      baseY: roofY, rise: Math.min(W, D) * 0.32, dir: 'pyramid', thickness: 0.25,
    }, { color: colors.roof, data });
  } else {
    // Flachdach mit Rand
    box(0, roofY - H.slab, 0, W, roofY, D, colors.roof);
    const p = H.parapet;
    const t = 0.25;
    box(0, roofY, 0, W, roofY + p, t, colors.trim);
    box(0, roofY, D - t, W, roofY + p, D, colors.trim);
    box(0, roofY, t, t, roofY + p, D - t, colors.trim);
    box(W - t, roofY, t, W, roofY + p, D - t, colors.trim);
  }

  // --- Plätze für Kisten und Boden-Loot (Welt-Koordinaten) ---------------------------------
  const spot = (u, v, y, faceU, faceV) => {
    const [x, z] = toWorld(u, v);
    const [fx, fz] = toWorld(faceU, faceV);
    return { x, y, z, yaw: Math.atan2(-(fx - x), -(fz - z)) };
  };
  const chestSpots = [];
  const lootSpots = [];
  // unten: hinten rechts (weg von der Treppe) und vorn links
  chestSpots.push(spot(W - T - 0.85, T + 0.75, floorTop, W / 2, D / 2));
  lootSpots.push(spot(W * 0.6, D * 0.55, floorTop, 0, 0));
  lootSpots.push(spot(T + 1.1, D - T - 1.2, floorTop, 0, 0));
  if (floors > 1) {
    const top = floorY[1];
    chestSpots.push(spot(W - T - 0.85, D - T - 0.75, top, W / 2, D / 2));
    lootSpots.push(spot(W * 0.45, D - T - 1.3, top, 0, 0));
  }
  // Tisch (Deckung, nur unten in größeren Häusern)
  if (W >= 10 && D >= 8) {
    box(W * 0.62 - 0.6, floorTop, D * 0.5 + 0.9, W * 0.62 + 0.6, floorTop + 0.78, D * 0.5 + 1.7, colors.trim);
  }

  // Grundfläche (Welt) für Abstands-Prüfungen
  const [c1x, c1z] = toWorld(0, 0);
  const [c2x, c2z] = toWorld(W, D);
  const [dx, dz] = toWorld(doorU, D + 1.2);
  const [ix, iz] = toWorld(doorU, D - 1.5);
  return {
    cx: spec.cx,
    cz: spec.cz,
    y: y0,
    floorY,
    width: W,
    depth: D,
    floors,
    rotation: r,
    bounds: { minX: Math.min(c1x, c2x), maxX: Math.max(c1x, c2x), minZ: Math.min(c1z, c2z), maxZ: Math.max(c1z, c2z) },
    door: { outside: { x: dx, z: dz }, inside: { x: ix, z: iz }, dir: worldDir(1) },
    stairs: floors > 1 ? (() => {
      const [sx, sz] = toWorld(stairStart - 0.45, T + H.stairWidth / 2);
      const [ex, ez] = toWorld(stairEnd + 1.0, T + H.stairWidth / 2);
      return { bottom: { x: sx, z: sz }, top: { x: ex, z: ez }, dir: worldDir(0) };
    })() : null,
    chestSpots,
    lootSpots,
    /** lokale Haus-Koordinaten (u = Breite, v = Tiefe, Tür bei v = depth) → Welt { x, z } */
    toWorld(u, v) {
      const [x, z] = toWorld(u, v);
      return { x, z };
    },
    height: roofY + (spec.style === 'wood' ? Math.min(W, D) * 0.32 : H.parapet) - y0,
  };
}
