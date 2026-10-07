// =============================================================================
// Lobby-Bühne (3D-Hintergrund des Hauptmenüs)
// =============================================================================
// Die eigene Figur steht in der Mitte auf einem runden Podest und dreht sich
// langsam (Maus/Finger ziehen = selbst drehen). Dahinter: kleine Gras-Insel mit
// Strand, Wasser, Bäumen, Felsen, einem Holz-Fort und Wolken – alles aus
// einfachen Formen, eigene Farben.
// Zusätzlich: kleine Vorschau-Bilder (Skins, Spitzhacken) für Spind und Shop.
//
// Nur Grafik (läuft nur mit Bildschirm). Werte: CONFIG.lobby.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Character } from '../player.js';
import { createCharacterView } from './characterModel.js';
import { createWeaponModel, createHandMount } from '../weapons/models.js';
import { stylePickaxe, applyEmoteMotion } from './cosmetics.js';

const L = CONFIG.lobby;
const PODIUM_TOP = 0.42;
const LOBBY_FOV = 32;

/**
 * @param {object} options { scene, camera, renderer, element (Fläche zum Ziehen) }
 */
export function createLobbyScene({ scene, camera, renderer, element }) {
  const group = new THREE.Group();
  group.name = 'Lobby';
  scene.add(group);
  const disposables = [];
  const track = (x) => {
    disposables.push(x);
    return x;
  };
  const lambert = (color, extra = {}) => track(new THREE.MeshLambertMaterial({ color, ...extra }));

  buildScenery(group, lambert, track);

  // --- Figur ------------------------------------------------------------------------
  const clock = { time: 0 }; // eigene Uhr (Tanz-Dauer)
  let character = null;
  let view = null;
  let pickaxeMount = null;
  let emoteMotionName = 'dance';
  let emoteStart = -1;
  const turntable = { angle: 0, idle: 99, dragging: null, lastX: 0, facing: false };

  function setSkin(skinId) {
    view?.dispose();
    character = new Character(clock, { name: 'Lobby', skin: skinId, position: { x: 0, y: PODIUM_TOP, z: 0 }, yaw: Math.PI });
    view = createCharacterView(character, group);
    if (pickaxeMount) {
      character.mode = 'pickaxe';
      view.attach('weapon', pickaxeMount);
    }
  }

  /** Spitzhacke in der Hand zeigen (style = Farben) oder weglegen (null). */
  function setPickaxe(style) {
    if (pickaxeMount) {
      view?.detach('weapon');
      disposeTree(pickaxeMount);
      pickaxeMount = null;
    }
    if (!style) {
      if (character) character.mode = 'weapon';
      return;
    }
    pickaxeMount = createHandMount('pickaxe', createWeaponModel('pickaxe'));
    stylePickaxe(pickaxeMount, style);
    if (character) {
      character.mode = 'pickaxe';
      view.attach('weapon', pickaxeMount);
    }
  }

  /** Emote vorführen (Figur dreht sich dabei zur Kamera). */
  function playEmote(motion = 'dance', seconds = L.emotePreview) {
    if (!character) return;
    emoteMotionName = motion;
    emoteStart = clock.time;
    character.emoteUntil = clock.time + seconds;
    faceCamera();
  }

  function faceCamera() {
    turntable.facing = true;
    turntable.idle = 0;
  }

  // --- Ziehen = drehen -----------------------------------------------------------------
  const onDown = (e) => {
    if (e.button !== 0 || !group.visible) return;
    turntable.dragging = e.pointerId;
    turntable.lastX = e.clientX;
    turntable.facing = false;
    element.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (e.pointerId !== turntable.dragging) return;
    turntable.angle += (e.clientX - turntable.lastX) * L.dragSpeed;
    turntable.lastX = e.clientX;
    turntable.idle = 0;
  };
  const onUp = (e) => {
    if (e.pointerId !== turntable.dragging) return;
    turntable.dragging = null;
    element.releasePointerCapture?.(e.pointerId);
  };
  element?.addEventListener('pointerdown', onDown);
  element?.addEventListener('pointermove', onMove);
  element?.addEventListener('pointerup', onUp);
  element?.addEventListener('pointercancel', onUp);

  // --- Kamera ---------------------------------------------------------------------------
  // layout: 'center' (Lobby) | 'side' (Spind/Shop: Figur links bzw. oben)
  let layout = 'center';
  const lookTarget = new THREE.Vector3(0, 1.0, 0);

  function placeCamera() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const aspect = w / h;
    camera.fov = LOBBY_FOV;
    camera.aspect = aspect;
    // Figur (ca. 2,1 m mit Podest) soll gut die Hälfte der Höhe füllen; schmale Bildschirme: weiter weg
    const visibleHeight = 4.3 * Math.max(1, 0.8 / aspect);
    const distance = visibleHeight / (2 * Math.tan(THREE.MathUtils.degToRad(LOBBY_FOV / 2)));
    camera.position.set(0, 1.55 + distance * 0.08, distance);
    camera.lookAt(lookTarget);
    if (layout === 'side') {
      // Bild verschieben statt Kamera drehen: Figur rückt nach links (breit) bzw. nach oben (schmal)
      if (aspect >= 1) camera.setViewOffset(w, h, w * 0.2, 0, w, h);
      else camera.setViewOffset(w, h, 0, h * 0.2, w, h);
    } else {
      camera.clearViewOffset();
    }
    camera.updateProjectionMatrix();
  }

  function setLayout(next) {
    layout = next;
    placeCamera();
  }

  // --- pro Bild -------------------------------------------------------------------------
  function frameUpdate(dt) {
    if (!character) return;
    clock.time += dt;
    turntable.idle += dt;
    if (turntable.facing) {
      // weich zur Kamera drehen (Winkel 0 = Blick zur Kamera)
      const target = Math.round(turntable.angle / (Math.PI * 2)) * Math.PI * 2;
      turntable.angle += (target - turntable.angle) * Math.min(1, dt * 6);
      if (turntable.idle > L.emotePreview + 0.5) turntable.facing = false;
    } else if (turntable.dragging === null && turntable.idle > L.idleReturn) {
      turntable.angle += L.turntableSpeed * dt;
    }
    view.update(1, dt, Math.PI + turntable.angle);
    const dancing = clock.time < character.emoteUntil;
    applyEmoteMotion(view.root, emoteMotionName, dancing ? clock.time - emoteStart : -1);
    // Podest dreht leicht mit (sieht lebendiger aus)
    podiumTopRing.rotation.y = turntable.angle * 0.5;
  }

  const podiumTopRing = group.getObjectByName('Podest-Ring');

  // --- Vorschau-Bilder ----------------------------------------------------------------------
  // Alle Bilder werden in EIN großes Bild (Atlas) gemalt und einmal asynchron gelesen –
  // so hält die Grafikkarte nie an (kein "GPU stall"), auch nicht bei vielen Skins.
  const thumbCache = new Map();
  const CELL = 160; // Pixel pro Bild (größer malen als gezeigt = glatte Kanten)

  /**
   * Kleine Bilder (data-URL) für Skins oder Spitzhacken aus dem Speicher ('' = noch nicht fertig).
   * Fehlt eins, wird es im Hintergrund gemalt und danach in alle <img data-thumb="art:id"> eingesetzt.
   * @param {'skins'|'pickaxes'} kind
   * @param {object[]} entries  Katalog-Einträge ({ id, data })
   */
  function thumbnails(kind, entries) {
    const out = new Map();
    const todo = entries.filter((e) => !thumbCache.has(`${kind}:${e.id}`));
    if (todo.length) prepareThumbnails([[kind, todo]]).catch((error) => console.error('Vorschau-Bilder:', error));
    for (const e of entries) out.set(e.id, thumbCache.get(`${kind}:${e.id}`) ?? '');
    return out;
  }

  /** Malt alle fehlenden Bilder. @param {[kind, entries][]} groups */
  async function prepareThumbnails(groups) {
    const jobs = [];
    for (const [kind, entries] of groups) {
      for (const e of entries) if (!thumbCache.has(`${kind}:${e.id}`)) jobs.push({ kind, entry: e });
    }
    if (!jobs.length) return;
    for (const job of jobs) thumbCache.set(`${job.kind}:${job.entry.id}`, ''); // nicht doppelt malen
    const cols = Math.ceil(Math.sqrt(jobs.length));
    const rows = Math.ceil(jobs.length / cols);
    const width = cols * CELL;
    const height = rows * CELL;
    const target = new THREE.WebGLRenderTarget(width, height);
    target.texture.colorSpace = THREE.SRGBColorSpace;
    const thumbScene = new THREE.Scene();
    thumbScene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(2, 3, 4);
    thumbScene.add(key);
    const cam = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
    const oldTarget = renderer.getRenderTarget();
    const oldClear = renderer.getClearColor(new THREE.Color());
    const oldAlpha = renderer.getClearAlpha();
    const oldShadows = renderer.shadowMap.enabled;
    renderer.shadowMap.enabled = false;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(target);
    renderer.clear();
    jobs.forEach((job, i) => {
      const { kind, entry } = job;
      let cleanup;
      if (kind === 'skins') {
        const c = new Character({ time: 0 }, { name: 'Bild', skin: entry.id, yaw: Math.PI - 0.35 });
        const v = createCharacterView(c, thumbScene);
        v.update(1, 0, Math.PI - 0.35);
        cam.position.set(0, 1.3, 3.3);
        cam.lookAt(0, 0.98, 0);
        cleanup = () => v.dispose();
      } else {
        const model = createHandMount('pickaxe', createWeaponModel('pickaxe'));
        stylePickaxe(model, entry.data);
        const holder = new THREE.Group();
        holder.add(model);
        // schräg ins Bild legen und mittig ausrichten
        model.rotation.set(0.9, 0.5, -0.7);
        const box = new THREE.Box3().setFromObject(holder);
        const center = box.getCenter(new THREE.Vector3());
        const extent = box.getSize(new THREE.Vector3()).length();
        holder.position.sub(center);
        thumbScene.add(holder);
        cam.position.set(0, 0, extent * 1.9);
        cam.lookAt(0, 0, 0);
        cleanup = () => {
          thumbScene.remove(holder);
          disposeTree(holder);
        };
      }
      // Zelle i: von oben links, WebGL zählt y von unten
      const x = (i % cols) * CELL;
      const y = height - (Math.floor(i / cols) + 1) * CELL;
      target.viewport.set(x, y, CELL, CELL);
      target.scissor.set(x, y, CELL, CELL);
      target.scissorTest = true;
      renderer.setRenderTarget(target);
      renderer.render(thumbScene, cam);
      cleanup();
    });
    renderer.setRenderTarget(oldTarget);
    renderer.setClearColor(oldClear, oldAlpha);
    renderer.shadowMap.enabled = oldShadows;
    const pixels = new Uint8Array(width * height * 4);
    try {
      await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height, pixels);
    } finally {
      target.dispose();
    }
    // Atlas zerschneiden (WebGL liest von unten nach oben → umdrehen)
    const canvas = document.createElement('canvas');
    canvas.width = CELL;
    canvas.height = CELL;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(CELL, CELL);
    jobs.forEach((job, i) => {
      const cx = (i % cols) * CELL;
      const cyTop = Math.floor(i / cols) * CELL; // von oben
      for (let row = 0; row < CELL; row++) {
        const srcRow = height - 1 - (cyTop + row);
        const src = (srcRow * width + cx) * 4;
        image.data.set(pixels.subarray(src, src + CELL * 4), row * CELL * 4);
      }
      ctx.putImageData(image, 0, 0);
      const key = `${job.kind}:${job.entry.id}`;
      const url = canvas.toDataURL('image/png');
      thumbCache.set(key, url);
      // Bilder, die schon im Menü stehen (noch leer), jetzt füllen
      document.querySelectorAll(`img[data-thumb="${CSS.escape(key)}"]`).forEach((img) => {
        img.src = url;
      });
    });
  }

  // --- Sichtbarkeit -------------------------------------------------------------------------
  function setVisible(on) {
    group.visible = !!on;
    if (on) placeCamera();
    else camera.clearViewOffset();
  }

  function dispose() {
    element?.removeEventListener('pointerdown', onDown);
    element?.removeEventListener('pointermove', onMove);
    element?.removeEventListener('pointerup', onUp);
    element?.removeEventListener('pointercancel', onUp);
    view?.dispose();
    if (pickaxeMount) disposeTree(pickaxeMount);
    scene.remove(group);
    for (const d of disposables) d.dispose?.();
  }

  return {
    group,
    get character() {
      return character;
    },
    get view() {
      return view;
    },
    get angle() {
      return turntable.angle;
    },
    get visible() {
      return group.visible;
    },
    focus: new THREE.Vector3(0, 0, 0),
    setSkin,
    setPickaxe,
    playEmote,
    faceCamera,
    setLayout,
    placeCamera,
    frameUpdate,
    thumbnails,
    prepareThumbnails,
    setVisible,
    dispose,
  };
}

