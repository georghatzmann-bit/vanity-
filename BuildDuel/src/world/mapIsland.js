// =============================================================================
// Battle-Royale-Insel (600 x 600 m)
// =============================================================================
// Was es gibt (alles mit Startwert → gleiche Insel bei gleichem seed):
//   - Gelände mit sanften Hügeln (Rauschen), Strand, flaches Wasser rundherum
//     (begehbar bis zur unsichtbaren Wand), dahinter tiefes Meer
//   - ein Fluss quer über die Insel (flach, man kann hindurchlaufen) mit zwei Brücken
//   - eine Wüstenstadt "Sandkrug" (Sand-Boden, begehbare Häuser, manche mit 2 Stockwerken)
//   - ein Weiler und ein Bauernhof (Holzhäuser mit Spitzdach, Felder, Metallzäune)
//   - ein Wald (Bäume = Holz), Felsen (Stein), Autos und Zäune (Metall)
//   - Plätze für Kisten (chestSpots) und Boden-Loot (floorLootSpots)
//   - Namen der Gegenden (areaAt) – nur zur Orientierung
//
// Leistung: Gelände = 1 Mesh, alle Häuser/Mauern = 1 Mesh (staticBatch.js),
// Bäume/Felsen/Autos/Zäune = wenige InstancedMeshes (props.js), Wasser = 2 Flächen.
// Das Gelände-Mesh und heightAt benutzen dieselben Dreiecke (terrain.js) – man
// steht genau auf dem, was man sieht.
//
// Koordinaten: Mitte der Insel = (0, 0), Norden = −Z. Wasser-Oberfläche bei y = seaLevel (0).
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createRng } from '../util/random.js';
import { createMapBuilder } from './mapBuilder.js';
import { createStaticBatch, createBatchTileTexture } from './staticBatch.js';
import { createPropSet } from './props.js';
import { buildHouse } from './houses.js';
import { addBarrierRing } from './mapArena.js';
import { findSpawnPoints } from './spawnPoints.js';
import {
  createNoise, createHeightfield, sampleHeights, limitSlopes, buildTerrainGeometry,
  createGroundDetailTexture, smoothstep,
} from './terrain.js';

const DESERT_WALLS = ['#F6C177', '#F2A65A', '#EFD3A1', '#F7DFB0', '#E9B384', '#F4CE8E', '#FADCB5', '#F3B5A0'];
const DESERT_TRIM = ['#C47F48', '#B5683A', '#D9955B', '#A86B45'];
const DESERT_ROOF = ['#D4A373', '#C9935F', '#DDB07F'];
const ACCENTS = ['#E85D75', '#3EC1D3', '#FFC93C', '#7A5CFA', '#2ECC71', '#FF8C42'];
const WOOD_WALLS = ['#D19A66', '#C68B59', '#DDA878'];
const FLOORS = ['#E8C9A0', '#E3B98C', '#EAD2AE'];
const WOOD_TRIM = ['#8B5A3C', '#7A4E33'];
const WOOD_ROOFS = ['#C0504D', '#B5443F', '#4E7FB8', '#5C8F4A'];

/**
 * @param {object} game
 * @param {object} [spec] { seed, size }
 * @returns {object} Karte: { id, size, center, terrain, isLand, isWater, heightAt, areaAt, areas, chestSpots,
 *   floorLootSpots, houses, spawnPoints(count, options), jumpPath(rng), playBounds, buildBounds, props, … }
 */
