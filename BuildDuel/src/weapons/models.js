// =============================================================================
// Waffen-Modelle: realistische Low-Poly-Waffen (eigene Formen, keine Original-Modelle)
// =============================================================================
// createWeaponModel(id, rarity) → THREE.Group, das man an die rechte Hand hängt
// (character.view.attach('weapon', createHandMount(id, model))).
//   Schrotflinte: dunkles Metall, Holz-Schaft und Holz-Pumpe   Sturmgewehr: grau/schwarz, Magazin, Schiene
//   Scharfschützengewehr: langer Lauf, Kammer-Hebel, großes Zielfernrohr
//   MP: kompakt, Klapp-Schaft   Pistole   Granatwerfer: Trommel
//   Spitzhacke (4 Formen aus CONFIG.pickaxes), Heil-Items (Verband, Medikit, Schildtränke)
// Seltenheit (CONFIG.rarities) wie im Original: NICHT die ganze Waffe gefärbt, sondern
// leuchtende Zier-Streifen in der Seltenheits-Farbe (eigenes, unbeleuchtetes Mesh).
//
// Aufbau: Griff (rechte Hand) im Ursprung, Lauf nach −Z, oben = +Y, Maße in Metern (echte Größe;
// in der Hand vergrößert um CONFIG.weaponVisuals.modelScale). Ein unsichtbarer Punkt "muzzle"
// sitzt an der Lauf-Spitze (Mündungsblitz). userData.foregrip = so weit vor dem Griff liegt die
// linke Hand (0 = Pistole: Hände zusammen), userData.twoHanded = false: linke Hand frei.
// Je Waffe 2 Meshes (Körper mit Ecken-Farben + Zier-Streifen). Formen/Materialien werden von allen
// Modellen geteilt (userData.shared) und nie entsorgt.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { MeshBuilder } from '../world/meshBuilder.js';

// Farben (echtes Waffen-Aussehen)
const METAL = '#4A505A';
const DARK = '#31353C';
const BLACK = '#202328';
const POLY = '#5B6068'; // Kunststoff
const STEEL = '#8C949E';
const WOOD = '#9A6234';
const WOOD_DARK = '#6E4323';
const HALF_PI = Math.PI / 2;

/** Farbe einer Seltenheit (unbekannt → gewöhnlich). */
export function rarityColor(rarity) {
  return (CONFIG.rarities[rarity] ?? CONFIG.rarities.common).color;
}

