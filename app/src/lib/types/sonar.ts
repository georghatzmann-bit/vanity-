/**
 * „Hör dein Netz“: Ping → Klang. Vertrag: docs/API.md, „Hör dein Netz“.
 */

/** Einstellungen `sonar` */
export interface SonarSettings {
  /** 0–1 */
  volume: number;
  /** Tonhöhe folgt dem Ping */
  pitch: boolean;
  /** leiser Warnton bei Ausreißern im Spiel (Standard aus) */
  alertInGame: boolean;
  /** 0,05–0,3 */
  alertVolume: number;
}

/** Klang-Parameter eines Pulses (`sonarParams`) */
export interface SonarParams {
  /** Periode = Messabstand (ms) */
  periodMs: number;
  /** Zittern 0–1 */
  jitter: number;
  /** dieser Puls fällt aus (Verlust) */
  drop: boolean;
  /** Puls betonen (Ausreißer) */
  accent: boolean;
  /** Tonstufe 0 (dunkel) – 5 (hell) = Resonanz auf einer Harmonischen von 173,7 Hz, null ohne Tonhöhe */
  step: number | null;
  /** Pegel 0–1 für `PulseVoice.setLevel`: `sonar.volume`, 0 bei `settings.sound = false` (die globale Lautstärke wirkt über den Master der Engine) */
  gain: number;
}
