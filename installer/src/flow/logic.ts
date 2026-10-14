/**
 * Reine Ablauf-Logik des Setups (ohne React, ohne Tauri) – testbar in node.
 * Der Hook `useSetupFlow` baut darauf auf.
 */
import type { DiskInfo, ErrorCode, InstallOptions, Phase, Progress, SetupInfo, UninstallProgress } from "../api";

export type Step = "intro" | "welcome" | "maintenance" | "folder" | "options" | "install" | "done" | "un-confirm" | "un-run" | "un-done";
export type InstallPhase = Exclude<Phase, "done">;
export type UninstallStep = Exclude<UninstallProgress["step"], "done">;

/** Schrittskala der normalen Installation */
export const RAIL: Step[] = ["welcome", "folder", "options", "install", "done"];
export const PHASES: InstallPhase[] = ["connect", "download", "verify", "install", "shortcuts", "register"];
export const UNINSTALL_STEPS: UninstallStep[] = ["stop", "shortcuts", "registry", "files", "data"];

/** Zeiten des Ablaufs (ms bzw. s) – unverändert gegenüber der alten App, Tipps neu 8000 ms */
export const TIP_COUNT = 5;
export const TIP_INTERVAL_MS = 8000;
export const COUNTDOWN_S = 5;
export const UPDATE_RESTART_MS = 2600;
export const DONE_DELAY_MS = 650;
/** Seite „Signal verloren.“ erst, wenn der Schirm ausgeklungen ist (≥ UNINSTALL_TIMING.decayToMs) */
export const UNDONE_DELAY_MS = 2100;
/** reduzierte Bewegung: wie bisher */
export const UNDONE_DELAY_REDUCED_MS = 500;
export const RESUME_NOTE_MS = 8000;
export const DISK_DEBOUNCE_MS = 250;

/** Ersatz, falls `setup_info` scheitert (wie bisher) */
export const FALLBACK_INFO: SetupInfo = { mode: "install", setupVersion: "1.0.0", appName: "Pulsar", defaultDir: "", elevated: false, systemLang: "de", manifestUrl: "" };

export function defaultOpts(si: SetupInfo): InstallOptions {
  return { dir: si.installed?.dir ?? si.defaultDir, desktopShortcut: true, startMenu: true, autostart: false, launchAfter: true };
}

/** Ziel nach dem Intro: entweder ein Schritt oder sofort die Installation (`start`). */
export interface IntroTarget {
  step: Step;
  start?: InstallOptions;
}

export function nextStepAfterIntro(si: SetupInfo): IntroTarget {
  if (si.mode === "uninstall") return { step: "un-confirm" };
  if (si.mode === "update") return { step: "install", start: { ...defaultOpts(si), dir: si.installed?.dir ?? si.defaultDir } };
  if (si.preset) return { step: "install", start: si.preset };
  if (si.mode === "maintenance") return { step: "maintenance" };
  return { step: "welcome" };
}

/** „Zurück“ nach einem Fehler: Platz- und Rechteprobleme → Speicherort, sonst Optionen */
export function errorBackTarget(code: ErrorCode): "folder" | "options" {
  return code === "disk" || code === "permission" ? "folder" : "options";
}

/** Index der aktuellen Phase (0…6; 6 = alles erledigt) */
export function phaseIndexOf(progress: Progress | null): number {
  if (!progress) return 0;
  return progress.phase === "done" ? PHASES.length : PHASES.indexOf(progress.phase);
}

/** Index des aktuellen Deinstallationsschritts (−1 = noch keiner, 5 = fertig) */
export function uninstallIndexOf(p: UninstallProgress | null): number {
  if (!p) return -1;
  return p.step === "done" ? UNINSTALL_STEPS.length : UNINSTALL_STEPS.indexOf(p.step);
}

/** Gewählter Ordner aus dem Dialog: ohne „Pulsar“ im Pfad wird `\Pulsar` angehängt (wie bisher). */
export function withPulsarSuffix(p: string): string {
  return /pulsar/i.test(p) ? p : `${p.replace(/[\\/]+$/, "")}\\Pulsar`;
}

/** Phasendauern im Client: Zeit zwischen den Phasenwechseln (ms). */
export type PhaseDurations = Partial<Record<InstallPhase, number>>;
export interface PhaseClock {
  phase: Phase | null;
  since: number;
  durations: PhaseDurations;
}
export const emptyPhaseClock = (): PhaseClock => ({ phase: null, since: 0, durations: {} });

/**
 * Neuer Phasenstand → neue Uhr (rein). Gleiche Phase ändert nichts.
 * Dauern ADDIEREN sich: Nach „Erneut versuchen“ läuft dieselbe Phase ein zweites Mal weiter.
 */
export function advancePhaseClock(c: PhaseClock, phase: Phase, now: number): PhaseClock {
  if (c.phase === phase) return c;
  const durations = { ...c.durations };
  if (c.phase && c.phase !== "done") durations[c.phase] = (durations[c.phase] ?? 0) + Math.max(0, now - c.since);
  return { phase, since: now, durations };
}

/** Uhr anhalten (Fehler/Abbruch): laufende Phase abschließen, die Wartezeit danach zählt nicht. */
export function pausePhaseClock(c: PhaseClock, now: number): PhaseClock {
  if (!c.phase || c.phase === "done") return c.phase === null ? c : { ...c, phase: null };
  const durations = { ...c.durations };
  durations[c.phase] = (durations[c.phase] ?? 0) + Math.max(0, now - c.since);
  return { phase: null, since: now, durations };
}

