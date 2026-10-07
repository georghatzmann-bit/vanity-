// =============================================================================
// Figuren-Grafik: menschliche Low-Poly-Figur mit kompletten Outfits ("Skins")
// =============================================================================
// Aufbau (Maße wie ein 1,8-m-Mensch, Comic-Stil mit breiten Schultern):
//   Becken + Oberkörper (mit Gürtel, Rucksack, Weste …)   = 1 Mesh
//   Kopf (Gesicht, Haare, Mütze/Helm …)                     = 1 Mesh
//   je Arm: Oberarm, Unterarm + Hand                         = 2 + 2 Meshes
//   je Bein: Oberschenkel, Unterschenkel, Schuh              = 3 + 3 Meshes
//   → 12 Meshes = 12 Zeichen-Aufrufe pro Figur. Alle Teile eines Meshes sind zu einer
//   Form verschmolzen (src/world/meshBuilder.js), die Farben stecken in den Ecken, ALLE
//   Figuren teilen EIN Material. Die Formen werden pro Skin einmal gebaut und geteilt.
//
// Animation per Code (keine Dateien):
//   Laufen/Rennen (Knie und Ellbogen beugen sich), Springen, Ducken, Zielen (beide Hände an
//   der Waffe – Arme per "IK" ausgerechnet), Bauen (Arm-Stoß), Spitzhacke (Schlag),
//   Tanz (Taste B), Zucken bei Treffern, Umfallen beim Besiegtwerden.
//
// Kopf: Die Gruppe "Kopf" sitzt genau in der Mitte der Treffer-Kugel (CONFIG.player.hitbox:
// headRadius, crouchHeight, crouchHeadForward) – stehend und geduckt. Der sichtbare Kopf liegt
// IN dieser Kugel (Oberkante bündig) → wer den Kopf trifft, trifft immer den Kopf.
//
// update(alpha, dt) setzt die Figur weich zwischen zwei Logik-Schritten
// (prevPosition → position). Die Figur schaut nach −Z (wie yaw = 0), rechts = +X.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { lerpAngle } from '../camera.js';
import { MeshBuilder } from './meshBuilder.js';

const P = CONFIG.player;
const HALF_PI = Math.PI / 2;

// --- Maße (Meter) ------------------------------------------------------------------
const HIP_Y = 0.92; // Hüftgelenk über den Füßen
const HIP_X = 0.1; // Hüftgelenke links/rechts
const THIGH = 0.43;
const SHIN = 0.41; // Knie → Knöchel (Knöchel 8 cm über dem Boden)
const SHOULDER_Y = 0.5; // Schultergelenk über der Hüfte (1,42 m)
const SHOULDER_X = 0.215;
const UPPER_ARM = 0.29;
const FOREARM = 0.28; // Ellbogen → Hand-Mitte
// Kopf: Mitte der Treffer-Kugel (Oberkante = Kapsel-Oberkante 1,8 m)
const HEAD_R = P.hitbox.headRadius;
const HEAD_Y = P.hitbox.height - HEAD_R - HIP_Y; // Kugel-Mitte über der Hüfte
// sichtbarer Kopf (Ellipsoid) – oben bündig mit der Kugel, ganz in ihr drin
const HEAD_RX = 0.13;
const HEAD_RYY = 0.155;
const HEAD_RZ = 0.14;
const FACE_LIFT = HEAD_R - HEAD_RYY - 0.01; // so weit über der Kugel-Mitte sitzt die Kopf-Mitte
// Ducken: Oberkörper neigt sich vor und die Hüfte sinkt so weit, dass die Kopf-Gruppe genau dort
// sitzt, wo die Treffer-Prüfung die Kugel erwartet (Oberkante = geduckte Kapsel, crouchHeadForward vor)
const CROUCH_LEAN = Math.asin(Math.min(0.9, P.hitbox.crouchHeadForward / HEAD_Y));
const CROUCH_DROP = HIP_Y - (P.hitbox.crouchHeight - HEAD_R - HEAD_Y * Math.cos(CROUCH_LEAN));
const ANKLE_Y = HIP_Y - THIGH - SHIN;
const CROUCH_FOOT_FORWARD = 0.1; // geduckt steht der Fuß etwas vor der Hüfte
// Bein-Winkel dafür (zwei Glieder – Kosinus-Satz)
const [CROUCH_THIGH, CROUCH_KNEE] = (() => {
  const down = HIP_Y - CROUCH_DROP - ANKLE_Y;
  const dist = Math.min(THIGH + SHIN - 1e-3, Math.hypot(CROUCH_FOOT_FORWARD, down));
  const toFoot = Math.atan2(CROUCH_FOOT_FORWARD, down);
  const atHip = Math.acos((THIGH * THIGH + dist * dist - SHIN * SHIN) / (2 * THIGH * dist));
  const atKnee = Math.acos((THIGH * THIGH + SHIN * SHIN - dist * dist) / (2 * THIGH * SHIN));
  return [toFoot + atHip, -(Math.PI - atKnee)];
})();
const STRIDE = 1.9; // Meter pro Schritt-Zyklus (zwei Schritte)

// Halte-Punkte der rechten Hand (im Oberkörper, vor der Brust), gedreht um PIVOT mit dem Blick
const PIVOT = new THREE.Vector3(0, 0.46, 0);
const GRIP_HIP = new THREE.Vector3(0.13, 0.26, -0.13); // Waffe in Hüft-/Brusthöhe
const GRIP_AIM = new THREE.Vector3(0.1, 0.36, -0.15); // Zielen: höher, an die Schulter
const POLE_R = new THREE.Vector3(0.8, -1, 0.35).normalize(); // Ellbogen zeigt nach unten-außen
const POLE_L = new THREE.Vector3(-0.6, -1, 0.05).normalize();
const AIM_TWIST = -0.38; // linke Schulter dreht beim Halten nach vorn

// --- gemeinsames Material und Formen ----------------------------------------------------
let sharedMaterial = null;
/** EIN Material für alle Figuren (Farben aus den Ecken). */
export function characterMaterial() {
  if (!sharedMaterial) {
    sharedMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
    sharedMaterial.name = 'Figuren';
    sharedMaterial.userData.shared = true;
  }
  return sharedMaterial;
}

// Standard-Werte für jeden Skin (fehlende Felder werden damit aufgefüllt)
const SKIN_DEFAULTS = {
  skinTone: '#E8B996', hair: 'short', hairColor: '#4A3020', headwear: 'none', headColor: '#3A3F4A', headColor2: '#9AA3AD',
  face: 'normal', top: 'tshirt', sleeves: 'short', topColor: '#D8D4CA', topColor2: '#3E6FB0', pants: 'jeans',
  pantsColor: '#3B5B8C', pantsColor2: '#2E4870', shoes: 'sneaker', shoeColor: '#F2F2F2', gloves: null, belt: null,
  back: 'none', backColor: '#6B6B6B', backColor2: '#4A4A4A', trim: '#C9A86A',
};
// alte Farbsets ({ body, accent, hat, hatColor }) → Outfit
const LEGACY_HATS = { cap: 'cap', beanie: 'beanie', helmet: 'armyHelmet', headband: 'headband', tophat: 'tricorn', crown: 'knightHelmet', cone: 'beanie' };

/** Skin vervollständigen (auch alte Farbsets). Gibt ein neues Objekt zurück. */
export function normalizeSkin(skin) {
  const s = { ...SKIN_DEFAULTS };
  if (!skin) return s;
  if (!skin.top && (skin.body || skin.accent || skin.hat)) {
    if (skin.body) s.topColor = skin.body;
    if (skin.accent) s.pantsColor = s.backColor = skin.accent;
    s.headwear = LEGACY_HATS[skin.hat] ?? 'none';
    if (skin.hatColor) s.headColor = skin.hatColor;
    if (s.headwear !== 'none') s.hair = 'none';
  }
  for (const key of Object.keys(skin)) {
    if (skin[key] !== undefined && (Object.hasOwn(SKIN_DEFAULTS, key) || key === 'id' || key === 'name')) s[key] = skin[key];
  }
  return s;
}

