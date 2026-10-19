/**
 * Einordnung von Downloads (rein, testbar): ausführbare oder skriptfähige Dateien, doppelte
 * Endungen und Quellen ohne HTTPS. AEGIS markiert nur – die Datei prüft der Echtzeit-Wächter.
 */

const EXECUTABLE = new Set([
  'exe',
  'msi',
  'msix',
  'scr',
  'com',
  'pif',
  'bat',
  'cmd',
  'ps1',
  'vbs',
  'vbe',
  'js',
  'jse',
  'wsf',
  'hta',
  'jar',
  'lnk',
  'iso',
  'img',
  'vhd',
  'vhdx',
  'reg',
  'cpl',
  'dll',
  'appx',
]);
const DOCUMENT_MACRO = new Set(['docm', 'xlsm', 'pptm', 'xlam', 'dotm']);

export type DownloadRisk = 'executable' | 'macro' | 'double_extension' | 'insecure_source';

/** Hinweise zu einem Download. */
export function downloadRisks(filename: string, url: string): DownloadRisk[] {
  const name = (filename.split(/[\\/]/).pop() ?? '').toLowerCase();
  const parts = name.split('.');
  const ext = parts.length > 1 ? (parts[parts.length - 1] ?? '') : '';
  const out: DownloadRisk[] = [];
  if (EXECUTABLE.has(ext)) {
    out.push('executable');
  }
  if (DOCUMENT_MACRO.has(ext)) {
    out.push('macro');
  }
  const inner = parts.length > 2 ? (parts[parts.length - 2] ?? '') : '';
  if (
    EXECUTABLE.has(ext) &&
    ['pdf', 'doc', 'docx', 'jpg', 'png', 'txt', 'xlsx', 'mp4'].includes(inner)
  ) {
    out.push('double_extension');
  }
  if (url.startsWith('http:') && out.length > 0) {
    out.push('insecure_source');
  }
  return out;
}
