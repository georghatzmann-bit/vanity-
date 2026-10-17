// German formatting helpers (de-DE).

const nf = new Intl.NumberFormat('de-DE');
const nfCache = new Map();
const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const weekdayFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'long' });
const dayMonthFmt = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short' });
const fullDateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

function numberFormat(min, max) {
  const key = `${min}:${max}`;
  if (!nfCache.has(key)) nfCache.set(key, new Intl.NumberFormat('de-DE', { minimumFractionDigits: min, maximumFractionDigits: max }));
  return nfCache.get(key);
}

/** 1234567 -> "1.234.567"; formatNumber(3.14159, 2) -> "3,14" */
export function formatNumber(n, maxFractionDigits) {
  const v = Number(n) || 0;
  return maxFractionDigits === undefined ? nf.format(v) : numberFormat(0, maxFractionDigits).format(v);
}

/** 0.42 -> "42 %" (German spacing). */
export function formatPercent(fraction, maxFractionDigits = 0) {
  const v = Math.max(0, Number(fraction) || 0) * 100;
  return `${numberFormat(0, maxFractionDigits).format(v)} %`;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Bytes with binary steps and Windows-style labels: 38400000000 -> "35,8 GB". */
export function formatBytes(bytes, { digits } = {}) {
  let v = Math.max(0, Number(bytes) || 0);
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const max = digits ?? (i === 0 ? 0 : v < 10 ? 1 : v < 100 ? 1 : 0);
  return `${numberFormat(0, max).format(v)} ${UNITS[i]}`;
}

/** 80000 -> "1 Min. 20 Sek."; 3725000 -> "1 Std. 2 Min."; 400 -> "< 1 Sek." */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 1) return '< 1 Sek.';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return m ? `${h} Std. ${m} Min.` : `${h} Std.`;
  if (m) return s ? `${m} Min. ${s} Sek.` : `${m} Min.`;
  return `${s} Sek.`;
}

/** Remaining time phrase: "noch etwa 2 Min." */
export function formatEta(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const sec = Math.round(ms / 1000);
  if (sec < 10) return 'gleich fertig';
  if (sec < 60) return `noch etwa ${Math.ceil(sec / 5) * 5} Sek.`;
  return `noch etwa ${formatDuration(Math.ceil(sec / 60) * 60000)}`;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "heute, 09:12" · "gestern, 18:40" · "Montag, 09:12" · "13. Okt., 09:12" · "13.10.2025" */
export function formatRelativeDate(input, now = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  const time = timeFmt.format(d);
  if (days === 0) return `heute, ${time}`;
  if (days === 1) return `gestern, ${time}`;
  if (days === -1) return `morgen, ${time}`;
  if (days > 1 && days < 7) return `${weekdayFmt.format(d)}, ${time}`;
  if (d.getFullYear() === now.getFullYear()) return `${dayMonthFmt.format(d)}, ${time}`;
  return fullDateFmt.format(d);
}

/** plural(1, 'App', 'Apps') -> "1 App"; plural(3, 'Spiel', 'Spiele') -> "3 Spiele" */
export function plural(n, one, many, { withNumber = true } = {}) {
  const word = Number(n) === 1 ? one : many;
  return withNumber ? `${formatNumber(n)} ${word}` : word;
}

/** German list join: ["A","B","C"] -> "A, B und C" */
export function joinList(items) {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} und ${list[list.length - 1]}`;
}