const partCache = new Map(); // Skin-Schlüssel → { body, head, … } (geteilte Formen, nie entsorgt)
/** Die 12 Formen eines Skins (einmal gebaut, danach aus dem Vorrat). */
export function characterParts(skin) {
  const s = normalizeSkin(skin);
  const key = JSON.stringify(s);
  let parts = partCache.get(key);
  if (!parts) {
    parts = {
      body: buildBody(s),
      head: buildHead(s),
      upperArmL: buildUpperArm(s, -1),
      upperArmR: buildUpperArm(s, 1),
      forearmL: buildForearm(s, -1),
      forearmR: buildForearm(s, 1),
      thighL: buildThigh(s, -1),
      thighR: buildThigh(s, 1),
      shinL: buildShin(s, -1),
      shinR: buildShin(s, 1),
      shoeL: buildShoe(s, -1),
      shoeR: buildShoe(s, 1),
    };
    for (const g of Object.values(parts)) g.userData.shared = true;
    partCache.set(key, parts);
  }
  return parts;
}

// --- Farben-Hilfen -------------------------------------------------------------------
const _shade = new THREE.Color();
function shade(hex, factor) {
  _shade.set(hex);
  _shade.r = Math.min(1, _shade.r * factor);
  _shade.g = Math.min(1, _shade.g * factor);
  _shade.b = Math.min(1, _shade.b * factor);
  return `#${_shade.getHexString()}`;
}

// Breite/Tiefe eines Rings bei Höhe y (zwischen den Ringen geradlinig)
function ringAt(rings, y) {
  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i];
    const b = rings[i + 1];
    if (y >= a.y && y <= b.y) {
      const t = (y - a.y) / (b.y - a.y || 1);
      return { y, w: a.w + (b.w - a.w) * t, d: a.d + (b.d - a.d) * t, round: a.round };
    }
  }
  return { ...rings[y < rings[0].y ? 0 : rings.length - 1], y };
}

// Farbiges Band zwischen y0 und y1 in die Ringe einfügen (z. B. Streifen über die Brust)
function addBand(rings, y0, y1, color) {
  const before = ringAt(rings, y0);
  const after = ringAt(rings, y1);
  const below = [...rings].reverse().find((r) => r.y <= y1);
  const keep = below?.color;
  const out = rings.filter((r) => r.y < y0 || r.y > y1);
  out.push({ ...before, color }, { ...after, color: keep });
  out.sort((a, b) => a.y - b.y);
  rings.length = 0;
  rings.push(...out);
}

// Ringe etwas größer machen (Weste, Mantel, Rüstung über dem Oberkörper)
function grow(rings, dw, dd, round) {
  return rings.map((r) => ({ ...r, w: r.w + dw, d: r.d + dd, round: round ?? r.round, color: undefined }));
}

// --- Oberkörper + Becken (Gruppe "Oberkörper", Ursprung = Hüftgelenk) ---------------------
const TORSO = [
  { y: 0.05, w: 0.305, d: 0.2 },
  { y: 0.2, w: 0.315, d: 0.205 },
  { y: 0.34, w: 0.385, d: 0.24 },
  { y: 0.45, w: 0.44, d: 0.245 },
  { y: 0.52, w: 0.36, d: 0.2 },
  { y: 0.565, w: 0.15, d: 0.13 },
];

function buildBody(s) {
  const b = new MeshBuilder();
  const T = s.topColor;
  const T2 = s.topColor2;
  const robot = s.top === 'robot';
  const coat = s.top === 'labcoat' || s.top === 'pirateCoat';
  // Becken (Hose)
  b.loft([
    { y: -0.13, w: 0.28, d: 0.185 },
    { y: -0.03, w: 0.33, d: 0.215 },
    { y: 0.07, w: 0.31, d: 0.205 },
  ], s.pantsColor);
  // Oberkörper (beim Mantel ist das das Hemd darunter)
  const rings = TORSO.map((r) => ({ ...r, round: robot ? 0.88 : 0.62 }));
  if (s.top === 'tracksuit') addBand(rings, 0.3, 0.345, T2);
  if (s.top === 'spacesuit') addBand(rings, 0.12, 0.16, T2);
  if (s.top === 'hoodie') addBand(rings, 0.05, 0.1, T2);
  b.loft(rings, coat ? T2 : T);
  // Hals
  const neck = robot ? '#56606B' : s.top === 'ninja' ? s.headColor : s.top === 'spacesuit' ? '#C8CDD3' : s.skinTone;
  b.cylinder(0.056, 0.062, 0.13, neck, 0, 0.605, 0.0);
  // Gürtel
  if (s.belt) {
    b.loft([{ y: 0.03, w: 0.322, d: 0.218 }, { y: 0.095, w: 0.318, d: 0.214 }], s.belt);
    b.box(0.065, 0.048, 0.02, s.trim, 0, 0.062, -0.112);
  }
  (TOPS[s.top] ?? TOPS.tshirt)(b, s, rings);
  (BACKS[s.back] ?? BACKS.none)(b, s);
  return b.build();
}

