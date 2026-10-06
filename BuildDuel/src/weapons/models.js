// =============================================================================
// Waffen-Modelle aus einfachen Formen (Kisten, Zylinder, Kegel)
// =============================================================================
// createWeaponModel(id, rarity) → THREE.Group, das man an die rechte Hand hängt
// (character.view.attach('weapon', model)). Jede Waffe ist gut zu erkennen:
//   Schrotflinte: Pump-Griff unter dem Lauf   Sturmgewehr: Magazin + Tragegriff
//   MP: kurz und kompakt                     Sniper: langer Lauf + Zielfernrohr
//   Pistole: klein                           Granatwerfer: dicke Trommel + dickes Rohr
//   Spitzhacke, Heil-Items (Verband, Medikit, Schildtränke)
// Die Hauptfarbe ist die Seltenheits-Farbe (CONFIG.rarities).
//
// Aufbau im Modell: Griff im Ursprung, Lauf zeigt nach −Z, oben = +Y.
// Ein unsichtbarer Punkt "muzzle" sitzt an der Lauf-Spitze (für den Mündungsblitz).
// Formen und Materialien werden von allen Modellen geteilt (userData.shared) –
// sie werden nie entsorgt, das spart Speicher und Ladezeit.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';

const DARK = '#2B2F38';
const MID = '#59616E';
const WOOD = '#9A6534';
const BLACK = '#17191E';

const geometries = new Map();
const materials = new Map();

function shared(object) {
  object.userData.shared = true;
  return object;
}

function boxGeo(w, h, d) {
  const key = `b${w}:${h}:${d}`;
  let g = geometries.get(key);
  if (!g) geometries.set(key, (g = shared(new THREE.BoxGeometry(w, h, d))));
  return g;
}

// Zylinder entlang Z (wie ein Lauf)
function cylGeo(r, length, segments = 12, r2 = r) {
  const key = `c${r}:${r2}:${length}:${segments}`;
  let g = geometries.get(key);
  if (!g) {
    g = new THREE.CylinderGeometry(r2, r, length, segments);
    g.rotateX(Math.PI / 2);
    geometries.set(key, (g = shared(g)));
  }
  return g;
}

function coneGeo(r, h, segments = 8) {
  const key = `k${r}:${h}:${segments}`;
  let g = geometries.get(key);
  if (!g) geometries.set(key, (g = shared(new THREE.ConeGeometry(r, h, segments))));
  return g;
}

function sphereGeo(r) {
  const key = `s${r}`;
  let g = geometries.get(key);
  if (!g) geometries.set(key, (g = shared(new THREE.SphereGeometry(r, 12, 8))));
  return g;
}

function mat(color, emissive = null) {
  const key = `${color}|${emissive ?? ''}`;
  let m = materials.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    if (emissive) m.emissive = new THREE.Color(emissive);
    materials.set(key, (m = shared(m)));
  }
  return m;
}

/** Farbe einer Seltenheit (unbekannt → gewöhnlich). */
export function rarityColor(rarity) {
  return (CONFIG.rarities[rarity] ?? CONFIG.rarities.common).color;
}

// kleine Bau-Hilfe
function part(group, geometry, material, x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  group.add(m);
  return m;
}

function muzzle(group, x, y, z) {
  const o = new THREE.Object3D();
  o.name = 'muzzle';
  o.position.set(x, y, z);
  group.add(o);
  return o;
}

function grip(group, main) {
  part(group, boxGeo(0.045, 0.12, 0.055), mat(BLACK), 0, -0.06, 0.02, 0.3);
  // Abzug-Bügel
  part(group, boxGeo(0.012, 0.012, 0.07), main, 0, -0.035, -0.045);
}

