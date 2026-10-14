/**
 * „Hör dein Netz“: Ping → Klang (reine Logik, ohne Audio). Vertrag: docs/API.md, „Hör dein Netz“.
 * Der Klang selbst kommt aus der Pulsar-Sonifikation (`shared/sound/engine.ts`, PulseVoice E.11);
 * `store/sonar.ts` übersetzt die Werte hier in deren Methoden.
 * Ehrlich: Der Ton macht die Messung hörbar, er verbessert nichts.
 */
import { isLiveSpike, LIVE_WINDOW, PING_GRADE_LIMITS } from "./grade";
import { defaultSonar, mergeSonar } from "./settings/sonar";
import type { LagEvent, PingSample, PingStats, Settings, SonarParams, SonarSettings } from "./types";

/** Ab dieser Schwankung (ms) stolpert der Takt voll (Zittern 1) */
export const SONAR_JITTER_FULL_MS = 30;
/** Betonung eines Ausreißers (Pegel × 1,5, höchstens 1) */
export const SONAR_ACCENT = 1.5;
/** Periode der Puls-Stimme: 250–10 000 ms */
export const SONAR_PERIOD_MIN_MS = 250;
export const SONAR_PERIOD_MAX_MS = 10_000;
/** Höchste Tonstufe (hell) – Stufe = Resonanz auf einer Harmonischen von 173,7 Hz, keine Melodie */
export const SONAR_TOP_STEP = PING_GRADE_LIMITS.length;
/** Warnton höchstens so oft (ms) */
export const SONAR_ALERT_GAP_MS = 10_000;
/** Ein-/Ausblenden der Puls-Stimme (s, Vertrag ≤ 0,15) */
export const SONAR_FADE_S = 0.1;
/** Pegel-Rampe (s, Vertrag ≥ 0,02) */
export const SONAR_LEVEL_RAMP_S = 0.03;
/** Probe-Knöpfe: so lange (ms) und in diesem Takt (ms) */
export const SONAR_PREVIEW_MS = 4000;
export const SONAR_PREVIEW_PERIOD_MS = 500;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Tonstufe zu einer Antwortzeit: < 20 ms → 5 (hell) · 20–34,9 → 4 · 35–59,9 → 3 · 60–99,9 → 2 · 100–179,9 → 1 · ≥ 180 → 0 (dunkel).
 * Gleiche Grenzen wie die Ø-Ping-Stufen von `pingGrade` (`PING_GRADE_LIMITS`).
 */
export function sonarStep(rtt: number): number {
  const below = PING_GRADE_LIMITS.findIndex((limit) => rtt < limit);
  return below === -1 ? 0 : SONAR_TOP_STEP - below;
}

/** Zittern 0–1 aus `PingStats.jitter` (ms): 0 → gleichmäßig, 15 → 0,5, ≥ 30 → 1; ohne Wert → 0 */
export function sonarJitter(jitterMs: number | null | undefined): number {
  if (jitterMs === null || jitterMs === undefined || !Number.isFinite(jitterMs)) return 0;
  return clamp(jitterMs / SONAR_JITTER_FULL_MS, 0, 1);
}

/** Einstellungen `sonar` (fehlend/fehlerhaft → Standard, gekappt) */
export function sonarSettings(settings: Pick<Settings, "sonar">): SonarSettings {
  return settings.sonar ? mergeSonar(settings.sonar) : defaultSonar();
}

/**
 * Pegel der Puls-Stimme (`PulseVoice.setLevel`): `sonar.volume`, stumm bei `settings.sound = false`.
 * Die globale Lautstärke `settings.volume` wirkt über den Master der Engine (wie bei allen Pulsar-Klängen) –
 * hier nicht noch einmal, sonst zählte sie doppelt.
 */
export function sonarGain(settings: Pick<Settings, "sound" | "volume" | "sonar">): number {
  if (!settings.sound || !(settings.volume > 0)) return 0;
  return sonarSettings(settings).volume;
}

/**
 * Klang-Parameter für eine Messung.
 * @param sample die neue Messung des Hauptziels
 * @param window die letzten Werte des Hauptziels **einschließlich** `sample` (höchstens 60 zählen)
 * @param stats `PingStats` der letzten 60 Messungen (für das Zittern)
 */
