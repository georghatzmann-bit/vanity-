// =============================================================================
// Minimap (oben rechts): rund, Norden oben, eigene Position als Pfeil,
// Zone als weißer Kreis, nächste Zone gestrichelt
// =============================================================================
// Norden = −Z (Blick mit yaw 0), Osten = +X. Auf der Karte: oben = −Z, rechts = +X.
// Die Karte zeigt einen Umkreis um die eigene Figur (CONFIG.hud.minimap.range),
// bei kleinen Karten die ganze Karte.
//
// Hintergrund: einmal pro Karte in ein Bild (Canvas) gemalt – Boden-Farbe, dazu die
// Umrisse der Karten-Teile (Häuser, Felsen …) in ihrer Farbe. Eine Karte kann den
// Boden selbst malen: map.paintMinimap(ctx, toPx, pxPerMeter) (z. B. Wasser, Sand).
// Pro Bild wird nur dieses Bild verschoben und Zone + Pfeil darüber gemalt
// (höchstens 30-mal pro Sekunde, nichts Neues angelegt).
// =============================================================================
import { CONFIG } from '../config.js';

const M = CONFIG.hud.minimap;
const DASH = [5, 4];
const NO_DASH = [];

function isRect(b) {
  return !!b && Number.isFinite(b.minX) && Number.isFinite(b.maxX) && Number.isFinite(b.minZ) && Number.isFinite(b.maxZ);
}

/**
 * Grenzen einer Karte { minX, maxX, minZ, maxZ } oder null.
 * Reihenfolge: map.bounds, map.playBounds, sonst map.size (Quadrat um map.center bzw. 0),
 * sonst map.buildBounds.
 */
export function mapBoundsOf(map) {
  if (!map) return null;
  if (isRect(map.bounds)) return map.bounds;
  if (isRect(map.playBounds)) return map.playBounds;
  if (Number.isFinite(map.size) && map.size > 0) {
    const h = map.size / 2;
    const cx = map.center?.x ?? 0;
    const cz = map.center?.z ?? 0;
    return { minX: cx - h, maxX: cx + h, minZ: cz - h, maxZ: cz + h };
  }
  const bb = map.buildBounds;
  if (bb && Number.isFinite(bb.minX) && Number.isFinite(bb.maxX)) return bb;
  return null;
}

/**
 * Wie viele Meter um die Figur die Karte zeigt: höchstens maxRange, bei kleinen Karten
 * so viel, dass die ganze Karte hineinpasst (halbe längste Seite + 10 %).
 */
export function minimapRange(bounds, maxRange = M.range) {
  if (!bounds) return maxRange;
  const half = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2;
  return Math.max(10, Math.min(maxRange, half * 1.1));
}

/**
 * Welt-Punkt (x, z) → Pixel auf der Minimap (Mitte = eigene Figur bei (cx, cz)).
 * k = Pixel pro Meter, r = Radius der Minimap in Pixeln. Norden (−Z) ist oben.
 * @returns {{x: number, y: number}} out
 */
export function worldToMinimap(x, z, cx, cz, k, r, out = { x: 0, y: 0 }) {
  out.x = r + (x - cx) * k;
  out.y = r + (z - cz) * k;
  return out;
}

/**
 * Drehung des eigenen Pfeils (Radiant, im Uhrzeigersinn ab "oben").
 * yaw 0 = Blick nach −Z (oben), positiver yaw = nach links gedreht → Pfeil dreht gegen den Uhrzeigersinn.
 */
export function arrowAngle(yaw) {
  return -yaw;
}

// Wasser einzeichnen (Karten mit map.isWater(x, z), z. B. die Insel): grobes Raster, einmal pro Karte
function paintWater(g, map, bounds, width, height) {
  const cells = 160; // Auflösung des Rasters (Kästchen je Seite)
  const small = document.createElement('canvas');
  small.width = cells;
  small.height = cells;
  const sg = small.getContext('2d');
  const image = sg.createImageData(cells, cells);
  const water = hexToRgb(M.water);
  const land = hexToRgb(M.background);
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxZ - bounds.minZ;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const x = bounds.minX + ((i + 0.5) / cells) * w;
      const z = bounds.minZ + ((j + 0.5) / cells) * h;
      let wet = false;
      try {
        wet = !!map.isWater(x, z);
      } catch {
        wet = false;
      }
      const c = wet ? water : land;
      const k = (j * cells + i) * 4;
      image.data[k] = c[0];
      image.data[k + 1] = c[1];
      image.data[k + 2] = c[2];
      image.data[k + 3] = 255;
    }
  }
  sg.putImageData(image, 0, 0);
  g.imageSmoothingEnabled = true;
  g.drawImage(small, 0, 0, width, height);
}