const BUILDERS = {
  shotgun(g, c) {
    const main = mat(c);
    part(g, boxGeo(0.085, 0.1, 0.3), main, 0, 0.03, -0.06); // Gehäuse
    part(g, cylGeo(0.024, 0.56), mat(DARK), 0, 0.058, -0.47); // Lauf
    part(g, cylGeo(0.02, 0.46), mat(MID), 0, 0.012, -0.42); // Röhren-Magazin
    part(g, cylGeo(0.037, 0.16, 10), mat(WOOD), 0, 0.012, -0.44); // Pump-Griff
    for (const z of [-0.39, -0.43, -0.47]) part(g, cylGeo(0.039, 0.01, 10), mat(DARK), 0, 0.012, z); // Rillen
    part(g, boxGeo(0.07, 0.11, 0.26), mat(WOOD), 0, 0.0, 0.2, -0.12); // Schaft
    part(g, boxGeo(0.072, 0.13, 0.03), mat(BLACK), 0, -0.015, 0.33, -0.12); // Schaft-Kappe
    part(g, boxGeo(0.02, 0.02, 0.02), mat(BLACK), 0, 0.085, -0.73); // Korn
    grip(g, main);
    muzzle(g, 0, 0.058, -0.76);
  },
  ar(g, c) {
    const main = mat(c);
    part(g, boxGeo(0.075, 0.11, 0.4), main, 0, 0.025, -0.07); // Gehäuse
    part(g, boxGeo(0.068, 0.085, 0.22), mat(DARK), 0, 0.03, -0.37); // Handschutz
    part(g, cylGeo(0.016, 0.2), mat(BLACK), 0, 0.04, -0.57); // Lauf
    part(g, cylGeo(0.024, 0.05), mat(BLACK), 0, 0.04, -0.68); // Mündung
    part(g, boxGeo(0.048, 0.18, 0.075), mat(DARK), 0, -0.1, -0.13, -0.28); // Magazin
    part(g, boxGeo(0.03, 0.04, 0.16), mat(DARK), 0, 0.1, -0.06); // Tragegriff
    part(g, boxGeo(0.012, 0.05, 0.012), mat(DARK), 0, 0.09, -0.46); // Korn
    part(g, boxGeo(0.055, 0.09, 0.2), main, 0, 0.0, 0.24, -0.08); // Schaft
    part(g, boxGeo(0.06, 0.12, 0.03), mat(BLACK), 0, -0.01, 0.345, -0.08); // Schaft-Kappe
    grip(g, main);
    muzzle(g, 0, 0.04, -0.71);
  },
  smg(g, c) {
    const main = mat(c);
    part(g, boxGeo(0.075, 0.1, 0.28), main, 0, 0.025, -0.05); // Gehäuse
    part(g, cylGeo(0.02, 0.12), mat(BLACK), 0, 0.04, -0.25); // kurzer Lauf
    part(g, cylGeo(0.03, 0.06), mat(DARK), 0, 0.04, -0.32); // Schalldämpfer-Stummel
    part(g, boxGeo(0.04, 0.2, 0.05), mat(DARK), 0, -0.11, -0.08); // gerades Magazin
    part(g, boxGeo(0.034, 0.08, 0.034), mat(BLACK), 0, -0.05, -0.17); // vorderer Griff
    part(g, boxGeo(0.02, 0.04, 0.14), mat(DARK), 0, 0.04, 0.15); // Klapp-Schaft
    part(g, boxGeo(0.05, 0.07, 0.02), mat(DARK), 0, 0.02, 0.22);
    part(g, boxGeo(0.03, 0.025, 0.05), mat(BLACK), 0, 0.085, -0.03); // Kimme
    grip(g, main);
    muzzle(g, 0, 0.04, -0.36);
  },
  sniper(g, c) {
    const main = mat(c);
    part(g, boxGeo(0.07, 0.1, 0.36), main, 0, 0.025, -0.03); // Gehäuse
    part(g, cylGeo(0.017, 0.74), mat(DARK), 0, 0.04, -0.58); // langer Lauf
    part(g, cylGeo(0.03, 0.07, 10), mat(BLACK), 0, 0.04, -0.97); // Mündungsbremse
    // Zielfernrohr
    part(g, cylGeo(0.032, 0.28), mat(BLACK), 0, 0.125, -0.06);
    part(g, cylGeo(0.042, 0.06, 12, 0.032), mat(BLACK), 0, 0.125, -0.23); // vorn weiter
    part(g, cylGeo(0.038, 0.04, 12), mat(BLACK), 0, 0.125, 0.1);
    part(g, cylGeo(0.036, 0.004, 12), mat('#6FD3FF', '#2A6F99'), 0, 0.125, -0.262); // Glas vorn
    part(g, cylGeo(0.032, 0.004, 12), mat('#6FD3FF', '#2A6F99'), 0, 0.125, 0.122); // Glas hinten
    part(g, boxGeo(0.02, 0.05, 0.025), mat(DARK), 0, 0.085, -0.12); // Halter
    part(g, boxGeo(0.02, 0.05, 0.025), mat(DARK), 0, 0.085, 0.02);
    part(g, cylGeo(0.008, 0.06), mat(DARK), 0.05, 0.04, 0.05, 0, Math.PI / 2); // Kammer-Hebel
    part(g, sphereGeo(0.016), mat(DARK), 0.08, 0.04, 0.05);
    part(g, boxGeo(0.062, 0.12, 0.3), main, 0, -0.005, 0.3, -0.1); // Schaft
    part(g, boxGeo(0.066, 0.14, 0.03), mat(BLACK), 0, -0.02, 0.45, -0.1);
    part(g, boxGeo(0.04, 0.03, 0.12), mat(DARK), 0, 0.075, 0.33); // Wangen-Auflage
    grip(g, main);
    muzzle(g, 0, 0.04, -1.01);
  },
  pistol(g, c) {
    const main = mat(c);
    part(g, boxGeo(0.045, 0.055, 0.2), main, 0, 0.055, -0.07); // Schlitten
    part(g, boxGeo(0.04, 0.035, 0.16), mat(DARK), 0, 0.017, -0.06); // Rahmen
    part(g, cylGeo(0.012, 0.02), mat(BLACK), 0, 0.055, -0.18); // Mündung
    part(g, boxGeo(0.012, 0.015, 0.012), mat(BLACK), 0, 0.09, -0.15); // Korn
    part(g, boxGeo(0.042, 0.12, 0.06), mat(BLACK), 0, -0.05, 0.01, 0.25); // Griff
    part(g, boxGeo(0.012, 0.012, 0.06), main, 0, -0.01, -0.04); // Abzug-Bügel
    muzzle(g, 0, 0.055, -0.19);
  },
  grenadeLauncher(g, c) {
    const main = mat(c);
    part(g, boxGeo(0.1, 0.11, 0.26), main, 0, 0.03, 0.0); // Gehäuse
    part(g, cylGeo(0.085, 0.15, 14), mat(DARK), 0, 0.0, -0.14); // Trommel
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      part(g, cylGeo(0.022, 0.152, 8), mat(BLACK), Math.cos(a) * 0.055, Math.sin(a) * 0.055, -0.14);
    }
    part(g, cylGeo(0.048, 0.34, 14), mat(MID), 0, 0.045, -0.38); // dickes Rohr
    part(g, cylGeo(0.058, 0.05, 14), main, 0, 0.045, -0.53); // Ring vorn
    part(g, boxGeo(0.03, 0.05, 0.08), mat(BLACK), 0, 0.11, -0.25); // Visier
    part(g, boxGeo(0.04, 0.1, 0.04), mat(BLACK), 0, -0.07, -0.3); // vorderer Griff
    part(g, boxGeo(0.06, 0.1, 0.22), mat(DARK), 0, 0.0, 0.24, -0.1); // Schaft
    grip(g, main);
    muzzle(g, 0, 0.045, -0.56);
  },
  pickaxe(g) {
    // Stiel nach oben, Kopf oben (wird an der Hand passend gedreht)
    part(g, cylGeo(0.022, 0.72, 8), mat(WOOD), 0, 0, -0.26);
    part(g, cylGeo(0.026, 0.1, 8), mat('#2E86DE'), 0, 0, 0.02); // Griff-Band
    part(g, boxGeo(0.07, 0.08, 0.09), mat(MID), 0, 0, -0.6); // Kopf-Mitte
    const head = mat('#C9D1DB');
    part(g, coneGeo(0.04, 0.3, 6), head, 0, 0.17, -0.6); // Spitze nach oben
    part(g, coneGeo(0.04, 0.24, 6), head, 0, -0.14, -0.6, Math.PI); // Spitze nach unten
    muzzle(g, 0, 0, -0.6);
  },
  bandage(g) {
    part(g, cylGeo(0.05, 0.08, 14), mat('#F4F1EA'), 0, 0.03, -0.06, 0, Math.PI / 2);
    part(g, cylGeo(0.051, 0.02, 14), mat('#E3C9A8'), 0, 0.03, -0.06, 0, Math.PI / 2);
    muzzle(g, 0, 0.03, -0.1);
  },
  medkit(g) {
    part(g, boxGeo(0.2, 0.13, 0.09), mat('#F7F7F7'), 0, 0.05, -0.08);
    part(g, boxGeo(0.12, 0.035, 0.094), mat('#E63946'), 0, 0.05, -0.08);
    part(g, boxGeo(0.035, 0.1, 0.094), mat('#E63946'), 0, 0.05, -0.08);
    part(g, boxGeo(0.08, 0.02, 0.03), mat(DARK), 0, 0.125, -0.08); // Griff
    muzzle(g, 0, 0.05, -0.13);
  },
  smallShield(g) {
    const glass = mat('#4FC3F7', '#1B6FA0');
    part(g, sphereGeo(0.05), glass, 0, 0.05, -0.06);
    part(g, cylGeo(0.016, 0.05, 8), glass, 0, 0.11, -0.06, Math.PI / 2);
    part(g, cylGeo(0.02, 0.02, 8), mat('#F1F5F9'), 0, 0.14, -0.06, Math.PI / 2);
    muzzle(g, 0, 0.05, -0.11);
  },
  bigShield(g) {
    const glass = mat('#4FC3F7', '#1B6FA0');
    part(g, cylGeo(0.06, 0.14, 14), glass, 0, 0.06, -0.07, Math.PI / 2);
    part(g, cylGeo(0.025, 0.04, 10), glass, 0, 0.15, -0.07, Math.PI / 2);
    part(g, cylGeo(0.03, 0.025, 10), mat('#F1F5F9'), 0, 0.18, -0.07, Math.PI / 2);
    part(g, boxGeo(0.122, 0.03, 0.03), mat('#E3F6FF'), 0, 0.06, -0.07); // Etikett
    muzzle(g, 0, 0.06, -0.14);
  },
};