export function createIslandMap(game, spec = {}) {
  const started = now();
  const cfg = CONFIG.maps.island;
  const size = spec.size ?? CONFIG.modes.battleRoyale.islandSize;
  const half = size / 2;
  const seed = spec.seed ?? cfg.seed;
  const rng = createRng(seed * 9973 + 17);
  const noise = createNoise(seed);
  const visual = !game.headless && typeof document !== 'undefined';
  const builder = createMapBuilder(game, 'Insel');
  const sea = cfg.seaLevel;
  const barrierHalf = half + cfg.barrierMargin;

  // ---------------------------------------------------------------------------
  // 1. Höhen
  // ---------------------------------------------------------------------------
  const R = cfg.coastRadius;
  const P = cfg.coastShape;
  const riverPhase = rng() * Math.PI * 2;
  const river = cfg.river;
  const riverX = (z) => river.x + river.meander * Math.sin((z / river.wavelength) * Math.PI * 2 + riverPhase) +
    river.meander * 0.25 * Math.sin((z / river.wavelength) * Math.PI * 5.3 + riverPhase * 2);
  const riverDist = (x, z) => {
    const e = 1;
    const slope = (riverX(z + e) - riverX(z - e)) / (2 * e);
    return Math.abs(x - riverX(z)) / Math.sqrt(1 + slope * slope);
  };
  // Küste: 0 = Küstenlinie, < 1 an Land (Anteil des Radius), > 1 im Meer
  const coastNorm = (x, z) => {
    const ax = Math.abs(x) / R;
    const az = Math.abs(z) / R;
    const r = Math.pow(Math.pow(ax, P) + Math.pow(az, P), 1 / P);
    return r / (1 + cfg.coastNoise * noise.fbm(x / 95 + 31.7, z / 95 - 12.1, 3));
  };
  const town = cfg.town;
  const farm = cfg.farm;
  const fh = farm.fieldSize / 2;
  const flats = []; // { x, z, r, blend, h } – flache Plätze (Häuser, Felder)

  function seaHeight(x, z) {
    const s = Math.max(Math.abs(x), Math.abs(z));
    const deep = smoothstep(barrierHalf + 4, barrierHalf + 34, s);
    return sea - cfg.shelfDepth - (cfg.seabedDepth - cfg.shelfDepth) * deep;
  }

  function hillMask(x, z) {
    // Sonnenhügel (Südwesten) und etwas überall
    const sun = cfg.areas.find((a) => a.name === 'Sonnenhügel');
    const d = sun ? Math.hypot(x - sun.x, z - sun.z) : 1e9;
    const boost = sun ? 1 - smoothstep(sun.radius * 0.4, sun.radius * 1.4, d) : 0;
    const wide = 0.5 + 0.5 * noise.fbm(x / 330 + 5.2, z / 330 + 8.9, 2);
    return Math.min(1, 0.25 + 0.55 * wide + 0.75 * boost);
  }

  function baseHeight(x, z) {
    const r = coastNorm(x, z);
    const land = smoothstep(1.0, 1.0 - cfg.beachWidth * 2.2, r);
    const hillNoise = Math.max(0, noise.fbm(x / cfg.hillScale, z / cfg.hillScale, 4) * 0.5 + 0.5);
    let inland = cfg.landHeight + cfg.hillHeight * Math.pow(hillNoise, 1.35) * hillMask(x, z) +
      cfg.rollingHeight * noise.fbm(x / 55 + 3.3, z / 55 - 7.7, 2);
    // Felsenkamm im Norden: langer Rücken
    const ridge = cfg.areas.find((a) => a.name === 'Felsenkamm');
    if (ridge) inland += 9 * Math.exp(-(((x - ridge.x) / 85) ** 2) - (((z - ridge.z) / 26) ** 2));
    inland = Math.max(cfg.landHeight * 0.55, inland) * smoothstep(1.0, 0.75, r) + cfg.landHeight * 0.55 * (1 - smoothstep(1.0, 0.75, r));
    let h = seaHeight(x, z) + (inland - seaHeight(x, z)) * land;
    // Stadt: flache Hochebene
    const dt = Math.hypot(x - town.x, z - town.z);
    const wt = 1 - smoothstep(town.radius, town.radius + 30, dt);
    h += (town.height - h) * wt;
    return h;
  }

  function heightFn(x, z) {
    let h = baseHeight(x, z);
    for (const f of flats) {
      const d = Math.hypot(x - f.x, z - f.z);
      if (d > f.r + f.blend) continue;
      const w = 1 - smoothstep(f.r, f.r + f.blend, d);
      h += (f.h - h) * w;
    }
    // Fluss: Bett unter dem Wasser
    const dr = riverDist(x, z);
    const wr = 1 - smoothstep(river.width / 2, river.width / 2 + river.bank, dr);
    if (wr > 0) h += (sea - river.depth - h) * wr;
    return h;
  }

  // Plätze für Weiler und Hof vorab flach machen (Höhe vom Gelände ohne Plätze)
  const hamletHouses = planGroupHouses(cfg.hamlet.x, cfg.hamlet.z, cfg.hamlet.houses, 22, rng);
  const farmHouses = planGroupHouses(cfg.farm.x, cfg.farm.z, cfg.farm.houses, 26, rng);
  for (const h of [...hamletHouses, ...farmHouses]) {
    h.y = Math.max(sea + 1.2, baseHeight(h.cx, h.cz));
    flats.push({ x: h.cx, z: h.cz, r: Math.hypot(h.width, h.depth) / 2 + 2.5, blend: 14, h: h.y });
  }
  const farmGround = Math.max(sea + 1.2, baseHeight(cfg.farm.x, cfg.farm.z));
  flats.unshift({ x: cfg.farm.x, z: cfg.farm.z, r: cfg.farm.fieldSize * 0.55, blend: 30, h: farmGround });

  const cell = cfg.terrainCell;
  const extent = Math.ceil(cfg.terrainExtent / cell) * cell;
  const count = Math.round((2 * extent) / cell) + 1;
  const heights = sampleHeights(-extent, -extent, cell, count, count, heightFn);
  // Hänge begrenzen (die Stadt bleibt, wie sie ist)
  // je Achse höchstens maxRise → jedes Dreieck ist höchstens maxSlopeDeg steil (Wurzel 2 für die Diagonale)
  const maxRise = (cell * Math.tan((cfg.maxSlopeDeg * Math.PI) / 180)) / Math.SQRT2;
  limitSlopes(heights, count, count, maxRise, 40, (ix, iz) => {
    const x = -extent + ix * cell;
    const z = -extent + iz * cell;
    return Math.hypot(x - town.x, z - town.z) < town.radius + 2;
  });
  const terrain = createHeightfield({ minX: -extent, minZ: -extent, cell, countX: count, countZ: count, heights, outsideHeight: sea - cfg.seabedDepth });
  game.world.setTerrain(terrain);
  const heightAt = (x, z) => terrain.heightAt(x, z);
  const isLand = (x, z) => heightAt(x, z) > sea + 0.25;
  const isWater = (x, z) => !isLand(x, z);

  // ---------------------------------------------------------------------------
  // 2. Platz-Verwaltung (nichts überlappt)
  // ---------------------------------------------------------------------------
  const occupied = []; // { minX, maxX, minZ, maxZ }
  const occupy = (x, z, r) => occupied.push({ minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r });
  const occupyRect = (b, m = 0) => occupied.push({ minX: b.minX - m, maxX: b.maxX + m, minZ: b.minZ - m, maxZ: b.maxZ + m });
  const isFree = (x, z, r) => {
    for (const o of occupied) {
      if (x + r > o.minX && x - r < o.maxX && z + r > o.minZ && z - r < o.maxZ) return false;
    }
    return true;
  };
  const nearRiver = (x, z, m) => riverDist(x, z) < river.width / 2 + river.bank * 0.6 + m;
  const inTown = (x, z, m = 0) => Math.hypot(x - town.x, z - town.z) < town.radius + m;
  const slopeAt = (x, z) => terrain.slopeAt(x, z);

  // ---------------------------------------------------------------------------
  // 3. Häuser, Mauern, Brücken (ein Mesh)
  // ---------------------------------------------------------------------------
  const tileTexture = visual ? createBatchTileTexture() : null;
  const batch = createStaticBatch(game, builder, { name: 'Häuser und Mauern', texture: tileTexture });
  const houses = [];
  const chestCandidates = [];
  const lootCandidates = [];

  // Wüstenstadt: Grundstücke auf einem Raster um einen Marktplatz
  const lots = [];
  const lotStep = 16;
  for (let gx = -4; gx <= 4; gx++) {
    for (let gz = -4; gz <= 4; gz++) {
      const x = town.x + gx * lotStep;
      const z = town.z + gz * lotStep;
      const d = Math.hypot(x - town.x, z - town.z);
      if (d < 14 || d > town.radius - 9) continue; // Marktplatz frei, nicht am Rand
      lots.push({ x, z, gx, gz, d });
    }
  }
  shuffle(lots, rng);
  lots.sort((a, b) => a.d - b.d + (rng() - 0.5) * 18);
  for (const lot of lots.slice(0, town.houses)) {
    const twoFloors = rng() < town.twoFloorChance;
    const width = twoFloors ? pick([8, 10, 12], rng) : pick([8, 10, 12], rng);
    const depth = pick([8, 10], rng);
    // Tür zeigt zum Marktplatz (ungefähr)
    const toCenterX = town.x - lot.x;
    const toCenterZ = town.z - lot.z;
    const rotation = Math.abs(toCenterX) > Math.abs(toCenterZ) ? (toCenterX > 0 ? 1 : 3) : (toCenterZ > 0 ? 0 : 2);
    const house = buildHouse(batch, {
      cx: lot.x, cz: lot.z, y: town.height, width, depth, floors: twoFloors ? 2 : 1, rotation, style: 'desert',
      colors: { wall: pick(DESERT_WALLS, rng), trim: pick(DESERT_TRIM, rng), roof: pick(DESERT_ROOF, rng), accent: pick(ACCENTS, rng), floor: pick(FLOORS, rng) },
    });
    house.area = 'Sandkrug';
    addHouse(house);
  }
  // Marktplatz: Brunnen, Stände, Kakteen, Fässer
  buildMarket(batch, town, rng, occupy);

  for (const h of hamletHouses) addHouse(buildWoodHouse(h, 'Kiefernruh'));
  for (const h of farmHouses) addHouse(buildWoodHouse(h, 'Kornfeldhof'));

  function buildWoodHouse(h, area) {
    const house = buildHouse(batch, {
      cx: h.cx, cz: h.cz, y: h.y, width: h.width, depth: h.depth, floors: h.floors, rotation: h.rotation, style: 'wood',
      colors: { wall: pick(WOOD_WALLS, rng), trim: pick(WOOD_TRIM, rng), roof: pick(WOOD_ROOFS, rng), stairs: '#A8774F', floor: '#D9A066' },
    });
    house.area = area;
    return house;
  }

  function addHouse(house) {
    houses.push(house);
    occupyRect(house.bounds, 2.5);
    for (const s of house.chestSpots) chestCandidates.push({ ...s, area: house.area, indoor: true });
    for (const s of house.lootSpots) lootCandidates.push({ ...s, area: house.area, indoor: true });
  }

  // Brücken über den Fluss
  const bridges = [];
  for (const bz of [-24, 118]) {
    const bridge = buildBridge(batch, bz);
    if (bridge) bridges.push(bridge);
  }

  function buildBridge(batch, z) {
    const xc = riverX(z);
    // Ufer-Höhe links und rechts suchen
    const bankL = heightAt(xc - river.width / 2 - river.bank - 2, z);
    const bankR = heightAt(xc + river.width / 2 + river.bank + 2, z);
    const top = Math.min(bankL, bankR);
    if (!(top > sea + 0.6)) return null;
    // Brücke endet dort, wo das Gelände die Brücken-Höhe erreicht
    let x0 = xc;
    while (x0 > xc - 60 && heightAt(x0, z) < top - 0.05) x0 -= 0.5;
    let x1 = xc;
    while (x1 < xc + 60 && heightAt(x1, z) < top - 0.05) x1 += 0.5;
    const w = 3.2;
    const wood = '#B07A4A';
    const dark = '#7E5232';
    batch.addBox({ x: x0, y: top - 0.35, z: z - w / 2 }, { x: x1, y: top, z: z + w / 2 }, { color: wood, data: { kind: 'static' } });
    batch.addBox({ x: x0, y: top, z: z - w / 2 }, { x: x1, y: top + 0.9, z: z - w / 2 + 0.15 }, { color: dark, data: { kind: 'static' } });
    batch.addBox({ x: x0, y: top, z: z + w / 2 - 0.15 }, { x: x1, y: top + 0.9, z: z + w / 2 }, { color: dark, data: { kind: 'static' } });
    for (let x = x0 + 2; x < x1 - 1; x += 4) {
      for (const side of [-1, 1]) {
        const pz = z + side * (w / 2 - 0.2);
        batch.addBox({ x: x - 0.15, y: sea - river.depth - 0.2, z: pz - 0.15 }, { x: x + 0.15, y: top - 0.35, z: pz + 0.15 }, { color: dark, data: { kind: 'static' } });
      }
    }
    occupyRect({ minX: x0, maxX: x1, minZ: z - w / 2, maxZ: z + w / 2 }, 1.5);
    return { x0, x1, z, top };
  }

  // ---------------------------------------------------------------------------
  // 4. Sammel-Objekte: Bäume, Felsen, Autos, Zäune
  // ---------------------------------------------------------------------------
  const props = createPropSet(game, builder);
  const forest = cfg.forest;
  const okGround = (x, z, r, opts = {}) =>
    Math.max(Math.abs(x), Math.abs(z)) < half - 6 && isLand(x, z) && heightAt(x, z) > sea + 0.9 &&
    !nearRiver(x, z, opts.riverMargin ?? 2) && isFree(x, z, r) && slopeAt(x, z) < (opts.maxSlope ?? 0.6) &&
    (opts.allowTown || !inTown(x, z, 6));

  // Wald
  let placedForest = 0;
  for (let t = 0; t < forest.trees * 12 && placedForest < forest.trees; t++) {
    const a = rng() * Math.PI * 2;
    const d = Math.sqrt(rng()) * forest.radius;
    const x = forest.x + Math.cos(a) * d;
    const z = forest.z + Math.sin(a) * d * 0.85;
    if (!okGround(x, z, 2.2)) continue;
    props.addTree(x, heightAt(x, z), z, { kind: rng() < 0.72 ? 'pine' : 'round', scale: 0.85 + rng() * 0.55, yaw: rng() * 6.28, colorIndex: Math.floor(rng() * 4) });
    occupy(x, z, 1.4);
    placedForest++;
  }
  // Einzelne Bäume überall (nicht in der Stadt, nicht auf den Feldern)
  let placedTrees = 0;
  for (let t = 0; t < cfg.scatteredTrees * 30 && placedTrees < cfg.scatteredTrees; t++) {
    const x = (rng() * 2 - 1) * (half - 10);
    const z = (rng() * 2 - 1) * (half - 10);
    if (inFarm(x, z, 8) || !okGround(x, z, 3)) continue;
    props.addTree(x, heightAt(x, z), z, { kind: rng() < 0.35 ? 'pine' : 'round', scale: 0.9 + rng() * 0.5, yaw: rng() * 6.28, colorIndex: Math.floor(rng() * 4) });
    occupy(x, z, 1.6);
    placedTrees++;
  }
  // Felsen: viele am Felsenkamm, ein paar auf den Hügeln und überall
  const ridge = cfg.areas.find((a) => a.name === 'Felsenkamm');
  let placedRocks = 0;
  for (let t = 0; t < cfg.rocks * 40 && placedRocks < cfg.rocks; t++) {
    let x;
    let z;
    if (ridge && placedRocks < cfg.rocks * 0.45) {
      x = ridge.x + (rng() * 2 - 1) * ridge.radius * 1.4;
      z = ridge.z + (rng() * 2 - 1) * ridge.radius * 0.5;
    } else {
      x = (rng() * 2 - 1) * (half - 12);
      z = (rng() * 2 - 1) * (half - 12);
    }
    if (inFarm(x, z, 6) || !okGround(x, z, 2.6, { maxSlope: 0.75 })) continue;
    const scale = 0.9 + rng() * 1.1;
    props.addRock(x, heightAt(x, z) - 0.15, z, { scale, yaw: rng() * 6.28, stretch: { x: 1.1 + rng() * 0.5, y: 0.7 + rng() * 0.4, z: 0.9 + rng() * 0.4 } });
    occupy(x, z, 1.6 * scale);
    placedRocks++;
  }
  // Autos: in der Stadt an den Straßen, am Hof, am Weiler, ein paar an Wegen
  const carColors = CONFIG.maps.props.colors.cars;
  let placedCars = 0;
  const carSpots = [];
  for (let i = 0; i < 80 && carSpots.length < Math.ceil(cfg.cars * 0.55); i++) {
    const lot = lots[i % lots.length];
    const x = lot.x + (rng() < 0.5 ? -1 : 1) * 8 + (rng() - 0.5) * 2;
    const z = lot.z + (rng() - 0.5) * 6;
    carSpots.push({ x, z, yaw: rng() < 0.5 ? 0 : Math.PI / 2, town: true });
  }
  for (const g of [cfg.farm, cfg.hamlet]) {
    for (let i = 0; i < 3; i++) carSpots.push({ x: g.x + (rng() - 0.5) * 40, z: g.z + (rng() - 0.5) * 40, yaw: rng() < 0.5 ? 0 : Math.PI / 2 });
  }
  for (let i = 0; i < 40; i++) carSpots.push({ x: (rng() * 2 - 1) * (half - 30), z: (rng() * 2 - 1) * (half - 30), yaw: rng() < 0.5 ? 0 : Math.PI / 2 });
  for (const s of carSpots) {
    if (placedCars >= cfg.cars) break;
    if (!okGround(s.x, s.z, 3, { allowTown: !!s.town, maxSlope: 0.25 })) continue;
    props.addCar(s.x, heightAt(s.x, s.z), s.z, { yaw: s.yaw, color: carColors[placedCars % carColors.length] });
    occupy(s.x, s.z, 3);
    placedCars++;
  }
  // Metallzäune: um die Felder des Hofs und ein paar Stücke in der Stadt
  const fenceRuns = [
    [farm.x - fh, farm.z - fh, farm.x - 8, farm.z - fh],
    [farm.x + 8, farm.z - fh, farm.x + fh, farm.z - fh],
    [farm.x - fh, farm.z - fh, farm.x - fh, farm.z - 4],
    [farm.x + fh, farm.z - fh, farm.x + fh, farm.z - 4],
    [farm.x - fh, farm.z + 8, farm.x - fh, farm.z + fh - 8],
    [farm.x + fh, farm.z + 8, farm.x + fh, farm.z + fh - 8],
    [town.x - 40, town.z - town.radius - 8, town.x - 12, town.z - town.radius - 8],
    [town.x + 12, town.z + town.radius + 8, town.x + 40, town.z + town.radius + 8],
  ];
  let fencePieces = 0;
  for (const [x0, z0, x1, z1] of fenceRuns) {
    if (fencePieces >= cfg.fences * 3) break;
    // nur dort, wo Land ist und nichts im Weg steht
    const mx = (x0 + x1) / 2;
    const mz = (z0 + z1) / 2;
    if (!isLand(x0, z0) || !isLand(x1, z1) || !isLand(mx, mz)) continue;
    const made = props.addFence(x0, z0, x1, z1, 0, { heightAt });
    fencePieces += made.length;
  }
  props.finish();

  // ---------------------------------------------------------------------------
  // 5. Loot-Plätze
  // ---------------------------------------------------------------------------
  // draußen: neben Bäumen/Felsen, auf Feldern, am Fluss, am Strand
  const outdoor = [];
  for (let t = 0; t < 3000 && outdoor.length < 260; t++) {
    const x = (rng() * 2 - 1) * (half - 14);
    const z = (rng() * 2 - 1) * (half - 14);
    if (!isLand(x, z) || heightAt(x, z) < sea + 0.5 || slopeAt(x, z) > 0.45 || !isFree(x, z, 1.2)) continue;
    outdoor.push({ x, y: heightAt(x, z), z, yaw: rng() * 6.28, area: areaAt(x, z), indoor: false });
  }
  // Kisten: zuerst in Häusern (gemischt), dann draußen (am liebsten im Wald / an Felsen)
  shuffle(chestCandidates, rng);
  const chestSpots = [];
  const chestIndoor = Math.min(chestCandidates.length, Math.round(cfg.chests * 0.62));
  for (let i = 0; i < chestIndoor; i++) chestSpots.push(chestCandidates[i]);
  for (const s of outdoor) {
    if (chestSpots.length >= cfg.chests) break;
    if (chestSpots.some((c) => Math.hypot(c.x - s.x, c.z - s.z) < 22)) continue;
    chestSpots.push(s);
  }
  // Boden-Loot: übrige Haus-Plätze + draußen
  const floorLootSpots = [];
  for (const s of lootCandidates) floorLootSpots.push(s);
  for (const s of chestCandidates.slice(chestIndoor)) floorLootSpots.push(s);
  for (const s of outdoor) {
    if (floorLootSpots.length >= cfg.floorLoot) break;
    if (chestSpots.includes(s)) continue;
    if (floorLootSpots.some((c) => Math.hypot(c.x - s.x, c.z - s.z) < 9)) continue;
    floorLootSpots.push(s);
  }
  floorLootSpots.length = Math.min(floorLootSpots.length, cfg.floorLoot);

  // ---------------------------------------------------------------------------
  // 6. Unsichtbare Wand rund um die Insel (auch im Wasser und in der Luft)
  // ---------------------------------------------------------------------------
  addBarrierRing(game, builder, barrierHalf, 2, -30, 600, -30);

  // ---------------------------------------------------------------------------
  // 7. Grafik: Gelände, Wasser, Meeresboden, Nebel
  // ---------------------------------------------------------------------------
  let restoreView = null;
  const waterAnim = { texture: null, time: 0 };
  if (visual) {
    batch.finish();
    buildVisuals();
    restoreView = applyFog(game, cfg);
  } else {
    batch.finish();
  }

  function buildVisuals() {
    const colors = CONFIG.visuals.colors;
    const grass = new THREE.Color(colors.grass);
    const grassLight = new THREE.Color('#79CD5E');
    const grassDark = new THREE.Color('#47A23F');
    const forestFloor = new THREE.Color('#3F9640');
    const desert = new THREE.Color(colors.desert);
    const desertLight = new THREE.Color('#EED49A');
    const sand = new THREE.Color('#EDDCA6');
    const wetSand = new THREE.Color('#C9B27A');
    const shelf = new THREE.Color('#E4D6A6');
    const deep = new THREE.Color('#2F8FA8');
    const rock = new THREE.Color('#A3A39A');
    const cropA = new THREE.Color('#D9CB5C');
    const cropB = new THREE.Color('#8CC24C');
    const tmp = new THREE.Color();
    const colorFn = (x, z, h, out) => {
      if (h < sea - 0.05) {
        // unter Wasser: heller Sand, nach außen tiefer und blauer
        const depth = Math.min(1, (sea - h) / cfg.seabedDepth);
        out.copy(shelf).lerp(wetSand, Math.min(1, (sea - h) * 0.8)).lerp(deep, Math.pow(depth, 0.6));
        return;
      }
      const n = noise.noise(x / 9 + 50, z / 9 - 20);
      const n2 = noise.noise(x / 31 - 4, z / 31 + 9);
      out.copy(grass).lerp(n2 > 0 ? grassLight : grassDark, Math.abs(n2) * 0.55);
      // Wald-Boden dunkler
      const df = Math.hypot((x - forest.x) / forest.radius, (z - forest.z) / (forest.radius * 0.85));
      if (df < 1.15) out.lerp(forestFloor, (1 - smoothstep(0.7, 1.15, df)) * 0.6);
      // Hügel oben etwas gelblicher
      if (h > 8) out.lerp(tmp.set('#9BCB55'), Math.min(0.5, (h - 8) / 20));
      // Felder: Streifen
      if (inFarm(x, z, 0) && !houses.some((hs) => hs.area === 'Kornfeldhof' && Math.hypot(hs.cx - x, hs.cz - z) < 12)) {
        const stripe = Math.floor((x - farm.x) / 4) % 2 === 0;
        out.copy(stripe ? cropA : cropB).lerp(tmp.set('#B8A050'), Math.max(0, n) * 0.15);
      }
      // Stadt: Wüstensand
      const dt = Math.hypot(x - town.x, z - town.z);
      const wd = 1 - smoothstep(town.radius + 6, town.radius + 26, dt + n * 6);
      if (wd > 0) out.lerp(desert, wd).lerp(desertLight, wd * Math.max(0, n) * 0.5);
      // steile Hänge: Fels
      const slope = slopeAt(x, z);
      if (slope > 0.45) out.lerp(rock, Math.min(1, (slope - 0.45) * 2.5));
      // Strand und Ufer
      const beach = 1 - smoothstep(sea + 0.7, sea + 1.6, h + n * 0.3);
      if (beach > 0) out.lerp(sand, beach);
      if (h < sea + 0.25) out.lerp(wetSand, 0.6);
    };
    const geometry = buildTerrainGeometry(terrain, colorFn);
    const groundTexture = createGroundDetailTexture(CONFIG, game.renderer);
    const groundMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, map: groundTexture });
    const ground = new THREE.Mesh(geometry, groundMaterial);
    ground.name = 'Gelände';
    ground.receiveShadow = true;
    ground.castShadow = false;
    builder.addObject(ground);

    // Meeresboden weit draußen (Gelände-Rand verschwindet darin)
    const bedGeometry = new THREE.PlaneGeometry(6000, 6000);
    bedGeometry.rotateX(-Math.PI / 2);
    const bed = new THREE.Mesh(bedGeometry, new THREE.MeshBasicMaterial({ color: deep.clone() }));
    bed.position.y = sea - cfg.seabedDepth - 0.05;
    bed.name = 'Meeresboden';
    builder.addObject(bed);

    // Wasser: türkis, leicht durchsichtig, kleine Glanzlichter, Wellen-Muster wandert
    const waterTexture = createWaterTexture();
    waterTexture.repeat.set(6000 / 24, 6000 / 24);
    const waterGeometry = new THREE.PlaneGeometry(6000, 6000);
    waterGeometry.rotateX(-Math.PI / 2);
    const waterMaterial = new THREE.MeshPhongMaterial({
      color: new THREE.Color(colors.water),
      map: waterTexture,
      specular: new THREE.Color('#BFEFFF'),
      shininess: 70,
      transparent: true,
      opacity: 0.8,
    });
    const water = new THREE.Mesh(waterGeometry, waterMaterial);
    water.name = 'Wasser';
    water.position.y = sea;
    water.renderOrder = 1;
    builder.addObject(water);
    waterAnim.texture = waterTexture;
  }
  function inFarm(x, z, m) {
    return Math.abs(x - farm.x) < fh + m && Math.abs(z - farm.z) < fh + m;
  }

  function areaAt(x, z) {
    let best = null;
    let bestD = Infinity;
    for (const a of cfg.areas) {
      const d = Math.hypot(x - a.x, z - a.z) / a.radius;
      if (d < 1 && d < bestD) {
        best = a.name;
        bestD = d;
      }
    }
    return best;
  }

  const playBounds = { minX: -barrierHalf + 1, maxX: barrierHalf - 1, minZ: -barrierHalf + 1, maxZ: barrierHalf - 1 };
  const generationMs = now() - started;

  const map = {
    ...builder,
    id: 'island',
    size,
    seed,
    center: { x: 0, z: 0 },
    terrain,
    seaLevel: sea,
    houses,
    bridges,
    props,
    areas: cfg.areas,
    chestSpots,
    floorLootSpots,
    playBounds,
    generationMs,
    buildBounds: { minX: -barrierHalf, maxX: barrierHalf, minZ: -barrierHalf, maxZ: barrierHalf, maxLevel: cfg.maxBuildLevel },
    heightAt,
    isLand,
    isWater,
    areaAt,
    riverX,
    /** Liegt (x, z) innerhalb der unsichtbaren Wand? */
    contains(x, z, margin = 0) {
      return Math.abs(x) <= barrierHalf - margin && Math.abs(z) <= barrierHalf - margin;
    },
    /** Zufällige Startpunkte an Land (mit Abstand, nicht in Häusern/Objekten). */
    spawnPoints(count, options = {}) {
      const points = findSpawnPoints(game, count, {
        rng: options.rng ?? game.rng,
        bounds: options.bounds ?? { minX: -half + 20, maxX: half - 20, minZ: -half + 20, maxZ: half - 20 },
        minDistance: options.minDistance ?? 60,
        isValid: (x, z, y) => y > sea + 0.6 && !nearRiver(x, z, 1),
        ...options,
      });
      return points.map((p) => ({ ...p, yaw: Math.atan2(p.x, p.z) }));
    },
    /**
     * Flug-Linie des Absprung-Fahrzeugs: gerade über die Insel (Zufall), von weit vor
     * dem einen Rand bis weit hinter den anderen. → { start, end, dir } (THREE.Vector3)
     */
    jumpPath(pathRng = game.rng, height = CONFIG.modes.battleRoyale.jumpVehicleHeight) {
      const sd = CONFIG.skydive;
      const angle = pathRng() * Math.PI * 2;
      const dir = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const side = new THREE.Vector3(-dir.z, 0, dir.x);
      const offset = (pathRng() * 2 - 1) * sd.vehiclePathOffset * half;
      const reach = half * Math.SQRT2 + sd.vehicleStartOffset;
      const start = new THREE.Vector3().addScaledVector(side, offset).addScaledVector(dir, -reach);
      const end = new THREE.Vector3().addScaledVector(side, offset).addScaledVector(dir, reach);
      start.y = height;
      end.y = height;
      return { start, end, dir };
    },
    frameUpdate(dt) {
      builder.frameUpdate(dt);
      if (waterAnim.texture) {
        waterAnim.time += dt ?? 0;
        waterAnim.texture.offset.set(Math.sin(waterAnim.time * 0.05) * 0.5, waterAnim.time * 0.012);
      }
    },
    dispose() {
      restoreView?.();
      props.dispose();
      tileTexture?.dispose();
      builder.dispose();
      game.world.setTerrain(null);
    },
  };
  return map;

  // --- Hilfen (Gruppen-Häuser) ---------------------------------------------------------------
  function planGroupHouses(cx, cz, n, spread, r) {
    const list = [];
    for (let i = 0; i < n; i++) {
      const a = (i / Math.max(1, n)) * Math.PI * 2 + r() * 0.6;
      const d = n > 1 ? spread * (0.6 + r() * 0.4) : 0;
      const width = pick([8, 10], r);
      const depth = pick([8, 10], r);
      list.push({
        cx: Math.round((cx + Math.cos(a) * d) / 2) * 2,
        cz: Math.round((cz + Math.sin(a) * d) / 2) * 2,
        width,
        depth,
        floors: r() < 0.5 ? 2 : 1,
        rotation: Math.floor(r() * 4),
        y: 0,
      });
    }
    return list;
  }
}