const TOPS = {
  tshirt(b, s) {
    b.box(0.15, 0.075, 0.012, s.topColor2, 0, 0.37, -0.124); // Aufdruck auf der Brust
    b.box(0.05, 0.05, 0.013, s.trim, 0, 0.37, -0.127, 0, 0, Math.PI / 4);
    b.torus(0.068, 0.012, shade(s.topColor, 0.85), 0, 0.555, 0, HALF_PI); // Kragen
  },
  hoodie(b, s) {
    b.box(0.22, 0.1, 0.022, s.topColor2, 0, 0.17, -0.108); // Bauchtasche
    b.sphere(0.155, 0.085, 0.095, s.topColor2, 0, 0.545, 0.1); // Kapuze (liegt hinten auf den Schultern)
    b.sphere(0.1, 0.05, 0.05, shade(s.topColor2, 0.7), 0, 0.565, 0.06);
    for (const x of [-0.035, 0.035]) b.box(0.011, 0.12, 0.008, '#FFFFFF', x, 0.45, -0.127); // Bänder
  },
  tactical(b, s) {
    const vest = s.topColor2;
    b.loft(grow([
      { y: 0.11, w: 0.315, d: 0.205 }, { y: 0.34, w: 0.385, d: 0.24 }, { y: 0.47, w: 0.425, d: 0.24 },
    ], 0.03, 0.035), vest, false);
    const pouch = shade(vest, 0.82);
    for (const x of [-0.1, 0, 0.1]) {
      b.box(0.075, 0.085, 0.045, pouch, x, 0.22, -0.135);
      b.box(0.079, 0.025, 0.05, shade(vest, 1.1), x, 0.27, -0.137);
    }
    b.box(0.05, 0.09, 0.035, '#2A2A2A', -0.12, 0.39, -0.147); // Funkgerät
    b.cylinder(0.005, 0.005, 0.12, '#2A2A2A', -0.135, 0.48, -0.147);
    b.box(0.06, 0.04, 0.01, s.trim, 0.11, 0.41, -0.155); // Abzeichen
  },
  spacesuit(b, s) {
    b.box(0.17, 0.1, 0.045, '#D9DDE2', 0, 0.36, -0.13); // Steuer-Kasten
    b.box(0.03, 0.03, 0.01, s.topColor2, -0.05, 0.37, -0.155);
    b.box(0.03, 0.03, 0.01, s.trim, 0, 0.37, -0.155);
    b.box(0.03, 0.03, 0.01, '#4CD964', 0.05, 0.37, -0.155);
    b.box(0.12, 0.015, 0.01, '#4E5863', 0, 0.34, -0.155);
    b.torus(0.12, 0.028, '#C8CDD3', 0, 0.555, 0, HALF_PI); // Kragen-Ring für den Helm
  },
  ninja(b, s) {
    b.box(0.065, 0.56, 0.258, s.topColor2, 0, 0.29, 0, 0, 0, 0.6); // Schärpe quer über die Brust
    const fold = shade(s.topColor, 0.75);
    b.box(0.018, 0.22, 0.012, fold, -0.05, 0.43, -0.124, 0, 0, -0.45); // Kreuz-Kragen
    b.box(0.018, 0.22, 0.012, fold, 0.05, 0.43, -0.124, 0, 0, 0.45);
  },
  armor(b, s, rings) {
    const plate = shade(s.topColor, 1.08);
    b.loft(grow(rings.filter((r) => r.y >= 0.2 && r.y <= 0.52), 0.025, 0.03), plate, false);
    b.box(0.22, 0.46, 0.014, s.topColor2, 0, 0.03, -0.127); // Wappenrock vorn
    b.box(0.22, 0.46, 0.014, s.topColor2, 0, 0.03, 0.127); // … und hinten
    b.box(0.07, 0.07, 0.012, s.trim, 0, 0.12, -0.136, 0, 0, Math.PI / 4); // Wappen
    b.torus(0.085, 0.022, shade(s.topColor, 0.9), 0, 0.56, 0, HALF_PI); // Halsschutz
  },
  tracksuit(b, s) {
    b.box(0.012, 0.22, 0.01, s.topColor2, 0, 0.42, -0.124); // Reißverschluss oben
    b.loft([{ y: 0.52, w: 0.2, d: 0.165 }, { y: 0.6, w: 0.17, d: 0.15 }], s.topColor, false); // Kragen
  },
  labcoat(b, s, rings) {
    coatOver(b, s, rings, s.topColor, shade(s.topColor, 0.8));
    b.box(0.07, 0.05, 0.012, shade(s.topColor, 0.92), -0.1, 0.39, -0.135); // Brusttasche
    b.cylinder(0.006, 0.006, 0.07, s.trim, -0.085, 0.42, -0.14); // Stift
    b.box(0.03, 0.04, 0.008, '#E63946', 0.11, 0.4, -0.14); // Namensschild
  },
  pirateCoat(b, s, rings) {
    coatOver(b, s, rings, s.topColor, s.trim);
    for (let i = 0; i < 4; i++) {
      for (const x of [-0.065, 0.065]) b.sphere(0.012, 0.012, 0.012, s.trim, x, 0.42 - i * 0.09, -0.137 + i * 0.008);
    }
    b.box(0.05, 0.56, 0.272, '#4A3020', 0, 0.29, 0, 0, 0, -0.62); // Schulter-Gurt (vorn und hinten)
    b.box(0.05, 0.04, 0.012, s.trim, -0.06, 0.24, -0.137, 0, 0, -0.62);
    for (let i = 0; i < 3; i++) b.box(0.06, 0.018, 0.02, s.topColor2, 0, 0.5 - i * 0.03, -0.12); // Rüschen
  },
  robot(b, s) {
    b.box(0.21, 0.13, 0.02, '#3A424C', 0, 0.36, -0.125); // Brust-Platte
    b.box(0.04, 0.04, 0.012, s.topColor2, -0.06, 0.37, -0.137);
    b.box(0.04, 0.04, 0.012, s.trim, 0, 0.37, -0.137);
    b.box(0.04, 0.04, 0.012, s.topColor2, 0.06, 0.37, -0.137);
    for (let i = 0; i < 3; i++) b.box(0.16, 0.012, 0.01, '#56606B', 0, 0.22 - i * 0.03, -0.106);
    b.box(0.3, 0.03, 0.2, '#56606B', 0, 0.06, 0); // Gelenk-Ring an der Hüfte
  },
};

// Mantel über dem Hemd: vorn offen, mit Schößen bis zur Mitte der Oberschenkel
const FRONT = [5]; // vordere Seite des Achtecks (siehe MeshBuilder.loft)
const TAILS_OPEN = [4, 5, 6]; // Schöße: vorn ganz offen
function coatOver(b, s, rings, color, hem) {
  const coat = grow(rings.filter((r) => r.y <= 0.52), 0.022, 0.024, 0.34);
  b.loft(coat, color, false, FRONT);
  // Kragen-Aufschläge (V)
  b.box(0.035, 0.2, 0.014, shade(color, 0.88), -0.055, 0.43, -0.13, 0, 0, -0.35);
  b.box(0.035, 0.2, 0.014, shade(color, 0.88), 0.055, 0.43, -0.13, 0, 0, 0.35);
  // Schöße: hinten und an den Seiten (vorn offen, damit die Beine frei schwingen)
  const tails = [
    { y: -0.42, w: 0.4, d: 0.285, round: 0.34, color: hem },
    { y: -0.38, w: 0.395, d: 0.28, round: 0.34, color },
    { y: 0.06, w: 0.332, d: 0.228, round: 0.34 },
  ];
  b.push(0, 0, 0.012);
  b.loft(tails, color, false, TAILS_OPEN);
  // Innenseite (umgekehrte Reihenfolge = Flächen zeigen nach innen; dunkler)
  const inside = shade(color, 0.6);
  b.loft(tails.map((r) => ({ ...r, w: r.w - 0.006, d: r.d - 0.006, color: inside })).reverse(), inside, false, TAILS_OPEN);
  b.pop();
}

const BACKS = {
  none() {},
  pack(b, s) {
    b.box(0.27, 0.3, 0.12, s.backColor, 0, 0.3, 0.17);
    b.box(0.275, 0.07, 0.126, s.backColor2, 0, 0.43, 0.172); // Deckel
    b.box(0.2, 0.12, 0.05, s.backColor2, 0, 0.22, 0.24); // Außentasche
    b.box(0.06, 0.02, 0.02, s.trim, 0, 0.26, 0.268);
    for (const x of [-0.095, 0.095]) {
      b.box(0.04, 0.27, 0.014, s.backColor2, x, 0.36, -0.124); // Gurte vorn
      b.box(0.04, 0.014, 0.25, s.backColor2, x, 0.523, 0.0); // über die Schulter
    }
  },
  tank(b, s) {
    b.box(0.22, 0.34, 0.03, '#9AA3AD', 0, 0.3, 0.13);
    for (const x of [-0.072, 0.072]) {
      b.cylinder(0.07, 0.07, 0.38, s.backColor, x, 0.3, 0.19);
      b.cylinder(0.073, 0.073, 0.035, s.backColor2, x, 0.44, 0.19);
      b.cylinder(0.073, 0.073, 0.035, s.backColor2, x, 0.16, 0.19);
      b.sphere(0.07, 0.04, 0.07, s.backColor, x, 0.49, 0.19);
    }
  },
  cape(b, s) {
    b.push(0, 0.53, 0.14, -0.12);
    b.box(0.42, 0.95, 0.022, s.backColor, 0, -0.475, 0);
    b.box(0.424, 0.045, 0.026, s.backColor2, 0, -0.93, 0); // Saum
    b.pop();
    for (const x of [-0.12, 0.12]) b.sphere(0.03, 0.03, 0.02, s.backColor2, x, 0.5, -0.1); // Spangen
  },
  sword(b, s) {
    b.push(0, 0.3, 0.145, 0, 0, 0.7);
    b.box(0.038, 0.62, 0.012, s.backColor, 0, -0.1, 0); // Klinge
    b.box(0.03, 0.62, 0.02, '#1A1C22', 0, -0.1, 0.012); // Scheide
    b.box(0.13, 0.025, 0.035, s.trim, 0, 0.22, 0); // Parier-Stange
    b.cylinder(0.018, 0.018, 0.14, s.backColor2, 0, 0.31, 0); // Griff
    b.sphere(0.025, 0.025, 0.025, s.trim, 0, 0.39, 0);
    b.pop();
  },
};

