'use strict';
// PURE progress parser for `winget install` output. Language-independent where possible:
// numbers ("12.3 MB / 45.6 MB", "40%") drive the percentage; a few English/German phrases
// only refine the stage. Never used to decide success – the exit code does that.

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g;
const SIZE = /(\d+(?:[.,]\d+)?)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB)\s*\/\s*(\d+(?:[.,]\d+)?)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB)/i;
const PCT = /(?:^|\s)(\d{1,3}(?:[.,]\d+)?)\s*%/;
const URL = /https?:\/\/\S+/i;

const STAGE_HINTS = [
  // [stage, regex] – checked in order, first hit wins
  ['installing', /(Starting package install|Paketinstallation wird gestartet|Installation wird gestartet|Installing|Wird installiert)/i],
  ['verifying', /(installer hash|Installer-Hash|Installerhash|Hash des Installationsprogramms|Hash.*(verified|überprüft|verifiziert))/i],
  ['downloading', /(Downloading|Download läuft|Wird heruntergeladen|Herunterladen)/i],
  ['resolving', /^(Found|Gefunden)\b.*\[[^\]]+\]/i],
];

const UNITS = { B: 1, KB: 1024, KIB: 1024, MB: 1024 ** 2, MIB: 1024 ** 2, GB: 1024 ** 3, GIB: 1024 ** 3, TB: 1024 ** 4 };

function toBytes(num, unit) {
  return Math.round(parseFloat(String(num).replace(',', '.')) * (UNITS[String(unit).toUpperCase()] || 1));
}

/** Removes ANSI sequences, progress-bar glyphs and spinner characters. */
function cleanLine(line) {
  return String(line)
    .replace(ANSI, '')
    .replace(/[▀-▟]/g, '') // block elements used by the progress bar
    .trim()
    .replace(/^[-\\|/](\s+|$)/, '') // spinner glyph
    .trim();
}

/**
 * Creates a stateful parser. feed(text) accepts raw chunks; onEvent receives
 * { stage, pct, bytes? } whenever stage or integer percentage changes, and onLine receives
 * cleaned, non-empty text lines (for the log).
 */
function createProgressParser(onEvent = () => {}, onLine = () => {}, { onUrl = () => {} } = {}) {
  let buffer = '';
  let stage = 'resolving';
  let lastPct = null;
  let lastStage = null;
  let lastLine = '';

  function emit(next, pct, bytes) {
    const p = pct == null ? null : Math.max(0, Math.min(100, Math.floor(pct)));
    if (next === lastStage && p === lastPct) return;
    lastStage = next;
    lastPct = p;
    onEvent(bytes ? { stage: next, pct: p, bytes } : { stage: next, pct: p });
  }

  function handle(segment) {
    const line = cleanLine(segment);
    if (!line) return;
    if (line !== lastLine && !SIZE.test(line) && !/^\d{1,3}\s*%$/.test(line)) onLine(line);
    lastLine = line;

    const size = line.match(SIZE);
    if (size) {
      const done = toBytes(size[1], size[2]);
      const total = toBytes(size[3], size[4]);
      if (stage === 'resolving') stage = 'downloading';
      emit(stage, total > 0 ? (done / total) * 100 : null, { done, total });
      return;
    }
    for (const [hint, re] of STAGE_HINTS) {
      if (re.test(line)) {
        const u = line.match(URL);
        if (u) onUrl(u[0]);
        // never move backwards from installing to an earlier stage
        if (!(stage === 'installing' && hint !== 'installing')) stage = hint;
        emit(stage, stage === 'downloading' ? 0 : null);
        return;
      }
    }
    const url = line.match(URL);
    // Store packages print agreement links (aka.ms, go.microsoft.com) before anything is downloaded.
    if (url && !/\/\/(aka\.ms|go\.microsoft\.com|www\.microsoft\.com)\//i.test(url[0])) {
      onUrl(url[0]);
      if (stage === 'resolving') {
        stage = 'downloading';
        emit(stage, 0);
      }
      return;
    }
    const pct = line.match(PCT);
    if (pct && line.length <= 24) emit(stage, parseFloat(pct[1].replace(',', '.')));
  }

  return {
    feed(chunk) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const parts = buffer.split(/\r\n|\r|\n/);
      buffer = parts.pop();
      for (const p of parts) handle(p);
      // progress bars are redrawn with \r only; handle a long pending tail eagerly
      if (buffer.length > 200) {
        handle(buffer);
        buffer = '';
      }
    },
    flush() {
      if (buffer) handle(buffer);
      buffer = '';
    },
    get stage() {
      return stage;
    },
    /** Lets an external source (download-file watcher) report progress through the same dedupe. */
    report(next, pct, bytes) {
      if (stage === 'installing' && next !== 'installing') return;
      stage = next;
      emit(next, pct, bytes);
    },
  };
}

module.exports = { createProgressParser, cleanLine, toBytes };
