// Simulator-Daten für den Cache-Cleaner (nur Browser-Vorschau).

const MB = 1024 * 1024;
const GB = 1024 * MB;

const CATS = [
  { id: 'directx', group: 'shader', label: 'DirectX-Shader-Cache', hint: 'Von Windows gespeicherte Grafik-Bausteine (Shader). Wird beim nächsten Spielstart neu aufgebaut – das erste Match kann kurz ruckeln.', privacy: null, bytes: 412 * MB, count: 1843, folders: 1 },
  { id: 'nvidia', group: 'shader', label: 'NVIDIA-Shader-Cache', hint: 'Zwischenspeicher des NVIDIA-Grafiktreibers. Wird neu aufgebaut – das erste Match danach kann kurz ruckeln.', privacy: null, bytes: 1.42 * GB, count: 312, folders: 3 },
  { id: 'logs', group: 'fortnite', label: 'Fortnite-Protokolle', hint: 'Textdateien, in denen Fortnite mitschreibt, was beim Spielen passiert. Fortnite legt beim nächsten Start neue an.', privacy: 'Fortnite legt dort auch einmalige Anmelde-Codes ab. Löschen entfernt sie.', bytes: 186 * MB, count: 23, folders: 1 },
  { id: 'crashes', group: 'fortnite', label: 'Fortnite-Absturzberichte', hint: 'Berichte von früheren Abstürzen. Werden nur für die Fehlersuche gebraucht.', privacy: 'Enthalten oft Kopien der Protokolle – also auch dort alte Anmelde-Codes.', bytes: 96 * MB, count: 14, folders: 1 },
  { id: 'temp', group: 'fortnite', label: 'Temporäre Fortnite-Dateien', hint: 'Reste von Fortnite und der Unreal Engine (das Spiel-Grundgerüst) im Windows-Temp-Ordner. Nur Einträge, deren Name mit UE, Unreal, Fortnite oder CrashReport beginnt.', privacy: null, bytes: 0, count: 0, folders: 1 },
];

const state = {
  cats: CATS.map((c) => ({ ...c })),
  history: [],
  at: Date.now() - 60 * 1000,
};

function scanResult(db) {
  return {
    at: state.at,
    bytes: state.cats.reduce((n, c) => n + c.bytes, 0),
    count: state.cats.reduce((n, c) => n + c.count, 0),
    categories: state.cats.map((c) => ({ ...c, truncated: false })),
    fortniteRunning: !!db?.fortnite?.running,
    lastClean: state.history[state.history.length - 1] || null,
  };
}

export default {
  async summary() {
    const bytes = state.cats.reduce((n, c) => n + c.bytes, 0);
    if (bytes < MB) return null;
    const gb = bytes / GB;
    return { text: gb >= 1 ? `${gb.toLocaleString('de-DE', { maximumFractionDigits: 1 })} GB können frei werden` : `${Math.round(bytes / MB)} MB können frei werden` };
  },
  async scan(_a, mctx) {
    await mctx.wait(500);
    state.at = Date.now();
    return scanResult(mctx.db);
  },
  async clean(a, mctx) {
    if (mctx.db?.fortnite?.running) {
      const e = new Error('Fortnite läuft noch. Schließe Fortnite zuerst – HELIX kann das für dich übernehmen.');
      e.code = 'FORTNITE_RUNNING';
      throw e;
    }
    const ids = Array.isArray(a.ids) ? a.ids : [];
    const chosen = state.cats.filter((c) => ids.includes(c.id));
    let freedBytes = 0; let deleted = 0; let skipped = 0; let skippedBytes = 0;
    for (let i = 0; i < chosen.length; i++) {
      const c = chosen[i];
      mctx.emit('cache.progress', { index: i, total: chosen.length, id: c.id, label: c.label });
      await mctx.wait(350);
      // NVIDIA: ein paar Dateien sind gerade in Benutzung
      const sk = c.id === 'nvidia' ? 3 : 0;
      const skb = c.id === 'nvidia' ? 24 * MB : 0;
      freedBytes += c.bytes - skb;
      deleted += c.count - sk;
      skipped += sk;
      skippedBytes += skb;
      c.bytes = skb;
      c.count = sk;
    }
    mctx.emit('cache.progress', { index: chosen.length, total: chosen.length, done: true });
    state.at = Date.now();
    state.history.push({ at: Date.now(), freedBytes, deleted, skipped, ids });
    return { freedBytes, deleted, skipped, skippedBytes, perCategory: [], scan: scanResult(mctx.db) };
  },
  async openFolder(a) {
    return { opened: a.id };
  },
};
