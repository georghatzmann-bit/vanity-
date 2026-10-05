// =============================================================================
// Feste Spiel-Uhr ("fester Zeitschritt")
// =============================================================================
// Die Spiel-Logik (Laufen, Schießen, Bauen …) soll immer gleich schnell laufen,
// egal ob der Bildschirm 30, 60 oder 144 Bilder pro Sekunde schafft. Darum
// sammelt diese Uhr die vergangene Zeit und sagt bei jedem Bild, wie viele
// Logik-Schritte (je 1/60 s) jetzt fällig sind.
//
// Beispiel bei 60 Schritten pro Sekunde:
//   - Bildschirm mit 60 Hz  → pro Bild 1 Schritt (ganz selten 0 oder 2, weil
//                             Bildschirme nie exakt 60,000 Hz haben)
//   - Bildschirm mit 144 Hz → meistens 0, manchmal 1 Schritt
//   - Bildschirm mit 30 Hz  → pro Bild 2 Schritte
//
// "alpha" (0..1) sagt, wie weit wir schon im nächsten Schritt sind. Damit
// zeichnet das Bild ab Phase 2 Bewegungen weich zwischen zwei Schritten
// (sonst würde es bei 0 oder 2 Schritten kurz ruckeln).
//
// Trick: Die Uhr startet mit einem HALBEN Schritt Vorrat. Bei 60 Hz liegt der
// Vorrat dann immer in der Mitte zwischen zwei Schritten – kleine Messfehler
// der Browser-Zeit (± 0,1 ms) führen so nicht zu 0-1-2-Gezappel.
//
// Diese Datei benutzt kein Three.js und keinen Browser – darum lässt sie sich
// in tests/tests.html einfach prüfen.
// =============================================================================

// Kleine Toleranz gegen Rundungsfehler: 60 x (1/60) soll genau 60 Schritte geben.
const EPSILON = 1e-9;

export class FixedStepClock {
  /**
   * @param {object} options
   * @param {number} options.tickRate          Logik-Schritte pro Sekunde (z. B. 60)
   * @param {number} options.maxFrameTime      längste Bild-Pause, die gezählt wird (s)
   * @param {number} options.maxStepsPerFrame  höchstens so viele Schritte pro Bild
   */
  constructor({ tickRate, maxFrameTime, maxStepsPerFrame }) {
    if (!(tickRate > 0)) throw new Error('tickRate muss größer als 0 sein');
    this.step = 1 / tickRate; // Länge eines Schritts in Sekunden
    this.maxFrameTime = maxFrameTime;
    this.maxStepsPerFrame = maxStepsPerFrame;
    this.accumulator = this.step / 2; // gesammelte, noch nicht verrechnete Zeit (Start: halber Schritt)
    this.totalSteps = 0; // alle Schritte seit dem Start
    this.droppedTime = 0; // Zeit, die verworfen wurde (zu langsamer Rechner / Tab im Hintergrund)
  }

  /**
   * Meldet der Uhr, wie viel Zeit seit dem letzten Bild vergangen ist.
   * @param {number} frameSeconds  Zeit seit dem letzten Bild in Sekunden
   * @returns {{steps: number, alpha: number}} fällige Schritte und Zwischenstand
   */
  advance(frameSeconds) {
    // Ungültige oder negative Zeiten (z. B. Uhr springt) zählen als 0.
    let dt = Number.isFinite(frameSeconds) && frameSeconds > 0 ? frameSeconds : 0;

    // Sehr lange Pausen kürzen, sonst müsste die Logik danach "nachrennen".
    if (dt > this.maxFrameTime) {
      this.droppedTime += dt - this.maxFrameTime;
      dt = this.maxFrameTime;
    }

    this.accumulator += dt;

    let steps = 0;
    while (this.accumulator + EPSILON >= this.step && steps < this.maxStepsPerFrame) {
      this.accumulator -= this.step;
      steps++;
    }

    // Immer noch zu viel Zeit übrig? Dann ist der Rechner zu langsam.
    // Rest verwerfen, damit es nicht immer schlimmer wird.
    if (this.accumulator + EPSILON >= this.step) {
      let keep = this.accumulator % this.step;
      if (keep + EPSILON >= this.step) keep = 0; // Rundungsrest von fast einem ganzen Schritt
      this.droppedTime += this.accumulator - keep;
      this.accumulator = keep;
    }

    // Kleine negative Reste durch die Toleranz auf 0 setzen.
    if (this.accumulator < 0) this.accumulator = 0;

    this.totalSteps += steps;
    return { steps, alpha: this.accumulator / this.step };
  }

  /** Setzt die Uhr zurück (z. B. nach einer Pause oder beim Rundenstart). */
  reset() {
    this.accumulator = this.step / 2;
  }
}