// --- Kopf (Gruppe "Kopf", Ursprung = Mitte der Treffer-Kugel) -----------------------------
function buildHead(s) {
  const b = new MeshBuilder();
  const L = FACE_LIFT;
  const hw = s.headwear;
  if (hw !== 'robotHead') {
    b.sphere(HEAD_RX, HEAD_RYY, HEAD_RZ, s.skinTone, 0, L, 0, 0, 0, 0, 12, 9);
    b.sphere(0.1, 0.07, 0.11, s.skinTone, 0, L - 0.075, -0.02, 0, 0, 0, 10, 6); // Kinn/Kiefer
    for (const x of [-1, 1]) b.sphere(0.022, 0.038, 0.03, shade(s.skinTone, 0.92), x * 0.128, L - 0.005, 0.01);
    if (s.face !== 'none' && hw !== 'ninjaHood') face(b, s, L);
  }
  if (!['spaceHelmet', 'ninjaHood', 'knightHelmet', 'robotHead', 'armyHelmet'].includes(hw)) hair(b, s, L);
  (HEADWEAR[hw] ?? HEADWEAR.none)(b, s, L);
  return b.build();
}

function face(b, s, L) {
  const brow = s.hair !== 'none' ? shade(s.hairColor, 0.9) : shade(s.skinTone, 0.55);
  for (const x of [-1, 1]) {
    b.sphere(0.03, 0.034, 0.018, '#FFFFFF', x * 0.05, L + 0.02, -0.124); // Augen
    b.sphere(0.019, 0.023, 0.01, '#3B2A20', x * 0.05, L + 0.018, -0.138);
    b.sphere(0.006, 0.006, 0.004, '#FFFFFF', x * 0.05 - 0.006, L + 0.026, -0.147); // Glanzpunkt
    b.box(0.055, 0.014, 0.016, brow, x * 0.052, L + 0.068, -0.127, 0, 0, -x * 0.12); // Brauen
  }
  b.box(0.032, 0.05, 0.035, shade(s.skinTone, 0.9), 0, L - 0.015, -0.145, -0.15); // Nase
  b.box(0.055, 0.012, 0.012, '#8A3F36', 0, L - 0.072, -0.124); // Mund
  if (s.face === 'glasses') {
    for (const x of [-1, 1]) {
      b.torus(0.034, 0.006, '#222630', x * 0.05, L + 0.02, -0.148);
      b.box(0.006, 0.008, 0.13, '#222630', x * 0.112, L + 0.026, -0.08);
    }
    b.box(0.03, 0.008, 0.008, '#222630', 0, L + 0.025, -0.152);
  } else if (s.face === 'pirate') {
    b.sphere(0.036, 0.036, 0.012, '#151515', 0.05, L + 0.02, -0.146); // Augenklappe
    b.torus(0.146, 0.006, '#151515', 0, L + 0.045, 0, HALF_PI, 0, -0.35);
    b.sphere(0.1, 0.075, 0.075, s.hairColor, 0, L - 0.095, -0.075); // Bart
    b.box(0.08, 0.018, 0.02, s.hairColor, 0, L - 0.055, -0.135, 0, 0, 0); // Schnurrbart
  }
}

function hair(b, s, L) {
  const c = s.hairColor;
  if (s.hair === 'none') return;
  // Haar-Kappe: nach hinten gekippte Halbkugel (vorn Stirn frei, hinten bis in den Nacken)
  b.dome(0.142, 0.17, 0.152, c, 0, L, 0.004, 0.6, 0, 0, 1, 12, 5);
  b.sphere(0.1, 0.032, 0.045, c, -0.02, L + 0.1, -0.108, 0.45, 0, 0.18, 8, 5); // Pony (Strähne über der Stirn)
  for (const x of [-1, 1]) b.box(0.02, 0.06, 0.035, c, x * 0.128, L + 0.01, -0.02); // Koteletten
  if (s.hair === 'spiky') {
    const spikes = [[0, 0.17, -0.05, -0.3, 0], [-0.06, 0.15, 0.0, -0.1, 0.4], [0.06, 0.15, 0.0, -0.1, -0.4], [0, 0.15, 0.06, 0.4, 0], [-0.05, 0.12, 0.08, 0.6, 0.4], [0.05, 0.12, 0.08, 0.6, -0.4]];
    for (const [x, y, z, rx, rz] of spikes) b.cone(0.04, 0.1, c, x, L + y, z, rx, 0, rz, 5);
  } else if (s.hair === 'bun') {
    b.sphere(0.065, 0.06, 0.065, c, 0, L + 0.13, 0.1);
  } else if (s.hair === 'long') {
    b.box(0.2, 0.26, 0.06, c, 0, L - 0.1, 0.11, -0.12); // hinten bis auf die Schultern
    for (const x of [-1, 1]) b.box(0.03, 0.17, 0.09, c, x * 0.125, L - 0.05, 0.03);
  } else if (s.hair === 'mohawk') {
    for (let i = 0; i < 5; i++) b.box(0.03, 0.08, 0.05, c, 0, L + 0.165 - Math.abs(i - 2) * 0.012, -0.09 + i * 0.045);
  }
}

