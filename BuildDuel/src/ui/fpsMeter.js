// =============================================================================
// FPS-Anzeige (Bilder pro Sekunde)
// =============================================================================
// Zwei Teile:
//   1. FpsCounter  – rechnet nur (kein Browser nötig, darum testbar)
//   2. FpsDisplay  – zeigt die Zahlen oben links im Bild an
// =============================================================================

export class FpsCounter {
  /** @param {number} windowSeconds  über diesen Zeitraum wird gemittelt */
  constructor(windowSeconds = 0.5) {
    this.windowSeconds = windowSeconds;
    this._time = 0;
    this._frames = 0;
    this._ticks = 0;
    this._worstFrame = 0;
    // Ergebnisse (werden alle 0,5 s neu berechnet)
    this.fps = 0; // Bilder pro Sekunde
    this.frameMs = 0; // durchschnittliche Zeit pro Bild in Millisekunden
    this.worstFrameMs = 0; // langsamstes Bild im Zeitraum (zeigt Ruckler)
    this.ticksPerSecond = 0; // Logik-Schritte pro Sekunde (soll 60 sein)
    this.hasData = false; // false, bis die erste Messung fertig ist
  }

  /**
   * Bei jedem gemalten Bild aufrufen.
   * @param {number} frameSeconds  Zeit seit dem letzten Bild (s)
   * @param {number} ticks         Logik-Schritte in diesem Bild
   * @returns {boolean} true, wenn gerade neue Werte berechnet wurden
   */
  frame(frameSeconds, ticks = 0) {
    if (!(frameSeconds > 0) || !Number.isFinite(frameSeconds)) return false;
    // Riesige Pausen (Tab war im Hintergrund) verfälschen nur die Messung.
    if (frameSeconds > 1) {
      this._restart();
      return false;
    }
    this._time += frameSeconds;
    this._frames++;
    this._ticks += ticks;
    if (frameSeconds > this._worstFrame) this._worstFrame = frameSeconds;

    // kleine Toleranz: 30 x (1/60) ergibt durch Rundung 0,49999… statt 0,5
    if (this._time + 1e-9 < this.windowSeconds) return false;

    this.fps = this._frames / this._time;
    this.frameMs = (this._time / this._frames) * 1000;
    this.worstFrameMs = this._worstFrame * 1000;
    this.ticksPerSecond = this._ticks / this._time;
    this.hasData = true;
    this._restart();
    return true;
  }

  _restart() {
    this._time = 0;
    this._frames = 0;
    this._ticks = 0;
    this._worstFrame = 0;
  }
}

/**
 * Bewertet die Bildrate: 'gut' (ab 55), 'mittel' (ab 30) oder 'schlecht'.
 * @param {number} fps
 */
export function rateFps(fps) {
  if (fps >= 55) return 'gut';
  if (fps >= 30) return 'mittel';
  return 'schlecht';
}

/** Zeigt die Messwerte in einem kleinen Kasten an. */
export class FpsDisplay {
  /** @param {HTMLElement} element  der Kasten aus index.html (#fps) */
  constructor(element) {
    this.element = element;
    this.counter = new FpsCounter(0.5);
    this.element.hidden = false;
    this.element.innerHTML =
      '<span class="fps-main"><b data-fps>–</b> FPS</span>' +
      '<span class="fps-detail"><span data-ms>–</span> ms · Logik <span data-tps>–</span>/s</span>';
    this._fps = this.element.querySelector('[data-fps]');
    this._ms = this.element.querySelector('[data-ms]');
    this._tps = this.element.querySelector('[data-tps]');
  }

  /** Bei jedem Bild aufrufen. */
  update(frameSeconds, ticks) {
    if (!this.counter.frame(frameSeconds, ticks)) return;
    const c = this.counter;
    this._fps.textContent = Math.round(c.fps);
    this._ms.textContent = c.frameMs.toFixed(1);
    this._tps.textContent = Math.round(c.ticksPerSecond);
    // Farbe (grün/orange/rot) über CSS – der Text sagt es zusätzlich im Titel.
    const rating = rateFps(c.fps);
    this.element.dataset.rating = rating;
    this.element.title =
      `Bildrate ${rating} – langsamstes Bild: ${c.worstFrameMs.toFixed(1)} ms`;
  }
}