export function sonarParams(
  sample: Pick<PingSample, "rtt">,
  window: (number | null)[],
  stats: Pick<PingStats, "jitter"> | null,
  settings: Pick<Settings, "sound" | "volume" | "sonar" | "pingIntervalMs">,
): SonarParams {
  const sonar = sonarSettings(settings);
  const drop = sample.rtt === null || !Number.isFinite(sample.rtt);
  const interval = Number.isFinite(settings.pingIntervalMs) ? settings.pingIntervalMs : 1000;
  return {
    periodMs: clamp(interval, SONAR_PERIOD_MIN_MS, SONAR_PERIOD_MAX_MS),
    jitter: sonarJitter(stats?.jitter),
    drop,
    accent: !drop && isLiveSpike(window.slice(-LIVE_WINDOW)),
    step: sonar.pitch && !drop ? sonarStep(sample.rtt as number) : null,
    gain: sonarGain(settings),
  };
}

/** Warnton-Pegel (`sound.alertTone(level)`): `sonar.alertVolume`, gekappt auf 0,05–0,3; globale Lautstärke über den Master */
export function sonarAlertLevel(settings: Pick<Settings, "sonar">): number {
  return sonarSettings(settings).alertVolume;
}

/** Merker für den Warnton (in `store/sonar.ts` gehalten) */
export interface AlertMemo {
  /** Zeitpunkt (ms) des letzten Warntons, null = noch keiner */
  lastAt: number | null;
  /** schon gesehene Ausreißer (`targetId|at`) – die `count`-Aktualisierung kommt mit demselben Schlüssel */
  seen: string[];
}

export const emptyAlertMemo = (): AlertMemo => ({ lastAt: null, seen: [] });

const SEEN_MAX = 64;
export const lagKey = (ev: Pick<LagEvent, "targetId" | "at">) => `${ev.targetId}|${ev.at}`;

/**
 * Entscheidet über den Warnton bei `net://lag`: nur bei der **ersten** Meldung eines Ausreißers (nicht bei der
 * `count`-Aktualisierung), nur mit `sonar.alertInGame` (Standard aus), nur wenn ein Spiel läuft, höchstens alle 10 s.
 * Gibt den neuen Merker zurück (jede Meldung wird gemerkt, auch ohne Ton).
 */
export function alertDecision(
  ev: Pick<LagEvent, "targetId" | "at">,
  memo: AlertMemo,
  ctx: { settings: Pick<Settings, "sonar">; gameRunning: boolean; now: number },
): { play: boolean; memo: AlertMemo } {
  const key = lagKey(ev);
  if (memo.seen.includes(key)) return { play: false, memo };
  const seen = [...memo.seen, key].slice(-SEEN_MAX);
  const on = sonarSettings(ctx.settings).alertInGame;
  const rested = memo.lastAt === null || ctx.now - memo.lastAt >= SONAR_ALERT_GAP_MS;
  const play = on && ctx.gameRunning && rested;
  return { play, memo: { lastAt: play ? ctx.now : memo.lastAt, seen } };
}

/** Probe-Knöpfe in den Einstellungen */
export type SonarPreviewKind = "stable" | "unstable" | "loss" | "alert";
export const SONAR_PREVIEWS: SonarPreviewKind[] = ["stable", "unstable", "loss", "alert"];

/**
 * Beispielwerte der Probe-Knöpfe (deterministisch, je 4 s im 500-ms-Takt): `history` füllt das Fenster vorab
 * (damit die Ausreißer-Regel greift), `rtts` sind die gespielten Messungen, `jitterMs` die Schwankung.
 * „Warnton“: stabile Werte mit einem Ausreißer, bei dem der Warnton erklingt.
 */
export function sonarPreviewSeries(kind: SonarPreviewKind): { history: (number | null)[]; rtts: (number | null)[]; jitterMs: number } {
  const steady = (n: number, base: number) => Array.from({ length: n }, (_, i) => base + (i % 3) * 0.6);
  const count = Math.round(SONAR_PREVIEW_MS / SONAR_PREVIEW_PERIOD_MS);
  switch (kind) {
    case "unstable":
      return { history: steady(20, 28), rtts: [31, 58, 27, 74, 36, 29, 112, 41].slice(0, count), jitterMs: 24 };
    case "loss":
      return { history: steady(20, 26), rtts: [26, null, 27, 26, null, null, 26, 27].slice(0, count), jitterMs: 1.2 };
    case "alert":
      // ein Ausreißer in der Mitte – dazu spielt der Warnton
      return { history: steady(20, 24), rtts: [24, 24.6, 25.2, 140, 24, 24.6, 25.2, 24].slice(0, count), jitterMs: 1 };
    case "stable":
    default:
      return { history: steady(20, 24), rtts: steady(count, 24), jitterMs: 0.6 };
  }
}