const HEADWEAR = {
  none() {},
  cap(b, s, L) {
    b.dome(0.148, 0.105, 0.158, s.headColor, 0, L + 0.05, 0, 0, 0, 0, 1.05, 12, 5);
    b.cylinder(0.11, 0.11, 0.016, s.headColor2, 0, L + 0.06, -0.15, 0.12, 0, 0, 12, 1, 0.78); // Schirm
    b.sphere(0.016, 0.012, 0.016, s.headColor2, 0, L + 0.157, 0);
    b.box(0.06, 0.045, 0.01, s.headColor2, 0, L + 0.1, -0.148, -0.5); // Abzeichen vorn
  },
  beanie(b, s, L) {
    b.dome(0.15, 0.18, 0.16, s.headColor, 0, L + 0.03, 0, 0.2, 0, 0, 1, 12, 5);
    b.torus(0.152, 0.024, s.headColor2, 0, L + 0.045, 0.01, HALF_PI + 0.2);
    b.sphere(0.04, 0.04, 0.04, s.headColor2, 0, L + 0.21, 0.04);
  },
  armyHelmet(b, s, L) {
    b.dome(0.172, 0.15, 0.182, s.headColor, 0, L + 0.025, 0.005, 0.08, 0, 0, 1.12, 12, 6);
    b.torus(0.18, 0.012, shade(s.headColor, 0.8), 0, L + 0.012, 0.005, HALF_PI + 0.08);
    const spots = [[-0.08, 0.13, -0.05], [0.07, 0.12, 0.05], [0.0, 0.16, 0.06], [0.1, 0.08, -0.08], [-0.11, 0.07, 0.07]];
    for (const [x, y, z] of spots) b.sphere(0.045, 0.02, 0.04, s.headColor2, x, L + y, z, x * 3, 0, z * 3);
    for (const x of [-1, 1]) b.box(0.012, 0.13, 0.012, '#2E2A24', x * 0.127, L - 0.04, -0.03); // Kinnriemen
    // Schutzbrille auf dem Helm
    b.box(0.2, 0.025, 0.02, '#2A2A2A', 0, L + 0.105, -0.155, -0.35);
    for (const x of [-1, 1]) {
      b.cylinder(0.03, 0.03, 0.03, '#2A2A2A', x * 0.045, L + 0.11, -0.165, HALF_PI - 0.35, 0, 0, 8);
      b.cylinder(0.022, 0.022, 0.01, '#7FD3FF', x * 0.045, L + 0.117, -0.184, HALF_PI - 0.35, 0, 0, 8);
    }
  },
  spaceHelmet(b, s, L) {
    b.sphere(0.21, 0.215, 0.215, s.headColor, 0, L - 0.005, 0.005, 0, 0, 0, 14, 10);
    b.sphere(0.152, 0.115, 0.08, s.headColor2, 0, L + 0.01, -0.157, 0, 0, 0, 12, 8); // Visier
    b.sphere(0.04, 0.018, 0.01, '#8FB7E0', -0.06, L + 0.065, -0.226, 0, 0, 0.3); // Glanz
    for (const x of [-1, 1]) b.cylinder(0.035, 0.035, 0.03, s.trim, x * 0.205, L, 0, 0, 0, HALF_PI, 8);
    b.cylinder(0.006, 0.006, 0.12, '#9AA3AD', 0.1, L + 0.23, 0.05);
    b.sphere(0.015, 0.015, 0.015, '#F27F1B', 0.1, L + 0.29, 0.05);
  },
  knightHelmet(b, s, L) {
    b.cylinder(0.155, 0.16, 0.29, s.headColor, 0, L - 0.005, 0, 0, 0, 0, 10);
    b.dome(0.155, 0.075, 0.155, s.headColor, 0, L + 0.14, 0, 0, 0, 0, 1, 10, 4);
    b.box(0.17, 0.022, 0.03, '#1A1C22', 0, L + 0.03, -0.152); // Seh-Schlitz
    for (const x of [-0.04, 0, 0.04]) {
      for (const y of [-0.04, -0.07]) b.box(0.012, 0.012, 0.02, '#1A1C22', x, L + y, -0.158);
    }
    b.box(0.022, 0.06, 0.33, shade(s.headColor, 1.12), 0, L + 0.18, 0); // Kamm
    for (let i = 0; i < 5; i++) b.box(0.035, 0.15, 0.05, shade(s.headColor2, 1 - i * 0.06), 0, L + 0.27 - i * 0.02, -0.02 + i * 0.045, 0.4 + i * 0.22); // Feder-Busch
    b.torus(0.15, 0.018, shade(s.headColor, 0.85), 0, L - 0.15, 0, HALF_PI);
  },
  tricorn(b, s, L) {
    b.dome(0.142, 0.105, 0.152, s.headColor, 0, L + 0.07, 0, 0, 0, 0, 1.1, 12, 5);
    b.cylinder(0.27, 0.27, 0.035, s.headColor, 0, L + 0.085, 0.01, 0, Math.PI, 0, 3); // Dreispitz-Krempe
    b.cylinder(0.28, 0.28, 0.018, s.headColor2, 0, L + 0.07, 0.01, 0, Math.PI, 0, 3);
    b.box(0.05, 0.05, 0.012, '#F2EEE6', 0, L + 0.14, -0.145, -0.25); // Abzeichen
    b.box(0.07, 0.012, 0.012, '#F2EEE6', 0, L + 0.11, -0.148, -0.25, 0, 0.6);
    b.box(0.07, 0.012, 0.012, '#F2EEE6', 0, L + 0.11, -0.148, -0.25, 0, -0.6);
  },
  ninjaHood(b, s, L) {
    b.sphere(0.148, 0.172, 0.155, s.headColor, 0, L, 0.004, 0, 0, 0, 12, 9);
    b.box(0.2, 0.055, 0.05, s.skinTone, 0, L + 0.025, -0.137); // Augen-Schlitz
    for (const x of [-1, 1]) {
      b.sphere(0.03, 0.022, 0.012, '#FFFFFF', x * 0.05, L + 0.025, -0.163);
      b.sphere(0.016, 0.018, 0.008, '#2A1E16', x * 0.05, L + 0.023, -0.172);
      b.box(0.05, 0.012, 0.012, '#1A1C22', x * 0.05, L + 0.062, -0.165, 0, 0, -x * 0.25); // böse Brauen
    }
    b.torus(0.153, 0.016, s.headColor2, 0, L + 0.075, 0, HALF_PI); // Stirnband
    for (const x of [-1, 1]) b.box(0.035, 0.14, 0.012, s.headColor2, x * 0.03, L + 0.0, 0.165, 0.25, 0, x * 0.35);
  },
  robotHead(b, s, L) {
    b.box(0.25, 0.25, 0.25, s.headColor, 0, L - 0.01, 0);
    b.box(0.21, 0.13, 0.02, '#2B3038', 0, L + 0.005, -0.13);
    for (const x of [-1, 1]) {
      b.box(0.055, 0.03, 0.012, s.headColor2, x * 0.05, L + 0.025, -0.142);
      b.cylinder(0.035, 0.035, 0.03, '#56606B', x * 0.135, L, 0, 0, 0, HALF_PI, 8);
    }
    for (let i = 0; i < 3; i++) b.box(0.1, 0.008, 0.01, '#56606B', 0, L - 0.035 - i * 0.016, -0.142);
    b.cylinder(0.008, 0.008, 0.1, '#56606B', 0.06, L + 0.16, 0);
    b.sphere(0.022, 0.022, 0.022, s.headColor2, 0.06, L + 0.22, 0);
  },
  headband(b, s, L) {
    b.torus(0.144, 0.018, s.headColor, 0, L + 0.07, 0.0, HALF_PI + 0.12);
    b.torus(0.1445, 0.006, s.headColor2, 0, L + 0.07, 0.0, HALF_PI + 0.12);
  },
};

// --- Arme (Ursprung = Gelenk, Arm hängt nach −Y) ----------------------------------------
function sleeveColor(s) {
  return s.topColor;
}

function buildUpperArm(s, side) {
  const b = new MeshBuilder();
  const sleeve = sleeveColor(s);
  b.sphere(0.075, 0.075, 0.075, s.top === 'robot' ? '#56606B' : sleeve, 0, -0.005, 0, 0, 0, 0, 8, 6);
  if (s.sleeves === 'short') {
    b.cylinder(0.07, 0.064, 0.12, sleeve, 0, -0.055, 0);
    b.cylinder(0.054, 0.049, UPPER_ARM - 0.08, s.skinTone, 0, -0.08 - (UPPER_ARM - 0.1) / 2, 0);
  } else {
    b.cylinder(0.064, 0.055, UPPER_ARM + 0.01, sleeve, 0, -UPPER_ARM / 2, 0);
  }
  if (s.top === 'tracksuit') {
    b.box(0.012, UPPER_ARM, 0.025, s.topColor2, side * 0.062, -UPPER_ARM / 2, 0, 0, 0, -side * 0.035);
    b.box(0.012, UPPER_ARM, 0.025, s.topColor2, side * 0.06, -UPPER_ARM / 2, 0.03, 0, 0, -side * 0.035);
  } else if (s.top === 'armor') {
    b.dome(0.1, 0.075, 0.1, shade(s.topColor, 1.08), side * 0.012, 0.0, 0, 0, 0, -side * 0.3, 1.2, 8, 4); // Schulter-Platte
    b.cylinder(0.068, 0.06, 0.16, shade(s.topColor, 0.95), 0, -UPPER_ARM + 0.1, 0);
  } else if (s.top === 'spacesuit') {
    b.box(0.012, 0.06, 0.06, s.topColor2, side * 0.064, -0.07, 0); // Abzeichen
  } else if (s.top === 'tactical') {
    b.box(0.012, 0.05, 0.05, s.trim, side * 0.064, -0.08, 0);
  } else if (s.top === 'robot') {
    b.cylinder(0.068, 0.06, 0.08, s.topColor2, 0, -UPPER_ARM + 0.03, 0);
  } else if (s.top === 'pirateCoat') {
    b.cylinder(0.068, 0.068, 0.03, s.trim, 0, -0.04, 0);
  }
  return b.build();
}

