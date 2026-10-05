// =============================================================================
// Maßstab-Objekte (nur zur Orientierung, in config.js unter debug abschaltbar)
// =============================================================================
// - eine Figur in Spielergröße (Kapsel, 1,8 m hoch, Radius 0,4 m)
//   mit hellerer "Kopf-Zone" (oberste 0,3 m = Kopfschuss)
// - der Umriss einer Bau-Zelle (4 x 4 x 4 m)
// =============================================================================
import * as THREE from 'three';

export function createReferenceObjects(scene, config) {
  const group = new THREE.Group();
  group.name = 'Maßstab';

  const { height, radius, headZone } = config.player.hitbox;
  const cell = config.world.gridCellSize;
  const wallHeight = config.world.wallHeight;

  // --- Figur: Kapsel. CapsuleGeometry(radius, Länge des Mittelteils) --------
  // Gesamthöhe = Mittelteil + 2 x Radius → Mittelteil = 1,8 - 0,8 = 1,0 m
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(radius, height - radius * 2, 8, 20),
    new THREE.MeshLambertMaterial({ color: 0xff8a3d }),
  );
  body.position.set(cell / 2, height / 2, cell / 2); // mitten in der Zelle, Füße auf dem Boden
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // Kopf-Zone als gelber Ring knapp unter dem Scheitel. Dort ist die Kapsel
  // schon "rund" (obere Halbkugel), also etwas schmaler als 0,4 m – den echten
  // Radius an dieser Höhe ausrechnen, sonst schneidet der Ring in die Figur.
  const ringY = height - headZone; // 1,5 m
  const above = Math.max(0, ringY - (height - radius)); // wie weit über dem Mittelpunkt der Halbkugel
  const radiusAtRing = Math.sqrt(radius * radius - above * above);
  const headRing = new THREE.Mesh(
    new THREE.TorusGeometry(radiusAtRing + 0.012, 0.012, 6, 40),
    new THREE.MeshBasicMaterial({ color: 0xffd93d }),
  );
  headRing.rotation.x = Math.PI / 2; // flach hinlegen
  headRing.position.set(cell / 2, ringY, cell / 2);
  group.add(headRing);

  // --- Umriss einer Bau-Zelle ------------------------------------------------
  const box = new THREE.BoxGeometry(cell, wallHeight, cell);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(box),
    new THREE.LineBasicMaterial({ color: 0x1f6fd1, transparent: true, opacity: 0.9 }),
  );
  edges.position.set(cell / 2, wallHeight / 2 + 0.01, cell / 2);
  group.add(edges);

  // leicht durchsichtige Fläche, damit man die Zelle besser erkennt
  const fill = new THREE.Mesh(
    box,
    new THREE.MeshBasicMaterial({ color: 0x4da6ff, transparent: true, opacity: 0.08, depthWrite: false }),
  );
  fill.position.copy(edges.position);
  group.add(fill);

  scene.add(group);
  return group;
}
