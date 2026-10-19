/**
 * Plattform-Adapter: die einzige Stelle, an der die Oberfläche mit Tauri spricht.
 *
 * - In der Desktop-App (`isTauri()`) gehen die Aufrufe an die Fenster-API und die App-Befehle
 *   `app_info` und `hide_to_tray` – genau die Rechte aus `src-tauri/capabilities/default.json`,
 *   nicht mehr.
 * - In einem normalen Browser (Vite-Vorschau, Playwright) gibt es keinen Rust-Teil: Fenster-
 *   steuerung fehlt (`window: null`), `app_info` liefert gekennzeichnete Vorschau-Werte und
 *   Tray-Ereignisse kommen nie. So läuft die Oberfläche überall, ohne etwas vorzutäuschen.
 *
 * Bewusst nicht vorhanden: Senden von Ereignissen an das Backend, Zerstören von Fenstern,
 * `onCloseRequested` (bräuchte `allow-destroy`, siehe README „Bewusst nicht gewährt“).
 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { version as configuredVersion } from '../../src-tauri/tauri.conf.json';
import { parseAppInfo, previewAppInfo, type AppInfo } from './appInfo.ts';
import {
  expectType,
  parseDecision,
  parseProposal,
  parseQuarantine,
  parseScan,
  parseHistory,
  parseLab,
  parseLabReportResponse,
  parseMemoryScan,
  parsePanic,
  parseRansom,
  parseBackup,
  parseSafe,
  parseEmergency,
  parseLabScreenshot,
  decodeBase64,
  parseSchedule,
  parseTrust,
  parseWatch,
  type ServiceApi,
} from './service.ts';

/** Meldet einen Empfänger wieder ab. */
export type Unlisten = () => void;

/** Seiten, die das Tray-Menü öffnen kann (`aegis://navigate`, Rust: `tray::Page`). */
export type NavigateTarget = 'dashboard' | 'settings';

/** Ereignis Rust → Oberfläche aus dem Tray-Menü. */
export const NAVIGATE_EVENT = 'aegis://navigate';

/**
 * Ergebnis von `hide_to_tray`: `hidden` – Fenster versteckt, AEGIS über das Symbol im
 * Infobereich erreichbar; `noTray` – kein Symbol, nichts versteckt.
 */
export type HideOutcome = 'hidden' | 'noTray';

/** Prüft die Antwort von `hide_to_tray`; alles andere ist ein Fehler. */
export function parseHideOutcome(value: unknown): HideOutcome {
  if (value === 'hidden' || value === 'noTray') {
    return value;
  }
  throw new TypeError('hide_to_tray: unerwartete Antwort.');
}

/** Dateien, die auf das Fenster gezogen werden (nur Pfade – gelesen wird dabei nichts). */
export type FileDropEvent =
  | { readonly type: 'enter' }
  | { readonly type: 'leave' }
  | { readonly type: 'drop'; readonly paths: readonly string[] };

/** Fenstersteuerung der eigenen Titelleiste (rahmenloses Fenster). */
export interface WindowApi {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  /** Nur lesend – für das passende Symbol (Maximieren / Wiederherstellen). */
  isMaximized(): Promise<boolean>;
  /** Größenänderung des Fensters (auch nach Maximieren, Andocken …). */
  onResized(handler: () => void): Promise<Unlisten>;
  /**
   * Fenster in den Infobereich verstecken. Rust versteckt nur, wenn es dort ein Symbol gibt
   * (sonst bliebe AEGIS unsichtbar ohne Rückweg) und meldet sonst `noTray`.
   */
  hideToTray(): Promise<HideOutcome>;
  /** Fenster schließen – beendet AEGIS vollständig (Rust: jede Schließ-Anforderung = Ende). */
  close(): Promise<void>;
}

export interface Platform {
  readonly kind: 'tauri' | 'browser';
  /** `null` in der Browser-Vorschau: dort gibt es keine Fensterknöpfe. */
  readonly window: WindowApi | null;
  /** Version, Build-Profil, Plattform (einmal ermittelt, danach aus dem Zwischenspeicher). */
  appInfo(): Promise<AppInfo>;
  /** Tray-Menü „Dashboard“ / „Einstellungen“. In der Vorschau kommt nie ein Ereignis. */
  onNavigate(handler: (target: NavigateTarget) => void): Promise<Unlisten>;
  /** Dienst `aegis-service` – `null` in der Browser-Vorschau (dort gibt es keinen Dienst). */
  readonly service: ServiceApi | null;
  /** Datei-/Ordnerauswahl; leere Liste bei Abbruch. `null` in der Vorschau. */
  readonly pickPaths: ((kind: 'files' | 'folder') => Promise<readonly string[]>) | null;
  /** Auf das Fenster gezogene Dateien (Drag & Drop). In der Vorschau kommt nie ein Ereignis. */
  onFileDrop(handler: (event: FileDropEvent) => void): Promise<Unlisten>;
  /** Windows-Sicherheit „Ransomware-Schutz“ öffnen (ändert nichts). `null` in der Vorschau. */
  readonly openWindowsSecurity: (() => Promise<void>) | null;
}