function buildForearm(s, side) {
  const b = new MeshBuilder();
  const bare = s.sleeves === 'short';
  const arm = bare ? s.skinTone : sleeveColor(s);
  const hand = s.gloves ?? s.skinTone;
  b.sphere(0.057, 0.057, 0.057, arm, 0, 0, 0, 0, 0, 0, 8, 6);
  const F = FOREARM;
  b.cylinder(0.055, 0.045, F - 0.03, arm, 0, -(F - 0.03) / 2, 0);
  if (!bare) {
    const cuff = s.top === 'hoodie' || s.top === 'tracksuit' ? s.topColor2 : s.top === 'pirateCoat' ? s.trim : s.top === 'labcoat' ? s.topColor : shade(arm, 0.85);
    b.cylinder(0.053, 0.053, 0.035, cuff, 0, -F + 0.045, 0);
  }
  if (s.top === 'armor' || s.top === 'robot') b.cylinder(0.062, 0.054, 0.15, s.gloves ?? s.topColor, 0, -F / 2, 0); // Arm-Schiene
  if (s.top === 'tracksuit') b.box(0.012, F - 0.06, 0.025, s.topColor2, side * 0.05, -(F - 0.06) / 2, 0.0, 0, 0, -side * 0.04);
  // Hand: Handfläche zeigt zum Körper (−side · X), Finger gekrümmt, Daumen vorn
  b.box(0.045, 0.085, 0.08, hand, 0, -F, -0.005);
  b.box(0.05, 0.05, 0.075, shade(hand, 0.96), -side * 0.004, -F - 0.05, -0.008, 0.15, 0, 0);
  b.box(0.026, 0.05, 0.026, hand, -side * 0.012, -F + 0.005, -0.052, -0.4, 0, 0);
  return b.build();
}

// --- Beine (Ursprung = Gelenk, Bein hängt nach −Y) --------------------------------------
function buildThigh(s, side) {
  const b = new MeshBuilder();
  b.cylinder(0.1, 0.075, 0.46, s.pantsColor, 0, -0.205, 0);
  if (s.pants === 'cargo') {
    b.box(0.03, 0.11, 0.1, s.pantsColor2, side * 0.089, -0.22, 0);
    b.box(0.034, 0.025, 0.104, shade(s.pantsColor2, 1.12), side * 0.09, -0.165, 0);
  } else if (s.pants === 'track') {
    b.box(0.014, 0.42, 0.03, s.pantsColor2, side * 0.088, -0.21, 0, 0, 0, -side * 0.055);
  } else if (s.pants === 'armor') {
    b.cylinder(0.106, 0.09, 0.22, s.pantsColor2, 0, -0.14, 0); // Oberschenkel-Platte
  } else if (s.pants === 'jeans') {
    b.box(0.006, 0.42, 0.012, s.pantsColor2, side * 0.087, -0.21, 0, 0, 0, -side * 0.055); // Naht
  }
  return b.build();
}

function buildShin(s, side) {
  const b = new MeshBuilder();
  b.sphere(0.075, 0.075, 0.075, s.pantsColor, 0, 0, 0, 0, 0, 0, 8, 6);
  b.cylinder(0.072, 0.055, 0.41, s.pantsColor, 0, -0.205, 0);
  if (s.shoes === 'boot') b.cylinder(0.072, 0.066, 0.17, s.shoeColor, 0, -0.33, 0);
  if (s.pants === 'track') b.box(0.014, 0.4, 0.03, s.pantsColor2, side * 0.064, -0.2, 0, 0, 0, -side * 0.04);
  else if (s.pants === 'armor') {
    b.dome(0.075, 0.06, 0.06, s.pantsColor2, 0, 0, -0.03, -HALF_PI + 0.2, 0, 0, 1, 8, 4); // Knie-Kappe
    b.cylinder(0.078, 0.066, 0.24, s.pantsColor2, 0, -0.22, -0.006); // Bein-Schiene
  } else if (s.pants === 'suit' && s.top === 'spacesuit') b.box(0.09, 0.08, 0.03, s.pantsColor2, 0, -0.03, -0.06);
  else if (s.pants === 'cargo') b.box(0.12, 0.03, 0.12, shade(s.pantsColor, 0.85), 0, -0.25, 0); // Hosen-Bund über dem Stiefel
  return b.build();
}

function buildShoe(s, side) {
  const b = new MeshBuilder();
  const c = s.shoeColor;
  if (s.shoes === 'boot') {
    b.box(0.112, 0.085, 0.235, c, 0, -0.033, -0.04);
    b.cylinder(0.056, 0.056, 0.112, c, 0, -0.035, -0.155, 0, 0, HALF_PI, 8);
    b.box(0.12, 0.028, 0.26, shade(c, 0.6), 0, -0.066, -0.045);
    b.box(0.115, 0.02, 0.03, shade(c, 1.2), 0, 0.0, 0.0); // Schaft-Rand
  } else {
    b.box(0.105, 0.072, 0.225, c, 0, -0.028, -0.045);
    b.cylinder(0.052, 0.052, 0.105, c, 0, -0.03, -0.155, 0, 0, HALF_PI, 8);
    const sole = c === '#FFFFFF' || c === '#F2F2F2' ? '#D8DCE2' : '#F4F4F4';
    b.box(0.115, 0.03, 0.255, sole, 0, -0.065, -0.045);
    b.box(0.05, 0.012, 0.085, '#FFFFFF', 0, 0.01, -0.085); // Schnürung
    b.box(0.008, 0.025, 0.1, s.trim, side * 0.054, -0.03, -0.04); // Streifen an der Seite
  }
  return b.build();
}

// --- Rechen-Hilfen für die Arme (keine neuen Objekte pro Bild) -----------------------------
const _D = new THREE.Vector3();
const _H = new THREE.Vector3();
const _E = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _grip = new THREE.Vector3();
const _fore = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _qPitch = new THREE.Quaternion();
const _qTwist = new THREE.Quaternion();
const _qHand = new THREE.Quaternion();
const _qArmR = new THREE.Quaternion();
const _qArmL = new THREE.Quaternion();
const _qFk = new THREE.Quaternion();
const _qTmp = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _AX = new THREE.Vector3(1, 0, 0);
const _AY = new THREE.Vector3(0, 1, 0);
const _ID = new THREE.Quaternion();

/**
 * Zwei-Glieder-Arm ("IK"): Schulter bei (sx, sy, sz), Hand soll an target.
 * Liefert die Ellbogen-Beugung (rotation.x) und die Schulter-Drehung in outQ;
 * der Ellbogen zeigt möglichst in Richtung pole.
 */
function solveArm(sx, sy, sz, target, pole, outQ) {
  _D.set(target.x - sx, target.y - sy, target.z - sz);
  const a = UPPER_ARM;
  const b = FOREARM;
  const d = clamp(_D.length(), Math.abs(a - b) + 0.02, a + b - 0.002);
  const bend = Math.PI - Math.acos(clamp((a * a + b * b - d * d) / (2 * a * b), -1, 1));
  _D.normalize();
  _H.set(0, -a - b * Math.cos(bend), -b * Math.sin(bend)).normalize();
  _qa.setFromUnitVectors(_H, _D);
  _E.set(0, -1, 0).applyQuaternion(_qa);
  _E.addScaledVector(_D, -_E.dot(_D));
  _pole.copy(pole).addScaledVector(_D, -pole.dot(_D));
  if (_E.lengthSq() > 1e-8 && _pole.lengthSq() > 1e-8) {
    _cross.crossVectors(_E, _pole);
    _qb.setFromAxisAngle(_D, Math.atan2(_cross.dot(_D), _E.dot(_pole)));
    outQ.multiplyQuaternions(_qb, _qa);
  } else outQ.copy(_qa);
  return bend;
}