// --- Bau-Pläne -------------------------------------------------------------------------
// build(body, accent, options) – body = MeshBuilder (Ecken-Farben), accent = Zier-Streifen
// muzzle = Lauf-Spitze, foregrip = linke Hand (m vor dem Griff)
const DESIGNS = {
  shotgun: {
    muzzle: [0, 0.088, -0.76],
    foregrip: 0.34,
    build(b, a) {
      b.box(0.06, 0.085, 0.27, METAL, 0, 0.07, -0.16); // Gehäuse
      b.box(0.062, 0.02, 0.2, DARK, 0, 0.117, -0.17); // Oberseite
      b.cylinder(0.018, 0.018, 0.48, DARK, 0, 0.088, -0.52, HALF_PI, 0, 0, 10); // Lauf
      b.cylinder(0.022, 0.022, 0.02, BLACK, 0, 0.088, -0.755, HALF_PI, 0, 0, 10);
      b.cylinder(0.015, 0.015, 0.42, METAL, 0, 0.052, -0.48, HALF_PI, 0, 0, 8); // Röhren-Magazin
      b.box(0.054, 0.05, 0.17, WOOD, 0, 0.047, -0.34); // Pumpe (Holz)
      for (const z of [-0.28, -0.32, -0.36, -0.4]) b.box(0.056, 0.008, 0.012, WOOD_DARK, 0, 0.073, z); // Rillen
      b.box(0.008, 0.012, 0.012, STEEL, 0, 0.11, -0.73); // Korn
      // Griff + Schaft (Holz), nach unten abgeknickt
      b.box(0.04, 0.11, 0.06, WOOD_DARK, 0, -0.02, 0.0, 0.32);
      b.box(0.05, 0.075, 0.33, WOOD, 0, 0.02, 0.18, -0.13);
      b.box(0.053, 0.1, 0.025, BLACK, 0, 0.0, 0.345, -0.13); // Schaft-Kappe
      b.box(0.012, 0.035, 0.06, DARK, 0, 0.01, -0.06); // Abzug-Bügel
      b.box(0.006, 0.02, 0.006, BLACK, 0, 0.018, -0.055);
      // Zier-Streifen: an beiden Seiten des Gehäuses und am Schaft
      for (const x of [-0.031, 0.031]) {
        a.box(0.003, 0.012, 0.22, '#FFFFFF', x, 0.085, -0.16);
        a.box(0.003, 0.01, 0.2, '#FFFFFF', x * 0.85, 0.035, 0.19, -0.13);
      }
    },
  },
  ar: {
    muzzle: [0, 0.08, -0.7],
    foregrip: 0.32,
    build(b, a) {
      b.box(0.055, 0.08, 0.32, POLY, 0, 0.065, -0.15); // Gehäuse
      b.box(0.04, 0.025, 0.36, DARK, 0, 0.117, -0.2); // Schiene oben
      for (let i = 0; i < 9; i++) b.box(0.044, 0.008, 0.012, BLACK, 0, 0.13, -0.05 - i * 0.035);
      b.box(0.06, 0.07, 0.22, DARK, 0, 0.075, -0.42); // Handschutz
      for (const z of [-0.36, -0.42, -0.48]) b.box(0.062, 0.02, 0.03, BLACK, 0, 0.07, z); // Kühl-Schlitze
      b.cylinder(0.012, 0.012, 0.16, BLACK, 0, 0.08, -0.6, HALF_PI, 0, 0, 8); // Lauf
      b.cylinder(0.019, 0.019, 0.05, BLACK, 0, 0.08, -0.69, HALF_PI, 0, 0, 8); // Mündungsbremse
      b.box(0.008, 0.04, 0.012, BLACK, 0, 0.13, -0.5); // Korn
      b.box(0.03, 0.035, 0.05, BLACK, 0, 0.145, -0.05); // Kimme
      b.box(0.038, 0.15, 0.06, BLACK, 0, -0.04, -0.2, -0.22); // Magazin (nach vorn geneigt)
      b.box(0.04, 0.02, 0.064, DARK, 0, -0.115, -0.22, -0.22);
      b.box(0.038, 0.1, 0.055, BLACK, 0, -0.02, 0.0, 0.3); // Pistolen-Griff
      b.box(0.012, 0.03, 0.06, DARK, 0, 0.01, -0.06); // Abzug-Bügel
      b.box(0.045, 0.07, 0.2, POLY, 0, 0.055, 0.12); // Schaft
      b.box(0.048, 0.11, 0.06, DARK, 0, 0.03, 0.25); // Schaft-Ende
      b.box(0.05, 0.12, 0.02, BLACK, 0, 0.03, 0.29);
      for (const x of [-0.029, 0.029]) {
        a.box(0.003, 0.012, 0.26, '#FFFFFF', x, 0.075, -0.15);
        a.box(0.003, 0.01, 0.16, '#FFFFFF', x * 0.85, 0.06, 0.12);
      }
      a.box(0.042, 0.006, 0.066, '#FFFFFF', 0, -0.126, -0.225, -0.22); // Magazin-Boden
    },
  },
  smg: {
    muzzle: [0, 0.07, -0.42],
    foregrip: 0.24,
    build(b, a) {
      b.box(0.055, 0.075, 0.26, POLY, 0, 0.06, -0.11); // Gehäuse
      b.box(0.045, 0.018, 0.24, DARK, 0, 0.105, -0.12);
      b.box(0.05, 0.055, 0.12, DARK, 0, 0.065, -0.3); // Lauf-Mantel
      b.cylinder(0.016, 0.016, 0.09, BLACK, 0, 0.07, -0.39, HALF_PI, 0, 0, 8);
      b.box(0.03, 0.17, 0.045, BLACK, 0, -0.06, -0.07); // gerades Magazin
      b.box(0.034, 0.1, 0.04, BLACK, 0, -0.02, -0.23); // vorderer Griff (senkrecht)
      b.box(0.038, 0.1, 0.05, BLACK, 0, -0.02, 0.03, 0.25); // Pistolen-Griff
      b.box(0.012, 0.025, 0.05, DARK, 0, 0.01, -0.02);
      // Klapp-Schaft aus Draht
      b.box(0.008, 0.012, 0.22, DARK, 0.018, 0.07, 0.12);
      b.box(0.008, 0.012, 0.22, DARK, -0.018, 0.03, 0.12, 0.18);
      b.box(0.045, 0.08, 0.016, DARK, 0, 0.045, 0.235);
      b.box(0.026, 0.03, 0.04, BLACK, 0, 0.125, -0.04); // Visier
      for (const x of [-0.029, 0.029]) a.box(0.003, 0.012, 0.2, '#FFFFFF', x, 0.07, -0.12);
      a.box(0.032, 0.006, 0.047, '#FFFFFF', 0, -0.148, -0.07);
    },
  },
  sniper: {
    muzzle: [0, 0.075, -1.05],
    foregrip: 0.33,
    build(b, a) {
      b.box(0.055, 0.075, 0.3, DARK, 0, 0.065, -0.12); // Gehäuse
      b.cylinder(0.016, 0.014, 0.66, METAL, 0, 0.075, -0.6, HALF_PI, 0, 0, 10); // langer Lauf
      b.cylinder(0.024, 0.024, 0.08, BLACK, 0, 0.075, -0.97, HALF_PI, 0, 0, 8); // Mündungsbremse
      for (const z of [-0.95, -0.99]) b.box(0.05, 0.012, 0.012, BLACK, 0, 0.075, z);
      b.box(0.06, 0.06, 0.32, POLY, 0, 0.03, -0.36); // Vorderschaft
      // großes Zielfernrohr
      b.cylinder(0.026, 0.026, 0.26, BLACK, 0, 0.155, -0.12, HALF_PI, 0, 0, 12);
      b.cylinder(0.04, 0.026, 0.07, BLACK, 0, 0.155, -0.28, HALF_PI, 0, 0, 12); // Objektiv (vorn weiter)
      b.cylinder(0.034, 0.026, 0.05, BLACK, 0, 0.155, 0.03, -HALF_PI, 0, 0, 12); // Okular
      b.cylinder(0.035, 0.035, 0.005, '#6FC3EF', 0, 0.155, -0.318, HALF_PI, 0, 0, 12); // Glas vorn
      b.cylinder(0.03, 0.03, 0.005, '#6FC3EF', 0, 0.155, 0.057, HALF_PI, 0, 0, 12);
      b.cylinder(0.032, 0.032, 0.04, DARK, 0, 0.155, -0.12, HALF_PI, 0, 0, 12); // Stellrad-Ring
      b.cylinder(0.012, 0.012, 0.04, DARK, 0, 0.19, -0.12, 0, 0, 0, 8);
      b.box(0.02, 0.05, 0.025, DARK, 0, 0.115, -0.2); // Halter
      b.box(0.02, 0.05, 0.025, DARK, 0, 0.115, -0.03);
      b.cylinder(0.007, 0.007, 0.07, STEEL, 0.05, 0.07, -0.02, 0, 0, HALF_PI, 6); // Kammer-Hebel
      b.sphere(0.016, 0.016, 0.016, STEEL, 0.085, 0.07, -0.02);
      b.box(0.034, 0.08, 0.06, BLACK, 0, -0.01, -0.12); // Magazin
      b.box(0.04, 0.1, 0.055, DARK, 0, -0.02, 0.01, 0.3); // Griff
      b.box(0.012, 0.03, 0.06, DARK, 0, 0.01, -0.05);
      b.box(0.05, 0.085, 0.28, POLY, 0, 0.035, 0.17); // Schaft
      b.box(0.05, 0.035, 0.14, DARK, 0, 0.095, 0.15); // Wangen-Auflage
      b.box(0.054, 0.12, 0.025, BLACK, 0, 0.025, 0.315);
      for (const x of [-0.029, 0.029]) {
        a.box(0.003, 0.012, 0.22, '#FFFFFF', x, 0.075, -0.12);
        a.box(0.003, 0.01, 0.22, '#FFFFFF', x * 0.88, 0.04, 0.17);
      }
      a.cylinder(0.0275, 0.0275, 0.012, '#FFFFFF', 0, 0.155, -0.2, HALF_PI, 0, 0, 12); // Ring am Fernrohr
    },
  },
  pistol: {
    muzzle: [0, 0.075, -0.2],
    foregrip: 0,
    build(b, a) {
      b.box(0.034, 0.04, 0.2, METAL, 0, 0.075, -0.075); // Schlitten
      for (let i = 0; i < 5; i++) b.box(0.036, 0.03, 0.006, DARK, 0, 0.075, 0.0 - i * 0.012); // Griff-Rillen am Schlitten
      b.box(0.03, 0.028, 0.16, DARK, 0, 0.042, -0.07); // Rahmen
      b.cylinder(0.009, 0.009, 0.012, BLACK, 0, 0.075, -0.178, HALF_PI, 0, 0, 8);
      b.box(0.006, 0.012, 0.008, BLACK, 0, 0.1, -0.16); // Korn
      b.box(0.02, 0.012, 0.01, BLACK, 0, 0.1, 0.015); // Kimme
      b.box(0.032, 0.11, 0.05, BLACK, 0, -0.01, 0.005, 0.22); // Griff
      b.box(0.01, 0.022, 0.045, DARK, 0, 0.02, -0.05); // Abzug-Bügel
      for (const x of [-0.0175, 0.0175]) {
        a.box(0.003, 0.008, 0.15, '#FFFFFF', x, 0.07, -0.08);
        a.box(0.003, 0.05, 0.03, '#FFFFFF', x * 0.95, -0.01, 0.005, 0.22);
      }
    },
  },
  grenadeLauncher: {
    muzzle: [0, 0.08, -0.6],
    foregrip: 0.3,
    build(b, a) {
      b.box(0.07, 0.09, 0.2, METAL, 0, 0.06, -0.02); // Gehäuse
      b.cylinder(0.075, 0.075, 0.16, DARK, 0, 0.06, -0.19, HALF_PI, 0, 0, 12); // Trommel
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2;
        b.cylinder(0.022, 0.022, 0.162, BLACK, Math.cos(ang) * 0.05, 0.06 + Math.sin(ang) * 0.05, -0.19, HALF_PI, 0, 0, 8);
      }
      b.cylinder(0.042, 0.042, 0.34, POLY, 0, 0.08, -0.42, HALF_PI, 0, 0, 12); // dickes Rohr
      b.cylinder(0.048, 0.048, 0.04, BLACK, 0, 0.08, -0.58, HALF_PI, 0, 0, 12);
      b.cylinder(0.032, 0.032, 0.01, '#111111', 0, 0.08, -0.601, HALF_PI, 0, 0, 12);
      b.box(0.012, 0.06, 0.04, BLACK, 0, 0.15, -0.3); // Klapp-Visier
      b.box(0.04, 0.11, 0.045, BLACK, 0, 0.0, -0.32); // vorderer Griff
      b.box(0.04, 0.1, 0.055, BLACK, 0, -0.02, 0.02, 0.28); // Griff
      b.box(0.012, 0.03, 0.06, DARK, 0, 0.01, -0.04);
      b.box(0.05, 0.08, 0.24, POLY, 0, 0.05, 0.18, -0.08); // Schaft
      b.box(0.054, 0.11, 0.025, BLACK, 0, 0.04, 0.3, -0.08);
      for (const x of [-0.036, 0.036]) a.box(0.003, 0.014, 0.16, '#FFFFFF', x, 0.08, -0.02);
      a.cylinder(0.044, 0.044, 0.015, '#FFFFFF', 0, 0.08, -0.33, HALF_PI, 0, 0, 12); // Ring am Rohr
    },
  },
  // --- Heil-Items (eine Hand) ---------------------------------------------------------
  bandage: {
    muzzle: [0, 0.03, -0.1],
    twoHanded: false,
    build(b) {
      b.cylinder(0.05, 0.05, 0.08, '#F4F1EA', 0, 0.03, -0.06, 0, 0, HALF_PI, 14);
      b.cylinder(0.051, 0.051, 0.02, '#E3C9A8', 0, 0.03, -0.06, 0, 0, HALF_PI, 14);
      b.box(0.06, 0.004, 0.09, '#F4F1EA', 0.0, -0.02, -0.1, 0.3);
    },
  },
  medkit: {
    muzzle: [0, 0.05, -0.13],
    twoHanded: false,
    build(b) {
      b.box(0.2, 0.13, 0.09, '#F7F7F7', 0, 0.05, -0.08);
      b.box(0.12, 0.035, 0.094, '#E63946', 0, 0.05, -0.08);
      b.box(0.035, 0.1, 0.094, '#E63946', 0, 0.05, -0.08);
      b.box(0.08, 0.02, 0.03, DARK, 0, 0.125, -0.08); // Griff
    },
  },
  smallShield: {
    muzzle: [0, 0.05, -0.11],
    twoHanded: false,
    build(b) {
      b.sphere(0.05, 0.05, 0.05, '#4FC3F7', 0, 0.05, -0.06);
      b.cylinder(0.016, 0.016, 0.05, '#4FC3F7', 0, 0.11, -0.06, 0, 0, 0, 8);
      b.cylinder(0.02, 0.02, 0.02, '#F1F5F9', 0, 0.14, -0.06, 0, 0, 0, 8);
    },
  },
  bigShield: {
    muzzle: [0, 0.06, -0.14],
    twoHanded: false,
    build(b) {
      b.cylinder(0.06, 0.06, 0.14, '#4FC3F7', 0, 0.06, -0.07, 0, 0, 0, 14);
      b.cylinder(0.025, 0.025, 0.04, '#4FC3F7', 0, 0.15, -0.07, 0, 0, 0, 10);
      b.cylinder(0.03, 0.03, 0.025, '#F1F5F9', 0, 0.18, -0.07, 0, 0, 0, 10);
      b.box(0.122, 0.03, 0.03, '#E3F6FF', 0, 0.06, -0.13); // Etikett
    },
  },
};

