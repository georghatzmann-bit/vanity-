/** Gemeinsame Typen des Radioteleskops (Schirm, Intro, Observatorium). */
import type { ErrorCode } from "../api";
import type { RefId } from "./catalog";

export type { RefId } from "./catalog";

/** Qualitätsstufe (H): 2 = 60 fps, 1 = 30 fps, 0 = 15 fps */
export type Quality = 0 | 1 | 2;

/** Zustand des Schirms (I.3 `useObservatory`) */
export type ObsMode = "idle" | "installing" | "error" | "halted" | "relock" | "strobe" | "installed" | "release" | "uninstalling" | "decay" | "lost";

/** „Hörbar als“ (E.6): < 8 Hz Klicks, < 20 Hz Knattern, < 40 Hz Schnarren, sonst Ton */
export type HeardAs = "clicks" | "rattle" | "buzz" | "tone";

/**
 * Was der Schirm vom Drehmodell braucht. `SpinModel` aus `shared/sound/spin.ts` erfüllt das.
 * Zeit = Modellzeit in Sekunden (`sound.clock.now()`).
 */
export interface SpinView {
  freqAt(t: number): number;
  phaseAt(t: number): number;
}

export interface ObsState {
  model: SpinView;
  mode: ObsMode;
  /** Modellzeit (s), seit der `mode` gilt */
  modeSince: number;
  reference: RefId;
  heard: HeardAs | "chord" | null;
  /** statt Stern das Zeichen zeigen (Wartung, Bestätigen, Fertig) */
  showMark: boolean;
  errorCode?: ErrorCode;
}

/** Variante des Intros (D.5/D.6) */
export type IntroVariant = "full" | "short" | "reduced" | "reducedShort";
