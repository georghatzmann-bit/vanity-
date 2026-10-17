'use strict';
// Windows PowerShell 5.1 runner. Scripts are written to a temp .ps1 (ASCII only) and their
// stdout is forced to UTF-8, so German umlauts in names/paths survive.
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const JSON_MARK = '@@PHXJSON@@';

const PREAMBLE = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  // Emits one JSON document on its own line, recognised by runPsJson(). Non-ASCII is escaped
  // to \\uXXXX so the result survives any console code page. -InputObject keeps 1-item arrays.
  'function Write-PhxJson($obj) {',
  '  $json = ConvertTo-Json -InputObject $obj -Depth 6 -Compress',
  "  $json = [regex]::Replace($json, '[^\\x00-\\x7F]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value })",
  `  [Console]::Out.WriteLine('${JSON_MARK}' + $json)`,
  '}',
  '',
].join('\r\n');

function powershellExe() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(full) ? full : 'powershell.exe';
}

function killTree(pid) {
  if (!pid) return;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } catch {
    /* process already gone */
  }
}

/**
 * Runs a PowerShell script.
 * @param {string} script  ASCII-only script body (preamble is prepended automatically)
 * @param {{args?: string[], timeoutMs?: number, onLine?: (line: string) => void, raw?: boolean, env?: object}} [opts]
 * @returns {Promise<{code: number, stdout: string, stderr: string, timedOut: boolean}>}
 */
function runPs(script, opts = {}) {
  const { args = [], timeoutMs = 120000, onLine, raw = false, env } = opts;
  if (/[^\x00-\x7F]/.test(script)) {
    return Promise.reject(new Error('Interner Fehler: PowerShell-Skript enthält Nicht-ASCII-Zeichen.'));
  }
  const dir = path.join(os.tmpdir(), 'phoenix');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `ps-${crypto.randomUUID()}.ps1`);
  // raw: the script brings its own param() block, which must be the first statement
  fs.writeFileSync(file, (raw ? '' : PREAMBLE) + script, 'ascii');

  return new Promise((resolve, reject) => {
    const child = spawn(
      powershellExe(),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-File', file, ...args],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : process.env },
    );
    const out = [];
    const err = [];
    let pending = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    child.stdout.on('data', (buf) => {
      out.push(buf);
      if (!onLine) return;
      pending += buf.toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) if (line) onLine(line);
    });
    child.stderr.on('data', (buf) => err.push(buf));
    child.on('error', (e) => {
      clearTimeout(timer);
      fs.rm(file, { force: true }, () => {});
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rm(file, { force: true }, () => {});
      if (onLine && pending) onLine(pending);
      resolve({
        code: code == null ? -1 : code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
      });
    });
  });
}

/** Parses the last Write-PhxJson document from a script's output. */
function parsePhxJson(stdout) {
  const lines = stdout.split(/\r?\n/).filter((l) => l.startsWith(JSON_MARK));
  if (!lines.length) return undefined;
  return JSON.parse(lines[lines.length - 1].slice(JSON_MARK.length));
}

/** Runs a script that calls Write-PhxJson and returns the parsed value. */
async function runPsJson(script, opts = {}) {
  const res = await runPs(script, opts);
  const value = parsePhxJson(res.stdout);
  if (value === undefined) {
    const why = res.timedOut ? 'Zeitüberschreitung' : (res.stderr || res.stdout).trim().slice(0, 400);
    throw new Error(`PowerShell lieferte kein Ergebnis (${why || `Exit-Code ${res.code}`}).`);
  }
  return value;
}

module.exports = { runPs, runPsJson, parsePhxJson, killTree, powershellExe, JSON_MARK };