// --- Spitzhacken: Stiel entlang −Z (Griff im Ursprung), Kopf am Ende, Spitzen nach ±Y ---------
const PICK_LEN = 0.66;
const PICKAXE_STYLES = {
  // klassische Spitzhacke: zwei gebogene Spitzen
  classic(b, p) {
    b.push(0, 0, -PICK_LEN);
    b.box(0.06, 0.075, 0.08, p.accent, 0, 0, 0); // Kopf-Mitte
    for (const s of [1, -1]) {
      b.box(0.04, 0.16, 0.05, p.head, 0, s * 0.11, 0.015, s * 0.22, 0, 0);
      b.box(0.032, 0.12, 0.04, p.head, 0, s * 0.24, 0.06, s * 0.6, 0, 0);
      b.cone(0.018, 0.08, p.head, 0, s * 0.32, 0.12, s * 1.0 + (s < 0 ? Math.PI : 0), 0, 0, 4);
    }
  },
  // Eisaxt: breite Klinge oben, Haken unten
  axe(b, p) {
    b.push(0, 0, -PICK_LEN);
    b.box(0.05, 0.07, 0.07, p.accent, 0, 0, 0);
    b.box(0.02, 0.16, 0.13, p.head, 0, 0.11, 0.03, 0.1, 0, 0); // Klinge
    b.box(0.022, 0.03, 0.16, shadeHex(p.head, 1.2), 0, 0.19, 0.035, 0.1, 0, 0); // Schneide
    b.box(0.03, 0.14, 0.035, p.head, 0, -0.1, 0.02, -0.35, 0, 0);
    b.cone(0.02, 0.07, p.head, 0, -0.19, 0.06, Math.PI - 0.6, 0, 0, 4);
  },
  // Hammer: dicker Block mit Spitze
  hammer(b, p) {
    b.push(0, 0, -PICK_LEN);
    b.box(0.1, 0.24, 0.11, p.head, 0, 0.0, 0.0);
    b.box(0.106, 0.04, 0.116, p.accent, 0, 0.08, 0.0);
    b.box(0.106, 0.04, 0.116, p.accent, 0, -0.08, 0.0);
    b.cone(0.05, 0.1, p.accent, 0, 0.17, 0.0, 0, 0, 0, 4);
  },
  // Sense/Haken: lange gebogene Klinge nach oben
  scythe(b, p) {
    b.push(0, 0, -PICK_LEN);
    b.box(0.05, 0.06, 0.06, p.accent, 0, 0, 0);
    b.box(0.02, 0.2, 0.05, p.head, 0, 0.12, 0.01, 0.15, 0, 0);
    b.box(0.018, 0.16, 0.045, p.head, 0, 0.27, 0.07, 0.7, 0, 0);
    b.box(0.016, 0.12, 0.04, p.head, 0, 0.35, 0.17, 1.25, 0, 0);
    b.cone(0.02, 0.06, p.accent, 0, -0.05, 0.0, Math.PI, 0, 0, 4);
  },
};

