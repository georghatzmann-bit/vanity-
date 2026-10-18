// Hardware-Überblick: Bewertung der Messwerte in einfachen Worten (ohne DOM).
// Wird von der Ansicht und den Unit-Tests benutzt.
//
// Jede Kachel bekommt: Wert, Einheit, Plakette (Text + Art) und eine kurze Zeile (leer, wenn die Plakette reicht).
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
  if (p >= 90) return { type: 'warn', word: 'am Limit', text: 'Voll ausgelastet. Der Spiel-Booster kann helfen.' };
  if (p >= 70) return { type: 'warn', word: 'viel zu tun', text: 'Arbeitet viel – beim Spielen normal.' };
  return { type: 'ok', word: 'normal', text: 'Hat noch Reserve.' };
}

export function gpuLoadStatus(p, fnRunning) {
  if (!isNum(p)) return null;
  if (fnRunning) {
    if (p >= 95) return { type: 'accent', word: 'voll ausgelastet', text: 'Gibt alles – sie bestimmt gerade deine FPS.' };
    if (p >= 60) return { type: 'ok', word: 'arbeitet', text: 'Arbeitet und hat noch etwas Reserve.' };
    return { type: 'ok', word: 'Reserve', text: 'Viel Luft – dann bremst oft Prozessor oder FPS-Limit.' };
  }
  if (p >= 80) return { type: 'warn', word: 'hohe Last', text: 'Stark belastet ohne Fortnite. Läuft ein Spiel oder Video?' };
  if (p >= 30) return { type: 'ok', word: 'arbeitet', text: 'Fortnite läuft nicht – arbeitet für ein anderes Programm.' };
  return { type: 'ok', word: 'normal', text: 'Fortnite läuft nicht – wenig zu tun.' };
}

export function gpuTempStatus(c) {
  if (!isNum(c)) return null;
  if (c >= 87) return { type: 'err', word: 'sehr heiß', text: 'Sehr heiß. Lüfter, Staub und Luftzufuhr prüfen.' };
  if (c >= 80) return { type: 'warn', word: 'warm', text: 'Warm, aber okay. Gute Belüftung hilft.' };
  if (c >= 45) return { type: 'ok', word: 'normal', text: 'Normal für eine Grafikkarte unter Last.' };
  return { type: 'ok', word: 'kühl', text: 'Kühl – die Grafikkarte hat wenig zu tun.' };
}

export function boardTempStatus(c, flat = false) {
  if (!isNum(c)) return null;
  const note = 'Nicht unbedingt die Prozessor-Temperatur.';
  if (flat) return { type: '', word: 'ändert sich nicht', text: 'Bleibt immer gleich – wohl keine echte Messung.' };
  if (c >= 90) return { type: 'err', word: 'sehr heiß', text: `Sehr heiß – Lüfter prüfen. ${note}` };
  if (c >= 75) return { type: 'warn', word: 'warm', text: `Warm. ${note}` };
  return { type: 'ok', word: 'normal', text: note };
}

export function ramStatus(used, total) {
  const p = pct(used, total);
  if (p == null) return null;
  if (p >= 90) return { type: 'err', word: 'fast voll', text: 'Schließ Programme, sonst kann Fortnite ruckeln.' };
  if (p >= 75) return { type: 'warn', word: 'wird knapp', text: 'Browser mit vielen Tabs schließen hilft.' };
  return { type: 'ok', word: 'genug frei', text: '' };
}

export function vramStatus(used, total) {
  const p = pct(used, total);
  if (p == null) {
    return isNum(used) ? { type: '', word: 'belegt', text: 'Speicher auf der Grafikkarte.' } : null;
  }
  if (p >= 95) return { type: 'err', word: 'voll', text: 'Stell in Fortnite die Texturen niedriger, sonst ruckelt es.' };
  if (p >= 85) return { type: 'warn', word: 'fast voll', text: 'Niedrigere Texturen in Fortnite helfen.' };
  return { type: 'ok', word: 'genug frei', text: '' };
}

