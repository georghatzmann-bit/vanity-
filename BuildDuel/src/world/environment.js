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
  scene.fog = new THREE.Fog(horizon.clone(), viewDistance * visuals.fogStartFraction, viewDistance * 0.95);

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
  const hemi = new THREE.HemisphereLight(
    new THREE.Color(colors.skyHorizon),
    new THREE.Color(colors.grass).multiplyScalar(0.8),
    visuals.hemiIntensity,
  );
  hemi.name = 'Umgebungslicht';
  scene.add(hemi);

  // --- Sonne mit Schatten ---------------------------------------------------
  const sunDirection = new THREE.Vector3(
    visuals.sunDirection.x, visuals.sunDirection.y, visuals.sunDirection.z,
  ).normalize();
  const sun = new THREE.DirectionalLight(0xfff3dd, visuals.sunIntensity);
  sun.name = 'Sonne';
  const area = visuals.shadowArea;
  const sunDistance = 200;
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
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 2; // weiche Kanten
  }
  scene.add(sun);
  scene.add(sun.target);

  // Größe eines Schatten-Pixels in Metern (zum "Einrasten", siehe unten)
  const texelSize = (area * 2) / (quality.shadowMapSize || 1024);
  const snapped = new THREE.Vector3();

  function placeSun(focus) {
    // Schatten-Bereich auf ganze Schatten-Pixel einrasten – sonst flimmern
    // Schattenkanten, wenn sich der Bereich mit dem Spieler mitbewegt.
    snapped.set(
      Math.round(focus.x / texelSize) * texelSize,
      0,
      Math.round(focus.z / texelSize) * texelSize,
    );
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