/**
 * Baut die Grafik für eine Figur und hängt sie in die Szene.
 * @param {Character} character
 * @param {THREE.Object3D} scene  (oder eine Gruppe in der Szene)
 */
export function createCharacterView(character, scene) {
  const parts = characterParts(character.skin ?? CONFIG.skins.list[0]);
  const material = characterMaterial();

  const mesh = (geometry, parent, name) => {
    const m = new THREE.Mesh(geometry, material);
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const group = (parent, x = 0, y = 0, z = 0, name = '') => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    if (name) g.name = name;
    parent.add(g);
    return g;
  };

  // --- Aufbau ---------------------------------------------------------------------
  const root = new THREE.Group();
  root.name = `Figur ${character.name}`;
  const fall = group(root); // kippt beim Besiegtwerden um
  const hips = group(fall, 0, HIP_Y, 0, 'Hüfte');
  const upper = group(hips, 0, 0, 0, 'Oberkörper'); // neigt und dreht sich
  mesh(parts.body, upper, 'Körper');
  const head = group(upper, 0, HEAD_Y, 0, 'Kopf'); // = Mitte der Treffer-Kugel
  mesh(parts.head, head, 'Kopf-Form');

  const legs = [];
  for (const side of [-1, 1]) {
    const thigh = group(hips, side * HIP_X, 0, 0);
    mesh(side < 0 ? parts.thighL : parts.thighR, thigh, 'Oberschenkel');
    const knee = group(thigh, 0, -THIGH, 0);
    mesh(side < 0 ? parts.shinL : parts.shinR, knee, 'Unterschenkel');
    const ankle = group(knee, 0, -SHIN, 0);
    mesh(side < 0 ? parts.shoeL : parts.shoeR, ankle, 'Schuh');
    legs.push({ thigh, knee, ankle });
  }

  const arms = [];
  let rightHand = null;
  for (const side of [-1, 1]) {
    const shoulder = group(upper, side * SHOULDER_X, SHOULDER_Y, 0);
    mesh(side < 0 ? parts.upperArmL : parts.upperArmR, shoulder, 'Oberarm');
    const elbow = group(shoulder, 0, -UPPER_ARM, 0);
    mesh(side < 0 ? parts.forearmL : parts.forearmR, elbow, 'Unterarm');
    if (side === 1) rightHand = group(elbow, 0, -FOREARM, 0, 'rechte Hand');
    arms.push({ shoulder, elbow, side });
  }

  scene.add(root);

  // --- Zustand der Animation ---------------------------------------------------------
  const anim = {
    time: 0,
    walkPhase: 0,
    move: 0, // 0 = steht, 1 = läuft normal, > 1 = rennt
    crouch: 0,
    air: 0,
    hold: 0, // rechte Hand an der Waffe (0..1)
    holdL: 0, // linke Hand an der Waffe
    ads: 0, // Zielen (Waffe an der Schulter)
    death: 0,
    hidden: false,
    flinchAt: -10,
    lastHp: (character.health ?? 0) + (character.shield ?? 0),
  };
  const attachments = new Map();

  const view = {
    root,
    rightHand,
    head,
    character,
    meshCount: 12,

    /** Gegenstand (z. B. Waffe) an die rechte Hand hängen. Gleicher Name ersetzt. */
    attach(name, object) {
      view.detach(name);
      attachments.set(name, object);
      rightHand.add(object);
      return object;
    },

    /** Gegenstand von der Hand nehmen (wird nicht entsorgt). */
    detach(name) {
      const old = attachments.get(name);
      if (old) {
        rightHand.remove(old);
        attachments.delete(name);
      }
      return old ?? null;
    },

    /** Ausblenden, z. B. wenn die Kamera zu nah an der eigenen Figur ist. */
    setHidden(hidden) {
      anim.hidden = !!hidden;
    },

    /**
     * Jedes Bild aufrufen.
     * @param {number} alpha  0..1 zwischen zwei Logik-Schritten
     * @param {number} dt     Zeit seit dem letzten Bild (s)
     * @param {number} [yawOverride]  Blickrichtung (für den Spieler: die der Kamera)
     */
    update(alpha, dt, yawOverride) {
      const c = character;
      anim.time += dt;
      const t = anim.time;
      const gameTime = c.time;

      // Lage zwischen zwei Logik-Schritten
      const a = c.prevPosition;
      const b = c.position;
      root.position.set(
        a.x + (b.x - a.x) * alpha,
        a.y + (b.y - a.y) * alpha + c.prevStepOffset + (c.stepOffset - c.prevStepOffset) * alpha,
        a.z + (b.z - a.z) * alpha,
      );
      root.rotation.y = yawOverride ?? lerpAngle(c.prevYaw, c.yaw, alpha);

      // Besiegt: nach hinten umkippen, nach 2,5 s verschwinden
      anim.death = approach(anim.death, c.alive ? 0 : 1, dt * 3);
      const deadFor = gameTime - c.deathTime;
      root.visible = !anim.hidden && (c.alive || deadFor < 2.5);
      if (!root.visible) return;
      const fallen = easeOut(anim.death);
      fall.rotation.x = fallen * HALF_PI;
      fall.position.y = fallen * 0.2;

      // Treffer: kurzes Zucken
      const hp = (c.health ?? 0) + (c.shield ?? 0);
      if (c.alive && hp < anim.lastHp - 0.01) anim.flinchAt = t;
      anim.lastHp = hp;
      const flinchAge = t - anim.flinchAt;
      const flinch = flinchAge >= 0 && flinchAge < 0.28 ? Math.sin((flinchAge / 0.28) * Math.PI) : 0;

      // Zustände weich überblenden
      const speed = Math.hypot(c.velocity.x, c.velocity.z);
      anim.move = approach(anim.move, Math.min(1.4, speed / P.walkSpeed), dt * 8);
      anim.crouch = approach(anim.crouch, c.crouching ? 1 : 0, dt * 10);
      anim.air = approach(anim.air, c.grounded || !c.alive ? 0 : 1, dt * 8);
      const item = c.mode === 'weapon' ? c.slots[c.selectedSlot] : null;
      const weapon = attachments.get('weapon') ?? null;
      const building = c.mode === 'build' || c.mode === 'edit';
      const holding = c.alive && (c.aiming || !!item);
      const twoHanded = holding && (weapon ? weapon.userData.twoHanded !== false : true);
      anim.hold = approach(anim.hold, holding ? 1 : building && c.alive ? 0.6 : 0, dt * 10);
      anim.holdL = approach(anim.holdL, twoHanded ? 1 : building && c.alive ? 0.6 : 0, dt * 10);
      anim.ads = approach(anim.ads, c.aiming ? 1 : 0, dt * 9);
      if (c.grounded) anim.walkPhase += (speed / STRIDE) * Math.PI * 2 * dt;

      const move = anim.move * (1 - anim.air);
      const walk = Math.min(1, move);
      const run = clamp((anim.move - 1) / 0.25, 0, 1) * (1 - anim.air);
      const phase = anim.walkPhase;
      const swing = Math.sin(phase) * (0.5 + 0.3 * run) * walk;
      const crouch = anim.crouch;
      const air = anim.air;
      const dancing = c.alive && gameTime < c.emoteUntil;

      // --- Beine ------------------------------------------------------------------
      const legL = legs[0];
      const legR = legs[1];
      const kneeAmp = (0.75 + 0.6 * run) * walk;
      legL.thigh.rotation.set(swing + CROUCH_THIGH * crouch + air * 0.95, 0, -0.03);
      legR.thigh.rotation.set(-swing + CROUCH_THIGH * crouch + air * 0.25, 0, 0.03);
      // Knie beugen sich, wenn das Bein nach vorn schwingt (Fuß hebt ab)
      legL.knee.rotation.x = -(0.12 * walk + kneeAmp * Math.max(0, Math.cos(phase))) * (1 - crouch) + CROUCH_KNEE * crouch - air * 1.3;
      legR.knee.rotation.x = -(0.12 * walk + kneeAmp * Math.max(0, -Math.cos(phase))) * (1 - crouch) + CROUCH_KNEE * crouch - air * 0.55;

      // Hüfte: tiefer beim Ducken, wippt beim Laufen
      const bob = Math.abs(Math.cos(phase)) * (0.035 + 0.025 * run) * walk;
      hips.position.y = HIP_Y - CROUCH_DROP * crouch + bob - 0.05 * air;
      const lean = -0.06 * walk - 0.12 * run - CROUCH_LEAN * crouch + 0.22 * flinch;
      let twist = AIM_TWIST * anim.hold * (1 - crouch * 0.3) + Math.sin(phase) * 0.08 * walk * (1 - anim.hold);
      upper.rotation.set(lean, twist, 0);
      head.rotation.set(clamp(c.pitch, -0.7, 0.7) * 0.5 - 0.15 * flinch, -twist * 0.9, 0);

      // Füße möglichst waagerecht (am Boden)
      const flat = c.grounded ? 1 : 0.3;
      legL.ankle.rotation.x = -(legL.thigh.rotation.x + legL.knee.rotation.x) * flat * (crouch > 0.5 ? 1 : 0.65);
      legR.ankle.rotation.x = -(legR.thigh.rotation.x + legR.knee.rotation.x) * flat * (crouch > 0.5 ? 1 : 0.65);

      // --- Arme: frei (schwingen) -----------------------------------------------------
      const armL = arms[0];
      const armR = arms[1];
      const pitch = clamp(c.pitch, -1.25, 1.3);
      let lx = -swing * 1.1;
      let rx = swing * 1.1;
      let lz = -0.1 - air * 0.9 - fallen * 1.1;
      let rz = 0.1 + air * 0.9 + fallen * 1.1;
      let le = 0.25 + 0.55 * walk + 0.4 * run;
      let re = le;
      if (c.mode === 'pickaxe' && c.alive) {
        rx = 0.35 + swing * 0.4;
        re = 0.8;
      }
      // Arm-Schwung (Spitzhacke, Bauen)
      const actionAge = gameTime - c.actionTime;
      const acting = actionAge >= 0 && actionAge < 0.32;
      if (acting && c.actionKind !== 'build') {
        const p = actionAge / 0.32;
        rx = 2.5 - p * 2.8 + pitch * 0.5;
        re = 0.6 - p * 0.4;
        rz = 0.15;
        upper.rotation.y += Math.sin(p * Math.PI) * -0.25;
      }
      // Tanz
      if (dancing) {
        const beat = t * 7;
        upper.rotation.y = Math.sin(beat * 0.5) * 0.45;
        hips.position.y += Math.abs(Math.sin(beat)) * 0.07;
        lz = -2.5 - Math.sin(beat) * 0.4;
        rz = 2.5 + Math.cos(beat) * 0.4;
        lx = 0.2;
        rx = 0.2;
        le = 0.4 + Math.sin(beat) * 0.3;
        re = 0.4 - Math.sin(beat) * 0.3;
        legL.thigh.rotation.x = Math.max(0, Math.sin(beat)) * 0.7;
        legR.thigh.rotation.x = Math.max(0, -Math.sin(beat)) * 0.7;
        legL.knee.rotation.x = -legL.thigh.rotation.x * 1.3;
        legR.knee.rotation.x = -legR.thigh.rotation.x * 1.3;
        head.rotation.z = Math.sin(beat * 0.5) * 0.2;
      } else {
        head.rotation.z = 0;
      }
      twist = upper.rotation.y;

      // --- Arme: an der Waffe (IK) ------------------------------------------------------
      const hold = dancing ? 0 : anim.hold;
      const holdL = dancing ? 0 : anim.holdL;
      if (hold > 0 || holdL > 0) {
        // Blick-Neigung im Oberkörper (der Oberkörper ist selbst vorgeneigt)
        const q = pitch - upper.rotation.x;
        _qPitch.setFromAxisAngle(_AX, q);
        _qTwist.setFromAxisAngle(_AY, -twist);
        // rechte Hand: Griff-Punkt vor der Brust, mit dem Blick gedreht
        _grip.lerpVectors(GRIP_HIP, GRIP_AIM, anim.ads).sub(PIVOT);
        if (acting && c.actionKind === 'build') _grip.z -= Math.sin((actionAge / 0.32) * Math.PI) * 0.12;
        _grip.applyQuaternion(_qPitch).add(PIVOT);
        // linke Hand: vorn am Lauf (Waffe sagt wie weit) oder an der rechten Hand (Pistole)
        const fore = weapon?.userData.foregrip ?? 0;
        if (fore > 0.05) {
          const tilt = CONFIG.weaponVisuals.holdTiltIn ?? 0;
          _dir.set(-Math.sin(tilt), 0, -Math.cos(tilt)).applyQuaternion(_qPitch);
          _fore.copy(_grip).addScaledVector(_dir, fore);
          _dir.set(-0.015, -0.045, 0).applyQuaternion(_qPitch);
          _fore.add(_dir);
        } else {
          _dir.set(-0.075, -0.03, 0.01).applyQuaternion(_qPitch);
          _fore.copy(_grip).add(_dir);
        }
        // in den gedrehten Oberkörper umrechnen
        _grip.applyQuaternion(_qTwist);
        _fore.applyQuaternion(_qTwist);
        const bendR = solveArm(SHOULDER_X, SHOULDER_Y, 0, _grip, POLE_R, _qArmR);
        const bendL = solveArm(-SHOULDER_X, SHOULDER_Y, 0, _fore, POLE_L, _qArmL);
        // Hand-Lage: −Y = Lauf-Richtung (Blick), −Z = oben (siehe weapons/models.js createHandMount)
        _qHand.copy(_qTwist).multiply(_qPitch).multiply(_qTmp.setFromAxisAngle(_AX, HALF_PI));
        _qTmp.setFromAxisAngle(_AX, bendR);
        _qFk.multiplyQuaternions(_qArmR, _qTmp).invert();
        _qHand.premultiply(_qFk);

        _qFk.setFromEuler(_euler.set(rx, 0, rz));
        armR.shoulder.quaternion.slerpQuaternions(_qFk, _qArmR, hold);
        armR.elbow.rotation.x = re + (bendR - re) * hold;
        rightHand.quaternion.slerpQuaternions(_ID, _qHand, hold);
        _qFk.setFromEuler(_euler.set(lx, 0, lz));
        armL.shoulder.quaternion.slerpQuaternions(_qFk, _qArmL, holdL);
        armL.elbow.rotation.x = le + (bendL - le) * holdL;
      } else {
        armL.shoulder.rotation.set(lx, 0, lz);
        armR.shoulder.rotation.set(rx, 0, rz);
        armL.elbow.rotation.x = le;
        armR.elbow.rotation.x = re;
        rightHand.quaternion.identity();
      }
    },

    /** Grafik entfernen (Formen und Material sind geteilt und bleiben). */
    dispose() {
      root.parent?.remove(root);
      attachments.clear();
    },
  };
  return view;
}

function approach(value, target, step) {
  if (value < target) return Math.min(target, value + step);
  if (value > target) return Math.max(target, value - step);
  return value;
}

function easeOut(x) {
  return 1 - (1 - x) * (1 - x);
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}
