'use strict';
// PURE winget exit-code table (values from winget-cli src/AppInstallerSharedLib/Public/AppInstallerErrors.h).
// The exit code is the only reliable result signal – winget's text output is localized.

/** @typedef {'installed'|'already'|'failed'|'cancelled'} Status */
/** @typedef {null|'network'|'source'|'in-use'|'busy'|'user-lane'} Retry */

const E = {
  INTERNAL_ERROR: 0x8a150001,
  INVALID_CL_ARGUMENTS: 0x8a150002,
  COMMAND_FAILED: 0x8a150003,
  MANIFEST_FAILED: 0x8a150004,
  CTRL_SIGNAL_RECEIVED: 0x8a150005,
  SHELLEXEC_INSTALL_FAILED: 0x8a150006,
  DOWNLOAD_FAILED: 0x8a150008,
  INDEX_INTEGRITY_COMPROMISED: 0x8a15000a,
  SOURCES_INVALID: 0x8a15000b,
  SOURCE_DATA_MISSING: 0x8a15000f,
  NO_APPLICABLE_INSTALLER: 0x8a150010,
  INSTALLER_HASH_MISMATCH: 0x8a150011,
  SOURCE_NAME_DOES_NOT_EXIST: 0x8a150012,
  NO_APPLICATIONS_FOUND: 0x8a150014,
  NO_SOURCES_DEFINED: 0x8a150015,
  MULTIPLE_APPLICATIONS_FOUND: 0x8a150016,
  NO_MANIFEST_FOUND: 0x8a150017,
  COMMAND_REQUIRES_ADMIN: 0x8a150019,
  MSSTORE_BLOCKED_BY_POLICY: 0x8a15001b,
  MSSTORE_APP_BLOCKED_BY_POLICY: 0x8a15001c,
  MSSTORE_INSTALL_FAILED: 0x8a15001e,
  UPDATE_NOT_APPLICABLE: 0x8a15002b,
  INSTALLER_SECURITY_CHECK_FAILED: 0x8a15002d,
  DOWNLOAD_SIZE_MISMATCH: 0x8a15002e,
  BLOCKED_BY_POLICY: 0x8a15003a,
  SOURCE_DATA_INTEGRITY_FAILURE: 0x8a15003f,
  PACKAGE_AGREEMENTS_NOT_ACCEPTED: 0x8a150041,
  SOURCE_OPEN_FAILED: 0x8a150045,
  SOURCE_AGREEMENTS_NOT_ACCEPTED: 0x8a150046,
  MSI_INSTALL_FAILED: 0x8a150049,
  FAILED_TO_OPEN_ALL_SOURCES: 0x8a15004b,
  DEPENDENCIES_VALIDATION_FAILED: 0x8a15004c,
  MISSING_PACKAGE: 0x8a15004d,
  UPGRADE_VERSION_NOT_NEWER: 0x8a15004f,
  UPGRADE_VERSION_UNKNOWN: 0x8a150050,
  PORTABLE_INSTALL_FAILED: 0x8a150052,
  INSTALLER_PROHIBITS_ELEVATION: 0x8a150056,
  UNSUPPORTED_ARGUMENT: 0x8a150059,
  EXTRACT_ARCHIVE_FAILED: 0x8a15005c,
  INSTALL_LOCATION_REQUIRED: 0x8a15005f,
  PACKAGE_ALREADY_INSTALLED: 0x8a150061,
  APPTERMINATION_RECEIVED: 0x8a15006a,
  DOWNLOAD_DEPENDENCIES: 0x8a15006b,
  SERVICE_UNAVAILABLE: 0x8a15006d,
  AUTHENTICATION_FAILED: 0x8a150075,
  ADMIN_CONTEXT_ACTION_PROHIBITED: 0x8a15007d,
  INSTALLER_ZERO_BYTE_FILE: 0x8a150086,
  INSTALL_PACKAGE_IN_USE: 0x8a150101,
  INSTALL_INSTALL_IN_PROGRESS: 0x8a150102,
  INSTALL_FILE_IN_USE: 0x8a150103,
  INSTALL_MISSING_DEPENDENCY: 0x8a150104,
  INSTALL_DISK_FULL: 0x8a150105,
  INSTALL_INSUFFICIENT_MEMORY: 0x8a150106,
  INSTALL_NO_NETWORK: 0x8a150107,
  INSTALL_CONTACT_SUPPORT: 0x8a150108,
  INSTALL_REBOOT_REQUIRED_TO_FINISH: 0x8a150109,
  INSTALL_REBOOT_REQUIRED_FOR_INSTALL: 0x8a15010a,
  INSTALL_REBOOT_INITIATED: 0x8a15010b,
  INSTALL_CANCELLED_BY_USER: 0x8a15010c,
  INSTALL_ALREADY_INSTALLED: 0x8a15010d,
  INSTALL_DOWNGRADE: 0x8a15010e,
  INSTALL_BLOCKED_BY_POLICY: 0x8a15010f,
  INSTALL_DEPENDENCIES: 0x8a150110,
  INSTALL_PACKAGE_IN_USE_BY_APPLICATION: 0x8a150111,
  INSTALL_INVALID_PARAMETER: 0x8a150112,
  INSTALL_SYSTEM_NOT_SUPPORTED: 0x8a150113,
  INSTALL_UPGRADE_NOT_SUPPORTED: 0x8a150114,
  INSTALL_CUSTOM_ERROR: 0x8a150115,
  UPDATE_INSTALL_TECHNOLOGY_MISMATCH: 0x8a15008e,
  PROMPT_INPUT_ERROR: 0x8a150042,
  // non-winget HRESULTs that winget passes through as exit codes
  HR_CANCELLED: 0x800704c7, // UAC prompt declined
  HR_ABORT: 0x80004004,
  HR_ACCESS_DENIED: 0x80070005,
  HR_DISK_FULL: 0x80070070,
  HR_NAME_NOT_RESOLVED: 0x80072ee7,
  HR_CANNOT_CONNECT: 0x80072efd,
  HR_TIMEOUT: 0x80072ee2,
  HR_CONNECTION_ABORTED: 0x80072efe,
  HR_SECURE_FAILURE: 0x80072f8f,
  HR_HTTP_403: 0x80190193,
  HR_HTTP_404: 0x80190194,
};

