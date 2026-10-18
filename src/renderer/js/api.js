// Verbindung zum Hauptprozess. Im normalen Browser (Vorschau/Tests) wird ein Simulator benutzt.

const bridge = window.helix || (await import('./mock/index.js')).createMock();

export const isMock = !window.helix;

/** Ruft eine Aktion im Hauptprozess auf und wirft bei Fehlern einen Error mit .code */
export async function call(channel, args = {}) {
  const r = await bridge.call(channel, args);
  if (r && r.ok) return r.data;
  const err = new Error(r?.error?.message || 'Unbekannter Fehler');
  err.code = r?.error?.code || 'UNKNOWN';
  err.details = r?.error?.details;
  throw err;
}

/** Hört auf ein Ereignis ("drift", "fortnite.state", ...). Gibt eine Abmeldefunktion zurück. */
export function on(event, cb) {
  return bridge.on(event, cb);
}

export const platform = bridge.platform || 'web';
