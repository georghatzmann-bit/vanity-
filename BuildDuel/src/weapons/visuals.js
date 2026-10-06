// =============================================================================
// Waffen-Grafik (nur mit Bildschirm): Waffe in der Hand, Mündungsblitz, Leuchtspur,
// Feuerball der Granate und Treffer-Zahlen (das Zielfernrohr-Bild malt das HUD, src/ui/hud.js)
// =============================================================================
// Hört auf Ereignisse des Spiels:
//   'shot'      → Mündungsblitz (+ kurzes Licht), Rückstoß der Waffe, Leuchtspur (AR)
//   'hit'       → Treffer-Zahl über dem Ziel (weiß Körper, gelb Kopf, blau Schild)
//   'harvest'   → "+7" beim Sammeln mit der Spitzhacke
//   'explosion' → Feuerball
// Alles wird aus Vorräten ("Pools") genommen – keine neuen Objekte beim Schießen.
// Zeit für Effekte: echte Bild-Zeit (performance.now), auch wenn das Spiel pausiert.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { damageNumberKind } from '../core/damage.js';
import { createWeaponModel, createHandMount, hasWeaponModel } from './models.js';

const V = CONFIG.weaponVisuals;
const COLORS = CONFIG.visuals.colors;
const FLASHES = 8;
const TRACERS = 24;
const EXPLOSIONS = 4;
const PENDING = 16;