/** Wandelt das Ergebnis des Auswahldialogs in eine Pfadliste. */
export function toPathList(selection: unknown): readonly string[] {
  if (typeof selection === 'string') {
    return [selection];
  }
  return Array.isArray(selection)
    ? selection.filter((p): p is string => typeof p === 'string')
    : [];
}

/** Prüft die Nutzdaten von `aegis://navigate`; Unbekanntes wird ignoriert (`null`). */
export function parseNavigatePayload(payload: unknown): NavigateTarget | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }
  const page = (payload as { readonly page?: unknown }).page;
  return page === 'dashboard' || page === 'settings' ? page : null;
}

/** Merkt sich ein einmal begonnenes Ergebnis; ein Fehlschlag darf später erneut versucht werden. */
function memoize<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

/** Echte Desktop-App: Aufrufe über `@tauri-apps/api` an das Hauptfenster. */
export function createTauriPlatform(): Platform {
  const current = getCurrentWindow();
  return {
    kind: 'tauri',
    window: {
      minimize: () => current.minimize(),
      toggleMaximize: () => current.toggleMaximize(),
      isMaximized: () => current.isMaximized(),
      onResized: (handler) => current.onResized(() => handler()),
      hideToTray: async () => parseHideOutcome(await invoke<unknown>('hide_to_tray')),
      close: () => current.close(),
    },
    appInfo: memoize(async () => parseAppInfo(await invoke<unknown>('app_info'))),
    onNavigate: (handler) =>
      current.listen<unknown>(NAVIGATE_EVENT, (event) => {
        const target = parseNavigatePayload(event.payload);
        if (target !== null) {
          handler(target);
        }
      }),
    service: createTauriService(),
    pickPaths: async (kind) =>
      toPathList(
        await openDialog(
          kind === 'folder' ? { directory: true } : { multiple: true, directory: false },
        ),
      ),
    onFileDrop: (handler) =>
      current.onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === 'drop') {
          handler({ type: 'drop', paths: toPathList(p.paths) });
        } else if (p.type === 'enter') {
          handler({ type: 'enter' });
        } else if (p.type === 'leave') {
          handler({ type: 'leave' });
        }
      }),
    openWindowsSecurity: () => invoke<undefined>('open_windows_security'),
  };
}

/**
 * Dienst-Befehle (`service_*`): jeder Aufruf steht hier wörtlich, damit
 * `tests/ipc-contract.test.ts` Aufrufe, Anmeldung (build.rs) und Rechte abgleichen kann.
 */