/**
 * Übertragene Bytes über alle Läufe (Fortsetzen, Neustart): je Lauf `last − base`.
 * `base` = Stand beim ersten Download-Event des Laufs (neuer Lauf: 0, Fortsetzen: Offset,
 * Neustart des Servers: 0).
 */
export interface TransferTally {
  acc: number;
  base: number | null;
  last: number;
  /** Lauf ohne Vorgeschichte (Bytes zählen ab 0) */
  fresh: boolean;
}
export const emptyTally = (): TransferTally => ({ acc: 0, base: null, last: 0, fresh: true });

/** Neuer Lauf: `fresh` = ganz neue Installation, sonst Fortsetzen (laufendes Segment abschließen) */
export function tallyRunStart(t: TransferTally, fresh: boolean): TransferTally {
  if (fresh) return emptyTally();
  const acc = t.acc + (t.base !== null ? Math.max(0, t.last - t.base) : 0);
  return { acc, base: null, last: t.last, fresh: false };
}

/**
 * Download nach dem Fortsetzen deutlich unter dem letzten Stand → der Server hat neu begonnen
 * (kein Range, `.part` ungültig). Kleine Rücksprünge (Puffer) gelten als Fortsetzen.
 */
export function isDownloadRestart(lastDownloaded: number, downloaded: number): boolean {
  return lastDownloaded > 0 && downloaded < lastDownloaded * 0.5;
}

/** Download-Event in die Zählung übernehmen */
export function tallyDownload(t: TransferTally, downloaded: number): TransferTally {
  if (t.base === null) {
    const base = t.fresh || isDownloadRestart(t.last, downloaded) ? 0 : downloaded;
    return { ...t, base, last: downloaded };
  }
  if (downloaded < t.last) {
    // Neustart mitten im Lauf: Bisheriges zählt, ab 0 neu
    return { ...t, acc: t.acc + Math.max(0, t.last - t.base), base: 0, last: downloaded };
  }
  return { ...t, last: downloaded };
}

/** Übertragene Bytes (null = kein Download gemessen) */
export function tallyTransferred(t: TransferTally): number | null {
  const v = t.acc + (t.base !== null ? Math.max(0, t.last - t.base) : 0);
  return t.base === null && t.acc === 0 ? null : v;
}

/** Wartezeit nach „Pulsar schließen und weiter“, bevor die Installation neu startet */
export const RETRY_CLOSE_WAIT_MS = 800;
/** Hinweis „Deinstallation läuft – bitte warten“ nach dem X */
export const CLOSE_NOTICE_MS = 4000;

/**
 * Fortsetzen nach Fehler/Abbruch: Das Backend meldet erst `connect` mit 0 % – das wird nicht
 * übernommen (sonst 40 → 0 → 40 %). Alles andere gilt, auch ein Neustart bei 0 (Server ohne Range):
 * Die Anzeige fällt dann ehrlich, statt für die ganze erneute Übertragung einzufrieren.
 */
export function acceptResumeProgress(p: Pick<Progress, "phase">): boolean {
  return p.phase !== "connect";
}

/** Fehler „Die Installation läuft bereits.“ des Backends (kein echter Fehler für die Oberfläche) */
export function isAlreadyRunning(message: string): boolean {
  return /läuft bereits|already running/i.test(message);
}

/** Ergebnis einer gescheiterten Speicherplatz-Abfrage: ungültig, nicht „alles gut“ */
export function invalidDisk(path: string, message?: string): DiskInfo {
  return { path, free: 0, total: 0, required: 0, exists: false, writable: false, needsAdmin: false, valid: false, message };
}

/** Ansagen während der Installation (H): Phasenwechsel und 25-%-Schritte, höchstens alle 5 s */
export const ANNOUNCE_MIN_GAP_MS = 5000;
export interface AnnounceState {
  phase: string;
  quarter: number;
  at: number;
}
export const emptyAnnounce = (): AnnounceState => ({ phase: "", quarter: -1, at: -Infinity });
/** Neuer Ansage-Stand oder `null` (nichts ansagen) */
export function nextAnnouncement(last: AnnounceState, p: { phase: string; percent: number }, now: number): AnnounceState | null {
  if (p.phase === "done") return null;
  const quarter = Math.floor(Math.max(0, Math.min(100, p.percent)) / 25);
  if (p.phase === last.phase && quarter === last.quarter) return null;
  if (now - last.at < ANNOUNCE_MIN_GAP_MS) return null;
  return { phase: p.phase, quarter, at: now };
}

/** Protokoll der Installation (Fertig): Gesamtdauer, übertragen, mittlere Rate (nur Gemessenes) */
export interface InstallLog {
  totalMs: number | null;
  bytes: number | null;
  rate: number | null;
  /** weniger übertragen als die Datei groß ist (Fortsetzen) */
  resumed: boolean;
}
/**
 * `transferred` = in DIESER Sitzung wirklich übertragene Bytes (nicht die Dateigröße),
 * Rate = übertragen / Downloaddauer (Dauern aller Läufe addiert).
 */
export function installLog(durations: PhaseDurations, transferred: number | null | undefined, total?: number | null): InstallLog {
  const vals = Object.values(durations).filter((d): d is number => typeof d === "number" && Number.isFinite(d));
  const totalMs = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  const bytes = transferred && transferred > 0 ? transferred : null;
  const dl = durations.download;
  const rate = bytes !== null && dl !== undefined && dl > 0 ? bytes / (dl / 1000) : null;
  const resumed = bytes !== null && total !== null && total !== undefined && total > 0 && bytes < total * 0.995;
  return { totalMs, bytes, rate, resumed };
}