// Marktplatz der Wüstenstadt: Brunnen, Marktstände mit bunten Dächern, Kakteen, Fässer
function buildMarket(batch, town, rng, occupy) {
  const y = town.height;
  const x = town.x;
  const z = town.z;
  const stone = '#CDB59A';
  // Brunnen
  batch.addBox({ x: x - 2, y, z: z - 2 }, { x: x + 2, y: y + 0.9, z: z - 1.6 }, { color: stone });
  batch.addBox({ x: x - 2, y, z: z + 1.6 }, { x: x + 2, y: y + 0.9, z: z + 2 }, { color: stone });
  batch.addBox({ x: x - 2, y, z: z - 1.6 }, { x: x - 1.6, y: y + 0.9, z: z + 1.6 }, { color: stone });
  batch.addBox({ x: x + 1.6, y, z: z - 1.6 }, { x: x + 2, y: y + 0.9, z: z + 1.6 }, { color: stone });
  batch.addBox({ x: x - 1.6, y, z: z - 1.6 }, { x: x + 1.6, y: y + 0.45, z: z + 1.6 }, { color: '#3FB7D9', collide: true });
  batch.addBox({ x: x - 0.2, y, z: z - 0.2 }, { x: x + 0.2, y: y + 2.6, z: z + 0.2 }, { color: stone });
  occupy(x, z, 3);
  // Marktstände
  const stalls = [[-8, -6], [8, -6], [-8, 7], [8, 7]];
  for (const [dx, dz] of stalls) {
    const sx = x + dx;
    const sz = z + dz;
    const roof = ACCENTS[Math.floor(rng() * ACCENTS.length)];
    batch.addBox({ x: sx - 1.6, y, z: sz - 0.6 }, { x: sx + 1.6, y: y + 1.0, z: sz + 0.6 }, { color: '#B9875F' });
    for (const px of [-1.5, 1.5]) {
      for (const pz of [-0.9, 0.9]) {
        batch.addBox({ x: sx + px - 0.06, y, z: sz + pz - 0.06 }, { x: sx + px + 0.06, y: y + 2.5, z: sz + pz + 0.06 }, { color: '#8B5A3C' });
      }
    }
    batch.addBox({ x: sx - 1.9, y: y + 2.5, z: sz - 1.2 }, { x: sx + 1.9, y: y + 2.65, z: sz + 1.2 }, { color: roof });
    occupy(sx, sz, 2.4);
  }
  // Kakteen und Fässer am Rand des Platzes
  for (let i = 0; i < 10; i++) {
    const a = rng() * Math.PI * 2;
    const d = 11 + rng() * 3;
    const px = x + Math.cos(a) * d;
    const pz = z + Math.sin(a) * d;
    if (rng() < 0.5) {
      const hgt = 1.6 + rng() * 1.2;
      batch.addBox({ x: px - 0.25, y, z: pz - 0.25 }, { x: px + 0.25, y: y + hgt, z: pz + 0.25 }, { color: '#4E9A4A' });
      batch.addBox({ x: px + 0.25, y: y + hgt * 0.5, z: pz - 0.15 }, { x: px + 0.7, y: y + hgt * 0.5 + 0.3, z: pz + 0.15 }, { color: '#4E9A4A' });
      batch.addBox({ x: px + 0.45, y: y + hgt * 0.5 + 0.3, z: pz - 0.15 }, { x: px + 0.7, y: y + hgt * 0.85, z: pz + 0.15 }, { color: '#4E9A4A' });
    } else {
      batch.addBox({ x: px - 0.45, y, z: pz - 0.45 }, { x: px + 0.45, y: y + 1.1, z: pz + 0.45 }, { color: rng() < 0.5 ? '#C0504D' : '#4E7FB8' });
    }
    occupy(px, pz, 1);
  }
}

