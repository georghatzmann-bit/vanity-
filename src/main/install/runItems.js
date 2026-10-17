'use strict';
// Installs a list of items sequentially in THIS process (used by the elevated worker for the
// admin lane and by the UI process for the user lane). Emits install events (ARCHITECTURE §6).
const locate = require('../winget/locate');
const bootstrap = require('../winget/bootstrap');
const runner = require('../winget/runner');

/**
 * @param {Array<{key,id,source,name,elevation}>} items sanitized items
 * @param {{emit: Function, log?: Function, signal?: AbortSignal, indexOffset?: number, total?: number}} opts
 * @returns {Promise<Array<{key, status}>>}
 */
async function runItems(items, { emit, log = () => {}, signal, indexOffset = 0, total } = {}) {
  const results = [];
  const count = total || items.length;

  let status = await locate.getStatus({ refresh: true });
  if (!status.ok) {
    log(`winget nicht bereit (${status.version || 'fehlt'}) – Reparatur wird versucht`);
    const fixed = await bootstrap.ensureWinget({ onProgress: (p) => log(p.message) });
    status = await locate.getStatus({ refresh: true });
    if (!fixed.ok || !status.ok) {
      for (const item of items) {
        const message = 'winget ist auf diesem PC nicht verfügbar. Installiere „App-Installer“ aus dem Microsoft Store und starte Phoenix neu.';
        emit({ type: 'item-done', key: item.key, status: 'failed', rebootRequired: false, message, durationMs: 0 });
        results.push({ key: item.key, status: 'failed' });
      }
      return results;
    }
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (signal && signal.aborted) {
      emit({ type: 'item-done', key: item.key, status: 'cancelled', rebootRequired: false, message: 'Abgebrochen', durationMs: 0 });
      results.push({ key: item.key, status: 'cancelled' });
      continue;
    }
    emit({ type: 'item-start', key: item.key, index: indexOffset + i, total: count });
    const started = Date.now();
    let res;
    try {
      res = await runner.installPackage(item, {
        wingetPath: status.path,
        signal,
        onProgress: (p) => emit({ type: 'item-progress', key: item.key, ...p }),
        onLog: (line) => emit({ type: 'log', key: item.key, line }),
      });
    } catch (err) {
      res = { status: 'failed', rebootRequired: false, message: `Unerwarteter Fehler: ${err.message}` };
    }
    emit({
      type: 'item-done',
      key: item.key,
      status: res.status,
      rebootRequired: !!res.rebootRequired,
      code: res.code,
      codeHex: res.codeHex,
      message: res.message,
      durationMs: Date.now() - started,
      ...(res.retry === 'user-lane' ? { retryLane: 'user' } : {}),
    });
    results.push({ key: item.key, status: res.status });
  }
  return results;
}

module.exports = { runItems };
