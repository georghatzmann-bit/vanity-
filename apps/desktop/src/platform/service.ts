/**
 * Verbindung zum Dienst `aegis-service` über die App-Befehle `service_*`.
 *
 * Die Oberfläche führt nichts aus: Sie fragt an, zeigt Vorschläge im Freigabe-Dialog und reicht
 * die Antwort (mit der Einmal-Nonce des Dienstes) zurück. Antworten des Dienstes werden hier
 * nur grob geprüft und typisiert – vertraut wird ihnen für die Anzeige, nicht für Sicherheit.
 */
import {
  riskLevelFromCoreId,
  type ConsentDecision,
  type ConsentPlan,
  type RiskLevel,
} from '@aegis/ui';

/** Ein Fund aus dem Scan (Ausschnitt aus `aegis_engine::Finding`). */
export interface ScanFinding {
  readonly path: string;
  readonly sha256: string | null;
  readonly size: number;
  readonly risk: RiskLevel;
  readonly confidence: number;
  readonly category: string;
  readonly summaryDe: string;
  readonly summaryEn: string;
  readonly recommendation: 'none' | 'review' | 'quarantine';
  readonly reasons: readonly FindingReason[];
  readonly notScannable: string | null;
  /** Auffällige Inhalte von Archiven/Abbildern/Dokumenten. */
  readonly contained: readonly ContainedItem[];
  /** Vom Nutzer vertraut (Hash + Pfad) – die Stufe bleibt trotzdem sichtbar. */
  readonly trusted: { readonly id: string; readonly reason: string; readonly since: string } | null;
}

/** Eintrag der Vertrauensliste. */
export interface TrustEntry {
  readonly id: string;
  readonly sha256: string;
  readonly path: string;
  readonly reason: string;
  readonly createdAt: string;
}

/** Eine Begründung („Warum?“). */
export interface FindingReason {
  readonly code: string;
  readonly de: string;
  readonly en: string;
}

/** Auffälliger Inhalt eines Containers. */
export interface ContainedItem {
  readonly name: string;
  readonly risk: RiskLevel;
  readonly summaryDe: string;
  readonly summaryEn: string;
}

