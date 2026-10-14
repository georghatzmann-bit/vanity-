/** Einstellungen `sonar` („Hör dein Netz“): Standardwerte und Kappung (volume 0–1, alertVolume 0,05–0,3). */
import type { SonarSettings } from "../types";
import { bool, num, obj } from "./clamp";

export const defaultSonar = (): SonarSettings => ({ volume: 0.5, pitch: true, alertInGame: false, alertVolume: 0.15 });

export function mergeSonar(stored: unknown): SonarSettings {
  const s = obj(stored);
  const d = defaultSonar();
  return {
    volume: num(s.volume, d.volume, 0, 1),
    pitch: bool(s.pitch, d.pitch),
    alertInGame: bool(s.alertInGame, d.alertInGame),
    alertVolume: num(s.alertVolume, d.alertVolume, 0.05, 0.3),
  };
}