// Wellen-Muster für das Wasser (hell auf weiß → wird mit der Wasser-Farbe eingefärbt)
function createWaterTexture() {
  const px = 128;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#E8F6FA';
  ctx.fillRect(0, 0, px, px);
  const rng = createRng(77);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 26; i++) {
    const x = rng() * px;
    const y = rng() * px;
    const w = 8 + rng() * 18;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + w / 2, y - 3, x + w, y);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

// Nebel, Sichtweite und Umgebungslicht passend zur Insel (beim Aufräumen zurück).
// Das weiche Licht "von unten" ist sonst grasgrün – das färbt Hauswände und Decken in der
// Wüstenstadt grünlich. Auf der Insel kommt es warm-sandig von unten.
function applyFog(game, cfg) {
  const fog = game.scene?.fog;
  const camera = game.camera;
  let hemi = null;
  game.scene?.traverse((o) => {
    if (!hemi && o.isHemisphereLight) hemi = o;
  });
  const oldGround = hemi ? hemi.groundColor.clone() : null;
  if (hemi) hemi.groundColor.set(cfg.hemiGroundColor);
  const old = { near: fog?.near, far: fog?.far, cameraFar: camera?.far };
  if (fog) {
    fog.near = cfg.fog.near;
    fog.far = cfg.fog.far;
  }
  if (camera && camera.far < cfg.cameraFar) {
    camera.far = cfg.cameraFar;
    camera.updateProjectionMatrix();
  }
  return () => {
    if (hemi && oldGround) hemi.groundColor.copy(oldGround);
    if (fog) {
      fog.near = old.near;
      fog.far = old.far;
    }
    if (camera && old.cameraFar !== undefined) {
      camera.far = old.cameraFar;
      camera.updateProjectionMatrix();
    }
  };
}

function pick(list, rng) {
  return list[Math.floor(rng() * list.length) % list.length];
}

function shuffle(list, rng) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = list[i];
    list[i] = list[j];
    list[j] = t;
  }
  return list;
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