function hexToRgb(hex) {
  const v = parseInt(String(hex).replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/**
 * HTML-Minimap. container = leeres Element (rund per CSS).
 * @returns {{ draw(game, player, now), setVisible(on), dispose() }}
 */
export function createMinimap(container) {
  const canvas = document.createElement('canvas');
  canvas.className = 'hud-map-canvas';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let cssSize = 0;
  let px = 0; // Kanten-Länge in echten Pixeln
  let bg = null; // { canvas, bounds, scale (Pixel pro Meter), map }
  let lastDraw = -Infinity;
  let dirty = true;
  let needMeasure = true; // Größe nur nach Fenster-Änderung neu messen (kein Layout pro Bild)
  const last = { x: 0, y: 0, z: 0, yaw: 0, sr: 0, scx: 0, scz: 0, snr: 0 };
  const p = { x: 0, y: 0 };

  function resize() {
    const size = container.clientWidth || 0;
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const next = Math.round(size * dpr);
    if (size === cssSize && next === px) return;
    cssSize = size;
    px = next;
    canvas.width = Math.max(1, px);
    canvas.height = Math.max(1, px);
    dirty = true;
  }

  // Hintergrund einer Karte einmal malen
  function buildBackground(map) {
    const bounds = mapBoundsOf(map);
    if (!bounds) return null;
    const w = bounds.maxX - bounds.minX;
    const h = bounds.maxZ - bounds.minZ;
    const scale = Math.min(4, 1024 / Math.max(w, h)); // Pixel pro Meter
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w * scale));
    c.height = Math.max(1, Math.ceil(h * scale));
    const g = c.getContext('2d');
    const toPx = (x, z, out = { x: 0, y: 0 }) => {
      out.x = (x - bounds.minX) * scale;
      out.y = (z - bounds.minZ) * scale;
      return out;
    };
    g.fillStyle = M.background;
    g.fillRect(0, 0, c.width, c.height);
    if (typeof map.paintMinimap !== 'function' && typeof map.isWater === 'function') paintWater(g, map, bounds, c.width, c.height);
    if (typeof map.paintMinimap === 'function') {
      try {
        map.paintMinimap(g, toPx, scale);
      } catch (error) {
        console.error('Minimap: map.paintMinimap ist fehlgeschlagen', error);
      }
    }
    // Karten-Teile (niedrige zuerst, hohe darüber)
    const list = (map.colliders ?? []).filter((col) => col && col.enabled !== false && !map.minimapSkipColliders);
    const top = (col) => (col.type === 'box' ? col.max.y : (col.baseY ?? 0) + (col.rise ?? 0));
    list.sort((a, b) => top(a) - top(b));
    for (const col of list) {
      const minX = col.type === 'box' ? col.min.x : col.minX;
      const maxX = col.type === 'box' ? col.max.x : col.maxX;
      const minZ = col.type === 'box' ? col.min.z : col.minZ;
      const maxZ = col.type === 'box' ? col.max.z : col.maxZ;
      if (!Number.isFinite(minX) || !Number.isFinite(maxZ)) continue;
      const color = col.mesh?.visible === false ? null : col.mesh?.material?.color;
      g.fillStyle = color ? `#${color.getHexString()}` : '#9AA3AD';
      const a = toPx(minX, minZ);
      const ax = a.x;
      const ay = a.y;
      const b = toPx(maxX, maxZ);
      g.fillRect(ax, ay, Math.max(1, b.x - ax), Math.max(1, b.y - ay));
    }
    // Rand der Karte
    g.strokeStyle = M.border;
    g.lineWidth = Math.max(2, scale);
    g.strokeRect(0, 0, c.width, c.height);
    return { canvas: c, bounds, scale, map };
  }

  return {
    canvas,

    /**
     * Malt die Minimap (höchstens alle redrawInterval Sekunden, und nur wenn sich etwas bewegt hat).
     * @param {object} game
     * @param {object} player  eigene Figur (Pfeil in der Mitte)
     * @param {number} now     HUD-Zeit (s)
     * @param {number} yaw     Blickrichtung (Kamera)
     */
    draw(game, player, now, yaw) {
      if (now - lastDraw < M.redrawInterval) return false;
      if (needMeasure) {
        needMeasure = false;
        resize();
      }
      if (px <= 0) return false;
      if (!bg || bg.map !== game.map) {
        bg = game.map ? buildBackground(game.map) : null;
        dirty = true;
      }
      const storm = game.storm;
      const x = player ? player.position.x : 0;
      const z = player ? player.position.z : 0;
      // nur neu malen, wenn sich etwas sichtbar geändert hat (Zahlen vergleichen, keine Texte)
      const sr = storm && Number.isFinite(storm.radius) ? storm.radius : -1;
      const scx = storm?.center?.x ?? 0;
      const scz = storm?.center?.z ?? 0;
      const snr = storm && Number.isFinite(storm.nextRadius) ? storm.nextRadius : -1;
      if (!dirty && Math.abs(x - last.x) < 0.05 && Math.abs(z - last.z) < 0.05 && Math.abs(yaw - last.yaw) < 0.005 &&
        Math.abs(sr - last.sr) < 0.05 && Math.abs(scx - last.scx) < 0.05 && Math.abs(scz - last.scz) < 0.05 &&
        Math.abs(snr - last.snr) < 0.05) return false;
      dirty = false;
      last.x = x;
      last.z = z;
      last.yaw = yaw;
      last.sr = sr;
      last.scx = scx;
      last.scz = scz;
      last.snr = snr;
      lastDraw = now;

      const r = px / 2;
      const range = minimapRange(bg?.bounds ?? mapBoundsOf(game.map));
      const k = r / range;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, px, px);
      ctx.save();
      ctx.beginPath();
      ctx.arc(r, r, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = '#2B3A2A';
      ctx.fillRect(0, 0, px, px);
      if (bg) {
        worldToMinimap(bg.bounds.minX, bg.bounds.minZ, x, z, k, r, p);
        ctx.drawImage(bg.canvas, p.x, p.y, (bg.canvas.width / bg.scale) * k, (bg.canvas.height / bg.scale) * k);
      }
      // Sturm: draußen lila, Zone weiß, nächste Zone gestrichelt
      if (storm && Number.isFinite(storm.radius) && storm.center) {
        worldToMinimap(storm.center.x, storm.center.z, x, z, k, r, p);
        const cr = Math.max(0, storm.radius * k);
        ctx.beginPath();
        ctx.rect(0, 0, px, px);
        ctx.arc(p.x, p.y, cr, 0, Math.PI * 2, true);
        ctx.fillStyle = 'rgba(142, 63, 216, 0.38)';
        ctx.fill('evenodd');
        ctx.beginPath();
        ctx.arc(p.x, p.y, cr, 0, Math.PI * 2);
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = Math.max(1.5, px / 90);
        ctx.setLineDash(NO_DASH);
        ctx.stroke();
        if (storm.nextCenter && Number.isFinite(storm.nextRadius) && storm.nextRadius >= 0 && storm.nextRadius < storm.radius) {
          worldToMinimap(storm.nextCenter.x, storm.nextCenter.z, x, z, k, r, p);
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(0.5, storm.nextRadius * k), 0, Math.PI * 2);
          ctx.setLineDash(DASH);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
          ctx.lineWidth = Math.max(1, px / 120);
          ctx.stroke();
          ctx.setLineDash(NO_DASH);
        }
      }
      // eigener Pfeil (Mitte)
      if (player) {
        const s = px / 14;
        ctx.translate(r, r);
        ctx.rotate(arrowAngle(yaw));
        ctx.beginPath();
        ctx.moveTo(0, -s * 1.25);
        ctx.lineTo(s * 0.85, s * 0.9);
        ctx.lineTo(0, s * 0.45);
        ctx.lineTo(-s * 0.85, s * 0.9);
        ctx.closePath();
        ctx.fillStyle = '#FFD23D';
        ctx.strokeStyle = '#1A1D24';
        ctx.lineWidth = Math.max(1.5, s / 4);
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.fill();
      }
      ctx.restore();
      return true;
    },

    /** Größe beim nächsten Malen neu messen (Fenster-Größe geändert, Minimap eingeblendet). */
    measure() {
      needMeasure = true;
      dirty = true;
    },

    /** Neuer Hintergrund beim nächsten Malen (z. B. Karte hat sich geändert). */
    invalidate() {
      bg = null;
      dirty = true;
    },

    dispose() {
      bg = null;
      canvas.remove();
    },
  };
}
