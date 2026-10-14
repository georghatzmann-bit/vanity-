/**
 * Fortschritt → Periode (Spec F.1): Inszenierung mit Rastplateaus an den Katalog-Pulsaren.
 * Keine künstliche Monotonie – sinkt der Fortschritt, sinkt auch die Drehzahl.
 */
import type { Progress, UninstallProgress } from "../api";
import type { Step } from "../flow/logic";

const L = [Math.log(1.3373), Math.log(0.08933), Math.log(0.0337), Math.log(0.005757)];
const SEG: [number, number, number, number][] = [[0, 0.06, 0, 0], [0.06, 0.4, 0, 1], [0.4, 0.48, 1, 1], [0.48, 0.62, 1, 2], [0.62, 0.7, 2, 2], [0.7, 0.94, 2, 3], [0.94, 1, 3, 3]];

export function periodForProgress(x: number): number {
  x = Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
  const [a, b, i, j] = SEG.find(([, e]) => x <= e) ?? SEG[SEG.length - 1];
  const u = b > a ? (x - a) / (b - a) : 0;
  const s = u * u * (3 - 2 * u);
  return Math.exp(L[i] + (L[j] - L[i]) * s);
}

/** Was der Antrieb vom Ablauf braucht (Teilmenge von `SetupFlow`) */
export interface DriveInput {
  step: Step;
  progress: Progress | null;
  unProgress: UninstallProgress | null;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

/** Antrieb x ∈ [0, 1] je Schritt (F.1, Tabelle „Eingang“) */
export function driveFor(step: Step, flow: Omit<DriveInput, "step">): number {
  switch (step) {
    case "install": {
      const p = flow.progress;
      if (!p || p.phase === "connect") return 0;
      if (p.phase === "done") return 1;
      return clamp01(p.percent / 100);
    }
    case "un-run":
      return clamp01(1 - (flow.unProgress?.percent ?? 0) / 100);
    case "done":
    case "maintenance":
    case "un-confirm":
      return 1;
    default:
      return 0;
  }
}

/** Rauschbett während der Installation: −46 dBFS bei x = 0, linear in dB bis „aus“ bei x ≥ 0,25 (null = aus) */
export function installNoiseDb(x: number): number | null {
  if (x >= 0.25) return null;
  const u = clamp01(x) / 0.25;
  // „aus“ ≈ −90 dBFS: linear in dB dorthin
  return -46 + (-90 + 46) * u;
}
