'use strict';
// Erkennt, ob Fortnite läuft, und schließt es auf Wunsch.
// Es werden nur Fortnite-eigene Programme geschlossen – nie Anti-Cheat-Dienste oder der Epic Launcher.

const processes = require('../sys/processes');
const { sleep } = require('./fsutil');

const FORTNITE_RE = /^fortnite.*\.exe$/i;
// Das eigentliche Spiel und der Fortnite-Starter. Die Startprogramme (_EAC/_EAC_EOS/_BE)
// beenden sich von selbst, sobald das Spiel zu ist.
const GAME_RE = /^FortniteClient-Win64-Shipping\.exe$/i;
const MAIN_NAMES = ['FortniteClient-Win64-Shipping.exe', 'FortniteLauncher.exe'];
const NEVER_CLOSE = /(easyanticheat|beservice|battleye|epicgameslauncher|epicwebhelper)/i;

function isFortnite(name) {
  return FORTNITE_RE.test(name) && !NEVER_CLOSE.test(name);
}

async function status(exec) {
  const list = await processes.listProcesses({ filter: 'Fortnite*' }, exec);
  const found = list.filter((p) => FORTNITE_RE.test(p.name));
  return {
    running: found.length > 0,
    gameRunning: found.some((p) => GAME_RE.test(p.name)),
    processes: found.map((p) => ({ name: p.name, pid: p.pid, memKb: p.memKb })),
  };
}

/**
 * Schließt Fortnite. Erst normal (wie das X am Fenster), auf Wunsch danach sofort.
 * Rückgabe: { closed: bool, remaining: [...] }
 */
async function close({ force = false, waitMs = 10000 } = {}, exec) {
  let st = await status(exec);
  if (!st.running) return { closed: true, remaining: [] };
  const names = force
    ? [...new Set(st.processes.map((p) => p.name).filter(isFortnite))]
    : MAIN_NAMES;
  await processes.closeByName(names, { force, tree: force }, exec);
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await sleep(500);
    st = await status(exec);
    if (!st.running) return { closed: true, remaining: [] };
  }
  return { closed: false, remaining: st.processes };
}

module.exports = { status, close, isFortnite, FORTNITE_RE, GAME_RE };