const HEAL_MODELS = ['bandage', 'medkit', 'smallShield', 'bigShield'];

/** Gibt es ein Modell für diesen Namen? */
export function hasWeaponModel(id) {
  return Object.hasOwn(BUILDERS, id);
}

/**
 * Baut ein Modell (Griff im Ursprung, Lauf nach −Z).
 * @param {string} id      'shotgun' | 'ar' | … | 'pickaxe' | 'bandage' | …
 * @param {string} [rarity]
 * @returns {THREE.Group}  mit userData.muzzle (Object3D an der Lauf-Spitze)
 */
export function createWeaponModel(id, rarity = 'common') {
  const group = new THREE.Group();
  group.name = `Waffe ${id}`;
  const build = BUILDERS[id];
  if (build) build(group, rarityColor(rarity));
  group.userData.muzzle = group.getObjectByName('muzzle') ?? null;
  return group;
}

/**
 * Hängt das Modell richtig gedreht an die Hand: Die Hand zeigt mit −Y den Unterarm
 * entlang (siehe characterModel.js). Waffen zeigen dorthin; die Spitzhacke liegt
 * schräg nach vorn-oben in der Hand.
 * @returns {THREE.Group}  Halter (an die Hand hängen)
 */
export function createHandMount(id, model) {
  const mount = new THREE.Group();
  mount.name = `Halter ${id}`;
  mount.add(model);
  // Comic-Stil: Waffen etwas größer als in echt, damit man sie gut erkennt
  mount.scale.setScalar(CONFIG.weaponVisuals.modelScale ?? 1);
  if (id === 'pickaxe') {
    mount.rotation.set(0.35, 0, 0);
    mount.position.set(0, -0.02, 0);
  } else {
    // Modell −Z → Hand −Y (den Unterarm entlang nach vorn), Modell +Y → Hand −Z (nach oben)
    mount.rotation.set(-Math.PI / 2, 0, 0);
    // etwas zur Körpermitte hin und leicht nach unten/innen gekippt: Lange Läufe zeigen sonst
    // genau in Blickrichtung und ragen (von hinten gesehen) bis ans Fadenkreuz heran.
    mount.position.set(-0.06, -0.02, 0.03);
    model.rotation.set(-(CONFIG.weaponVisuals.holdTiltDown ?? 0), CONFIG.weaponVisuals.holdTiltIn ?? 0, 0);
    // Heil-Items liegen in der Hand (nicht davor)
    if (HEAL_MODELS.includes(id)) mount.position.set(-0.04, 0.06, 0.02);
  }
  mount.userData.muzzle = model.userData.muzzle;
  return mount;
}