// -----------------------------------------------------------------------------
// Kulisse
// -----------------------------------------------------------------------------
function buildScenery(group, lambert, track) {
  const add = (geometry, material, x = 0, y = 0, z = 0, { cast = true, receive = true, name } = {}) => {
    const m = new THREE.Mesh(track(geometry), material);
    m.position.set(x, y, z);
    m.castShadow = cast;
    m.receiveShadow = receive;
    if (name) m.name = name;
    group.add(m);
    return m;
  };

  // --- Podest: dunkler Sockel, weiße Platte, blauer Ring, goldene Kante ---------------------
  add(new THREE.CylinderGeometry(1.55, 1.75, 0.22, 48), lambert('#2B5FA8'), 0, 0.11, 0);
  add(new THREE.CylinderGeometry(1.38, 1.45, 0.16, 48), lambert('#F4FAFF'), 0, 0.3, 0);
  const ring = add(new THREE.TorusGeometry(1.42, 0.05, 8, 64), lambert('#FFC83D', { emissive: '#5A3A00' }), 0, 0.38, 0, { cast: false });
  ring.rotation.x = Math.PI / 2;
  const inner = add(new THREE.CylinderGeometry(1.05, 1.05, 0.05, 48), lambert('#4FB3FF'), 0, 0.39, 0, { cast: false, name: 'Podest-Ring' });
  // Muster auf der Platte: kleine helle Kreise (dreht sich mit)
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const dot = new THREE.Mesh(track(new THREE.CylinderGeometry(0.09, 0.09, 0.02, 12)), lambert('#BFE6FF'));
    dot.position.set(Math.cos(a) * 0.78, 0.035, Math.sin(a) * 0.78);
    inner.add(dot);
  }

  // --- Insel: Gras, Strand, Wasser ------------------------------------------------------------
  add(new THREE.CylinderGeometry(26, 27, 1, 40), lambert('#5DBB4C'), 0, -0.5, -8, { cast: false });
  add(new THREE.CylinderGeometry(29.5, 31, 1, 40), lambert('#E3C47A'), 0, -0.62, -8, { cast: false });
  const water = add(new THREE.CircleGeometry(600, 48), lambert('#3FB7D9'), 0, -0.75, 0, { cast: false });
  water.rotation.x = -Math.PI / 2;
  // ein paar Gras-Hügel hinten
  for (const [x, z, r, h] of [[-15, -24, 7, 2.5], [12, -27, 9, 3.4], [24, -14, 6, 2], [-25, -10, 5, 1.6]]) {
    const hill = add(new THREE.SphereGeometry(r, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), lambert('#55B045'), x, -0.1, z, { cast: false });
    hill.scale.y = h / r;
  }

  // --- Bäume (Kegel-Tannen und runde Laubbäume) ---------------------------------------------
  const trunk = lambert('#8A5A33');
  const pine = lambert('#2F8F46');
  const pineLight = lambert('#3FA556');
  const leaf = lambert('#49B04B');
  const trees = [
    [-7.5, -10, 1.1, 'pine'], [-10, -15, 1.4, 'round'], [8, -11, 1.2, 'pine'], [10.5, -16, 1.5, 'pine'],
    [-13, -17, 1.6, 'pine'], [15, -19, 1.4, 'round'], [3, -18, 1.3, 'pine'], [-4, -22, 1.5, 'round'],
    [19, -8, 1.2, 'pine'], [-18, -5, 1.3, 'round'], [-21, -20, 1.8, 'pine'], [22, -25, 1.7, 'pine'],
  ];
  for (const [x, z, s, kind] of trees) {
    add(new THREE.CylinderGeometry(0.16 * s, 0.22 * s, 1.4 * s, 8), trunk, x, 0.7 * s, z);
    if (kind === 'pine') {
      add(new THREE.ConeGeometry(1.2 * s, 2.0 * s, 8), pine, x, 2.0 * s, z);
      add(new THREE.ConeGeometry(0.9 * s, 1.6 * s, 8), pineLight, x, 2.9 * s, z);
    } else {
      add(new THREE.IcosahedronGeometry(1.25 * s, 1), leaf, x, 2.3 * s, z);
    }
  }

  // --- Felsen -----------------------------------------------------------------------------------
  const rock = lambert('#9AA4AE');
  for (const [x, z, s] of [[-5.5, -7, 0.6], [6.5, -8.5, 0.45], [-12, -12, 0.9], [13, -10, 0.8], [7, -19, 1.1]]) {
    const r = add(new THREE.DodecahedronGeometry(s, 0), rock, x, s * 0.55, z);
    r.rotation.set(x, z, 0.3);
  }

  // --- kleines Holz-Fort hinten links (Wände + Rampe + Boden, wie gebaut) ---------------------------
  const wood = lambert('#C98F55');
  const woodDark = lambert('#A8733F');
  const fort = new THREE.Group();
  fort.position.set(-13, 0, -24);
  fort.rotation.y = 0.45;
  group.add(fort);
  const part = (geometry, material, x, y, z, rx = 0) => {
    const m = new THREE.Mesh(track(geometry), material);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    m.castShadow = true;
    m.receiveShadow = true;
    fort.add(m);
    return m;
  };
  const wallGeo = new THREE.BoxGeometry(4, 4, 0.25);
  part(wallGeo, wood, 0, 2, -2);
  part(wallGeo, woodDark, 0, 2, 2);
  part(new THREE.BoxGeometry(0.25, 4, 4), wood, -2, 2, 0);
  part(new THREE.BoxGeometry(0.25, 4, 4), woodDark, 2, 2, 0);
  part(new THREE.BoxGeometry(4, 0.25, 4), wood, 0, 4, 0);
  part(new THREE.BoxGeometry(4, 0.25, 5.66), woodDark, 4, 2, 0, Math.PI / 4).rotation.set(0, Math.PI / 2, Math.PI / 4);
  part(wallGeo, wood, 0, 6, -2); // zweite Etage, eine Wand

  // --- Wolken ------------------------------------------------------------------------------------
  const cloud = lambert('#FFFFFF', { emissive: '#B8D8F0', fog: false });
  for (const [x, y, z, s] of [[-30, 26, -70, 4], [18, 32, -85, 5], [45, 22, -60, 3.5], [-55, 30, -40, 4.5], [0, 38, -110, 6]]) {
    const c = new THREE.Group();
    c.position.set(x, y, z);
    for (const [dx, dy, r] of [[0, 0, 1], [1.1, -0.2, 0.75], [-1.1, -0.25, 0.7], [0.4, 0.5, 0.65]]) {
      const puff = new THREE.Mesh(track(new THREE.SphereGeometry(r * s, 14, 10)), cloud);
      puff.position.set(dx * s, dy * s, 0);
      c.add(puff);
    }
    group.add(c);
  }
}

function disposeTree(root) {
  root.traverse((obj) => {
    if (obj.geometry && !obj.geometry.userData?.shared) obj.geometry.dispose();
    const m = obj.material;
    // geteilte Materialien aus models.js NICHT entsorgen – nur eigene Kopien (stylePickaxe)
    if (m && obj.userData?.cosmeticOriginal && m !== obj.userData.cosmeticOriginal) m.dispose();
  });
}