const NAMES = new Map(Object.entries(E).map(([k, v]) => [v, k]));

// [status, retry, rebootRequired, German message]
const TABLE = new Map([
  [E.PACKAGE_ALREADY_INSTALLED, ['already', null, false, 'War bereits installiert.']],
  [E.INSTALL_ALREADY_INSTALLED, ['already', null, false, 'War bereits installiert.']],
  [E.UPDATE_NOT_APPLICABLE, ['already', null, false, 'Bereits installiert und aktuell.']],
  [E.UPGRADE_VERSION_NOT_NEWER, ['already', null, false, 'Bereits in einer aktuellen Version installiert.']],
  [E.INSTALL_DOWNGRADE, ['already', null, false, 'Eine neuere Version ist bereits installiert.']],
  // (winget normally converts this one to exit 0 for single installs; kept for safety)
  [E.INSTALL_REBOOT_REQUIRED_TO_FINISH, ['installed', null, true, 'Installiert – ein Neustart schließt die Installation ab.']],
  [E.INSTALL_REBOOT_INITIATED, ['installed', null, true, 'Installiert – Windows möchte neu starten.']],
  [E.INSTALL_REBOOT_REQUIRED_FOR_INSTALL, ['failed', null, true, 'Windows muss erst neu starten. Danach diese App erneut installieren.']],
  [E.INSTALLER_PROHIBITS_ELEVATION, ['failed', 'user-lane', false, 'Diese App darf nicht als Administrator installiert werden.']],
  [E.ADMIN_CONTEXT_ACTION_PROHIBITED, ['failed', 'user-lane', false, 'Diese App darf nicht als Administrator installiert werden.']],
  [E.COMMAND_REQUIRES_ADMIN, ['failed', null, false, 'Für diese App werden Administratorrechte benötigt.']],
  [E.DOWNLOAD_FAILED, ['failed', 'network', false, 'Download fehlgeschlagen – bitte Internetverbindung prüfen.']],
  [E.INSTALL_NO_NETWORK, ['failed', 'network', false, 'Keine Internetverbindung.']],
  [E.DOWNLOAD_SIZE_MISMATCH, ['failed', 'network', false, 'Download unvollständig.']],
  [E.INSTALLER_ZERO_BYTE_FILE, ['failed', 'network', false, 'Download war leer.']],
  [E.SERVICE_UNAVAILABLE, ['failed', 'network', false, 'Der Download-Server ist gerade nicht erreichbar.']],
  [E.INSTALLER_HASH_MISMATCH, ['failed', 'source', false, 'Der Hersteller hat den Installer geändert (Prüfsumme passt nicht). Später erneut versuchen.']],
  [E.SOURCE_OPEN_FAILED, ['failed', 'source', false, 'Die winget-Paketquelle konnte nicht geöffnet werden.']],
  [E.FAILED_TO_OPEN_ALL_SOURCES, ['failed', 'source', false, 'Die winget-Paketquellen konnten nicht geöffnet werden.']],
  [E.SOURCE_AGREEMENTS_NOT_ACCEPTED, ['failed', 'source', false, 'Die Bedingungen der Paketquelle wurden nicht akzeptiert.']],
  [E.SOURCE_DATA_MISSING, ['failed', 'source', false, 'Die Paketquelle ist unvollständig.']],
  [E.SOURCE_DATA_INTEGRITY_FAILURE, ['failed', 'source', false, 'Die Paketquelle ist beschädigt.']],
  [E.INDEX_INTEGRITY_COMPROMISED, ['failed', 'source', false, 'Die Paketquelle ist beschädigt.']],
  [E.SOURCES_INVALID, ['failed', 'source', false, 'Die winget-Paketquellen sind ungültig.']],
  [E.NO_SOURCES_DEFINED, ['failed', 'source', false, 'Es ist keine winget-Paketquelle eingerichtet.']],
  [E.SOURCE_NAME_DOES_NOT_EXIST, ['failed', 'source', false, 'Die benötigte Paketquelle fehlt.']],
  [E.INSTALL_PACKAGE_IN_USE, ['failed', 'in-use', false, 'Die App läuft gerade – bitte schließen und erneut versuchen.']],
  [E.INSTALL_FILE_IN_USE, ['failed', 'in-use', false, 'Eine Datei der App wird gerade benutzt – bitte die App schließen.']],
  [E.INSTALL_PACKAGE_IN_USE_BY_APPLICATION, ['failed', 'in-use', false, 'Die App wird gerade benutzt – bitte schließen.']],
  [E.INSTALL_INSTALL_IN_PROGRESS, ['failed', 'busy', false, 'Es läuft bereits eine andere Installation.']],
  [E.NO_APPLICATIONS_FOUND, ['failed', null, false, 'Paket nicht gefunden – evtl. umbenannt oder entfernt.']],
  [E.NO_MANIFEST_FOUND, ['failed', null, false, 'Paket nicht gefunden.']],
  [E.MISSING_PACKAGE, ['failed', null, false, 'Paket nicht gefunden.']],
  [E.MULTIPLE_APPLICATIONS_FOUND, ['failed', null, false, 'Mehrere passende Pakete gefunden.']],
  [E.NO_APPLICABLE_INSTALLER, ['failed', null, false, 'Kein passender Installer für dieses System.']],
  [E.INSTALL_SYSTEM_NOT_SUPPORTED, ['failed', null, false, 'Diese App unterstützt dein System nicht.']],
  [E.INSTALL_DISK_FULL, ['failed', null, false, 'Nicht genug Speicherplatz.']],
  [E.INSTALL_INSUFFICIENT_MEMORY, ['failed', null, false, 'Nicht genug Arbeitsspeicher.']],
  [E.INSTALL_BLOCKED_BY_POLICY, ['failed', null, false, 'Durch eine Richtlinie blockiert.']],
  [E.BLOCKED_BY_POLICY, ['failed', null, false, 'Durch eine Richtlinie blockiert.']],
  [E.MSSTORE_BLOCKED_BY_POLICY, ['failed', null, false, 'Der Microsoft Store ist blockiert.']],
  [E.MSSTORE_APP_BLOCKED_BY_POLICY, ['failed', null, false, 'Die Microsoft-Store-App ist blockiert.']],
  [E.MSSTORE_INSTALL_FAILED, ['failed', 'network', false, 'Installation aus dem Microsoft Store fehlgeschlagen.']],
  [E.INSTALL_MISSING_DEPENDENCY, ['failed', null, false, 'Eine benötigte Komponente fehlt.']],
  [E.INSTALL_DEPENDENCIES, ['failed', null, false, 'Abhängigkeiten konnten nicht installiert werden.']],
  [E.DEPENDENCIES_VALIDATION_FAILED, ['failed', null, false, 'Abhängigkeiten konnten nicht geprüft werden.']],
  [E.DOWNLOAD_DEPENDENCIES, ['failed', 'network', false, 'Abhängigkeiten konnten nicht geladen werden.']],
  [E.PACKAGE_AGREEMENTS_NOT_ACCEPTED, ['failed', null, false, 'Die Lizenzbedingungen des Pakets wurden nicht akzeptiert.']],
  [E.INSTALLER_SECURITY_CHECK_FAILED, ['failed', null, false, 'Der Installer wurde von der Sicherheitsprüfung blockiert.']],
  [E.INSTALL_CANCELLED_BY_USER, ['failed', null, false, 'Installation abgebrochen (z. B. Windows-Abfrage mit „Nein“ beantwortet).']],
  [E.CTRL_SIGNAL_RECEIVED, ['cancelled', null, false, 'Abgebrochen.']],
  [E.APPTERMINATION_RECEIVED, ['cancelled', null, false, 'Abgebrochen.']],
  [E.SHELLEXEC_INSTALL_FAILED, ['failed', null, false, 'Der Installer der App ist mit einem Fehler beendet worden.']],
  [E.MSI_INSTALL_FAILED, ['failed', null, false, 'Der MSI-Installer ist fehlgeschlagen.']],
  [E.INSTALL_CONTACT_SUPPORT, ['failed', null, false, 'Der Installer meldet einen Fehler.']],
  [E.INSTALL_CUSTOM_ERROR, ['failed', null, false, 'Der Installer meldet einen eigenen Fehler.']],
  [E.INSTALL_INVALID_PARAMETER, ['failed', null, false, 'Der Installer lehnt die Parameter ab.']],
  [E.INSTALL_UPGRADE_NOT_SUPPORTED, ['failed', null, false, 'Ein Update dieser App wird nicht unterstützt.']],
  [E.EXTRACT_ARCHIVE_FAILED, ['failed', null, false, 'Das Archiv konnte nicht entpackt werden.']],
  [E.PORTABLE_INSTALL_FAILED, ['failed', null, false, 'Installation der portablen App fehlgeschlagen.']],
  [E.AUTHENTICATION_FAILED, ['failed', null, false, 'Anmeldung bei der Paketquelle fehlgeschlagen.']],
  [E.INVALID_CL_ARGUMENTS, ['failed', null, false, 'winget kennt einen Parameter nicht – bitte winget aktualisieren.']],
  [E.UNSUPPORTED_ARGUMENT, ['failed', null, false, 'Der Installer unterstützt einen Parameter nicht – bitte winget aktualisieren.']],
  [E.INSTALL_LOCATION_REQUIRED, ['failed', null, false, 'Der Installer braucht einen Installationsordner.']],
  [E.UPDATE_INSTALL_TECHNOLOGY_MISMATCH, ['already', null, false, 'Bereits installiert (andere Installationsart).']],
  [E.PROMPT_INPUT_ERROR, ['failed', null, false, 'winget wollte eine Rückfrage stellen – bitte erneut versuchen.']],
  [E.HR_CANCELLED, ['failed', null, false, 'Die Windows-Abfrage (Admin-Rechte) wurde abgelehnt.']],
  [E.HR_ABORT, ['cancelled', null, false, 'Abgebrochen.']],
  [E.HR_ACCESS_DENIED, ['failed', null, false, 'Zugriff verweigert.']],
  [E.HR_DISK_FULL, ['failed', null, false, 'Nicht genug Speicherplatz für den Download.']],
  [E.HR_NAME_NOT_RESOLVED, ['failed', 'network', false, 'Keine Internetverbindung (Server nicht gefunden).']],
  [E.HR_CANNOT_CONNECT, ['failed', 'network', false, 'Keine Verbindung zum Download-Server.']],
  [E.HR_TIMEOUT, ['failed', 'network', false, 'Zeitüberschreitung beim Download.']],
  [E.HR_CONNECTION_ABORTED, ['failed', 'network', false, 'Die Verbindung wurde unterbrochen.']],
  [E.HR_SECURE_FAILURE, ['failed', 'network', false, 'Sichere Verbindung fehlgeschlagen – stimmen Datum und Uhrzeit des PCs?']],
  [E.HR_HTTP_403, ['failed', 'source', false, 'Der Download wurde vom Server verweigert (403).']],
  [E.HR_HTTP_404, ['failed', 'source', false, 'Der Download wurde nicht gefunden (404) – Paket evtl. veraltet.']],
]);