function buildPickaxe(b, p) {
  b.cylinder(0.019, 0.022, PICK_LEN + 0.08, p.handle, 0, 0, -PICK_LEN / 2 + 0.04, HALF_PI, 0, 0, 8); // Stiel
  b.cylinder(0.025, 0.025, 0.14, p.accent, 0, 0, 0.0, HALF_PI, 0, 0, 8); // Griff-Band
  b.cylinder(0.028, 0.028, 0.02, shadeHex(p.accent, 0.7), 0, 0, 0.08, HALF_PI, 0, 0, 8); // Knauf
  (PICKAXE_STYLES[p.style] ?? PICKAXE_STYLES.classic)(b, p);
  b.pop();
}

const _c = new THREE.Color();
function shadeHex(hex, f) {
  _c.set(hex);
  _c.setRGB(Math.min(1, _c.r * f), Math.min(1, _c.g * f), Math.min(1, _c.b * f));
  return `#${_c.getHexString()}`;
}

// --- geteilte Formen und Materialien ---------------------------------------------------------
const shapes = new Map(); // "id" bzw. "pickaxe:variante" → { body, accent }
let bodyMaterial = null;
const accentMaterials = new Map();

function getBodyMaterial() {
  if (!bodyMaterial) {
    bodyMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
    bodyMaterial.name = 'Waffen';
    bodyMaterial.userData.shared = true;
  }
  return bodyMaterial;
}

