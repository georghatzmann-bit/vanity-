'use strict';
// Laufende Programme auflisten und (auf Wunsch) normal schließen.
// Nur Programme des angemeldeten Benutzers, keine Systemdienste.

const { run, IS_WIN, notOnWindows } = require('./exec');

/** Zerlegt eine CSV-Zeile von tasklist ("a","b","c"). */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Wandelt die Ausgabe von `tasklist /FO CSV /NH` in Objekte um. */
function parseTasklist(text) {
  const list = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('"')) continue; // "INFO: keine Aufgaben ..." u. Ä.
    const cols = parseCsvLine(line);
    if (cols.length < 2) continue;
    const pid = Number.parseInt(cols[1], 10);
    if (!Number.isFinite(pid)) continue;
    const memKb = Number.parseInt(String(cols[4] || '').replace(/[^0-9]/g, ''), 10);
    list.push({ name: cols[0], pid, session: cols[2] || '', memKb: Number.isFinite(memKb) ? memKb : null });
  }
  return list;
}

async function listProcesses({ filter } = {}, exec = run) {
  if (!IS_WIN && exec === run) throw notOnWindows('Die Prozessliste');
  const args = ['/FO', 'CSV', '/NH'];
  if (filter) args.push('/FI', `IMAGENAME eq ${filter}`);
  const out = await exec('tasklist.exe', args, { timeout: 10000 });
  return parseTasklist(out);
}

/**
 * Schließt Programme über ihren Dateinamen.
 * force=false: normales Schließen (wie das X am Fenster).
 * force=true: sofort beenden (wie Task-Manager "Task beenden").
 * Rückgabe: Liste der Namen, die taskkill angenommen hat.
 */
async function closeByName(names, { force = false, tree = false } = {}, exec = run) {
  if (!IS_WIN && exec === run) throw notOnWindows('Programme schließen');
  const done = [];
  for (const name of names) {
    if (!/^[\w .()+\-]+\.exe$/i.test(name)) continue; // nur einfache Dateinamen
    const args = ['/IM', name];
    if (tree) args.push('/T');
    if (force) args.push('/F');
    try {
      await exec('taskkill.exe', args, { timeout: 15000, allowExitCodes: [0, 1, 128, 255] });
      done.push(name);
    } catch { /* wird über erneute Prüfung erkannt */ }
  }
  return done;
}

async function closeByPid(pids, { force = false } = {}, exec = run) {
  if (!IS_WIN && exec === run) throw notOnWindows('Programme schließen');
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 4) continue;
    const args = ['/PID', String(pid)];
    if (force) args.push('/F');
    try {
      await exec('taskkill.exe', args, { timeout: 15000, allowExitCodes: [0, 1, 128, 255] });
    } catch { /* wird über erneute Prüfung erkannt */ }
  }
}

module.exports = { parseCsvLine, parseTasklist, listProcesses, closeByName, closeByPid };