/** Erklärung, warum die Grafikkarten-Temperatur fehlt. */
export function gpuTempMissing(caps = {}, windows = true) {
  if (!windows) return 'Geht nur unter Windows.';
  if (caps.vendor === 'nvidia' && caps.nvidiaSmi === false) {
    return '„nvidia-smi“ fehlt. Installiere den aktuellen NVIDIA-Treiber.';
  }
  if (caps.vendor === 'nvidia') return 'Der NVIDIA-Treiber meldet gerade keine.';
  if (caps.vendor === 'amd') return 'Bei AMD nicht lesbar. Zu sehen im Task-Manager (Leistung › GPU) oder in der AMD-Software.';
  if (caps.vendor === 'intel') return 'Intel meldet sie nicht an Windows. Zu sehen in der Intel Graphics Software.';
  return 'Windows meldet keine. Oft zeigt sie der Task-Manager unter „Leistung“.';
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
  // 'ok' ohne frische Skript-Zeile: Windows antwortet gerade langsam – dann "misst …" statt "nicht verfügbar"
  const pending = windows && (stream === 'starting' || stream === 'off' || stream === 'ok') && !s.psFresh;
  const waitText = stream === 'ok' ? 'Windows antwortet langsam – der Wert kommt gleich.' : 'Messung startet …';
  const tiles = [];

  const tile = (id, label, value, unit, st, extra = {}) => ({ id, label, value, unit, badge: st ? { text: st.word, type: st.type } : null, text: st ? st.text : '', ...extra });
  const missing = (id, label, text) => ({ id, label, value: '–', unit: '', badge: pending ? { text: 'misst …', type: '' } : { text: 'nicht verfügbar', type: '' }, text: pending ? waitText : text, spark: null, available: false });

  // Prozessor
  if (isNum(s.cpuPct)) {
    tiles.push(tile('cpu', 'Prozessor', fmtNum(s.cpuPct), '%', cpuStatus(s.cpuPct), { spark: { values: series(history, 'cpuPct'), min: 0, max: 100 }, available: true }));
  } else {
    tiles.push({ ...missing('cpu', 'Prozessor', ''), badge: { text: 'misst …', type: '' }, text: 'Erster Wert in 2 Sekunden.' });
  }

  // Grafikkarte: Auslastung
  if (isNum(s.gpuPct)) {
    const parts = [];
    if (isNum(s.gpuPower)) parts.push(`${fmtNum(s.gpuPower)} W Strom`);
    if (isNum(s.gpuClock)) parts.push(`${fmtNum(s.gpuClock)} MHz Takt`);
    tiles.push(tile('gpu', 'Grafikkarte', fmtNum(s.gpuPct), '%', gpuLoadStatus(s.gpuPct, !!s.fnRunning), { spark: { values: series(history, 'gpuPct'), min: 0, max: 100 }, available: true, extra: parts.join(' · ') }));
  } else {
    tiles.push(missing('gpu', 'Grafikkarte', windows
      ? 'Windows liefert keine Werte. Ein aktueller Grafiktreiber hilft.'
      : 'Geht nur unter Windows.'));
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
      ? 'Nur mit Zusatz-Treiber lesbar – den installiert HELIX bewusst nicht.'
      : 'Geht nur unter Windows.'));
  }

  // Arbeitsspeicher
  if (isNum(s.ramUsed) && isNum(s.ramTotal)) {
    const ramPct = series(history, 'ramUsed').map((u, i) => pct(u, history[i] && history[i].ramTotal));
    tiles.push(tile('ram', 'Arbeitsspeicher', `${fmtGB(s.ramUsed)} / ${fmtGB(s.ramTotal)}`, 'GB', ramStatus(s.ramUsed, s.ramTotal), { spark: { values: ramPct, min: 0, max: 100 }, available: true }));
  } else {
    tiles.push({ ...missing('ram', 'Arbeitsspeicher', ''), badge: { text: 'misst …', type: '' }, text: 'Erster Wert in 2 Sekunden.' });
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
      ? 'Windows liefert keinen Wert.'
      : 'Geht nur unter Windows.'));
  }

  // Fortnite (nur Prozess-Werte wie im Task-Manager)
  if (s.fnRunning && isNum(s.fnRam)) {
    const cpuPart = isNum(s.fnCpuPct) ? `, ${fmtNum(s.fnCpuPct)} % Prozessor` : '';
    tiles.push({
      id: 'fortnite', label: 'Fortnite', value: fmtGB(s.fnRam), unit: 'GB RAM',
      badge: { text: 'läuft', type: 'accent' },
      text: `Belegt ${fmtGB(s.fnRam)} GB Arbeitsspeicher${cpuPart}.`,
      spark: { values: series(history, 'fnRam'), min: 0, max: isNum(s.ramTotal) ? s.ramTotal : Math.max(1, ...series(history, 'fnRam').filter(isNum)) },
      available: true,
    });
  } else if (!windows) {
    tiles.push(missing('fortnite', 'Fortnite', 'Geht nur unter Windows.'));
  } else if (pending) {
    tiles.push(missing('fortnite', 'Fortnite', ''));
  } else if (s.fnRunning === false) {
    tiles.push({ id: 'fortnite', label: 'Fortnite', value: '–', unit: '', badge: { text: 'läuft nicht', type: '' }, text: 'Starte Fortnite, dann steht hier sein Speicherbedarf.', spark: null, available: false });
  } else {
    // ohne Messwerte von Windows weiß HELIX nicht, ob Fortnite läuft
    tiles.push({ id: 'fortnite', label: 'Fortnite', value: '–', unit: '', badge: { text: 'unbekannt', type: '' }, text: 'Ohne Messwerte von Windows nicht erkennbar.', spark: null, available: false });
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
  if (status.windows === false) return ''; // das sagen schon Plakette und Hinweis darunter
  if (status.stream === 'failed') return 'Nur Prozessor und Arbeitsspeicher.';
  if (status.stream === 'starting') return 'Messung startet …';
  return 'Alle 2 Sekunden, nur lesend.';
}
