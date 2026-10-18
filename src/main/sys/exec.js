'use strict';
// Startet externe Windows-Programme (tasklist, reg, powershell ...) ohne Shell.
// Alles läuft mit den Rechten des angemeldeten Benutzers, nie als Administrator.

const { execFile, spawn } = require('node:child_process');

const IS_WIN = process.platform === 'win32';

class HelixError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function notOnWindows(what) {
  return new HelixError('NOT_WINDOWS', `${what} gibt es nur unter Windows.`);
}

/**
 * Führt ein Programm aus und liefert stdout als Text.
 * Wirft HelixError mit code 'EXEC_FAILED' oder 'EXEC_TIMEOUT'.
 */
function run(file, args = [], { timeout = 15000, input, encoding = 'utf8', allowExitCodes = [0], env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, {
      timeout,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      encoding: encoding === 'buffer' ? 'buffer' : 'utf8',
      env: env || process.env,
    }, (err, stdout, stderr) => {
      if (err && err.killed) {
        reject(new HelixError('EXEC_TIMEOUT', `${file} hat zu lange gebraucht.`));
        return;
      }
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      if (err && !allowExitCodes.includes(code)) {
        const e = new HelixError('EXEC_FAILED', `${file} ist fehlgeschlagen (Code ${err.code}).`, {
          code: err.code,
          stderr: String(stderr || '').slice(0, 2000),
          stdout: String(stdout || '').slice(0, 2000),
        });
        reject(e);
        return;
      }
      resolve(encoding === 'buffer' ? stdout : String(stdout), code);
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

/**
 * Führt ein PowerShell-Skript aus (Windows PowerShell 5.1, immer vorhanden).
 * Das Skript wird als Base64 übergeben, damit Anführungszeichen und Umlaute heil ankommen.
 * Die Ausgabe wird als UTF-8 erzwungen.
 */
async function powershell(script, { timeout = 30000, json = false } = {}) {
  if (!IS_WIN) throw notOnWindows('PowerShell');
  const prelude = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" +
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;';
  const encoded = Buffer.from(prelude + script, 'utf16le').toString('base64');
  const out = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
  ], { timeout });
  if (!json) return out;
  const text = out.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new HelixError('BAD_OUTPUT', 'PowerShell hat keine gültigen Daten geliefert.', { output: text.slice(0, 500) });
  }
}

/**
 * Startet ein dauerhaft laufendes PowerShell-Skript, das pro Zeile ein JSON-Objekt ausgibt.
 * Gibt eine Funktion zum Beenden zurück.
 */
function powershellStream(script, onObject, onExit) {
  if (!IS_WIN) throw notOnWindows('PowerShell');
  const prelude = "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;";
  const encoded = Buffer.from(prelude + script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { onObject(JSON.parse(line)); } catch { /* unvollständige Zeile ignorieren */ }
    }
  });
  child.on('exit', (code) => { if (onExit) onExit(code); });
  child.on('error', () => { if (onExit) onExit(-1); });
  return () => { try { child.kill(); } catch { /* schon beendet */ } };
}

// Konsolenprogramme (tasklist, powercfg …) schreiben in der OEM-Codepage (deutsch: 850), nicht UTF-8.
const CP850 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u00ad±‗¾¶§÷¸°¨·¹³²■\u00a0';

/** Liest Konsolen-Ausgabe: gültiges UTF-8 bleibt, sonst Codepage 850. */
function decodeConsole(buf) {
  if (typeof buf === 'string') return buf;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const utf8 = b.toString('utf8');
  if (!utf8.includes('\ufffd')) return utf8;
  let s = '';
  for (const byte of b) s += byte < 0x80 ? String.fromCharCode(byte) : CP850[byte - 0x80];
  return s;
}

module.exports = { run, powershell, powershellStream, decodeConsole, HelixError, notOnWindows, IS_WIN };
