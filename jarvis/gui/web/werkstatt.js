/* ==========================================================================
   Jarvis – Werkstatt-Ansicht
   Ein Programmier-Auftrag als Blaupause: Plan (A), Ablauf (B), Hologramm (C),
   Dateien (D), Befehle (E). app.js reicht die Ereignisse weiter:
     progress  mit step.workshop = true   -> step()
     workshop  start | text | logo | done | error | cancelled -> handle()
   und beim Verbinden den ganzen Stand (workshop_state) -> load().
   Texte aus Ereignissen werden nur als Klartext (textContent) eingesetzt,
   das Logo nur als Bild (logoSrc: data:image/svg+xml).
   ========================================================================== */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const pad2 = (n) => String(n).padStart(2, '0');
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const motionMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reducedMotion = () => !!(motionMQ && motionMQ.matches);

  const KIND_ICONS = {
    command: '<path d="M4.5 6.5 9.5 12l-5 5.5"/><path d="M12.5 18h7"/>',
    install: '<path d="M12 3.5v10.5M7.5 9.5 12 14l4.5-4.5"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>',
    file: '<path d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5z"/><path d="M14 3v4.5h4.5M9 13h6M9 16.5h4"/>',
    read: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5.5 5.5"/>',
    web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z"/>',
    plan: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="m3.5 6 1.3 1.3L7.3 4.8M3.5 12l1.3 1.3 2.5-2.5M4 18h3"/>',
    app: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9h18M6.5 6.8h.01M9 6.8h.01"/>',
    message: '<path d="M4 5.5h16v10H9.5L4 19.5z"/>',
    task: '<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="18" r="2.2"/><circle cx="6" cy="18" r="2.2"/><path d="M6 8.2v7.6M8.2 6H13a3 3 0 0 1 3 3v6.8"/>',
    other: '<circle cx="12" cy="12" r="3"/>',
  };
  const FILE_NEW = '<path d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5z"/><path d="M14 3v4.5h4.5M12 11v6M9 14h6"/>';
  const FILE_EDIT = '<path d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h4"/><path d="M14 3v4.5h4.5"/><path d="m13.5 20.5.6-2.6 5.2-5.2a1.4 1.4 0 0 1 2 2L16.1 19.9z"/>';
  const PROMPT = '<path d="M5 7.5 9.5 12 5 16.5"/><path d="M12 17h7"/>';
  const MARKS = {
    done: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    error: '<path d="M7 7l10 10M17 7 7 17"/>',
    cancelled: '<path d="M7 12h10"/>',
  };
  const CHIP = { running: 'Arbeitet', done: 'Fertig', error: 'Fehler', cancelled: 'Abgebrochen' };
  const STAMP = { done: 'Fertig', error: 'Fehler', cancelled: 'Abgebrochen' };
  const COLORS = {
    running: [124, 196, 255],
    done: [96, 214, 146],
    error: [240, 85, 90],
    cancelled: [128, 148, 176],
  };

  function svg(paths, cls) {
    const node = document.createElementNS(SVG_NS, 'svg');
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('aria-hidden', 'true');
    if (cls) node.setAttribute('class', cls);
    node.innerHTML = paths; // nur feste Zeichen aus diesem Skript
    return node;
  }

  // Zustandszeichen wie in style.css (.mark): dreht sich, Haken, Kreuz, Strich
  function mark(state) {
    const span = document.createElement('span');
    const kind = state === 'running' || state === 'in_progress' ? 'run' : state;
    span.className = 'mark mark-' + kind;
    if (MARKS[state]) span.append(svg(MARKS[state]));
    else if (state === 'completed') span.append(svg(MARKS.done));
    return span;
  }

  function fmtSecs(value) {
    const v = Math.max(0, Number(value) || 0);
    if (v < 10) return v.toFixed(1).replace('.', ',') + ' s';
    if (v < 59.5) return Math.round(v) + ' s';
    const total = Math.round(v);
    return Math.floor(total / 60) + ':' + pad2(total % 60) + ' min';
  }

  function fmtClock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return (h ? h + ':' + pad2(m) : pad2(m)) + ':' + pad2(s);
  }

  function nowClock() {
    const d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function fmtSize(bytes) {
    if (!(bytes > 0)) return '0 KB';
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    return (bytes / 1048576).toFixed(1).replace('.', ',') + ' MB';
  }

  function shortDate(iso) {
    const d = new Date(String(iso || ''));
    if (Number.isNaN(d.getTime())) return '';
    return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '. ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function baseName(path) {
    const parts = String(path || '').split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(path || '');
  }

  // "C:\Users\Georg\Jarvis-Werkstatt\2026-10-01_1530_bot" -> "…\Jarvis-Werkstatt\2026-10-01_1530_bot"
  function shortPath(path) {
    const parts = String(path || '').split(/[\\/]+/).filter(Boolean);
    if (parts.length <= 2) return String(path || '–') || '–';
    return '…\\' + parts.slice(-2).join('\\');
  }

  // Pfad innerhalb des Projektordners: "C:\…\projekt\src\bot.py" -> "src\bot.py"
  function relPath(path, folder) {
    const p = String(path || '');
    const f = String(folder || '');
    if (f && p.toLowerCase().startsWith(f.toLowerCase())) return p.slice(f.length).replace(/^[\\/]+/, '') || baseName(p);
    return p;
  }

  // Was Jarvis in der Werkstatt schreibt: die letzten zwei Zeilen, ohne Markdown und Code
  function lastWords(text) {
    const lines = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/```[\s\S]*$/, ' ')
      .split(/\n+/)
      .map((line) => line.replace(/[#*_`>|]+/g, '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    let out = lines.slice(-2).join(' ');
    if (out.length > 260) out = '… ' + out.slice(-256).replace(/^\S*\s/, '');
    return out;
  }

  // ==================================================================
  //   Hologramm: Das Projekt entsteht als Drahtmodell, von unten nach oben
  //   (wie ein 3D-Drucker, mit Laser-Ebene an der Baukante). Die Form passt
  //   zum Auftrag: ein Roboter für Bots, ein Controller für Spiele, ein Globus
  //   für Webseiten ... Hat die Werkstatt ihr eigenes logo.svg gezeichnet,
  //   baut sich an seiner Stelle dieses Logo als Hologramm auf (setLogo).
  // ==================================================================

  // Symbole im 24er-Raster (wie die Icons): Linienzüge, "c" am Ende = geschlossen
  const ring = (cx, cy, r, n = 20, from = 0, to = Math.PI * 2) => {
    const pts = [];
    for (let i = 0; i <= n; i += 1) {
      const a = from + (to - from) * (i / n);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    return pts;
  };
  const gear = () => {
    const pts = [];
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2;
      for (const [d, r] of [[-0.3, 6.3], [-0.16, 8.6], [0.16, 8.6], [0.3, 6.3]]) {
        pts.push([12 + Math.cos(a + d) * r, 12 + Math.sin(a + d) * r]);
      }
    }
    pts.push(pts[0]);
    return pts;
  };
  const EMBLEMS = {
    robot: () => [
      [[5, 8], [19, 8], [19, 19], [5, 19], [5, 8]],
      ring(9.5, 12.5, 1.5, 10), ring(14.5, 12.5, 1.5, 10),
      [[9, 16], [15, 16]],
      [[12, 8], [12, 4.5]], ring(12, 3.6, 1, 8),
      [[5, 11.5], [3, 11.5], [3, 15.5], [5, 15.5]], [[19, 11.5], [21, 11.5], [21, 15.5], [19, 15.5]],
    ],
    gamepad: () => [
      [[6, 7.5], [18, 7.5], [21, 12.5], [21.8, 16.8], [19.6, 18.6], [16, 15.8], [8, 15.8], [4.4, 18.6], [2.2, 16.8], [3, 12.5], [6, 7.5]],
      [[7.2, 10], [7.2, 13.6]], [[5.4, 11.8], [9, 11.8]],
      ring(16, 10.6, 0.9, 8), ring(18, 12.8, 0.9, 8),
    ],
    globe: () => [
      ring(12, 12, 8.5, 28),
      [[3.5, 12], [20.5, 12]], [[5, 7.5], [19, 7.5]], [[5, 16.5], [19, 16.5]],
      ring(12, 12, 8.5, 18, -Math.PI / 2, Math.PI / 2).map(([x, y]) => [12 + (x - 12) * 0.42, y]),
      ring(12, 12, 8.5, 18, Math.PI / 2, Math.PI * 1.5).map(([x, y]) => [12 + (x - 12) * 0.42, y]),
    ],
    bag: () => [
      [[5, 8.5], [19, 8.5], [18, 20.5], [6, 20.5], [5, 8.5]],
      ring(12, 8.5, 3.4, 12, Math.PI, Math.PI * 2),
      [[8.5, 12], [15.5, 12]],
    ],
    note: () => [
      [[15, 17], [15, 4], [20.5, 6.2], [20.5, 9], [15, 6.8]],
      ring(12.4, 17, 2.6, 16),
      [[6, 9], [6, 18]], ring(4.6, 18, 1.4, 10),
    ],
    chart: () => [
      [[3.5, 3.5], [3.5, 20.5], [20.5, 20.5]],
      [[6.5, 20.5], [6.5, 14], [9.5, 14], [9.5, 20.5]],
      [[11.5, 20.5], [11.5, 9], [14.5, 9], [14.5, 20.5]],
      [[16.5, 20.5], [16.5, 5.5], [19.5, 5.5], [19.5, 20.5]],
    ],
    gear: () => [gear(), ring(12, 12, 2.8, 14)],
    window: () => [
      [[3, 5], [21, 5], [21, 19.5], [3, 19.5], [3, 5]],
      [[3, 8.5], [21, 8.5]], ring(5.4, 6.8, 0.6, 6), ring(7.6, 6.8, 0.6, 6),
      [[6.5, 12.5], [9.5, 14.5], [6.5, 16.5]], [[11, 16.5], [16, 16.5]],
    ],
  };
  const EMBLEM_WORDS = [
    ['robot', /\bbots?\b|roboter|discord|telegram|whatsapp|chatbot|assistent/],
    ['gamepad', /(?<!bei|ab)spiel|\bgames?\b|pygame|snake|tetris|pong|minecraft|würfel|quiz|jump/],
    ['bag', /shop|\bladen\b|verkauf|produkt|bestell|kasse|warenkorb/],
    ['note', /musik|music|spotify|song|playlist|radio|sound|beat|podcast/],
    ['globe', /webseite|website|homepage|html|landing|seite|\bweb\b|blog/],
    ['chart', /aktie|finanz|budget|tabelle|excel|statistik|diagramm|chart|ausgaben|krypto|bitcoin|börse/],
    ['window', /\bapps?\b|programm(?!ier)|fenster|rechner|kalender|notiz|todo|editor/],
    ['gear', /skript|script|tool|werkzeug|automat|sortier|download|ordner|datei|backup|python|makro|\bmod\b|plugin/],
  ];

  // Welches Symbol zum Auftrag passt; unbekannt bleibt die Kugel von früher
  function emblemFor(task) {
    const text = String(task || '').toLowerCase();
    for (const [name, pattern] of EMBLEM_WORDS) if (pattern.test(text)) return name;
    return 'sphere';
  }

  // Kanten von unten nach oben sortiert, dazu ihre Höhe (ey) und die Höhe des ganzen Modells
  function prepare(v, e, flat) {
    const mid = ([a, b]) => (v[a][1] + v[b][1]) / 2;
    e.sort((e1, e2) => mid(e1) - mid(e2));
    const ys = v.map((p) => p[1]);
    return { v, e, ey: e.map(mid), lo: Math.min(...ys), hi: Math.max(...ys), flat };
  }

  // Ein Symbol als 3D-Drahtmodell: vorne und hinten derselbe Linienzug, dazwischen Streben
  function extrude(lines) {
    const v = [];
    const e = [];
    const depth = 0.2;
    for (const line of lines) {
      const ids = line.map(([x, y]) => {
        v.push([(x - 12) / 10, (12 - y) / 10, depth], [(x - 12) / 10, (12 - y) / 10, -depth]);
        return v.length - 2;
      });
      for (let i = 0; i + 1 < ids.length; i += 1) {
        e.push([ids[i], ids[i + 1]], [ids[i] + 1, ids[i + 1] + 1]);
      }
      const every = line.length > 12 ? 4 : 1;
      ids.forEach((id, i) => { if (i % every === 0) e.push([id, id + 1]); });
    }
    return prepare(v, e, true);
  }

  function geodesic() {
    const p = (1 + Math.sqrt(5)) / 2;
    const norm = (q) => {
      const l = Math.hypot(q[0], q[1], q[2]);
      return [q[0] / l, q[1] / l, q[2] / l];
    };
    const v = [[-1, p, 0], [1, p, 0], [-1, -p, 0], [1, -p, 0], [0, -1, p], [0, 1, p], [0, -1, -p], [0, 1, -p],
      [p, 0, -1], [p, 0, 1], [-p, 0, -1], [-p, 0, 1]].map(norm);
    const faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2],
      [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10],
      [8, 6, 7], [9, 8, 1]];
    const cache = new Map();
    const mid = (a, b) => {
      const key = a < b ? a + '_' + b : b + '_' + a;
      if (cache.has(key)) return cache.get(key);
      v.push(norm([(v[a][0] + v[b][0]) / 2, (v[a][1] + v[b][1]) / 2, (v[a][2] + v[b][2]) / 2]));
      cache.set(key, v.length - 1);
      return v.length - 1;
    };
    const edges = new Map();
    const edge = (a, b) => {
      const key = a < b ? a + '_' + b : b + '_' + a;
      if (!edges.has(key)) edges.set(key, [a, b]);
    };
    for (const [a, b, c] of faces) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      for (const [x, y, z] of [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]) {
        edge(x, y);
        edge(y, z);
        edge(z, x);
      }
    }
    return prepare(v, [...edges.values()], false);
  }

  // Nur ein Bild, das Jarvis selbst geschickt hat: data:image/svg+xml (in einem Bild laufen keine Skripte)
  function logoSrc(value) {
    const src = String(value || '');
    return src.length < 200000 && /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/.test(src) ? src : '';
  }

  const Construct = (() => {
    let geo = geodesic();
    let shape = 'sphere';
    let canvas = null;
    let ctx = null;
    let w = 0;
    let h = 0;
    let dpr = 1;
    let running = false;
    let last = 0;
    let t = 0;
    let shown = 0;
    let goal = 0;
    let state = 'running';
    let flashT = -10;
    // Das Logo aus der Werkstatt (logo.svg) ersetzt das Drahtmodell, sobald es geladen ist
    let logo = '';
    let logoImg = null;
    let logoT = 0;
    let art = null; // das Logo in Hologramm-Farbe, neu nur bei anderer Größe oder Farbe
    let artKey = '';
    const color = COLORS.running.slice();

    const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(a, 0, 1).toFixed(3)})`;

    function resize() {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const nw = Math.max(1, Math.round(rect.width * dpr));
      const nh = Math.max(1, Math.round(rect.height * dpr));
      if (nw !== w || nh !== h) {
        w = nw;
        h = nh;
        canvas.width = w;
        canvas.height = h;
        if (!running) draw();
      }
    }

    function attach(node) {
      canvas = node;
      if (!canvas) return;
      ctx = canvas.getContext('2d');
      if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
      else window.addEventListener('resize', resize);
      resize();
    }

    function project(x, y, z, view) {
      const x1 = x * view.cy + z * view.sy;
      const z1 = -x * view.sy + z * view.cy;
      const y2 = y * view.cp - z1 * view.sp;
      const z2 = y * view.sp + z1 * view.cp;
      const s = 3.4 / (3.4 + z2);
      return [view.cx + x1 * view.R * s, view.cy0 - y2 * view.R * s, z2];
    }

    function ellipse(view, yLevel, radius, alpha, width, fill) {
      ctx.beginPath();
      for (let i = 0; i <= 48; i += 1) {
        const a = (i / 48) * Math.PI * 2;
        const [x, y] = project(Math.cos(a) * radius, yLevel, Math.sin(a) * radius, view);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      if (fill) {
        ctx.fillStyle = rgba(color, fill);
        ctx.fill();
      }
      ctx.lineWidth = width * dpr;
      ctx.strokeStyle = rgba(color, alpha);
      ctx.stroke();
    }

    // Das Logo in Hologramm-Farbe: Helles wird fast weiß, Dunkles ein tiefer Ton derselben Farbe
    // (nichts verschwindet im dunklen Hintergrund), dazu feine Scanlinien.
    function logoArt(side) {
      const key = side + ':' + (color[0] | 0) + ',' + (color[1] | 0) + ',' + (color[2] | 0);
      if (art && artKey === key) return art;
      if (!art) art = document.createElement('canvas');
      art.width = side;
      art.height = side;
      const c = art.getContext('2d');
      const iw = logoImg.naturalWidth || 256;
      const ih = logoImg.naturalHeight || 256;
      const k = Math.min(side / iw, side / ih);
      const dw = iw * k;
      const dh = ih * k;
      const dx = (side - dw) / 2;
      const dy = (side - dh) / 2;
      c.clearRect(0, 0, side, side);
      c.globalCompositeOperation = 'source-over';
      c.drawImage(logoImg, dx, dy, dw, dh);
      c.globalCompositeOperation = 'source-in';
      c.fillStyle = rgba(color, 1);
      c.fillRect(0, 0, side, side);
      c.globalCompositeOperation = 'overlay';
      c.filter = 'grayscale(1)';
      c.drawImage(logoImg, dx, dy, dw, dh);
      c.filter = 'none';
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(logoImg, dx, dy, dw, dh);
      c.globalCompositeOperation = 'destination-out';
      c.fillStyle = 'rgba(0,0,0,0.38)';
      const gap = Math.max(2, Math.round(3 * dpr));
      const line = Math.max(1, Math.round(dpr));
      for (let y = 0; y < side; y += gap) c.fillRect(0, y, side, line);
      c.globalCompositeOperation = 'source-over';
      artKey = key;
      return art;
    }

    // Wie weit das Logo schon gebaut ist: beim ersten Erscheinen fährt der Laser schnell bis zur Baukante
    function logoReveal() {
      const m = reducedMotion() ? 1 : clamp((t - logoT) / 1.2, 0, 1);
      return Math.min(shown, 1 - (1 - m) ** 3);
    }

    function drawLogo(view, level, flash) {
      const top = project(0, 0.9, 0, view)[1];
      const bottom = project(0, -0.9, 0, view)[1];
      const side = Math.round(bottom - top);
      if (side < 16) return;
      const img = logoArt(side);
      const yaw = reducedMotion() ? 0 : Math.sin(t * 0.55) * 0.55; // schwenkt wie ein Hologramm
      const dw = side * Math.cos(yaw);
      const bob = reducedMotion() ? 0 : Math.sin(t * 1.3) * 2 * dpr;
      const x = view.cx - dw / 2;
      const y = top + bob;
      const cut = project(0, level, 0, view)[1] + bob; // darunter ist gebaut
      ctx.save();
      ctx.globalAlpha = 0.13; // noch geplant: blass
      ctx.drawImage(img, x, y, dw, side);
      if (cut < y + side) {
        ctx.beginPath();
        ctx.rect(0, cut, w, h - cut);
        ctx.clip();
        const flicker = reducedMotion() ? 0 : Math.sin(t * 7.3) * Math.sin(t * 2.9) * 0.08;
        ctx.globalAlpha = clamp(0.86 + flicker + flash * 0.14, 0, 1);
        ctx.shadowColor = rgba(color, 0.9);
        ctx.shadowBlur = 14 * dpr;
        ctx.drawImage(img, x, y, dw, side);
      }
      ctx.restore();
    }

    function drawWire(view, level, flash) {
      const P = geo.v.map(([x, y, z]) => project(x, y, z, view));
      let built = 0;
      while (built < geo.ey.length && geo.ey[built] <= level) built += 1;
      // Drahtlinien: geplant (blass) und gebaut (hell, vorne heller), die neuesten leuchten
      for (let i = 0; i < geo.e.length; i += 1) {
        const [a, b] = geo.e[i];
        const pa = P[a];
        const pb = P[b];
        const near = 1 - ((pa[2] + pb[2]) / 2 + 1) / 2;
        let alpha = 0.1;
        let width = 1;
        if (i < built) {
          alpha = 0.28 + 0.52 * near + flash * 0.4;
          if (geo.flat) alpha += 0.15;
          if (state === 'running' && built - i <= 5) {
            alpha = 1;
            width = 1.6;
          }
        }
        ctx.beginPath();
        ctx.moveTo(pa[0], pa[1]);
        ctx.lineTo(pb[0], pb[1]);
        ctx.lineWidth = width * (geo.flat ? 1.3 : 1) * dpr;
        ctx.strokeStyle = rgba(color, alpha);
        ctx.stroke();
      }
      // Knotenpunkte des gebauten Teils
      if (geo.flat) return;
      for (let i = 0; i < P.length; i += 1) {
        if (geo.v[i][1] > level) continue;
        const near = 1 - (P[i][2] + 1) / 2;
        ctx.beginPath();
        ctx.arc(P[i][0], P[i][1], (1 + near) * dpr, 0, Math.PI * 2);
        ctx.fillStyle = rgba(color, 0.35 + 0.5 * near);
        ctx.fill();
      }
    }

    function draw() {
      if (!ctx || !w || !h) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const flat = geo.flat || !!logoImg;
      // Kugeln drehen sich ganz, Symbole schwenken hin und her (dann bleiben sie lesbar)
      const yaw = reducedMotion() ? (flat ? 0.3 : 0.5) : flat ? Math.sin(t * 0.55) * 0.7 : t * 0.32;
      const pitch = flat ? -0.12 : -0.36;
      const view = {
        cx: w / 2, cy0: h * 0.47, R: Math.min(w * 0.36, h * 0.38),
        cy: Math.cos(yaw), sy: Math.sin(yaw), cp: Math.cos(pitch), sp: Math.sin(pitch),
      };
      // Höhe der Baukante: vom Fuß bis zur Spitze des Modells (das Logo reicht von -0,9 bis 0,9)
      const level = logoImg ? -0.9 + 1.8 * logoReveal() : geo.lo - 0.03 + (geo.hi - geo.lo + 0.06) * shown;
      const flash = Math.max(0, 1 - (t - flashT) / 0.9);
      ctx.lineCap = 'round';

      // Projektor-Sockel unter dem Modell
      ctx.setLineDash([3 * dpr, 4 * dpr]);
      ellipse(view, -1.12, 0.9, 0.22, 1, 0.03);
      ctx.setLineDash([]);
      // Lichtkegel vom Sockel nach oben
      const base = project(0, -1.12, 0, view);
      const glow = ctx.createLinearGradient(0, base[1], 0, base[1] - view.R * 2.1);
      glow.addColorStop(0, rgba(color, 0.12));
      glow.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.moveTo(base[0] - view.R * 0.9, base[1]);
      ctx.lineTo(base[0] + view.R * 0.9, base[1]);
      ctx.lineTo(base[0] + view.R * 1.15, base[1] - view.R * 2.1);
      ctx.lineTo(base[0] - view.R * 1.15, base[1] - view.R * 2.1);
      ctx.closePath();
      ctx.fill();
      // Gyroskop-Ring mit Lichtpunkt
      ctx.save();
      ctx.translate(view.cx, view.cy0);
      ctx.rotate(Math.sin(t * 0.21) * 0.18);
      ctx.beginPath();
      ctx.ellipse(0, 0, view.R * 1.28, view.R * 0.32, 0, 0, Math.PI * 2);
      ctx.lineWidth = 1 * dpr;
      ctx.strokeStyle = rgba(color, 0.16);
      ctx.stroke();
      const dotA = t * 0.9;
      ctx.beginPath();
      ctx.arc(Math.cos(dotA) * view.R * 1.28, Math.sin(dotA) * view.R * 0.32, 2.2 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = rgba(color, 0.8);
      ctx.fill();
      ctx.restore();

      if (logoImg) drawLogo(view, level, flash);
      else drawWire(view, level, flash);
      // Laser-Ebene an der Baukante
      if (state === 'running' && level > -0.99 && level < 0.99 && shown > 0.01 && shown < 0.995) {
        const r = flat ? 1.05 : Math.sqrt(Math.max(0, 1 - level * level)) * 1.06;
        ctx.save();
        ctx.shadowColor = rgba(color, 0.9);
        ctx.shadowBlur = 12 * dpr;
        ellipse(view, level, r, 0.95, 1.6, 0.08);
        ctx.restore();
      }
      // Fertig: ein Lichtring breitet sich aus
      if (flash > 0) {
        ctx.beginPath();
        ctx.arc(view.cx, view.cy0, view.R * (1 + (1 - flash) * 0.7), 0, Math.PI * 2);
        ctx.lineWidth = 2 * dpr;
        ctx.strokeStyle = rgba(color, flash * 0.8);
        ctx.stroke();
      }
    }

    function frame(now) {
      if (!running) return;
      const dt = Math.min(0.05, (now - (last || now)) / 1000);
      last = now;
      t += dt;
      shown += (goal - shown) * Math.min(1, dt * (reducedMotion() ? 30 : state === 'done' ? 4 : 2));
      const want = COLORS[state] || COLORS.running;
      for (let i = 0; i < 3; i += 1) color[i] += (want[i] - color[i]) * Math.min(1, dt * 3);
      draw();
      setTimeout(() => requestAnimationFrame(frame), document.hidden ? 500 : 33);
    }

    function start() {
      if (running || !canvas) return;
      running = true;
      last = 0;
      resize();
      requestAnimationFrame(frame);
    }

    function stop() {
      running = false;
    }

    function set(progress, newState) {
      goal = clamp(progress, 0, 1);
      if (newState && newState !== state) {
        if (newState === 'done') flashT = t;
        state = newState;
      }
      if (!running) {
        shown = goal;
        draw();
      }
    }

    function setShape(name) {
      const want = EMBLEMS[name] ? name : 'sphere';
      if (want === shape) return;
      shape = want;
      geo = EMBLEMS[want] ? extrude(EMBLEMS[want]()) : geodesic();
      draw();
    }

    // Das Logo der Werkstatt; leer = wieder das Drahtmodell. Ein Bild, das nicht lädt, ändert nichts.
    function setLogo(src) {
      src = logoSrc(src);
      if (src === logo) return;
      logo = src;
      logoImg = null;
      artKey = '';
      if (!src) {
        draw();
        return;
      }
      const img = new Image();
      img.onload = () => {
        if (logo !== src) return;
        logoImg = img;
        logoT = t;
        draw();
      };
      img.onerror = () => {
        if (logo === src) logo = '';
      };
      img.src = src;
    }

    function reset() {
      shown = 0;
      goal = 0;
      state = 'running';
      flashT = -10;
      logo = '';
      logoImg = null;
      artKey = '';
      draw();
    }

    return {
      attach, start, stop, set, reset, setShape, setLogo,
      shape: () => shape, hasLogo: () => !!logoImg, progress: () => shown,
    };
  })();

  // ==================================================================
  //   Die Ansicht
  // ==================================================================

  function create(opts) {
    const call = opts.call;
    const toast = opts.toast || (() => {});
    const el = {
      body: document.body,
      ws: $('ws'),
      back: $('wsBack'),
      task: $('wsTask'),
      chip: $('wsChip'),
      chipText: $('wsChipText'),
      timer: $('wsTimer'),
      folder: $('wsFolder'),
      stop: $('wsStop'),
      stopText: $('wsStopText'),
      todos: $('wsTodos'),
      todosEmpty: $('wsTodosEmpty'),
      planCount: $('wsPlanCount'),
      planBar: $('wsPlanBar'),
      steps: $('wsSteps'),
      stepsEmpty: $('wsStepsEmpty'),
      stepCount: $('wsStepCount'),
      result: $('wsResult'),
      stamp: $('wsStamp'),
      summary: $('wsSummary'),
      answer: $('wsAnswer'),
      detail: $('wsDetail'),
      kicker: document.querySelector('.ws-kicker'),
      resultFolder: $('wsResultFolder'),
      resultBack: $('wsResultBack'),
      construct: $('wsConstruct'),
      percent: $('wsPercent'),
      percentHint: $('wsPercentHint'),
      files: $('wsFiles'),
      filesEmpty: $('wsFilesEmpty'),
      fileCount: $('wsFileCount'),
      cmds: $('wsCmds'),
      cmdsEmpty: $('wsCmdsEmpty'),
      cmdCount: $('wsCmdCount'),
      text: $('wsText'),
      path: $('wsPath'),
      begun: $('wsBegun'),
      pill: $('workshopPill'),
      pillText: $('workshopPillText'),
      pillTime: $('workshopPillTime'),
      projects: $('wsProjects'),
      resultRun: $('wsResultRun'),
      resultPreview: $('wsResultPreview'),
      resultDelete: $('wsResultDelete'),
      historyBox: $('wsHistoryBox'),
      history: $('wsHistory'),
      tell: $('wsTell'),
      tellLabel: $('wsTellLabel'),
      tellInput: $('wsTellInput'),
      tellBtn: $('wsTellBtn'),
    };
    if (!el.ws) return null;

    // live: der laufende (oder letzte) Auftrag aus den Ereignissen. job: was die Ansicht gerade zeigt,
    // das ist live oder ein Projekt aus der Liste ("Ansehen", "Zeig mir das Projekt …").
    let live = null;
    let job = null;
    let deleteArmed = 0;
    let isOpen = false;
    let follow = true;
    let armTimer = 0;
    let ticker = 0;
    let closeTimer = 0;
    const stepEls = new Map();

    Construct.attach(el.construct);

    function newJob(data) {
      data = data || {};
      return {
        task: String(data.task || 'Auftrag'),
        folder: String(data.folder || ''),
        continues: !!data.continues,
        question: '',
        state: 'running',
        begun: String(data.begun || nowClock()),
        startedAt: Date.now() - (Number(data.seconds) || 0) * 1000,
        endedAt: 0,
        summary: '',
        detail: '',
        text: '',
        todos: [],
        steps: new Map(),
        order: [],
        planId: '',
        logo: logoSrc(data.logo),
        viewed: false, // ein Projekt aus der Liste, nicht der laufende Auftrag
        noClock: false,
        name: String(data.name || ''),
        start: !!data.start,
        preview: !!data.preview,
        history: [],
        diskFiles: null,
      };
    }

    // Das Hologramm zum Auftrag: erst das passende Symbol, das eigene Logo, sobald es da ist
    function showModel() {
      Construct.setShape(emblemFor(job.task));
      Construct.setLogo(job.logo);
    }

    // ------------------------------------------------------------ Ereignisse

    function handle(ev) {
      if (!ev || typeof ev !== 'object') return;
      const state = String(ev.state || '');
      if (state === 'start') {
        live = newJob(ev);
        show(live);
        open();
        return;
      }
      if (state === 'deleted') {
        forget(String(ev.folder || ''));
        return;
      }
      if (!live) {
        live = newJob(ev);
        if (!job) {
          job = live;
          showModel();
        }
      }
      const shown = job === live;
      if (state === 'text') {
        live.text = String(ev.text || '');
        if (shown) renderText();
        return;
      }
      if (state === 'logo') {
        live.logo = logoSrc(ev.logo);
        if (shown) Construct.setLogo(live.logo);
        return;
      }
      if (state === 'done' || state === 'error' || state === 'cancelled') {
        live.state = state;
        live.summary = String(ev.summary || '');
        live.detail = String(ev.detail || '');
        live.question = String(ev.question || '');
        if (ev.folder) live.folder = String(ev.folder);
        const secs = Number(ev.seconds);
        live.endedAt = Number.isFinite(secs) && secs > 0 ? live.startedAt + secs * 1000 : Date.now();
        for (const s of live.steps.values()) {
          if (s.state !== 'running') continue;
          s.state = state === 'done' ? 'done' : state === 'error' ? 'error' : 'cancelled';
          if (shown) renderStep(s);
        }
        if (shown) renderAll();
        else {
          renderPill();
          syncTicker();
        }
      }
    }

    const todoList = (todos) => todos.map((t) => ({
      text: String((t && t.text) || ''), state: String((t && t.state) || 'pending'),
    }));

    // Einen Schritt in einen Auftrag übernehmen. null = nur ein Haken im Plan, kein neuer Schritt.
    function addStep(j, data) {
      const id = String(data.id);
      const todos = Array.isArray(data.todos) ? data.todos : null;
      if (todos) j.todos = todoList(todos);
      // Der Plan steht einmal im Ablauf; jedes Abhaken danach nur im Plan.
      if (data.kind === 'plan' && todos && j.planId && j.planId !== id) return null;
      if (data.kind === 'plan' && todos && !j.planId) j.planId = id;
      const known = j.steps.get(id);
      const merged = Object.assign({}, known || {}, data, { id });
      if (!known) {
        merged.firstSeen = Date.now() - (Number(data.seconds) || 0) * 1000;
        j.order.push(id);
      }
      j.steps.set(id, merged);
      return merged;
    }

    function step(data, quiet) {
      if (!data || typeof data !== 'object' || !data.id) return;
      if (!live) {
        live = newJob({});
        if (!job) job = live;
      }
      const merged = addStep(live, data);
      if (job !== live) {
        renderPill(); // Georg sieht sich gerade ein anderes Projekt an
        return;
      }
      if (Array.isArray(data.todos)) renderTodos();
      if (merged) {
        renderStep(merged, quiet);
        renderLists();
        renderCounts();
      }
      renderReadout();
      renderPill();
    }

    // Ein ganzer Stand (workshop_state oder ein Projekt zum Ansehen) als Auftrag
    function fromSnapshot(snap) {
      const j = newJob(snap);
      j.state = CHIP[snap.state] ? String(snap.state) : 'running';
      j.summary = String(snap.summary || '');
      j.detail = String(snap.detail || '');
      j.text = String(snap.text || '');
      j.question = String(snap.question || '');
      if (j.state !== 'running') j.endedAt = Date.now();
      if (Array.isArray(snap.todos)) j.todos = todoList(snap.todos);
      for (const s of Array.isArray(snap.steps) ? snap.steps : []) {
        if (!s || typeof s !== 'object' || !s.id) continue;
        const copy = Object.assign({}, s);
        if (copy.kind === 'plan' && j.planId) continue;
        delete copy.todos;
        if (copy.kind === 'plan' && !j.planId) j.planId = String(copy.id);
        addStep(j, copy);
      }
      if (Array.isArray(snap.history)) j.history = snap.history.slice(-20);
      return j;
    }

    function load(snap) {
      if (!snap || typeof snap !== 'object') return;
      live = fromSnapshot(snap);
      if (job && job.viewed && isOpen) {
        renderPill();
        syncTicker();
        return;
      }
      show(live);
    }

    // Die Ansicht ganz neu für einen Auftrag zeichnen
    function show(j) {
      job = j;
      resetView();
      if (!job) return;
      showModel();
      for (const id of job.order) {
        const s = job.steps.get(id);
        if (s) renderStep(s, true);
      }
      renderAll();
    }

    // "Ansehen" in der Projektliste oder "Zeig mir das Projekt …": ein Projekt mit Plan, Ablauf, Dateien
    function view(data) {
      if (!data || typeof data !== 'object') return false;
      const j = fromSnapshot(data);
      j.start = !!data.start;
      j.preview = !!data.preview;
      if (data.live) {
        if (live && live.folder === j.folder && live.state === 'running') {
          Object.assign(live, { start: j.start, preview: j.preview, history: j.history });
        } else {
          live = j;
        }
        show(live);
      } else {
        j.viewed = true;
        j.begun = String(data.begun || '–');
        const secs = Number(data.seconds);
        j.noClock = !(secs > 0);
        j.startedAt = Date.now() - (secs > 0 ? secs * 1000 : 0);
        j.endedAt = Date.now();
        j.diskFiles = Array.isArray(data.files) ? data.files : null;
        show(j);
      }
      open();
      return true;
    }

    // Ein Projekt wurde gelöscht: nicht mehr zeigen
    function forget(folder) {
      if (!folder) return;
      if (live && live.folder === folder && live.state !== 'running') live = null;
      if (job && job.folder === folder) {
        if (isOpen) close();
        else show(live);
      }
      renderPill();
      syncTicker();
    }

    // ------------------------------------------------------------ Anzeige

    function resetView() {
      stepEls.clear();
      el.steps.replaceChildren();
      el.todos.replaceChildren();
      el.files.replaceChildren();
      el.cmds.replaceChildren();
      el.result.hidden = true;
      follow = true;
      disarm();
      Construct.reset();
    }

    function renderAll() {
      if (!job) return;
      renderHeader();
      renderTodos();
      renderLists();
      renderCounts();
      renderText();
      renderResult();
      renderReadout();
      renderPill();
      syncTicker();
    }

    function elapsed(j) {
      j = j || job;
      if (!j) return 0;
      return (j.endedAt || Date.now()) - j.startedAt;
    }

    function renderHeader() {
      el.ws.dataset.state = job.state;
      el.ws.dataset.viewed = job.viewed ? 'true' : 'false';
      if (el.kicker) {
        el.kicker.textContent = job.viewed ? 'Werkstatt · Projekt' + (job.name ? ' ' + job.name : '')
          : job.continues ? 'Werkstatt · weiter am Projekt' : 'Werkstatt';
      }
      el.back.title = job.viewed ? 'Zurück zu allen Projekten (Esc)' : 'Zurück zu Jarvis (Esc). Die Arbeit läuft weiter.';
      el.task.textContent = job.task;
      el.task.title = job.task;
      el.chip.dataset.state = job.state;
      el.chipText.textContent = CHIP[job.state] || CHIP.running;
      const markBox = el.chip.querySelector('.ws-chip-mark');
      markBox.replaceChildren();
      if (MARKS[job.state]) markBox.append(svg(MARKS[job.state]));
      el.stop.hidden = job.state !== 'running';
      el.folder.disabled = !job.folder;
      el.resultFolder.disabled = !job.folder;
      el.path.textContent = job.folder ? shortPath(job.folder) : '–';
      el.path.title = job.folder;
      el.begun.textContent = job.begun;
      el.timer.textContent = job.noClock ? '' : fmtClock(elapsed());
      el.timer.hidden = job.noClock;
      renderTell();
    }

    // Das Feld unten: mitten in der Arbeit etwas ändern, danach am Projekt weiterbauen
    function renderTell() {
      if (!el.tell || !job) return;
      const working = job.state === 'running';
      const otherBusy = !working && !!live && live !== job && live.state === 'running';
      el.tell.dataset.mode = working ? 'tell' : 'more';
      el.tellLabel.textContent = working ? 'Ändern' : 'Weiterbauen';
      el.tellBtn.textContent = working ? 'Einbauen' : 'Weiterbauen';
      el.tellInput.placeholder = otherBusy
        ? 'Die Werkstatt arbeitet gerade an einem anderen Auftrag. Danach geht es hier weiter.'
        : working ? 'Etwas ändern? Zum Beispiel: Mach den Hintergrund blau'
          : 'Was soll noch dazu? Zum Beispiel: ein Highscore oder ein dunkles Design';
      el.tellInput.disabled = otherBusy;
      el.tellBtn.disabled = otherBusy || !el.tellInput.value.trim();
    }

    // Was "in Arbeit" war, zeigt nach dem Ende den echten Ausgang statt eines drehenden Rings
    function todoState(t) {
      if (t.state === 'completed') return 'completed';
      if (t.state !== 'in_progress') return 'pending';
      if (job.state === 'done') return 'completed';
      if (job.state === 'error' || job.state === 'cancelled') return job.state;
      return 'in_progress';
    }

    const TODO_WORDS = {
      pending: 'offen', in_progress: 'in Arbeit', completed: 'erledigt', error: 'Fehler', cancelled: 'abgebrochen',
    };

    function renderTodos() {
      if (!job) return;
      const todos = job.todos;
      const done = todos.filter((t) => t.state === 'completed').length;
      el.todos.replaceChildren(...todos.map((t, i) => {
        const li = document.createElement('li');
        li.className = 'ws-todo';
        li.dataset.state = todoState(t);
        const no = document.createElement('span');
        no.className = 'ws-todo-no';
        no.textContent = pad2(i + 1);
        const text = document.createElement('span');
        text.textContent = t.text;
        const m = mark(li.dataset.state);
        m.setAttribute('role', 'img');
        m.setAttribute('aria-label', TODO_WORDS[li.dataset.state]);
        li.append(no, m, text);
        return li;
      }));
      requestAnimationFrame(showCurrentTodo);
      markOverflow(el.todos);
      el.todosEmpty.hidden = todos.length > 0;
      el.todosEmpty.textContent = job.state === 'running'
        ? 'Jarvis legt gleich einen Plan mit den Arbeitsschritten an.'
        : 'Für diesen Auftrag gab es keinen eigenen Plan.';
      el.planCount.textContent = todos.length ? done + ' von ' + todos.length : '';
      const frac = job.state === 'done' ? 1 : todos.length ? done / todos.length : 0;
      el.planBar.style.width = (frac * 100).toFixed(1) + '%';
    }

    function renderStep(s, quiet) {
      let li = stepEls.get(s.id);
      if (!li) {
        li = document.createElement('li');
        li.className = 'ws-step';
        if (quiet) li.style.animation = 'none';
        const node = document.createElement('span');
        node.className = 'ws-node';
        const kind = document.createElement('span');
        kind.className = 'ws-kind';
        const what = document.createElement('span');
        what.className = 'ws-what';
        const label = document.createElement('span');
        label.className = 'ws-label';
        const detail = document.createElement('span');
        detail.className = 'ws-detail-line';
        what.append(label, detail);
        const time = document.createElement('span');
        time.className = 'ws-time';
        li.append(node, kind, what, time);
        stepEls.set(s.id, li);
        el.steps.append(li);
        el.stepsEmpty.hidden = true;
        if (follow) requestAnimationFrame(() => { el.steps.scrollTop = el.steps.scrollHeight; });
      }
      const state = ['running', 'done', 'error', 'cancelled'].includes(s.state) ? s.state : 'done';
      const kindName = KIND_ICONS[s.kind] ? s.kind : 'other';
      if (li.dataset.state !== state) {
        li.dataset.state = state;
        const m = mark(state);
        m.setAttribute('aria-label', { running: 'läuft', done: 'erledigt', error: 'Fehler', cancelled: 'abgebrochen' }[state]);
        li.querySelector('.ws-node').replaceChildren(m);
      }
      if (li.dataset.kind !== kindName) {
        li.dataset.kind = kindName;
        li.querySelector('.ws-kind').replaceChildren(svg(KIND_ICONS[kindName]));
      }
      li.querySelector('.ws-label').textContent = String(s.label || s.tool || 'Arbeitet');
      const raw = String(s.detail || '');
      const shownDetail = s.kind === 'file' || s.kind === 'read' ? relPath(raw, job && job.folder) : raw;
      const detail = li.querySelector('.ws-detail-line');
      // "Schreibt bot.py" braucht darunter nicht noch einmal "bot.py"
      detail.textContent = shownDetail === baseName(raw) && /^(Schreibt|Ändert|Liest) /.test(String(s.label)) ? '' : shownDetail;
      detail.title = raw;
      detail.hidden = !detail.textContent;
      li.querySelector('.ws-time').textContent = stepTime(s);
    }

    function stepTime(s) {
      if (s.state === 'running') return fmtSecs((Date.now() - (s.firstSeen || Date.now())) / 1000);
      if (s.state === 'cancelled') return 'abgebrochen';
      return fmtSecs(s.seconds);
    }

    function renderLists() {
      if (!job) return;
      const steps = job.order.map((id) => job.steps.get(id)).filter(Boolean);
      // Dateien: jede einmal, "neu" wenn Jarvis sie angelegt hat
      const files = new Map();
      for (const s of steps) {
        if (s.kind !== 'file' || !s.detail || !/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(String(s.tool))) continue;
        const key = String(s.detail).toLowerCase();
        if (!files.has(key)) files.set(key, { path: String(s.detail), created: s.tool === 'Write' });
      }
      if (job.diskFiles) {
        files.clear();
        for (const f of job.diskFiles) files.set(String(f.path).toLowerCase(), { path: String(f.path), size: Number(f.size) || 0, disk: true });
      }
      el.files.replaceChildren(...[...files.values()].map((f) => {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = relPath(f.path, job.folder);
        name.title = f.path;
        const tag = document.createElement('span');
        tag.className = 'ws-tag' + (f.created ? ' new' : '');
        tag.textContent = f.disk ? fmtSize(f.size) : f.created ? 'neu' : 'geändert';
        li.append(svg(f.disk ? KIND_ICONS.file : f.created ? FILE_NEW : FILE_EDIT), name, tag);
        return li;
      }));
      el.filesEmpty.hidden = files.size > 0;
      el.filesEmpty.textContent = job.diskFiles ? 'Der Projektordner ist leer.' : 'Noch keine Dateien geschrieben.';
      // Befehle: die neuesten zuerst
      const cmds = steps.filter((s) => /^(Bash|PowerShell)$/i.test(String(s.tool)) && s.detail).reverse();
      el.cmds.replaceChildren(...cmds.slice(0, 8).map((s) => {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = String(s.detail);
        name.title = String(s.detail);
        const state = document.createElement('span');
        state.className = 'ws-tag' + (s.state === 'error' ? ' err' : '');
        state.textContent = s.state === 'running' ? 'läuft' : s.state === 'error' ? 'Fehler'
          : s.state === 'cancelled' ? 'abgebrochen' : fmtSecs(s.seconds);
        li.append(svg(PROMPT), name, state);
        return li;
      }));
      el.cmdsEmpty.hidden = cmds.length > 0;
      el.fileCount.textContent = files.size ? String(files.size) : '';
      el.cmdCount.textContent = cmds.length ? String(cmds.length) : '';
      markOverflow(el.files);
      markOverflow(el.cmds);
    }

    // Unten weich auslaufen lassen, solange noch etwas darunter kommt. Ein zweites Mal
    // nachsehen, wenn die Einblend-Bewegung vorbei ist (die verschiebt kurz um 4 px).
    function markOverflow(list) {
      const check = () => {
        list.classList.toggle('more', list.scrollHeight - list.scrollTop - list.clientHeight > 8);
      };
      requestAnimationFrame(check);
      setTimeout(check, 260);
    }

    // Der Schritt in Arbeit soll im Plan zu sehen sein, auch wenn die Liste länger ist
    function showCurrentTodo() {
      const current = el.todos.querySelector('[data-state="in_progress"]');
      if (!current) return;
      const top = current.offsetTop - el.todos.offsetTop;
      const bottom = top + current.offsetHeight;
      if (top < el.todos.scrollTop) el.todos.scrollTop = top - 8;
      else if (bottom > el.todos.scrollTop + el.todos.clientHeight) el.todos.scrollTop = bottom - el.todos.clientHeight + 8;
    }

    function renderCounts() {
      if (!job) return;
      const n = job.order.length;
      el.stepCount.textContent = n ? n + (n === 1 ? ' Schritt' : ' Schritte') : '';
      el.stepsEmpty.hidden = n > 0;
      el.stepsEmpty.textContent = job.state === 'running'
        ? 'Noch keine Schritte. Jarvis liest sich gerade in den Auftrag ein.'
        : 'Es wurden keine Schritte ausgeführt.';
    }

    function renderText() {
      if (!job) return;
      const words = lastWords(job.text);
      el.text.textContent = words || (job.state === 'running' ? 'Ich sehe mir den Auftrag an …' : job.summary || '');
    }

    function renderResult() {
      if (!job || job.state === 'running') {
        el.result.hidden = true;
        return;
      }
      const wasHidden = el.result.hidden;
      el.result.hidden = false;
      el.result.dataset.state = job.state;
      el.stamp.textContent = STAMP[job.state] || '';
      el.summary.textContent = job.summary || (job.state === 'done' ? 'Der Auftrag ist erledigt.' : '');
      el.detail.textContent = job.detail;
      el.detail.hidden = !job.detail;
      el.answer.hidden = !(job.state === 'done' && job.question);
      el.resultRun.hidden = !job.start;
      el.resultPreview.hidden = !job.preview;
      el.resultDelete.hidden = !job.folder;
      el.resultFolder.classList.toggle('primary', !job.start);
      el.resultBack.textContent = job.viewed ? 'Alle Projekte' : 'Zurück zu Jarvis';
      disarmDelete();
      const rounds = (job.history || []).filter((h) => h && h.wunsch);
      el.historyBox.hidden = rounds.length < 2;
      el.history.replaceChildren(...rounds.slice(-8).reverse().map((h) => {
        const li = document.createElement('li');
        const what = document.createElement('span');
        what.textContent = '„' + String(h.wunsch).slice(0, 160) + '“';
        what.title = String(h.wunsch);
        const when = document.createElement('time');
        when.textContent = shortDate(h.zeit);
        li.dataset.state = String(h.zustand || '');
        li.append(when, what);
        return li;
      }));
      if (wasHidden) el.result.scrollIntoView({ block: 'nearest' });
    }

    function progress() {
      if (!job) return 0;
      if (job.state === 'done') return 1;
      if (job.todos.length) {
        const done = job.todos.filter((t) => t.state === 'completed').length;
        const doing = job.todos.some((t) => t.state === 'in_progress') ? 0.5 : 0;
        return Math.min(0.97, (done + doing) / job.todos.length);
      }
      return 0.85 * (1 - Math.exp(-job.order.length / 9));
    }

    function renderReadout() {
      if (!job) return;
      const frac = progress();
      Construct.set(frac, job.state);
      if (job.state === 'done') {
        el.percent.textContent = '100 %';
        el.percentHint.textContent = 'fertig';
      } else if (job.todos.length) {
        el.percent.textContent = Math.round(frac * 100) + ' %';
        el.percentHint.textContent = { running: 'vom Plan erledigt', error: 'angehalten', cancelled: 'abgebrochen' }[job.state];
      } else {
        const n = job.order.length;
        el.percent.textContent = String(n);
        el.percentHint.textContent = job.state === 'running' ? (n === 1 ? 'Schritt bisher' : 'Schritte bisher')
          : job.state === 'error' ? 'angehalten' : 'abgebrochen';
      }
    }

    function renderPill() {
      if (!el.pill) return;
      el.pill.hidden = false;
      const job = live; // die Leiste oben zeigt immer den laufenden Auftrag, nicht ein angesehenes Projekt
      if (!job) {
        el.pill.dataset.state = 'idle';
        el.pillText.textContent = 'Werkstatt';
        el.pillTime.textContent = '';
        el.pill.title = 'Werkstatt: alle Projekte';
        return;
      }
      el.pill.dataset.state = job.state;
      let text = 'Werkstatt arbeitet';
      if (job.state === 'running' && job.todos.length) {
        const done = job.todos.filter((t) => t.state === 'completed').length;
        text = 'Werkstatt · Schritt ' + Math.min(done + 1, job.todos.length) + '/' + job.todos.length;
      } else if (job.state === 'done') {
        text = 'Werkstatt: fertig';
      } else if (job.state === 'error') {
        text = 'Werkstatt: Fehler';
      } else if (job.state === 'cancelled') {
        text = 'Werkstatt: abgebrochen';
      }
      el.pillText.textContent = text;
      el.pillTime.textContent = job.state === 'running' ? fmtClock(elapsed(job)) : '';
      el.pill.title = 'Werkstatt öffnen: ' + job.task;
    }

    // Uhr, laufende Schritte und Knopf oben: einmal pro Sekunde
    function tick() {
      renderPill();
      if (!job || job !== live || job.state !== 'running') {
        syncTicker();
        return;
      }
      el.timer.textContent = fmtClock(elapsed());
      for (const [id, li] of stepEls) {
        const s = job.steps.get(id);
        if (s && s.state === 'running') li.querySelector('.ws-time').textContent = stepTime(s);
      }
    }

    function syncTicker() {
      const want = !!live && live.state === 'running';
      if (want && !ticker) ticker = setInterval(tick, 1000);
      if (!want && ticker) {
        clearInterval(ticker);
        ticker = 0;
      }
    }

    // ------------------------------------------------------------ Öffnen und Schließen

    function open() {
      if (!job) return;
      clearTimeout(closeTimer);
      const from = el.pill && !el.pill.hidden ? el.pill.getBoundingClientRect() : null;
      if (from && from.width) {
        el.ws.style.setProperty('--ox', Math.round(from.left + from.width / 2) + 'px');
        el.ws.style.setProperty('--oy', Math.round(from.top + from.height / 2) + 'px');
      } else {
        el.ws.style.removeProperty('--ox');
        el.ws.style.removeProperty('--oy');
      }
      const wasOpen = isOpen;
      isOpen = true;
      el.ws.hidden = false;
      el.ws.classList.remove('closing');
      if (!wasOpen && !reducedMotion()) {
        el.ws.classList.remove('opening');
        void el.ws.offsetWidth;
        el.ws.classList.add('opening');
        setTimeout(() => el.ws.classList.remove('opening'), 260);
      }
      el.body.dataset.view = 'workshop';
      renderAll();
      Construct.start();
      if (opts.onView) opts.onView('workshop');
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      const fromList = !!(job && job.viewed);
      if (fromList) setTimeout(() => show(live), 180);
      disarm();
      el.body.dataset.view = 'hud';
      el.ws.classList.remove('opening');
      el.ws.classList.add('closing');
      closeTimer = setTimeout(() => {
        if (isOpen) return;
        el.ws.hidden = true;
        el.ws.classList.remove('closing');
      }, 170);
      Construct.stop();
      renderPill();
      if (opts.onView) opts.onView('hud');
      if (fromList && opts.onHub) opts.onHub();
    }

    // Zum laufenden (oder letzten) Auftrag, auch wenn gerade ein anderes Projekt offen war
    function openLive() {
      if (!live) return;
      if (job !== live) show(live);
      open();
    }

    function disarm() {
      clearTimeout(armTimer);
      el.stop.classList.remove('armed');
      el.stopText.textContent = 'Stopp';
    }

    async function openFolder() {
      if (!job || !job.folder) return;
      try {
        const ok = await call('open_folder', job.folder);
        if (ok === false) toast('Den Ordner gibt es noch nicht. Jarvis legt ihn gleich an.', 'info');
        else toast('Der Projektordner öffnet sich.', 'ok');
      } catch {
        toast('Im Demo-Modus öffnet sich kein Ordner.', 'info');
      }
    }

    function disarmDelete() {
      deleteArmed = 0;
      el.resultDelete.classList.remove('armed');
      el.resultDelete.textContent = 'Löschen';
    }

    async function runProject() {
      if (!job || !job.folder) return;
      try {
        const ok = await call('workshop_run', job.folder);
        toast(ok === false ? 'Starten ging nicht.' : (job.name || 'Das Projekt') + ' startet.', ok === false ? 'error' : 'ok');
      } catch {
        toast('Im Demo-Modus startet nichts.', 'info');
      }
    }

    async function previewProject() {
      if (!job || !job.folder) return;
      try {
        const ok = await call('workshop_preview', job.folder);
        toast(ok === false ? 'Die Vorschau ging nicht auf.' : 'Die Vorschau öffnet sich im Browser.', ok === false ? 'error' : 'ok');
      } catch {
        toast('Im Demo-Modus gibt es keine Vorschau.', 'info');
      }
    }

    // Löschen: erst fragen (der Knopf wird rot), dann löschen. Unter Windows landet es im Papierkorb.
    async function deleteProject() {
      if (!job || !job.folder) return;
      if (job.state === 'running') {
        toast('Daran arbeitet die Werkstatt gerade. Erst stoppen, dann löschen.', 'info');
        return;
      }
      if (Date.now() - deleteArmed > 4000) {
        deleteArmed = Date.now();
        el.resultDelete.classList.add('armed');
        el.resultDelete.textContent = 'Wirklich löschen?';
        setTimeout(() => { if (Date.now() - deleteArmed >= 4000) disarmDelete(); }, 4100);
        return;
      }
      disarmDelete();
      const folder = job.folder;
      const name = job.name || 'Das Projekt';
      try {
        const r = await call('workshop_delete', folder);
        if (r && r.ok) {
          toast(name + (r.trash ? ' liegt jetzt im Papierkorb.' : ' ist gelöscht.'), 'ok');
          forget(folder);
          if (opts.onDeleted) opts.onDeleted(folder);
        } else {
          toast((r && r.error) || 'Das Löschen ging nicht.', 'error');
        }
      } catch {
        toast('Im Demo-Modus wird nichts gelöscht.', 'info');
      }
    }

    el.back.addEventListener('click', close);
    el.resultBack.addEventListener('click', close);
    el.resultRun.addEventListener('click', runProject);
    el.resultPreview.addEventListener('click', previewProject);
    el.resultDelete.addEventListener('click', deleteProject);
    if (el.tell) {
      el.tellInput.addEventListener('input', () => {
        el.tellBtn.disabled = el.tellInput.disabled || !el.tellInput.value.trim();
      });
      el.tell.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = el.tellInput.value.trim();
        if (!text || !job) return;
        const working = job.state === 'running';
        el.tellBtn.disabled = true;
        try {
          const ok = working ? await call('workshop_tell', text) : await call('workshop_continue', job.folder, text);
          if (ok === false) {
            toast(working ? 'Das ging gerade nicht.' : 'Das Projekt gibt es nicht mehr, oder die Werkstatt arbeitet gerade.', 'error');
          } else {
            el.tellInput.value = '';
            toast(working ? 'Jarvis baut das gleich mit ein.' : 'Jarvis baut an ' + (job.name || 'dem Projekt') + ' weiter.', 'ok');
          }
        } catch {
          toast('Jarvis ist gerade nicht verbunden.', 'error');
        } finally {
          el.tellBtn.disabled = el.tellInput.disabled || !el.tellInput.value.trim();
        }
      });
    }
    el.folder.addEventListener('click', openFolder);
    el.resultFolder.addEventListener('click', openFolder);
    // Der Knopf oben: läuft ein Auftrag, zu ihm, sonst zu allen Projekten.
    function hub() {
      if (opts.onHub) opts.onHub();
      else open();
    }
    if (el.pill) {
      el.pill.addEventListener('click', () => {
        if (live && (live.state === 'running' || (live.endedAt && Date.now() - live.endedAt < 120000))) openLive();
        else hub();
      });
    }
    if (el.projects) el.projects.addEventListener('click', hub);
    el.stop.addEventListener('click', async () => {
      // Erst fragen, dann stoppen: ein Klick aus Versehen soll keine Arbeit kosten.
      if (!el.stop.classList.contains('armed')) {
        el.stop.classList.add('armed');
        el.stopText.textContent = 'Wirklich stoppen?';
        clearTimeout(armTimer);
        armTimer = setTimeout(disarm, 3500);
        return;
      }
      disarm();
      el.stop.disabled = true;
      try {
        const ok = await call('workshop_cancel');
        toast(ok === false ? 'In der Werkstatt läuft gerade nichts.' : 'Die Werkstatt hält an …', 'info');
      } catch {
        toast('Jarvis ist gerade nicht verbunden.', 'error');
      } finally {
        el.stop.disabled = false;
      }
    });
    el.steps.addEventListener('scroll', () => {
      follow = el.steps.scrollHeight - el.steps.scrollTop - el.steps.clientHeight < 48;
    }, { passive: true });
    for (const list of [el.todos, el.files, el.cmds]) {
      list.addEventListener('scroll', () => markOverflow(list), { passive: true });
    }
    window.addEventListener('resize', () => {
      if (isOpen) [el.todos, el.files, el.cmds].forEach(markOverflow);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen && !e.defaultPrevented) {
        e.preventDefault();
        close();
      }
    });

    return {
      handle,
      step,
      load,
      view,
      open: openLive,
      close,
      isOpen: () => isOpen,
      hasJob: () => !!live,
      running: () => !!live && live.state === 'running',
      renderPill,
    };
  }

  // ==================================================================
  //   Demo: ein Auftrag zum Zuschauen (Seite ohne Python, ?werkstatt=…,
  //   dazu ?auftrag=… für ein anderes Symbol und ?logo=0 ohne eigenes Logo)
  // ==================================================================

  // So ein Logo zeichnet die Werkstatt für einen Discord-Bot (logo.svg)
  const DEMO_LOGO = 'data:image/svg+xml;base64,' + btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">'
    + '<circle cx="128" cy="128" r="114" fill="none" stroke="#5865F2" stroke-width="10"/>'
    + '<circle cx="128" cy="128" r="96" fill="#1E2A78"/>'
    + '<rect x="122" y="50" width="12" height="30" rx="4" fill="#C9D1FF"/>'
    + '<circle cx="128" cy="48" r="11" fill="#FFFFFF"/>'
    + '<rect x="64" y="80" width="128" height="100" rx="30" fill="#5865F2"/>'
    + '<rect x="46" y="112" width="20" height="40" rx="8" fill="#C9D1FF"/>'
    + '<rect x="190" y="112" width="20" height="40" rx="8" fill="#C9D1FF"/>'
    + '<circle cx="104" cy="126" r="15" fill="#FFFFFF"/><circle cx="152" cy="126" r="15" fill="#FFFFFF"/>'
    + '<path d="M100 156q28 18 56 0" fill="none" stroke="#FFFFFF" stroke-width="9" stroke-linecap="round"/>'
    + '<rect x="96" y="186" width="64" height="18" rx="9" fill="#5865F2"/>'
    + '</svg>');

  function demo(push, mode) {
    const params = new URLSearchParams(location.search);
    const task = params.get('auftrag') || 'Bau mir einen Discord-Bot, der jeden Morgen Hallo sagt';
    const withLogo = params.get('logo') !== '0';
    const folder = 'C:\\Users\\Georg\\Jarvis-Werkstatt\\2026-10-01_1530_discord-bot-jeden-morgen-hallo';
    const PLAN = ['Projektordner und Umgebung anlegen', 'Discord-Bibliothek installieren', 'Bot-Code schreiben',
      'Testen und Fehler beheben', 'LIESMICH.txt mit Startanleitung'];
    const todos = (k, doing) => PLAN.map((text, i) => ({
      text, state: i < k ? 'completed' : i === k && doing ? 'in_progress' : 'pending',
    }));
    const STEPS = [
      { id: 'p1', tool: 'TodoWrite', label: 'Plant die Schritte', detail: '5 Schritte', kind: 'plan', todos: todos(0, true), ms: 500,
        say: 'Ich lege zuerst einen Plan an.' },
      { id: 's1', tool: 'PowerShell', label: 'Legt Ordner an', detail: 'Projektordner und virtuelle Umgebung anlegen', kind: 'file', ms: 1100 },
      { id: 'sl', tool: 'Write', label: 'Schreibt logo.svg', detail: folder + '\\logo.svg', kind: 'file', ms: 700, logo: true,
        say: 'Ich zeichne kurz ein Logo für den Bot.' },
      { id: 'p2', tool: 'TodoWrite', label: 'Plant die Schritte', detail: '5 Schritte', kind: 'plan', todos: todos(1, true), ms: 300,
        say: 'Jetzt kommt die Discord-Bibliothek dazu.' },
      { id: 's2', tool: 'PowerShell', label: 'Installiert Python-Pakete', detail: 'pip install discord.py python-dotenv', kind: 'install', ms: 3400 },
      { id: 'p3', tool: 'TodoWrite', label: 'Plant die Schritte', detail: '5 Schritte', kind: 'plan', todos: todos(2, true), ms: 300 },
      { id: 's3', tool: 'Write', label: 'Schreibt bot.py', detail: folder + '\\bot.py', kind: 'file', ms: 900,
        say: 'Der Bot meldet sich jeden Morgen um acht im ersten Textkanal.' },
      { id: 's4', tool: 'Write', label: 'Schreibt .env.beispiel', detail: folder + '\\.env.beispiel', kind: 'file', ms: 500 },
      { id: 's5', tool: 'Write', label: 'Schreibt start.bat', detail: folder + '\\start.bat', kind: 'file', ms: 400 },
      { id: 'p4', tool: 'TodoWrite', label: 'Plant die Schritte', detail: '5 Schritte', kind: 'plan', todos: todos(3, true), ms: 300,
        say: 'Der Code steht, ich teste ihn kurz.' },
      { id: 's6', tool: 'PowerShell', label: 'Testet den Code', detail: 'python -m py_compile bot.py', kind: 'command', ms: 1900 },
      { id: 's7', tool: 'Edit', label: 'Ändert bot.py', detail: folder + '\\bot.py', kind: 'file', ms: 600 },
      { id: 's8', tool: 'PowerShell', label: 'Startet bot.py', detail: 'python bot.py --probelauf', kind: 'command', ms: 2400 },
      { id: 'p5', tool: 'TodoWrite', label: 'Plant die Schritte', detail: '5 Schritte', kind: 'plan', todos: todos(4, true), ms: 300,
        say: 'Läuft. Zum Schluss noch die Anleitung.' },
      { id: 's9', tool: 'Write', label: 'Schreibt LIESMICH.txt', detail: folder + '\\LIESMICH.txt', kind: 'file', ms: 600 },
      { id: 'p6', tool: 'TodoWrite', label: 'Plant die Schritte', detail: '5 Schritte', kind: 'plan', todos: todos(5, false), ms: 300 },
    ];
    const SUMMARY = 'Der Bot ist fertig, Sir. Er sagt jeden Morgen um acht in Ihrem Server Hallo. '
      + 'Tragen Sie den Bot-Schlüssel in die Datei .env ein und starten Sie ihn mit start.bat.';
    let said = '';
    let gen = 0;
    const event = (data) => push(Object.assign({ type: 'workshop' }, data));
    const stepEv = (s, state, seconds) => {
      const data = { id: s.id, tool: s.tool, label: s.label, detail: s.detail, kind: s.kind, state, seconds, workshop: true };
      if (s.todos) data.todos = s.todos;
      push({ type: 'progress', step: data });
    };
    const sayMore = (text) => {
      said += (said ? '\n\n' : '') + text;
      event({ state: 'text', text: said });
    };
    const drawn = (s) => {
      if (s.logo && withLogo) event({ state: 'logo', logo: DEMO_LOGO });
    };

    // Ohne Warten bis zu einer Stelle (für Bildschirmfotos)
    function upTo(count, runLast) {
      event({ state: 'start', task, folder, begun: '15:30', seconds: 0 });
      STEPS.slice(0, count).forEach((s, i) => {
        if (s.say) sayMore(s.say);
        const last = i === count - 1 && runLast;
        stepEv(s, last ? 'running' : 'done', last ? 0 : s.ms / 1000);
        if (!last) drawn(s);
      });
    }

    async function live(g) {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      event({ state: 'start', task, folder, begun: nowClock(), seconds: 0 });
      await wait(900);
      for (const s of STEPS) {
        if (g !== gen) return;
        if (s.say) sayMore(s.say);
        stepEv(s, 'running', 0);
        await wait(s.ms);
        if (g !== gen) return;
        stepEv(s, 'done', s.ms / 1000);
        drawn(s);
        await wait(250);
      }
      if (g !== gen) return;
      sayMore(SUMMARY);
      event({ state: 'done', summary: SUMMARY, folder, seconds: 0 });
    }

    return {
      start() {
        gen += 1;
        said = '';
        if (mode === 'running') {
          upTo(11, true);
        } else if (mode === 'done') {
          upTo(STEPS.length, false);
          sayMore(SUMMARY);
          event({ state: 'done', summary: SUMMARY, folder, seconds: 252 });
        } else if (mode === 'error') {
          upTo(9, false);
          stepEv({ id: 'sx', tool: 'PowerShell', label: 'Testet den Code', detail: 'python -m py_compile bot.py', kind: 'command' }, 'error', 2.4);
          sayMore('Beim Testen ist ein Fehler aufgetreten.');
          event({
            state: 'error', folder, seconds: 131,
            summary: 'In der Werkstatt ist etwas schiefgegangen, Sir. Die Einzelheiten stehen im Fenster.',
            detail: 'Traceback (most recent call last):\n  File "bot.py", line 3, in <module>\n    import discord\nModuleNotFoundError: No module named \'discord\'',
          });
        } else {
          live(gen);
        }
      },
      cancel() {
        gen += 1;
        event({ state: 'cancelled', summary: 'Die Arbeit in der Werkstatt ist abgebrochen, Sir.', folder, seconds: 0 });
      },
    };
  }

  window.JarvisWerkstatt = { create, demo, DEMO_LOGO };
})();