// Zier-Streifen: unbeleuchtet → leuchten in der Seltenheits-Farbe
function getAccentMaterial(color) {
  let m = accentMaterials.get(color);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color });
    m.name = `Seltenheit ${color}`;
    m.userData.shared = true;
    accentMaterials.set(color, m);
  }
  return m;
}

function shapeFor(id, variant) {
  const key = id === 'pickaxe' ? `pickaxe:${variant}` : id;
  let s = shapes.get(key);
  if (!s) {
    const body = new MeshBuilder();
    const accent = new MeshBuilder();
    if (id === 'pickaxe') buildPickaxe(body, pickaxeById(variant));
    else DESIGNS[id].build(body, accent);
    s = { body: body.build(), accent: accent.triangles ? accent.build() : null };
    s.body.userData.shared = true;
    if (s.accent) s.accent.userData.shared = true;
    shapes.set(key, s);
  }
  return s;
}

function pickaxeById(id) {
  const list = CONFIG.pickaxes.list;
  return list.find((p) => p.id === id) ?? list.find((p) => p.id === CONFIG.pickaxes.defaultId) ?? list[0];
}

/** Gibt es ein Modell für diesen Namen? */
export function hasWeaponModel(id) {
  return id === 'pickaxe' || Object.hasOwn(DESIGNS, id);
}