/** Ergebnis eines Scans. */
export interface ScanResult {
  readonly findings: readonly ScanFinding[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  readonly truncated: boolean;
}

/** Eintrag der Quarantäne. */
export interface QuarantineEntry {
  readonly id: string;
  readonly originalPath: string;
  readonly sha256: string;
  readonly size: number;
  readonly quarantinedAt: string;
  readonly reason: string;
}

/** Vorschlag des Dienstes für den Freigabe-Dialog. */
export interface Proposal {
  readonly plan: ConsentPlan;
  readonly digest: string;
  readonly nonce: string;
  /** „Vertrauen“ anbieten? Nur bei Isolieren-Vorschlägen (der Dienst prüft das ebenfalls). */
  readonly allowTrust: boolean;
}

/** Rückfrage vor endgültigem Löschen. */
export interface SecondChallenge {
  readonly challengeId: string;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly nonce: string;
}

/** Ergebnis einer Antwort. */
export type DecisionResult =
  | {
      readonly kind: 'executed';
      readonly ok: boolean;
      readonly message: string | null;
      /** Kennungen neuer bzw. betroffener Quarantäne-Einträge (für „Alles rückgängig“). */
      readonly entryIds: readonly string[];
    }
  | { readonly kind: 'nothing' }
  | { readonly kind: 'trusted'; readonly note: string }
  | { readonly kind: 'second'; readonly challenge: SecondChallenge };

/** Meldung des Echtzeit-Wächters. */
export interface WatchEvent {
  readonly seq: number;
  readonly at: string;
  readonly kind: 'file' | 'process' | 'ransomware';
  readonly path: string;
  readonly finding: ScanFinding;
}

/** Zustand des Echtzeit-Wächters. */
export interface WatchState {
  readonly events: readonly WatchEvent[];
  readonly active: boolean;
  readonly folders: readonly string[];
  readonly processes: boolean;
  readonly gaming: boolean;
  /** Restdauer des Gaming-Modus in Sekunden. */
  readonly gamingLeft: number | null;
  readonly pending: number;
  readonly dropped: number;
  readonly note: string | null;
}

/** Art eines Verlaufseintrags. */
export type HistoryKind = 'scan' | 'action' | 'decision' | 'watch' | 'schedule' | 'update' | 'lab';

/** Eintrag des Verlaufs (Bericht/Zeitleiste). */
export interface HistoryEntry {
  readonly seq: number;
  readonly at: string;
  readonly kind: HistoryKind;
  readonly risk: RiskLevel | null;
  readonly title: string;
  readonly detail: string;
  readonly paths: readonly string[];
}

/** Verlauf. */
export interface HistoryState {
  readonly entries: readonly HistoryEntry[];
  readonly saveFailed: boolean;
}

/** Eigener Zeitplan und Update-Einstellung. */
export interface ScheduleState {
  readonly schedule: {
    readonly enabled: boolean;
    readonly everyDays: 1 | 7 | 30;
    readonly hourUtc: number;
    readonly lastRun: string | null;
  } | null;
  readonly clamavAvailable: boolean;
  readonly clamavUpdateAvailable: boolean;
  readonly clamavUpdate: boolean;
  /** Darf das Konto rechnerweite Einstellungen ändern (Administrator)? */
  readonly canChangeGlobal: boolean;
  readonly lastUpdate: {
    readonly at: string;
    readonly ok: boolean;
    readonly message: string;
  } | null;
}

/** Labor-Stufe: 1 = Windows Sandbox (eigene VM), 2 = Mini-Sandbox (AppContainer). */
export type LabStage = 'windows_sandbox' | 'mini_sandbox';

/** Zustand der Windows Sandbox auf diesem Rechner. */
export interface SandboxStatus {
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly edition: string;
}

/** Art einer beobachteten Änderung. */
export type LabChange = 'created' | 'modified' | 'deleted';

/** Beobachtetes Verhalten (Einschätzung). */
export type LabBehavior =
  | 'autostart'
  | 'network'
  | 'encrypts_files'
  | 'deletes_backups'
  | 'drops_executables'
  | 'spawns_interpreters'
  | 'deletes_files';

/** Verhaltensbericht eines Laufs (nur Beobachtungen). */
export interface LabReport {
  readonly sha256: string | null;
  readonly end:
    | { readonly type: 'exited'; readonly code: number }
    | { readonly type: 'timed_out' }
    | { readonly type: 'failed'; readonly message: string };
  readonly processes: readonly {
    readonly pid: number;
    readonly parent: number;
    readonly image: string;
    readonly commandLine: string | null;
  }[];
  readonly files: readonly {
    readonly path: string;
    readonly change: LabChange;
    readonly size: number;
    readonly entropy: number | null;
  }[];
  readonly registry: readonly {
    readonly key: string;
    readonly value: string;
    readonly change: LabChange;
    readonly data: string | null;
  }[];
  readonly network: readonly {
    readonly remote: string;
    readonly port: number;
    readonly blocked: boolean;
  }[];
  readonly screenshots: readonly string[];
  readonly notes: readonly string[];
}

/** Einschätzung eines Laufs. */
export interface LabAssessment {
  readonly risk: RiskLevel;
  readonly behaviors: readonly LabBehavior[];
  readonly summaryDe: string;
  readonly summaryEn: string;
}

/** Zustand eines Laufs. */
export type LabRunState =
  | { readonly state: 'preparing' }
  | { readonly state: 'running' }
  | { readonly state: 'waiting_for_sandbox' }
  | { readonly state: 'done'; readonly assessment: LabAssessment }
  | { readonly state: 'failed'; readonly message: string };

/** Ein eigener Labor-Lauf. */
export interface LabRun {
  readonly id: string;
  readonly sample: string;
  readonly stage: LabStage;
  readonly seconds: number;
  readonly started: string;
  readonly state: LabRunState;
  /** AppContainer-SID (Stufe 2). */
  readonly container: string | null;
}

/** Labor: Sandbox-Zustand und eigene Läufe (neueste zuerst). */
export interface LabState {
  readonly sandbox: SandboxStatus;
  readonly miniAvailable: boolean;
  readonly runs: readonly LabRun[];
}

/** Ergebnis des Speicher-Scans. */
export interface MemoryScanResult {
  readonly result: ScanResult;
  readonly processes: number;
  readonly modules: number;
  readonly regions: number;
}

/** Panic-Button. */
export interface PanicState {
  /** Netz getrennt seit (ISO-Zeit) bzw. `null`. */
  readonly since: string | null;
  /** Gibt es den Panic-Button (Windows)? */
  readonly available: boolean;
}

/** Bereich des Notfall-Scans. */
export type EmergencyAreaId =
  'autostart' | 'downloads' | 'desktop' | 'temp' | 'appdata' | 'processes' | 'memory';

export interface EmergencyArea {
  readonly id: EmergencyAreaId;
  readonly checked: number;
  readonly findings: readonly ScanFinding[];
  readonly skipped: number;
  readonly note: string | null;
}

/** Ergebnis des Notfall-Scans (Panic-Button). */
export interface EmergencyResult {
  readonly areas: readonly EmergencyArea[];
  /** Funde im Arbeitsspeicher: Prozess + Programm (Reihenfolge wie im Bereich `memory`). */
  readonly memory: readonly { readonly pid: number; readonly program: string | null }[];
  readonly update: string;
}

const EMERGENCY_AREAS: readonly EmergencyAreaId[] = [
  'autostart',
  'downloads',
  'desktop',
  'temp',
  'appdata',
  'processes',
  'memory',
];

/** Eintrag im Datei-Safe. */
export interface SafeEntry {
  readonly id: string;
  readonly originalPath: string;
  readonly size: number;
  readonly sha256: string;
  readonly storedAt: string;
}

/** Datei-Safe des Kontos. */
export interface SafeState {
  readonly exists: boolean;
  readonly unlocked: boolean;
  /** Nur wenn entsperrt. */
  readonly entries: readonly SafeEntry[];
  readonly minPassword: number;
  /** Nach so vielen Minuten ohne Nutzung sperrt der Dienst den Safe. */
  readonly idleMinutes: number;
}

/** Eine gesicherte Version (Rückfall-Kopie). */
export interface BackupVersion {
  readonly id: string;
  readonly original: string;
  readonly size: number;
  readonly storedAt: string;
}

/** Rückfall-Kopien des Kontos. */
export interface BackupState {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly quotaMb: number;
  readonly files: number;
  readonly versions: number;
  readonly bytes: number;
  readonly lastRun: string | null;
  readonly note: string | null;
  readonly folders: readonly string[];
  readonly recent: readonly BackupVersion[];
}

/** Ransomware-Schutz des Kontos. */
export interface RansomState {
  /** Angelegte Köderdateien. */
  readonly baits: readonly string[];
  /** Standard-Schutzordner (Desktop, Dokumente, Bilder). */
  readonly defaultFolders: readonly string[];
  /** Eigene Schutzordner. */
  readonly folders: readonly string[];
  /** Kürzlich gestartete eigene Programme (zum Einfrieren im Alarm). */
  readonly recent: readonly string[];
  /** Windows „Überwachter Ordnerzugriff“. */
  readonly controlledFolderAccess: 'on' | 'off' | 'audit' | null;
}

/** Fehler des Dienstes (es wurde nichts ausgeführt, sofern nicht anders gesagt). */
export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

/** Dienst-Aufrufe (in der Browser-Vorschau nicht vorhanden). */
export interface ServiceApi {
  scan(paths: readonly string[]): Promise<ScanResult>;
  listQuarantine(): Promise<readonly QuarantineEntry[]>;
  proposeQuarantine(paths: readonly string[]): Promise<Proposal>;
  proposeRestore(entryId: string): Promise<Proposal>;
  proposeDelete(entryId: string): Promise<Proposal>;
  decide(proposal: Proposal, decision: ConsentDecision, dialogId: string): Promise<DecisionResult>;
  confirmSecond(
    challenge: SecondChallenge,
    decision: ConsentDecision,
    dialogId: string,
  ): Promise<DecisionResult>;
  listTrust(): Promise<readonly TrustEntry[]>;
  revokeTrust(id: string): Promise<void>;
  /** Meldungen des Wächters nach Nummer `after` (nur lesend). */
  watchPoll(after: number): Promise<WatchState>;
  /** Gaming-Modus an/aus (pausiert nur Prüfungen und Hinweise, endet nach spätestens 4 h). */
  setGaming(on: boolean): Promise<WatchState>;
  /** Eigener Verlauf (nur lesend). */
  history(): Promise<HistoryState>;
  getSchedule(): Promise<ScheduleState>;
  /** Geplanten Scan setzen – prüft und meldet nur. */
  setSchedule(enabled: boolean, everyDays: 1 | 7 | 30, hourUtc: number): Promise<ScheduleState>;
  setClamavUpdate(on: boolean): Promise<ScheduleState>;
  /** Bericht als HTML speichern (Ort wählt der Nutzer im Dialog); `null` = abgebrochen. */
  exportReport(english: boolean): Promise<string | null>;
  /** Labor: Zustand und eigene Läufe (nur lesend). */
  labStatus(): Promise<LabState>;
  /** Labor-Lauf vorschlagen – gestartet wird nur nach „Ja“ im Freigabe-Dialog. */
  proposeLabRun(
    path: string,
    stage: LabStage,
    seconds: number,
    network: boolean,
  ): Promise<Proposal>;
  /** Speicher-Scan der eigenen laufenden Programme (nur lesend). */
  memoryScan(): Promise<MemoryScanResult>;
  /** Panic-Button: Zustand (nur lesend). */
  panicStatus(): Promise<PanicState>;
  /** Netz trennen (`true`) bzw. wieder verbinden vorschlagen. */
  proposePanic(on: boolean): Promise<Proposal>;
  /** Notfall-Scan (nur lesend; stößt ein Signatur-Update an). */
  emergencyScan(): Promise<EmergencyResult>;
  /** „Alles rückgängig“: mehrere Quarantäne-Einträge in einem Plan wiederherstellen. */
  proposeRestoreMany(entryIds: readonly string[]): Promise<Proposal>;
  /** Datei-Safe: Zustand (Einträge nur, wenn entsperrt). */
  safeStatus(): Promise<SafeState>;
  /** Datei-Safe anlegen vorschlagen – das Passwort geht nur an den Dienst. */
  proposeSafeSetup(password: string): Promise<Proposal>;
  /** Datei-Safe entsperren (verändert nichts). */
  safeUnlock(password: string): Promise<SafeState>;
  /** Datei-Safe sperren. */
  safeLock(): Promise<SafeState>;
  /** Dateien in den Safe legen vorschlagen. */
  proposeSafeStore(paths: readonly string[]): Promise<Proposal>;
  /** Eintrag aus dem Safe holen vorschlagen. */
  proposeSafeRetrieve(id: string): Promise<Proposal>;
  /** Ransomware-Schutz: eigene Köderdateien (nur lesend). */
  ransomStatus(): Promise<RansomState>;
  /** Rückfall-Kopien: Zustand (nur lesend). */
  backupStatus(): Promise<BackupState>;
  /** Rückfall-Kopien ein- (`true`, Grenze in MiB) bzw. ausschalten vorschlagen. */
  proposeBackup(on: boolean, quotaMb: number): Promise<Proposal>;
  /** Version zurückholen vorschlagen. */
  proposeBackupRestore(id: string): Promise<Proposal>;
  /** Neueste Versionen in einen Ordner exportieren vorschlagen. */
  proposeBackupExport(folder: string): Promise<Proposal>;
  /** Alte Versionen ausdünnen vorschlagen (zweite Bestätigung). */
  proposeBackupPrune(days: 7 | 30 | 90 | 365): Promise<Proposal>;
  /** Eigene Schutzordner setzen (nur Beobachtung). */
  setProtectedFolders(folders: readonly string[]): Promise<RansomState>;
  /** Köderdateien anlegen (`true`) bzw. entfernen vorschlagen. */
  proposeBaits(on: boolean): Promise<Proposal>;
  /** Laufende Prozesse eines Programms beenden/anhalten/fortsetzen vorschlagen. */
  proposeProcessAction(
    program: string,
    action: 'terminate' | 'suspend' | 'resume',
  ): Promise<Proposal>;
  /** „Windows Sandbox einschalten“ vorschlagen (nur Administratoren). */
  proposeEnableSandbox(): Promise<Proposal>;
  /** Vollständiger Verhaltensbericht eines eigenen, fertigen Laufs (nur lesend). */
  labReport(runId: string): Promise<LabReport>;
  /** Bildschirmfoto eines eigenen Laufs der Windows Sandbox (PNG-Bytes). */
  labScreenshot(runId: string, name: string): Promise<Uint8Array>;
  /** Fensterfotos eines laufenden Mini-Sandbox-Laufs (PNG-Bytes; leer, wenn keine). */
  labCaptureWindows(runId: string): Promise<readonly Uint8Array[]>;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function arr(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Wirft bei `{type:"error"}` und prüft den erwarteten Typ. */
export function expectType(response: unknown, type: string): Json {
  if (!isObject(response)) {
    throw new ServiceError('invalid', 'Unerwartete Antwort des Dienstes.');
  }
  if (response['type'] === 'error') {
    throw new ServiceError(str(response['code'], 'error'), str(response['message'], 'Fehler'));
  }
  if (response['type'] !== type) {
    throw new ServiceError(
      'invalid',
      `Unerwartete Antwort des Dienstes (${str(response['type'])}).`,
    );
  }
  return response;
}

export function parseFinding(value: unknown): ScanFinding {
  const f = isObject(value) ? value : {};
  const rec = str(f['recommendation']);
  return {
    path: str(f['path']),
    sha256: typeof f['sha256'] === 'string' ? f['sha256'] : null,
    size: num(f['size']),
    risk: riskLevelFromCoreId(str(f['risk'])) ?? 'info',
    confidence: num(f['confidence']),
    category: str(f['category']),
    summaryDe: str(f['summary_de']),
    summaryEn: str(f['summary_en']),
    recommendation: rec === 'quarantine' || rec === 'review' ? rec : 'none',
    reasons: arr(f['reasons'])
      .filter(isObject)
      .map((r) => ({ code: str(r['code']), de: str(r['de']), en: str(r['en']) })),
    notScannable: typeof f['not_scannable'] === 'string' ? f['not_scannable'] : null,
    contained: arr(f['contained'])
      .filter(isObject)
      .map((c) => ({
        name: str(c['name']),
        risk: riskLevelFromCoreId(str(c['risk'])) ?? 'info',
        summaryDe: str(c['summary_de']),
        summaryEn: str(c['summary_en']),
      })),
    trusted: isObject(f['trusted'])
      ? {
          id: str(f['trusted']['id']),
          reason: str(f['trusted']['reason']),
          since: str(f['trusted']['since']),
        }
      : null,
  };
}

export function parseScan(response: unknown): ScanResult {
  const report = expectType(response, 'scan_report')['report'];
  const r = isObject(report) ? report : {};
  return {
    findings: arr(r['findings']).map(parseFinding),
    skipped: arr(r['skipped'])
      .filter(isObject)
      .map((s) => ({ path: str(s['path']), reason: str(s['reason']) })),
    truncated: r['truncated'] === true,
  };
}

export function parseQuarantine(response: unknown): readonly QuarantineEntry[] {
  return arr(expectType(response, 'quarantine')['entries'])
    .filter(isObject)
    .map((e) => ({
      id: str(e['id']),
      originalPath: str(e['original_path']),
      sha256: str(e['sha256']),
      size: num(e['size']),
      quarantinedAt: str(e['quarantined_at']),
      reason: str(e['reason']),
    }));
}

export function parseTrust(response: unknown): readonly TrustEntry[] {
  return arr(expectType(response, 'trust')['entries'])
    .filter(isObject)
    .map((e) => ({
      id: str(e['id']),
      sha256: str(e['sha256']),
      path: str(e['path']),
      reason: str(e['reason']),
      createdAt: str(e['created_at']),
    }));
}

export function parseWatch(response: unknown): WatchState {
  const r = expectType(response, 'watch');
  const s = isObject(r['status']) ? r['status'] : {};
  return {
    events: arr(r['events'])
      .filter(isObject)
      .map((e) => ({
        seq: num(e['seq']),
        at: str(e['at']),
        kind:
          e['kind'] === 'process'
            ? ('process' as const)
            : e['kind'] === 'ransomware'
              ? ('ransomware' as const)
              : ('file' as const),
        path: str(e['path']),
        finding: parseFinding(e['finding']),
      })),
    active: s['active'] === true,
    folders: arr(s['folders']).filter((f): f is string => typeof f === 'string'),
    processes: s['processes'] === true,
    gaming: s['gaming'] === true,
    gamingLeft: typeof r['gaming_left'] === 'number' ? r['gaming_left'] : null,
    pending: num(s['pending']),
    dropped: num(s['dropped']),
    note: typeof s['note'] === 'string' ? s['note'] : null,
  };
}

const historyKinds: readonly HistoryKind[] = [
  'scan',
  'action',
  'decision',
  'watch',
  'schedule',
  'update',
  'lab',
];

export function parseHistory(response: unknown): HistoryState {
  const r = expectType(response, 'history');
  return {
    entries: arr(r['entries'])
      .filter(isObject)
      .map((e) => {
        const kind = str(e['kind']);
        return {
          seq: num(e['seq']),
          at: str(e['at']),
          kind: historyKinds.find((k) => k === kind) ?? 'scan',
          risk: typeof e['risk'] === 'string' ? (riskLevelFromCoreId(e['risk']) ?? null) : null,
          title: str(e['title']),
          detail: str(e['detail']),
          paths: arr(e['paths']).filter((p): p is string => typeof p === 'string'),
        };
      }),
    saveFailed: r['save_failed'] === true,
  };
}

export function parseSchedule(response: unknown): ScheduleState {
  const r = expectType(response, 'schedule');
  const s = isObject(r['schedule']) ? r['schedule'] : null;
  const u = isObject(r['last_update']) ? r['last_update'] : null;
  const every = num(s?.['every_days']);
  return {
    schedule:
      s === null
        ? null
        : {
            enabled: s['enabled'] === true,
            everyDays: every === 1 || every === 30 ? every : 7,
            hourUtc: Math.min(23, Math.max(0, num(s['hour_utc']))),
            lastRun: typeof s['last_run'] === 'string' ? s['last_run'] : null,
          },
    clamavAvailable: r['clamav_available'] === true,
    clamavUpdateAvailable: r['clamav_update_available'] === true,
    clamavUpdate: r['clamav_update'] === true,
    canChangeGlobal: r['can_change_global'] === true,
    lastUpdate:
      u === null ? null : { at: str(u['at']), ok: u['ok'] === true, message: str(u['message']) },
  };
}

/** Base64 → Bytes (Bilder des Dienstes bzw. der App). */
export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const labBehaviors: readonly LabBehavior[] = [
  'autostart',
  'network',
  'encrypts_files',
  'deletes_backups',
  'drops_executables',
  'spawns_interpreters',
  'deletes_files',
];

function labChange(value: unknown): LabChange {
  return value === 'modified' || value === 'deleted' ? value : 'created';
}

function parseLabReport(value: unknown): LabReport {
  const r = isObject(value) ? value : {};
  const end = isObject(r['end']) ? r['end'] : {};
  return {
    sha256: typeof r['sha256'] === 'string' ? r['sha256'] : null,
    end:
      end['type'] === 'exited'
        ? { type: 'exited', code: num(end['code']) }
        : end['type'] === 'timed_out'
          ? { type: 'timed_out' }
          : { type: 'failed', message: str(end['message']) },
    processes: arr(r['processes'])
      .filter(isObject)
      .map((p) => ({
        pid: num(p['pid']),
        parent: num(p['parent']),
        image: str(p['image']),
        commandLine: typeof p['command_line'] === 'string' ? p['command_line'] : null,
      })),
    files: arr(r['files'])
      .filter(isObject)
      .map((f) => ({
        path: str(f['path']),
        change: labChange(f['change']),
        size: num(f['size']),
        entropy: typeof f['entropy'] === 'number' ? f['entropy'] : null,
      })),
    registry: arr(r['registry'])
      .filter(isObject)
      .map((g) => ({
        key: str(g['key']),
        value: str(g['value']),
        change: labChange(g['change']),
        data: typeof g['data'] === 'string' ? g['data'] : null,
      })),
    network: arr(r['network'])
      .filter(isObject)
      .map((n) => ({
        remote: str(n['remote']),
        port: num(n['port']),
        blocked: n['blocked'] === true,
      })),
    screenshots: arr(r['screenshots']).filter((s): s is string => typeof s === 'string'),
    notes: arr(r['notes']).filter((s): s is string => typeof s === 'string'),
  };
}

function parseLabRunState(value: unknown): LabRunState {
  const s = isObject(value) ? value : {};
  switch (s['state']) {
    case 'preparing':
      return { state: 'preparing' };
    case 'running':
      return { state: 'running' };
    case 'waiting_for_sandbox':
      return { state: 'waiting_for_sandbox' };
    case 'done': {
      const a = isObject(s['assessment']) ? s['assessment'] : {};
      return {
        state: 'done',
        assessment: {
          risk: riskLevelFromCoreId(str(a['risk'])) ?? 'info',
          behaviors: arr(a['behaviors']).flatMap((b) => labBehaviors.filter((k) => k === b)),
          summaryDe: str(a['summary_de']),
          summaryEn: str(a['summary_en']),
        },
      };
    }
    default:
      return { state: 'failed', message: str(s['message'], 'Unbekannter Zustand.') };
  }
}

export function parseLab(response: unknown): LabState {
  const r = expectType(response, 'lab');
  const s = isObject(r['sandbox']) ? r['sandbox'] : {};
  return {
    sandbox: {
      enabled: s['enabled'] === true,
      supported: s['supported'] === true,
      edition: str(s['edition']),
    },
    miniAvailable: r['mini_available'] === true,
    runs: arr(r['runs'])
      .filter(isObject)
      .map((run) => ({
        id: str(run['id']),
        sample: str(run['sample']),
        stage:
          run['stage'] === 'windows_sandbox'
            ? ('windows_sandbox' as const)
            : ('mini_sandbox' as const),
        seconds: num(run['seconds']),
        started: str(run['started']),
        state: parseLabRunState(run['state']),
        container: typeof run['container'] === 'string' ? run['container'] : null,
      })),
  };
}

export function parseMemoryScan(response: unknown): MemoryScanResult {
  const r = expectType(response, 'memory_scan');
  const report = isObject(r['report']) ? r['report'] : {};
  return {
    result: {
      findings: arr(report['findings']).map(parseFinding),
      skipped: arr(report['skipped'])
        .filter(isObject)
        .map((s) => ({ path: str(s['path']), reason: str(s['reason']) })),
      truncated: report['truncated'] === true,
    },
    processes: num(r['processes']),
    modules: num(r['modules']),
    regions: num(r['regions']),
  };
}

export function parsePanic(response: unknown): PanicState {
  const r = expectType(response, 'panic');
  return {
    since: typeof r['since'] === 'string' ? r['since'] : null,
    available: r['available'] === true,
  };
}

export function parseEmergency(response: unknown): EmergencyResult {
  const r = expectType(response, 'emergency_scan');
  return {
    areas: arr(r['areas'])
      .filter(isObject)
      .filter((a): a is typeof a & { id: EmergencyAreaId } =>
        (EMERGENCY_AREAS as readonly unknown[]).includes(a['id']),
      )
      .map((a) => ({
        id: a['id'] as EmergencyAreaId,
        checked: num(a['checked']),
        findings: arr(a['findings']).map(parseFinding),
        skipped: num(a['skipped']),
        note: typeof a['note'] === 'string' ? a['note'] : null,
      })),
    memory: arr(r['memory'])
      .filter(isObject)
      .map((m) => ({
        pid: num(m['pid']),
        program: typeof m['program'] === 'string' ? m['program'] : null,
      })),
    update: str(r['update']),
  };
}

export function parseSafe(response: unknown): SafeState {
  const r = expectType(response, 'safe');
  return {
    exists: r['exists'] === true,
    unlocked: r['unlocked'] === true,
    entries: arr(r['entries'])
      .filter(isObject)
      .map((e) => ({
        id: str(e['id']),
        originalPath: str(e['original_path']),
        size: num(e['size']),
        sha256: str(e['sha256']),
        storedAt: str(e['stored_at']),
      })),
    minPassword: num(r['min_password']),
    idleMinutes: num(r['idle_minutes']),
  };
}

export function parseBackup(response: unknown): BackupState {
  const s = expectType(response, 'backup')['state'];
  const st = isObject(s) ? s : {};
  const usage = isObject(st['usage']) ? st['usage'] : {};
  return {
    available: st['available'] === true,
    enabled: st['enabled'] === true,
    quotaMb: num(st['quota_mb']),
    files: num(usage['files']),
    versions: num(usage['versions']),
    bytes: num(usage['bytes']),
    lastRun: typeof st['last_run'] === 'string' ? st['last_run'] : null,
    note: typeof st['note'] === 'string' ? st['note'] : null,
    folders: arr(st['folders']).filter((f): f is string => typeof f === 'string'),
    recent: arr(st['versions'])
      .filter(isObject)
      .map((v) => ({
        id: str(v['id']),
        original: str(v['original']),
        size: num(v['size']),
        storedAt: str(v['stored_at']),
      })),
  };
}

export function parseRansom(response: unknown): RansomState {
  const r = expectType(response, 'ransom');
  const strings = (v: unknown) => arr(v).filter((b): b is string => typeof b === 'string');
  const cfa = r['controlled_folder_access'];
  return {
    baits: strings(r['baits']),
    defaultFolders: strings(r['default_folders']),
    folders: strings(r['folders']),
    recent: strings(r['recent']),
    controlledFolderAccess: cfa === 'on' || cfa === 'off' || cfa === 'audit' ? cfa : null,
  };
}

export function parseLabReportResponse(response: unknown): LabReport {
  return parseLabReport(expectType(response, 'lab_report')['report']);
}

export function parseLabScreenshot(response: unknown): Uint8Array {
  return decodeBase64(str(expectType(response, 'lab_screenshot')['png_base64']));
}

const kindLabels: Readonly<Record<string, string>> = {
  quarantine: 'In die Quarantäne verschieben',
  restore: 'Aus der Quarantäne wiederherstellen',
  delete_permanently: 'Endgültig löschen',
  run_in_sandbox: 'Im Labor ausführen',
  terminate_process: 'Prozess beenden',
  suspend_process: 'Prozess anhalten',
  resume_process: 'Prozess fortsetzen',
  change_setting: 'Einstellung ändern',
  safe_store: 'In den Datei-Safe legen',
  safe_retrieve: 'Aus dem Datei-Safe holen',
  restore_backup: 'Rückfall-Kopie zurückholen',
  export_backup: 'Rückfall-Kopien exportieren',
};

/** Wandelt den Vorschlag des Dienstes in die Form des Freigabe-Dialogs. */
export function parseProposal(response: unknown): Proposal {
  const proposal = expectType(response, 'proposal')['proposal'];
  const p = isObject(proposal) ? proposal : {};
  const plan = isObject(p['plan']) ? p['plan'] : {};
  const ticket = isObject(p['ticket']) ? p['ticket'] : {};
  const id = str(ticket['id']);
  const digest = str(ticket['digest']);
  const nonce = str(p['nonce']);
  if (id === '' || digest === '' || nonce === '') {
    throw new ServiceError('invalid', 'Unvollständiger Vorschlag des Dienstes – nichts angezeigt.');
  }
  const undo = isObject(plan['undo']) ? plan['undo'] : {};
  return {
    digest,
    nonce,
    allowTrust: plan['kind'] === 'quarantine',
    plan: {
      id,
      digest,
      kindLabel: kindLabels[str(plan['kind'])] ?? str(plan['kind']),
      severity: riskLevelFromCoreId(str(plan['severity'])) ?? 'info',
      targets: arr(plan['targets'])
        .filter(isObject)
        .map((t) =>
          t['type'] === 'setting'
            ? { type: 'setting' as const, id: str(t['id']) }
            : t['type'] === 'process'
              ? { type: 'process' as const, pid: num(t['pid']), image_path: str(t['image_path']) }
              : { type: 'file' as const, path: str(t['path']) },
        ),
      what: str(plan['what']),
      why: str(plan['why']),
      consequence: str(plan['consequence']),
      undo:
        undo['type'] === 'irreversible'
          ? { type: 'irreversible', warning: str(undo['warning']) }
          : { type: 'reversible', how: str(undo['how']) },
      expiresAt: str(ticket['expires_at']),
    },
  };
}

export function parseDecision(response: unknown): DecisionResult {
  if (!isObject(response)) {
    throw new ServiceError('invalid', 'Unerwartete Antwort des Dienstes.');
  }
  switch (response['type']) {
    case 'executed': {
      const result = isObject(response['result']) ? response['result'] : {};
      const status = str(result['status']);
      return {
        kind: 'executed',
        ok: status === 'succeeded',
        message: typeof result['message'] === 'string' ? result['message'] : null,
        entryIds: arr(response['entries'])
          .filter(isObject)
          .map((e) => str(e['id']))
          .filter((id) => id !== ''),
      };
    }
    case 'nothing_done':
      return { kind: 'nothing' };
    case 'trusted':
      return { kind: 'trusted', note: str(response['note']) };
    case 'second_confirmation_required': {
      const c = isObject(response['challenge']) ? response['challenge'] : {};
      return {
        kind: 'second',
        challenge: {
          challengeId: str(c['challenge_id']),
          notBefore: str(c['not_before']),
          expiresAt: str(c['expires_at']),
          nonce: str(response['nonce']),
        },
      };
    }
    default:
      expectType(response, 'executed');
      throw new ServiceError('invalid', 'Unerwartete Antwort des Dienstes.');
  }
}