export function createWeaponVisuals(game, system) {
  const root = new THREE.Group();
  root.name = 'Waffen-Effekte';
  game.root.add(root);
  const views = new WeakMap(); // Figur → { key, mount, models: Map, kickTime }
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const Z = new THREE.Vector3(0, 0, 1);
  let now = performance.now() / 1000;
  let paused = false;
  let lastFrame = performance.now();

  // --- Mündungsblitz: Sterne-Bild als Sprite + ein Licht (immer da, nur an/aus) ----------
  const flashTexture = createFlashTexture();
  const flashes = [];
  for (let i = 0; i < FLASHES; i++) {
    const material = new THREE.SpriteMaterial({ map: flashTexture, color: '#FFE2A0', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    sprite.name = 'Mündungsblitz';
    sprite.visible = false;
    sprite.renderOrder = 20;
    root.add(sprite);
    flashes.push({ sprite, start: -1, life: V.muzzleFlashTime, size: V.muzzleFlashSize });
  }
  let nextFlash = 0;
  const light = new THREE.PointLight(V.muzzleLight.color, 0, V.muzzleLight.distance, 2);
  light.castShadow = false;
  root.add(light);
  let lightStart = -1;

  // --- Leuchtspur ------------------------------------------------------------------------
  const tracerGeometry = new THREE.BoxGeometry(1, 1, 1);
  tracerGeometry.translate(0, 0, 0.5); // von z = 0 bis 1 → wird auf die Länge gestreckt
  const tracers = [];
  for (let i = 0; i < TRACERS; i++) {
    // normale Mischung (nicht additiv): bleibt auch vor dem hellen Himmel gelb
    const material = new THREE.MeshBasicMaterial({ color: V.tracerColor, transparent: true, opacity: 0, depthWrite: false });
    const mesh = new THREE.Mesh(tracerGeometry, material);
    mesh.name = 'Leuchtspur';
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 19;
    root.add(mesh);
    tracers.push({ mesh, start: -1 });
  }
  let nextTracer = 0;

  // --- Feuerball -------------------------------------------------------------------------
  const ballGeometry = new THREE.SphereGeometry(1, 20, 14);
  const explosions = [];
  for (let i = 0; i < EXPLOSIONS; i++) {
    const coreMat = new THREE.MeshBasicMaterial({ color: V.explosionCoreColor, transparent: true, opacity: 0, depthWrite: false });
    const outerMat = new THREE.MeshBasicMaterial({ color: V.explosionColor, transparent: true, opacity: 0, depthWrite: false });
    const core = new THREE.Mesh(ballGeometry, coreMat);
    const outer = new THREE.Mesh(ballGeometry, outerMat);
    core.visible = outer.visible = false;
    core.name = 'Feuerball innen';
    outer.name = 'Feuerball';
    root.add(outer, core);
    explosions.push({ core, outer, start: -1, radius: 4, position: new THREE.Vector3() });
  }
  let nextExplosion = 0;

  // Schüsse aus dem Logik-Schritt: Blitz/Spur erst im Bild starten (Mündung der GRAFIK)
  const pending = [];
  for (let i = 0; i < PENDING; i++) pending.push({ shooter: null, weaponId: null, end: new THREE.Vector3(), origin: new THREE.Vector3(), used: false });
  let pendingCount = 0;

  // --- Treffer-Zahlen (HTML über dem Bild) -------------------------------------------------
  const numbers = createDamageNumbers(game);

  const offs = [];
  offs.push(game.events.on('shot', (e) => {
    if (pendingCount >= PENDING) return;
    const p = pending[pendingCount++];
    p.shooter = e.shooter;
    p.weaponId = e.weaponId;
    p.end.copy(e.end);
    p.origin.copy(e.origin);
  }));
  offs.push(game.events.on('hit', (e) => {
    if (!numbers || game.settings?.game?.damageNumbers === false) return;
    if (V.damageNumbers.onlyOwnHits && game.player && e.attacker !== game.player) return;
    if (e.kind === 'character') {
      numbers.spawn(e.point, Math.round(e.amount), damageNumberKind(e.head, e.shield));
    } else if (V.damageNumbers.showStructureHits) {
      // an Bauteilen: der Waffen-Schaden (wie im Original), auch wenn das Teil weniger Leben hatte
      numbers.spawn(e.point, Math.round(e.nominal ?? e.amount), 'structure');
    }
  }));
  offs.push(game.events.on('harvest', (e) => {
    if (!numbers || game.settings?.game?.damageNumbers === false) return;
    if (game.player && e.character !== game.player) return;
    // was wirklich dazukam; schon voll (999) → "voll" statt einer Zahl, die nicht stimmt
    numbers.spawn(e.point, e.amount > 0 ? `+${e.amount}` : V.harvestFullText, 'harvest');
  }));
  offs.push(game.events.on('explosion', (e) => {
    const x = explosions[nextExplosion];
    nextExplosion = (nextExplosion + 1) % EXPLOSIONS;
    x.start = now;
    x.radius = e.radius;
    x.position.copy(e.position);
  }));

  // --- Waffe in der Hand ------------------------------------------------------------------------
  function wantedModel(c) {
    if (!c.alive) return null;
    if (c.mode === 'pickaxe') return 'pickaxe:common';
    if (c.mode !== 'weapon') return null;
    const item = c.slots[c.selectedSlot];
    if (!item || !hasWeaponModel(item.id)) return null;
    return `${item.id}:${item.rarity ?? 'common'}`;
  }

  function updateHeld(c) {
    let v = views.get(c);
    if (!v) {
      v = { key: null, mount: null, models: new Map(), kickTime: -1, view: c.view, mode: null, item: undefined, alive: true };
      views.set(c, v);
    }
    if (v.view !== c.view) {
      // neue Grafik (z. B. nach Neustart): alles neu anhängen
      v.view = c.view;
      v.key = null;
      v.mount = null;
      v.item = undefined;
    }
    // Nur neu rechnen, wenn sich Modus, Gegenstand oder Leben geändert haben (keine Texte pro Bild)
    const item = c.mode === 'weapon' ? c.slots[c.selectedSlot] ?? null : null;
    const key = item === v.item && c.mode === v.mode && c.alive === v.alive ? v.key : wantedModel(c);
    v.item = item;
    v.mode = c.mode;
    v.alive = c.alive;
    if (key !== v.key) {
      v.key = key;
      if (!key) {
        c.view.detach('weapon');
        v.mount = null;
      } else {
        let mount = v.models.get(key);
        if (!mount) {
          const id = key.slice(0, key.indexOf(':'));
          const rarity = key.slice(key.indexOf(':') + 1);
          mount = createHandMount(id, createWeaponModel(id, rarity));
          v.models.set(key, mount);
        }
        c.view.attach('weapon', mount);
        v.mount = mount;
      }
    }
    if (v.mount) {
      // Rückstoß: kurz nach hinten zucken
      const age = now - v.kickTime;
      const kick = age >= 0 && age < 0.12 ? V.recoilKick * (1 - age / 0.12) : 0;
      v.mount.children[0].position.z = kick;
      // Beim Blick nach oben die Waffe etwas tiefer halten – sonst ragt der Lauf
      // (die Arme folgen dem Blick) von unten ins Fadenkreuz.
      if (v.key !== 'pickaxe:common') {
        const lower = V.lookUpLowering * Math.max(0, c.pitch - V.lookUpLoweringFrom);
        v.mount.rotation.x = -Math.PI / 2 - lower;
      }
    }
    return v;
  }

  // Mündung der Grafik in Welt-Koordinaten (false = keine Grafik)
  function muzzleWorld(c, out) {
    const v = c.view ? views.get(c) : null;
    const muzzle = v?.mount?.userData.muzzle;
    if (!muzzle || !c.view.root.visible) return false;
    muzzle.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(muzzle.matrixWorld);
    return true;
  }

  function startFlash(position, big) {
    const f = flashes[nextFlash];
    nextFlash = (nextFlash + 1) % FLASHES;
    f.start = now;
    f.size = V.muzzleFlashSize * (big ? 1.5 : 1);
    f.sprite.position.copy(position);
    f.sprite.material.rotation = Math.random() * Math.PI * 2;
    f.sprite.visible = true;
    startLight(position);
  }

  // nur das kurze Licht (z. B. eigene Figur ausgeblendet: kein Blitz-Bild, aber die Wände leuchten auf)
  function startLight(position) {
    light.position.copy(position);
    lightStart = now;
  }

  function startTracer(from, to) {
    const length = from.distanceTo(to);
    if (length < 0.5) return;
    const t = tracers[nextTracer];
    nextTracer = (nextTracer + 1) % TRACERS;
    t.start = now;
    t.mesh.position.copy(from);
    tmp2.subVectors(to, from).multiplyScalar(1 / length);
    t.mesh.quaternion.setFromUnitVectors(Z, tmp2);
    t.mesh.scale.set(V.tracerWidth, V.tracerWidth, length);
    t.mesh.visible = true;
  }

  function handlePending() {
    for (let i = 0; i < pendingCount; i++) {
      const p = pending[i];
      const c = p.shooter;
      const def = CONFIG.weapons[p.weaponId];
      const v = c ? views.get(c) : null;
      if (v) v.kickTime = now;
      // Kein Blitz vor der Linse: nicht beim Zielfernrohr und nicht, wenn die eigene Figur
      // ausgeblendet ist (Kamera dicht am Kopf, z. B. in einer Box mit dem Rücken zur Wand)
      const visible = !!c?.view && c.view.root.visible && !(c === game.player && c.scopeFov);
      if (!(visible && muzzleWorld(c, tmp))) {
        tmp.copy(p.origin);
        if (c?.view && !visible && !c.scopeFov) startLight(tmp);
        if (!visible) {
          // Leuchtspur erst ein Stück vor der Kamera beginnen lassen
          tmp2.subVectors(p.end, p.origin);
          const length = tmp2.length();
          if (length > 1e-6) tmp.addScaledVector(tmp2, Math.min(V.hiddenShotStartDistance, length) / length);
        }
      }
      if (visible) startFlash(tmp, p.weaponId === 'shotgun' || p.weaponId === 'sniper' || p.weaponId === 'grenadeLauncher');
      if (def?.tracer) startTracer(tmp, p.end);
      p.shooter = null;
    }
    pendingCount = 0;
  }

  const visuals = {
    muzzleWorld,

    /** Für Tests: gerade sichtbare Treffer-Zahlen [{ text, kind }]. */
    visibleNumbers() {
      return numbers ? numbers.visible() : [];
    },

    /** Für Tests: sichtbare Blitze { x, y, z, size } und Leuchtspuren { x, y, z, length } (Anfang). */
    visibleEffects() {
      const out = { flashes: [], tracers: [] };
      for (const f of flashes) {
        if (f.sprite.visible) out.flashes.push({ x: f.sprite.position.x, y: f.sprite.position.y, z: f.sprite.position.z, size: f.sprite.scale.x });
      }
      for (const tr of tracers) {
        if (tr.mesh.visible) out.tracers.push({ x: tr.mesh.position.x, y: tr.mesh.position.y, z: tr.mesh.position.z, length: tr.mesh.scale.z });
      }
      return out;
    },

    frameUpdate(/* alpha */) {
      const t = performance.now();
      const dt = Math.min(0.1, Math.max(0, (t - lastFrame) / 1000));
      lastFrame = t;
      if (!paused) now += dt;

      for (const c of game.characters) if (c.view) updateHeld(c);
      handlePending();

      // Blitze
      for (const f of flashes) {
        if (!f.sprite.visible) continue;
        const age = now - f.start;
        if (age > f.life) {
          f.sprite.visible = false;
          continue;
        }
        const k = 1 - age / f.life;
        f.sprite.material.opacity = k;
        const s = f.size * (0.7 + 0.5 * k);
        f.sprite.scale.set(s, s, 1);
      }
      const la = now - lightStart;
      light.intensity = lightStart >= 0 && la < V.muzzleFlashTime * 1.4 ? V.muzzleLight.intensity * (1 - la / (V.muzzleFlashTime * 1.4)) : 0;

      // Leuchtspuren
      for (const tr of tracers) {
        if (!tr.mesh.visible) continue;
        const age = now - tr.start;
        if (age > V.tracerLifetime) {
          tr.mesh.visible = false;
          continue;
        }
        tr.mesh.material.opacity = 0.85 * (1 - age / V.tracerLifetime);
      }

      // Feuerbälle
      for (const x of explosions) {
        if (x.start < 0) continue;
        const age = now - x.start;
        if (age > V.explosionTime) {
          x.start = -1;
          x.core.visible = x.outer.visible = false;
          continue;
        }
        const k = age / V.explosionTime;
        const grow = 1 - (1 - k) * (1 - k) * (1 - k);
        x.outer.position.copy(x.position);
        x.core.position.copy(x.position);
        const rOuter = x.radius * (0.45 + 0.55 * grow);
        x.outer.scale.setScalar(rOuter);
        x.core.scale.setScalar(rOuter * 0.6);
        x.outer.material.opacity = 0.6 * (1 - k);
        x.core.material.opacity = 0.85 * (1 - k * k);
        x.core.visible = x.outer.visible = true;
      }

      numbers?.update(paused ? 0 : dt);
    },

    /** Effekte anhalten (Screenshots in Tests). */
    setPaused(on) {
      paused = !!on;
    },

    /** Alle laufenden Effekte sofort weg (neue Runde, Tests). */
    clear() {
      pendingCount = 0;
      for (const f of flashes) f.sprite.visible = false;
      lightStart = -1;
      light.intensity = 0;
      for (const tr of tracers) tr.mesh.visible = false;
      for (const x of explosions) {
        x.start = -1;
        x.core.visible = x.outer.visible = false;
      }
      numbers?.clear();
    },

    dispose() {
      for (const off of offs) off();
      offs.length = 0;
      root.parent?.remove(root);
      flashTexture.dispose();
      for (const f of flashes) f.sprite.material.dispose();
      tracerGeometry.dispose();
      for (const tr of tracers) tr.mesh.material.dispose();
      ballGeometry.dispose();
      for (const x of explosions) {
        x.core.material.dispose();
        x.outer.material.dispose();
      }
      numbers?.dispose();
    },
  };
  visuals.system = system;
  return visuals;
}

// Weißer Stern mit weichem Rand (wird mit der Sprite-Farbe eingefärbt)
function createFlashTexture() {
  const px = 64;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  const c = px / 2;
  const glow = ctx.createRadialGradient(c, c, 0, c, c, c);
  glow.addColorStop(0, 'rgba(255,255,255,1)');
  glow.addColorStop(0.25, 'rgba(255,240,200,0.9)');
  glow.addColorStop(1, 'rgba(255,200,120,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const r = i % 2 === 0 ? c : c * 0.38;
    ctx.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// -----------------------------------------------------------------------------
// Treffer-Zahlen: HTML-Elemente über dem 3D-Bild (Vorrat, keine neuen Elemente)
// -----------------------------------------------------------------------------
let styleAdded = false;
function addStyles() {
  if (styleAdded || typeof document === 'undefined') return;
  styleAdded = true;
  const d = V.damageNumbers;
  const outline = '#14161B';
  const shadow = [[-2, -2], [2, -2], [-2, 2], [2, 2], [0, 2], [0, -2], [2, 0], [-2, 0]]
    .map(([x, y]) => `${x}px ${y}px 0 ${outline}`).join(', ');
  const style = document.createElement('style');
  style.id = 'bd-weapon-styles';
  style.textContent = `
.bd-dmg-layer { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.bd-dmg { position: absolute; left: 0; top: 0; font: 900 ${d.fontPx}px/1 "Segoe UI", system-ui, Arial, sans-serif;
  color: ${COLORS.damageBody}; text-shadow: ${shadow}, 0 3px 6px rgba(0,0,0,0.45); white-space: nowrap;
  will-change: transform, opacity; display: none; font-variant-numeric: tabular-nums; }
.bd-dmg.head { color: ${COLORS.damageHead}; font-size: ${d.headFontPx}px; }
.bd-dmg.shield { color: ${COLORS.damageShield}; }
.bd-dmg.structure { color: ${d.structureColor}; font-size: ${d.structureFontPx}px; font-weight: 800; }
.bd-dmg.harvest { color: ${d.harvestColor}; font-size: ${d.structureFontPx + 2}px; font-weight: 800; }
`;
  document.head.appendChild(style);
}

function createDamageNumbers(game) {
  const ui = game.uiRoot;
  const camera = game.camera;
  if (!ui || !camera) return null;
  addStyles();
  const cfg = V.damageNumbers;
  const layer = document.createElement('div');
  layer.className = 'bd-dmg-layer';
  ui.insertBefore(layer, ui.firstChild); // unter allen anderen Anzeigen
  const list = [];
  for (let i = 0; i < cfg.pool; i++) {
    const el = document.createElement('div');
    el.className = 'bd-dmg';
    layer.appendChild(el);
    list.push({ el, active: false, age: 0, world: new THREE.Vector3(), dx: 0, kind: '' });
  }
  let next = 0;
  const v = new THREE.Vector3();

  return {
    spawn(point, text, kind) {
      const n = list[next];
      next = (next + 1) % list.length;
      n.active = true;
      n.age = 0;
      n.world.copy(point);
      n.dx = (Math.random() - 0.5) * 0.5; // leicht versetzt, damit sich Zahlen nicht überdecken
      if (n.kind !== kind) {
        n.el.className = `bd-dmg ${kind}`;
        n.kind = kind;
      }
      n.el.textContent = String(text);
      n.el.style.display = 'block';
    },
    update(dt) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      camera.updateMatrixWorld();
      for (const n of list) {
        if (!n.active) continue;
        n.age += dt;
        const k = n.age / cfg.lifetime;
        if (k >= 1) {
          n.active = false;
          n.el.style.display = 'none';
          continue;
        }
        const rise = cfg.rise * (1 - (1 - k) * (1 - k));
        v.set(n.world.x, n.world.y + 0.25 + rise, n.world.z).project(camera);
        if (v.z > 1 || v.z < -1) {
          n.el.style.opacity = '0';
          continue;
        }
        const x = (v.x + 1) * 0.5 * w + n.dx * 40;
        const y = (1 - v.y) * 0.5 * h;
        const pop = k < 0.12 ? 1.35 - (k / 0.12) * 0.35 : 1;
        n.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) scale(${pop.toFixed(3)})`;
        n.el.style.opacity = k > 0.7 ? ((1 - k) / 0.3).toFixed(3) : '1';
      }
    },
    /** Für Tests: sichtbare Zahlen { text, kind } */
    visible() {
      return list.filter((n) => n.active).map((n) => ({ text: n.el.textContent, kind: n.kind }));
    },
    clear() {
      for (const n of list) {
        n.active = false;
        n.el.style.display = 'none';
      }
    },
    dispose() {
      layer.remove();
    },
  };
}