/**
 * Baut ein Modell (Griff im Ursprung, Lauf nach −Z).
 * @param {string} id      'shotgun' | 'ar' | … | 'pickaxe' | 'bandage' | …
 * @param {string} [rarity]  Seltenheit; bei 'pickaxe' die Spitzhacken-id (CONFIG.pickaxes)
 * @returns {THREE.Group}  mit userData.muzzle (Object3D an der Lauf-Spitze), foregrip, twoHanded
 */
export function createWeaponModel(id, rarity = 'common') {
  const group = new THREE.Group();
  group.name = `Waffe ${id}`;
  if (!hasWeaponModel(id)) {
    group.userData.muzzle = null;
    return group;
  }
  const design = id === 'pickaxe' ? { muzzle: [0, 0, -PICK_LEN], twoHanded: false } : DESIGNS[id];
  const shape = shapeFor(id, rarity);
  const body = new THREE.Mesh(shape.body, getBodyMaterial());
  body.name = 'Waffen-Körper';
  body.castShadow = true;
  group.add(body);
  if (shape.accent) {
    const accent = new THREE.Mesh(shape.accent, getAccentMaterial(rarityColor(rarity)));
    accent.name = 'Seltenheits-Streifen';
    group.add(accent);
  }
  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.fromArray(design.muzzle);
  group.add(muzzle);
  group.userData.muzzle = muzzle;
  group.userData.foregrip = design.foregrip ?? 0;
  group.userData.twoHanded = design.twoHanded !== false;
  return group;
}