function createTauriService(): ServiceApi {
  return {
    scan: async (paths) => parseScan(await invoke<unknown>('service_scan', { paths })),
    listQuarantine: async () => parseQuarantine(await invoke<unknown>('service_list_quarantine')),
    proposeQuarantine: async (paths) =>
      parseProposal(await invoke<unknown>('service_propose_quarantine', { paths })),
    proposeRestore: async (entryId) =>
      parseProposal(await invoke<unknown>('service_propose_restore', { entryId })),
    proposeDelete: async (entryId) =>
      parseProposal(await invoke<unknown>('service_propose_delete', { entryId })),
    decide: async (proposal, decision, dialogId) =>
      parseDecision(
        await invoke<unknown>('service_decide', {
          planId: proposal.plan.id,
          digest: proposal.digest,
          nonce: proposal.nonce,
          decision,
          dialogId,
        }),
      ),
    confirmSecond: async (challenge, decision, dialogId) =>
      parseDecision(
        await invoke<unknown>('service_confirm_second', {
          challengeId: challenge.challengeId,
          nonce: challenge.nonce,
          decision,
          dialogId,
        }),
      ),
    listTrust: async () => parseTrust(await invoke<unknown>('service_list_trust')),
    revokeTrust: async (id) => {
      expectType(await invoke<unknown>('service_revoke_trust', { id }), 'trust_revoked');
    },
    watchPoll: async (after) => parseWatch(await invoke<unknown>('service_watch_poll', { after })),
    setGaming: async (on) => parseWatch(await invoke<unknown>('service_set_gaming', { on })),
    history: async () => parseHistory(await invoke<unknown>('service_history')),
    getSchedule: async () => parseSchedule(await invoke<unknown>('service_get_schedule')),
    setSchedule: async (enabled, everyDays, hourUtc) =>
      parseSchedule(await invoke<unknown>('service_set_schedule', { enabled, everyDays, hourUtc })),
    setClamavUpdate: async (on) =>
      parseSchedule(await invoke<unknown>('service_set_clamav_update', { on })),
    exportReport: async (english) => invoke<string | null>('export_report', { english }),
    labStatus: async () => parseLab(await invoke<unknown>('service_lab_status')),
    proposeLabRun: async (path, stage, seconds, network) =>
      parseProposal(
        await invoke<unknown>('service_propose_lab_run', { path, stage, seconds, network }),
      ),
    memoryScan: async () => parseMemoryScan(await invoke<unknown>('service_memory_scan')),
    panicStatus: async () => parsePanic(await invoke<unknown>('service_panic_status')),
    proposePanic: async (on) =>
      parseProposal(await invoke<unknown>('service_propose_panic', { on })),
    emergencyScan: async () => parseEmergency(await invoke<unknown>('service_emergency_scan')),
    proposeRestoreMany: async (entryIds) =>
      parseProposal(await invoke<unknown>('service_propose_restore_many', { entryIds })),
    safeStatus: async () => parseSafe(await invoke<unknown>('service_safe_status')),
    proposeSafeSetup: async (password) =>
      parseProposal(await invoke<unknown>('service_propose_safe_setup', { password })),
    safeUnlock: async (password) =>
      parseSafe(await invoke<unknown>('service_safe_unlock', { password })),
    safeLock: async () => parseSafe(await invoke<unknown>('service_safe_lock')),
    proposeSafeStore: async (paths) =>
      parseProposal(await invoke<unknown>('service_propose_safe_store', { paths })),
    proposeSafeRetrieve: async (id) =>
      parseProposal(await invoke<unknown>('service_propose_safe_retrieve', { id })),
    ransomStatus: async () => parseRansom(await invoke<unknown>('service_ransom_status')),
    backupStatus: async () => parseBackup(await invoke<unknown>('service_backup_status')),
    proposeBackup: async (on, quotaMb) =>
      parseProposal(await invoke<unknown>('service_propose_backup', { on, quotaMb })),
    proposeBackupRestore: async (id) =>
      parseProposal(await invoke<unknown>('service_propose_backup_restore', { id })),
    proposeBackupExport: async (folder) =>
      parseProposal(await invoke<unknown>('service_propose_backup_export', { folder })),
    proposeBackupPrune: async (days) =>
      parseProposal(await invoke<unknown>('service_propose_backup_prune', { days })),
    setProtectedFolders: async (folders) =>
      parseRansom(await invoke<unknown>('service_set_protected_folders', { folders })),
    proposeBaits: async (on) =>
      parseProposal(await invoke<unknown>('service_propose_baits', { on })),
    proposeProcessAction: async (program, action) =>
      parseProposal(await invoke<unknown>('service_propose_process_action', { program, action })),
    proposeEnableSandbox: async () =>
      parseProposal(await invoke<unknown>('service_propose_enable_sandbox')),
    labReport: async (runId) =>
      parseLabReportResponse(await invoke<unknown>('service_lab_report', { runId })),
    labScreenshot: async (runId, name) =>
      parseLabScreenshot(await invoke<unknown>('service_lab_screenshot', { runId, name })),
    labCaptureWindows: async (runId) => {
      const shots = await invoke<unknown>('lab_capture_windows', { runId });
      return Array.isArray(shots)
        ? shots.filter((s): s is string => typeof s === 'string').map(decodeBase64)
        : [];
    },
  };
}

/** Browser-Vorschau: keine Fensterknöpfe, keine Tray-Ereignisse, gekennzeichnete Werte. */
export function createBrowserPlatform(info: AppInfo): Platform {
  return {
    kind: 'browser',
    window: null,
    appInfo: () => Promise.resolve(info),
    onNavigate: () => Promise.resolve(() => undefined),
    service: null,
    pickPaths: null,
    onFileDrop: () => Promise.resolve(() => undefined),
    openWindowsSecurity: null,
  };
}

/** Wählt den Adapter passend zur Laufzeit (Tauri-WebView oder normaler Browser). */
export function detectPlatform(): Platform {
  if (isTauri()) {
    return createTauriPlatform();
  }
  return createBrowserPlatform(previewAppInfo(configuredVersion, import.meta.env.DEV));
}

/** Meldet einen Fehler eines Plattform-Aufrufs, ohne die Oberfläche abstürzen zu lassen. */
export function reportPlatformError(action: string, error: unknown): void {
  console.error(`AEGIS: ${action} fehlgeschlagen`, error);
}

/** Ruft eine Abmeldung auf und fängt synchrone wie asynchrone Fehler ab. */
function callUnlisten(unlisten: Unlisten): void {
  try {
    const result: unknown = unlisten();
    if (result instanceof Promise) {
      result.catch((error: unknown) => reportPlatformError('Abmelden', error));
    }
  } catch (error) {
    reportPlatformError('Abmelden', error);
  }
}

/**
 * Meldet einen asynchronen Empfänger an und gibt eine synchrone Aufräumfunktion zurück
 * (für `useEffect`). Wird schon vor dem Anmelden aufgeräumt (StrictMode, schneller
 * Seitenwechsel), meldet sie den Empfänger nach dem Anmelden sofort wieder ab.
 */
export function listenWhileMounted(action: string, start: () => Promise<Unlisten>): () => void {
  let disposed = false;
  let stop: Unlisten | undefined;
  start().then(
    (unlisten) => {
      if (disposed) {
        callUnlisten(unlisten);
      } else {
        stop = unlisten;
      }
    },
    (error: unknown) => reportPlatformError(action, error),
  );
  return () => {
    disposed = true;
    if (stop !== undefined) {
      callUnlisten(stop);
      stop = undefined;
    }
  };
}
