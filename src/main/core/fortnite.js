'use strict';
// Erkennt, ob Fortnite läuft, und schließt es auf Wunsch.
// Geschlossen wird nur das Spiel selbst (FortniteClient-Win64-Shipping.exe) – nie die Startprogramme
// mit Anti-Cheat (_EAC_EOS, _BE), nie Anti-Cheat-Dienste und nie der Epic Launcher.
// Die Startprogramme beenden sich von selbst, sobald das Spiel zu ist.

const processes = require('../sys/processes');
const { sleep } = require('./fsutil');

const FORTNITE_RE = /^fortnite.*\.exe$/i;
const GAME_RE = /^FortniteClient-Win64-Shipping\.exe$/i;
const GAME_NAME = 'FortniteClient-Win64-Shipping.exe';
const NEVER_CLOSE = /(easyanticheat|beservice|battleye|epicgameslauncher|epicwebhelper)/i;

function isFortnite(name) {
  return FORTNITE_RE.test(name) && !NEVER_CLOSE.test(name);
}

async function status(exec) {
  const list = await processes.listProcesses({ filter: 'Fortnite*' }, exec);
  const found = list.filter((p) => FORTNITE_RE.test(p.name));
  const game = found.some((p) => GAME_RE.test(p.name));
  return {
    // Maßgeblich ist nur das Spiel: Es speichert beim Beenden seine Einstellungen.
    running: game,
    gameRunning: game,
    starting: !game && found.length > 0, // nur Start-/Begleitprogramme offen
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
  await processes.closeByName([GAME_NAME], { force, tree: false }, exec);
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await sleep(500);
    st = await status(exec);
    if (!st.running) return { closed: true, remaining: [] };
  }
  return { closed: false, remaining: st.processes };
}

module.exports = { status, close, isFortnite, FORTNITE_RE, GAME_RE, GAME_NAME };