/**
 * Hängt das Modell richtig gedreht an die Hand: Die Hand zeigt mit −Y in Lauf-Richtung und
 * mit −Z nach oben (die Figur dreht die Hand beim Halten so, siehe characterModel.js).
 * Die Spitzhacke liegt schräg nach vorn-oben in der Hand.
 * @returns {THREE.Group}  Halter (an die Hand hängen), userData: muzzle, foregrip (m, mit Größe), twoHanded
 */
export function createHandMount(id, model) {
  const mount = new THREE.Group();
  mount.name = `Halter ${id}`;
  mount.add(model);
  const scale = CONFIG.weaponVisuals.modelScale ?? 1;
  mount.scale.setScalar(scale);
  if (id === 'pickaxe') {
    mount.rotation.set(0.35, 0, 0);
    mount.position.set(0, -0.02, 0);
  } else {
    // Modell −Z → Hand −Y (Lauf-Richtung), Modell +Y → Hand −Z (oben)
    mount.rotation.set(-Math.PI / 2, 0, 0);
    // Griff sitzt in der Faust: etwas zur Körpermitte und leicht nach unten
    mount.position.set(-0.03, 0.0, 0.03);
    // Waffe zeigt immer ein klein wenig tiefer und zur Mitte (sonst ragt der Lauf ins Fadenkreuz)
    model.rotation.set(-(CONFIG.weaponVisuals.holdTiltDown ?? 0), CONFIG.weaponVisuals.holdTiltIn ?? 0, 0);
    if (!model.userData.twoHanded) mount.position.set(-0.03, 0.06, 0.02); // Heil-Items liegen in der Hand
  }
  mount.userData.muzzle = model.userData.muzzle;
  mount.userData.foregrip = (model.userData.foregrip ?? 0) * scale;
  mount.userData.twoHanded = id !== 'pickaxe' && model.userData.twoHanded !== false;
  return mount;
}
