// Hardware-Überblick: Bewertung der Messwerte in einfachen Worten (ohne DOM).
// Wird von der Ansicht und den Unit-Tests benutzt.
//
// Jede Kachel bekommt: Wert, Einheit, Plakette (Text + Art) und eine Erklärungszeile.
// Plakette-Arten: 'ok' (grün), 'warn' (orange), 'err' (rot), 'accent', '' (neutral).

export const HISTORY_SECONDS = 120;

const GB = 1024 ** 3;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function fmtNum(v, digits = 0) {
  if (!isNum(v)) return '–';
  return v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtGB(bytes) {
  if (!isNum(bytes)) return '–';
  const gb = bytes / GB;
  return fmtNum(gb, gb < 10 ? 1 : 0);
}

/** Ändert sich ein Wert über viele Messungen gar nicht, ist es meist ein fester Platzhalter. */
export function isFlat(values, minCount = 20) {
  const v = (values || []).filter(isNum);
  if (v.length < minCount) return false;
  return v.every((x) => Math.abs(x - v[0]) < 0.05);
}

export function series(history, key) {
  return (history || []).map((s) => (s && isNum(s[key]) ? s[key] : null));
}

export function pct(used, total) {
  return isNum(used) && isNum(total) && total > 0 ? (100 * used) / total : null;
}

// ---------------------------------------------------------------- Bewertungen

export function cpuStatus(p) {
  if (!isNum(p)) return null;
  if (p >= 90) return { type: 'warn', word: 'am Limit', text: 'Der Prozessor ist voll ausgelastet. Hintergrundprogramme schließen hilft (Spiel-Booster).' };
  if (p >= 70) return { type: 'warn', word: 'viel zu tun', text: 'Der Prozessor arbeitet viel. Beim Spielen ist das normal.' };
  return { type: 'ok', word: 'normal', text: 'Der Prozessor hat noch Reserve.' };
}

export function gpuLoadStatus(p, fnRunning) {
  if (!isNum(p)) return null;
  if (fnRunning) {
    if (p >= 95) return { type: 'accent', word: 'voll ausgelastet', text: 'Die Grafikkarte gibt alles. Sie bestimmt gerade, wie viele FPS du bekommst.' };
    if (p >= 60) return { type: 'ok', word: 'arbeitet', text: 'Die Grafikkarte arbeitet und hat noch etwas Reserve.' };
    return { type: 'ok', word: 'Reserve', text: 'Die Grafikkarte langweilt sich. Oft bremst dann der Prozessor oder das FPS-Limit.' };
  }
  if (p >= 80) return { type: 'warn', word: 'hohe Last', text: 'Die Grafikkarte ist stark belastet, obwohl Fortnite nicht läuft. Läuft ein anderes Spiel oder ein Video?' };
  return { type: 'ok', word: 'normal', text: 'Fortnite läuft nicht – die Grafikkarte hat wenig zu tun.' };
}

export function gpuTempStatus(c) {
  if (!isNum(c)) return null;
  const v = `${fmtNum(c)} °C`;
  if (c >= 87) return { type: 'err', word: 'sehr heiß', text: `${v} – sehr heiß. Lüfter, Staub und Luftzufuhr im Gehäuse prüfen.` };
  if (c >= 80) return { type: 'warn', word: 'warm', text: `${v} – warm, aber noch okay. Gute Belüftung hilft.` };
  if (c >= 45) return { type: 'ok', word: 'normal', text: `${v} – normal für Grafikkarten unter Last.` };
  return { type: 'ok', word: 'kühl', text: `${v} – kühl. Die Grafikkarte hat wenig zu tun.` };
}

export function boardTempStatus(c, flat = false) {
  if (!isNum(c)) return null;
  const note = 'Sensor auf dem Mainboard (ACPI), nicht unbedingt die Prozessor-Temperatur.';
  if (flat) return { type: '', word: 'ändert sich nicht', text: `Der Wert bleibt immer gleich – vermutlich ein fester Platzhalter des Mainboards, keine echte Messung.` };
  if (c >= 90) return { type: 'err', word: 'sehr heiß', text: `${fmtNum(c)} °C – sehr heiß. Lüfter und Staub prüfen. ${note}` };
  if (c >= 75) return { type: 'warn', word: 'warm', text: `${fmtNum(c)} °C – warm. ${note}` };
  return { type: 'ok', word: 'normal', text: `${fmtNum(c)} °C – normal. ${note}` };
}

export function ramStatus(used, total) {
  const p = pct(used, total);
  if (p == null) return null;
  if (p >= 90) return { type: 'err', word: 'fast voll', text: 'Der Arbeitsspeicher ist fast voll. Schließe Programme, sonst kann Fortnite ruckeln.' };
  if (p >= 75) return { type: 'warn', word: 'wird knapp', text: 'Der Arbeitsspeicher wird knapp. Browser mit vielen Tabs schließen hilft.' };
  return { type: 'ok', word: 'genug frei', text: 'Es ist genug Arbeitsspeicher frei.' };
}

export function vramStatus(used, total) {
  const p = pct(used, total);
  if (p == null) {
    return isNum(used) ? { type: '', word: 'belegt', text: 'So viel Grafikspeicher (Speicher auf der Grafikkarte) ist gerade belegt.' } : null;
  }
  if (p >= 95) return { type: 'err', word: 'voll', text: 'Der Grafikspeicher ist voll. Stelle in Fortnite die Texturen niedriger, sonst gibt es Ruckler.' };
  if (p >= 85) return { type: 'warn', word: 'fast voll', text: 'Der Grafikspeicher wird knapp. Niedrigere Texturen in Fortnite helfen.' };
  return { type: 'ok', word: 'genug frei', text: 'Auf der Grafikkarte ist genug Speicher frei.' };
}

/** Erklärung, warum die Grafikkarten-Temperatur fehlt. */
export function gpuTempMissing(caps = {}, windows = true) {
  if (!windows) return 'Die Temperatur der Grafikkarte kann HELIX nur unter Windows lesen.';
  if (caps.vendor === 'nvidia' && caps.nvidiaSmi === false) {
    return 'Das kleine Messprogramm „nvidia-smi“ vom NVIDIA-Treiber fehlt. Installiere den aktuellen Treiber von nvidia.com.';
  }
  if (caps.vendor === 'nvidia') return 'Der NVIDIA-Treiber meldet gerade keine Temperatur.';
  if (caps.vendor === 'amd') return 'AMD-Grafikkarten geben die Temperatur nur an die AMD-Software (Adrenalin) weiter. Dort steht sie unter „Leistung“.';
  if (caps.vendor === 'intel') return 'Intel-Grafik meldet ihre Temperatur nicht an Windows. Die Intel Graphics Software zeigt sie an.';
  return 'Windows meldet keine Temperatur der Grafikkarte. Tipp: Der Task-Manager zeigt sie unter „Leistung“ bei vielen Karten.';
}

// ---------------------------------------------------------------- Kacheln

/**
 * Baut die Beschreibung aller Kacheln.
 * status: { windows, stream, caps } aus hardware.start / hardware.sample
 */
export function buildTiles(sample, history, status = {}) {
  const s = sample || {};
  const caps = status.caps || s.caps || {};
  const windows = status.windows !== false;
  const stream = s.stream || status.stream;
  const pending = windows && (stream === 'starting' || stream === 'off') && !s.psFresh;
  const waitText = 'Messung startet … das dauert ein paar Sekunden.';
  const tiles = [];

  const tile = (id, label, value, unit, st, extra = {}) => ({ id, label, value, unit, badge: st ? { text: st.word, type: st.type } : null, text: st ? st.text : '', ...extra });
  const missing = (id, label, text) => ({ id, label, value: '–', unit: '', badge: pending ? { text: 'misst …', type: '' } : { text: 'nicht verfügbar', type: '' }, text: pending ? waitText : text, spark: null, available: false });

  // Prozessor
  if (isNum(s.cpuPct)) {
    tiles.push(tile('cpu', 'Prozessor', fmtNum(s.cpuPct), '%', cpuStatus(s.cpuPct), { spark: { values: series(history, 'cpuPct'), min: 0, max: 100 }, available: true }));
  } else {
    tiles.push({ ...missing('cpu', 'Prozessor', 'Noch kein Messwert.'), badge: { text: 'misst …', type: '' }, text: 'Der erste Wert kommt in 2 Sekunden.' });
  }

  // Grafikkarte: Auslastung
  if (isNum(s.gpuPct)) {
    const parts = [];
    if (isNum(s.gpuPower)) parts.push(`${fmtNum(s.gpuPower)} W Strom`);
    if (isNum(s.gpuClock)) parts.push(`${fmtNum(s.gpuClock)} MHz Takt`);
    tiles.push(tile('gpu', 'Grafikkarte', fmtNum(s.gpuPct), '%', gpuLoadStatus(s.gpuPct, !!s.fnRunning), { spark: { values: series(history, 'gpuPct'), min: 0, max: 100 }, available: true, extra: parts.join(' · ') }));
  } else {
    tiles.push(missing('gpu', 'Grafikkarte', windows
      ? 'Windows liefert keine Auslastung der Grafikkarte. Das braucht Windows 10 ab Version 1709 und einen aktuellen Grafiktreiber.'
      : 'Die Auslastung der Grafikkarte kann HELIX nur unter Windows lesen.'));
  }

  // Grafikkarte: Temperatur
  if (isNum(s.gpuTemp)) {
    tiles.push(tile('gpuTemp', 'Grafikkarten-Temperatur', fmtNum(s.gpuTemp), '°C', gpuTempStatus(s.gpuTemp), { spark: { values: series(history, 'gpuTemp'), min: 20, max: 100 }, available: true }));
  } else {
    tiles.push(missing('gpuTemp', 'Grafikkarten-Temperatur', gpuTempMissing(caps, windows)));
  }

  // Mainboard-Sensor (ACPI)
  if (isNum(s.boardTemp)) {
    const flat = isFlat(series(history, 'boardTemp'));
    tiles.push(tile('board', 'Mainboard-Sensor', fmtNum(s.boardTemp), '°C', boardTempStatus(s.boardTemp, flat), { spark: { values: series(history, 'boardTemp'), min: 20, max: 100 }, available: true }));
  } else {
    tiles.push(missing('board', 'Prozessor-Temperatur', windows
      ? 'Dein PC gibt über Windows keine Temperatur heraus. Die echte Prozessor-Temperatur geht nur mit einem Zusatz-Treiber – den installiert HELIX absichtlich nicht.'
      : 'Temperaturen kann HELIX nur unter Windows lesen.'));
  }

  // Arbeitsspeicher
  if (isNum(s.ramUsed) && isNum(s.ramTotal)) {
    const ramPct = series(history, 'ramUsed').map((u, i) => pct(u, history[i] && history[i].ramTotal));
    tiles.push(tile('ram', 'Arbeitsspeicher', `${fmtGB(s.ramUsed)} / ${fmtGB(s.ramTotal)}`, 'GB', ramStatus(s.ramUsed, s.ramTotal), { spark: { values: ramPct, min: 0, max: 100 }, available: true }));
  } else {
    tiles.push({ ...missing('ram', 'Arbeitsspeicher', 'Noch kein Messwert.'), badge: { text: 'misst …', type: '' }, text: 'Der erste Wert kommt in 2 Sekunden.' });
  }

  // Grafikspeicher
  if (isNum(s.vramUsed)) {
    const vPct = (history || []).map((h) => (h ? pct(h.vramUsed, h.vramTotal) : null));
    const hasTotal = isNum(s.vramTotal) && s.vramTotal > 0;
    tiles.push(tile('vram', 'Grafikspeicher', hasTotal ? `${fmtGB(s.vramUsed)} / ${fmtGB(s.vramTotal)}` : fmtGB(s.vramUsed), 'GB', vramStatus(s.vramUsed, s.vramTotal), {
      spark: hasTotal ? { values: vPct, min: 0, max: 100 } : { values: series(history, 'vramUsed'), min: 0, max: Math.max(1, ...series(history, 'vramUsed').filter(isNum)) },
      available: true,
    }));
  } else {
    tiles.push(missing('vram', 'Grafikspeicher', windows
      ? 'Windows liefert keinen Wert für den Grafikspeicher (Speicher auf der Grafikkarte).'
      : 'Den Grafikspeicher kann HELIX nur unter Windows lesen.'));
  }

  // Fortnite (nur Prozess-Werte wie im Task-Manager)
  if (s.fnRunning && isNum(s.fnRam)) {
    const cpuPart = isNum(s.fnCpuPct) ? ` und ${fmtNum(s.fnCpuPct)} % des Prozessors` : '';
    tiles.push({
      id: 'fortnite', label: 'Fortnite', value: fmtGB(s.fnRam), unit: 'GB RAM',
      badge: { text: 'läuft', type: 'accent' },
      text: `Fortnite belegt ${fmtGB(s.fnRam)} GB Arbeitsspeicher${cpuPart}.`,
      spark: { values: series(history, 'fnRam'), min: 0, max: isNum(s.ramTotal) ? s.ramTotal : Math.max(1, ...series(history, 'fnRam').filter(isNum)) },
      available: true,
    });
  } else if (!windows) {
    tiles.push(missing('fortnite', 'Fortnite', 'Ob Fortnite läuft, sieht HELIX nur unter Windows.'));
  } else if (pending) {
    tiles.push(missing('fortnite', 'Fortnite', ''));
  } else {
    tiles.push({ id: 'fortnite', label: 'Fortnite', value: '–', unit: '', badge: { text: 'läuft nicht', type: '' }, text: 'Starte Fortnite. Dann siehst du hier, wie viel Arbeitsspeicher das Spiel braucht.', spark: null, available: false });
  }
  return tiles;
}

/** Ein Wert als "Ø 62 · max 71". */
export function avgMax(m, unit = '') {
  if (!m || !isNum(m.avg)) return '–';
  return `Ø ${fmtNum(m.avg)}${unit} · max ${fmtNum(m.max)}${unit}`;
}

/** Zeile für die Tabelle der aufgezeichneten Runden. */
export function sessionRow(s) {
  return {
    cpu: avgMax(s.cpu, ' %'),
    gpu: avgMax(s.gpu, ' %'),
    gpuTemp: avgMax(s.gpuTemp, ' °C'),
    boardTemp: s.boardTemp && isNum(s.boardTemp.max) ? `max ${fmtNum(s.boardTemp.max)} °C` : '–',
    fnRam: isNum(s.fnRamMax) ? `max ${fmtGB(s.fnRamMax)} GB` : '–',
    hot: !!(s.gpuTemp && s.gpuTemp.max >= 87) || !!(s.boardTemp && s.boardTemp.max >= 90),
  };
}

/** Kurzer Text, welche Quelle die Werte liefert. */
export function sourceText(status = {}) {
  if (status.windows === false) return 'Nur Prozessor und Arbeitsspeicher – die anderen Werte gibt es nur unter Windows.';
  if (status.stream === 'failed') return 'Windows hat keine Messwerte geliefert. Zu sehen sind nur Prozessor und Arbeitsspeicher.';
  if (status.stream === 'starting') return 'Messung startet …';
  return 'Live – alle 2 Sekunden. Nur lesend, kein Overlay im Spiel.';
}
