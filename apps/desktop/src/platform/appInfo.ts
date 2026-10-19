/**
 * App-Informationen für „Über AEGIS“ und die Statuszeile.
 *
 * In der Desktop-App liefert der Rust-Befehl `app_info` die Werte (einmal beim Start erhoben,
 * siehe apps/desktop/README.md, „IPC-Vertrag“). Die Antwort wird hier geprüft, statt ihr blind
 * zu vertrauen: Ein unerwartetes Format ergibt einen klaren Fehler, keine halb gefüllte Anzeige.
 * In der Browser-Vorschau gibt es keinen Rust-Teil – dann stehen ausdrücklich als Vorschau
 * gekennzeichnete Ersatzwerte da (`source: 'preview'`), nie erfundene Systemangaben.
 */

export type BuildProfile = 'debug' | 'release';

export interface AppInfo {
  /** Woher die Werte stammen: echte Desktop-App oder Browser-Vorschau. */
  readonly source: 'tauri' | 'preview';
  readonly version: string;
  readonly buildProfile: BuildProfile;
  /** `windows` | `linux` | `macos` | … – in der Vorschau `null` (unbekannt). */
  readonly os: string | null;
  /** z. B. `10.0.22631.4317`; `null`, wenn unbekannt. */
  readonly osVersion: string | null;
  /** z. B. `x86_64`; in der Vorschau `null`. */
  readonly arch: string | null;
  /** z. B. `2.12.4`; in der Vorschau `null`. */
  readonly tauriVersion: string | null;
  /**
   * Gibt es ein Symbol im Infobereich, über das ein verstecktes Fenster zurückkommt? Nur dann
   * versteckt „Schließen“ das Fenster (Einstellung „Beim Schließen in den Infobereich“).
   * In der Vorschau `false`.
   */
  readonly trayAvailable: boolean;
}

/** Obergrenze für einzelne Textwerte – schützt die Anzeige vor absurd langen Antworten. */
const MAX_FIELD_LENGTH = 200;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_FIELD_LENGTH) {
    throw new TypeError(`app_info: „${key}“ fehlt oder ist kein gültiger Text.`);
  }
  return value;
}

/**
 * Prüft die Antwort von `app_info` (Form laut IPC-Vertrag) und wirft bei Abweichungen.
 * `osVersion` muss als Schlüssel vorhanden sein (Text oder `null`).
 */
export function parseAppInfo(value: unknown): AppInfo {
  if (!isRecord(value)) {
    throw new TypeError('app_info: Antwort ist kein Objekt.');
  }
  const buildProfile = value['buildProfile'];
  if (buildProfile !== 'debug' && buildProfile !== 'release') {
    throw new TypeError('app_info: „buildProfile“ ist weder „debug“ noch „release“.');
  }
  if (!('osVersion' in value)) {
    throw new TypeError('app_info: „osVersion“ fehlt.');
  }
  const trayAvailable = value['trayAvailable'];
  if (typeof trayAvailable !== 'boolean') {
    throw new TypeError('app_info: „trayAvailable“ ist kein Wahrheitswert.');
  }
  const osVersion = value['osVersion'];
  if (
    osVersion !== null &&
    (typeof osVersion !== 'string' || osVersion.length > MAX_FIELD_LENGTH)
  ) {
    throw new TypeError('app_info: „osVersion“ ist weder Text noch null.');
  }
  return {
    source: 'tauri',
    version: text(value, 'version'),
    buildProfile,
    os: text(value, 'os'),
    osVersion: osVersion === null || osVersion.trim() === '' ? null : osVersion,
    arch: text(value, 'arch'),
    tauriVersion: text(value, 'tauriVersion'),
    trayAvailable,
  };
}

/**
 * Ersatzwerte der Browser-Vorschau: Version aus derselben Quelle wie die App
 * (tauri.conf.json), Build-Profil aus dem Vite-Modus, keine Systemangaben.
 */
export function previewAppInfo(version: string, dev: boolean): AppInfo {
  return {
    source: 'preview',
    version,
    buildProfile: dev ? 'debug' : 'release',
    os: null,
    osVersion: null,
    arch: null,
    tauriVersion: null,
    trayAvailable: false,
  };
}
