// =============================================================================
// Umgebung: Himmel, Sonne, weiches Licht und Nebel
// =============================================================================
import * as THREE from 'three';

/**
 * Baut Himmel, Licht und Nebel in die Szene.
 * @param {THREE.Scene} scene
 * @param {object} config   CONFIG aus config.js
 * @param {object} quality  aktuelle Grafik-Voreinstellung (niedrig/mittel/hoch)
 * @returns {{ update: (cameraPosition: THREE.Vector3, focus: THREE.Vector3) => void, sun: THREE.DirectionalLight }}
 */
export function createEnvironment(scene, config, quality) {
  const colors = config.visuals.colors;
  const visuals = config.visuals;
  const viewDistance = quality.viewDistance;

  // --- Nebel: weit entfernte Dinge verschwimmen in der Horizont-Farbe -------
  const horizon = new THREE.Color(colors.skyHorizon);
  scene.background = horizon.clone();
  scene.fog = new THREE.Fog(
    horizon.clone(),
    viewDistance * visuals.fogStartFraction,
    viewDistance * visuals.fogEndFraction,
  );

  // --- Himmel: eine große Kugel um die Kamera mit Farbverlauf ---------------
  // Unten/Horizont hellblau, nach oben kräftiger blau.
  const skyMaterial = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(colors.skyTop) },
      horizonColor: { value: horizon.clone() },
      curve: { value: 0.55 }, // wie schnell es nach oben dunkler wird
    },
    vertexShader: /* glsl */ `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform float curve;
      varying vec3 vDirection;
      void main() {
        float height = max(normalize(vDirection).y, 0.0);
        gl_FragColor = vec4(mix(horizonColor, topColor, pow(height, curve)), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    side: THREE.BackSide, // wir sind IN der Kugel
    depthWrite: false,
    fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), skyMaterial);
  sky.name = 'Himmel';
  sky.scale.setScalar(viewDistance); // muss kleiner sein als camera.far (siehe camera.js)
  sky.renderOrder = -1000; // zuerst malen, alles andere liegt davor
  sky.frustumCulled = false;
  scene.add(sky);

  // --- Weiches Umgebungslicht (Himmel von oben, Gras von unten) -------------
  // Farben aus config (visuals.hemiSkyColor/hemiGroundColor); sonst Himmel-Horizont und Gras
  const hemi = new THREE.HemisphereLight(
    new THREE.Color(visuals.hemiSkyColor ?? colors.skyHorizon),
    visuals.hemiGroundColor ? new THREE.Color(visuals.hemiGroundColor) : new THREE.Color(colors.grass).multiplyScalar(0.8),
    visuals.hemiIntensity,
  );
  hemi.name = 'Umgebungslicht';
  scene.add(hemi);

  // --- Sonne mit Schatten ---------------------------------------------------
  const sunDirection = new THREE.Vector3(
    visuals.sunDirection.x, visuals.sunDirection.y, visuals.sunDirection.z,
  ).normalize();
  const sun = new THREE.DirectionalLight(visuals.sunColor ?? 0xfff3dd, visuals.sunIntensity);
  sun.name = 'Sonne';
  const area = visuals.shadowArea;
  const sunDistance = 120; // so weit steht die "Schatten-Kamera" vom Mittelpunkt entfernt
  sun.castShadow = quality.shadows;
  if (quality.shadows) {
    sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    const cam = sun.shadow.camera;
    cam.left = -area;
    cam.right = area;
    cam.top = area;
    cam.bottom = -area;
    cam.near = 1;
    cam.far = sunDistance * 2;
    // bias ist ein Bruchteil der Tiefe (far - near ≈ 240 m): -0,00005 ≈ 1 cm.
    // Größer → helle Lichtspalte, wo Wände auf Böden stehen. normalBias
    // verhindert die "Streifen" (Schattenakne) auf schrägen Flächen.
    sun.shadow.bias = -0.00005;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 2; // weiche Kanten
  }
  scene.add(sun);
  scene.add(sun.target);

  // Der Schatten-Bereich wandert (ab Phase 2) mit dem Spieler mit. Damit die
  // Schattenkanten dabei nicht flimmern, rastet er auf ganze Schatten-Pixel ein.
  // Wichtig: Das Raster liegt schräg (so wie die Sonne scheint). Darum wird der
  // Punkt erst in die Sicht der Sonne gedreht, dort gerundet und zurückgedreht.
  const texelSize = (area * 2) / (quality.shadowMapSize || 1024); // ein Schatten-Pixel in Metern
  const sunRotation = new THREE.Matrix4().lookAt(sunDirection, new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
  const sunRotationInverse = sunRotation.clone().invert();
  const snapped = new THREE.Vector3();

  function placeSun(focus) {
    snapped.copy(focus).applyMatrix4(sunRotationInverse); // in Sonnen-Sicht
    snapped.x = Math.round(snapped.x / texelSize) * texelSize;
    snapped.y = Math.round(snapped.y / texelSize) * texelSize;
    snapped.applyMatrix4(sunRotation); // zurück in die Welt
    sun.target.position.copy(snapped);
    sun.position.copy(snapped).addScaledVector(sunDirection, sunDistance);
    sun.target.updateMatrixWorld();
  }
  placeSun(new THREE.Vector3());

  return {
    sun,
    sky,
    /**
     * Jedes Bild aufrufen: Himmel wandert mit der Kamera, Sonne mit dem
     * wichtigen Punkt (Phase 1: Mitte der Welt, später: der Spieler).
     */
    update(cameraPosition, focus) {
      sky.position.copy(cameraPosition);
      if (focus) placeSun(focus);
    },
  };
}