/** Converts whatever Node reports (signed or unsigned) into an unsigned 32-bit number. */
function toUnsigned(code) {
  const n = Number(code);
  return Number.isFinite(n) ? n >>> 0 : NaN;
}

function toHex(code) {
  const u = toUnsigned(code);
  return Number.isNaN(u) ? '' : `0x${u.toString(16).toUpperCase().padStart(8, '0')}`;
}

/**
 * @returns {{status: Status, retry: Retry, rebootRequired: boolean, message: string, code: number, codeHex: string, name: string}}
 */
function classify(exitCode) {
  const code = toUnsigned(exitCode);
  const codeHex = toHex(code);
  if (code === 0) return { status: 'installed', retry: null, rebootRequired: false, message: 'Erfolgreich installiert.', code, codeHex, name: 'OK' };
  const row = TABLE.get(code);
  if (row) {
    const [status, retry, rebootRequired, message] = row;
    return { status, retry, rebootRequired, message, code, codeHex, name: NAMES.get(code) || '' };
  }
  const message = code >>> 16 === 0x8a15
    ? `winget-Fehler ${codeHex}.`
    : `Der Installer ist mit Code ${code > 0x7fffffff ? codeHex : code} beendet worden.`;
  return { status: 'failed', retry: null, rebootRequired: false, message, code, codeHex, name: NAMES.get(code) || '' };
}

module.exports = { E, classify, toUnsigned, toHex };
