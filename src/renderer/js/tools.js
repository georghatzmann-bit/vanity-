// Alle Ziele im Cockpit. "ring": 0 = Kern in der Mitte, 1 = innere Umlaufbahn, 2 = äußere.
// Jedes Tool hat eine eigene Ansicht in js/views/<id>.js (export default { mount(root, env), unmount() }),
// eine eigene Farbe (hue, Farbton 0–360) und ein Symbol (icon, siehe ui.js).

export const CORE = {
  id: 'profiles',
  title: 'Settings-Profile',
  short: 'Profile',
  desc: 'Fortnite-Einstellungen als Profil speichern und mit einem Klick anwenden.',
  hue: 262,
  icon: 'layers',
};

export const TOOLS = [
  { id: 'sensi', ring: 1, title: 'Sensi-Kalibrierung', short: 'Sensi', desc: 'Aim-Test, der deine beste Sensi findet.', hue: 192, icon: 'crosshair' },
  { id: 'pccheck', ring: 1, title: 'PC-Check & Video-Settings', short: 'PC-Check', desc: 'Passende Grafikeinstellungen für deinen PC.', hue: 152, icon: 'cpu' },
  { id: 'sicht', ring: 1, title: 'Sicht-Presets', short: 'Sicht', desc: 'Bessere Sicht im Sturm, nachts und bei hellem Licht.', hue: 276, icon: 'eye' },
  { id: 'maus', ring: 1, title: 'Maus-Check', short: 'Maus', desc: 'Zeigertempo, Beschleunigung und Abfragerate.', hue: 218, icon: 'mouse' },
  { id: 'ping', ring: 1, title: 'Ping-Tester', short: 'Ping', desc: 'Findet den schnellsten Fortnite-Server.', hue: 168, icon: 'signal' },
  { id: 'booster', ring: 1, title: 'Spiel-Booster', short: 'Booster', desc: 'Schließt Hintergrundprogramme beim Spielen.', hue: 24, icon: 'bolt' },
  { id: 'monitor', ring: 2, title: 'Monitor-Tuner', short: 'Monitor', desc: 'Testbilder für Helligkeit und Kontrast.', hue: 318, icon: 'monitor' },
  { id: 'cache', ring: 2, title: 'Cache-Cleaner', short: 'Cache', desc: 'Löscht Zwischenspeicher und schafft Platz.', hue: 42, icon: 'sweep' },
  { id: 'hardware', ring: 2, title: 'Hardware-Überblick', short: 'Hardware', desc: 'Temperaturen und Auslastung live.', hue: 356, icon: 'thermo' },
  { id: 'stats', ring: 2, title: 'Session-Statistik', short: 'Statistik', desc: 'Spielzeit und Aim-Verlauf.', hue: 240, icon: 'chart' },
  { id: 'replays', ring: 2, title: 'Replay-Tresor', short: 'Replays', desc: 'Sichert deine besten Replays.', hue: 296, icon: 'film' },
  { id: 'reaktion', ring: 2, title: 'Reaktions-Labor', short: 'Reaktion', desc: 'Reaktionstest und Tasten-Trainer.', hue: 338, icon: 'timer' },
  { id: 'wincheck', ring: 2, title: 'Windows-Gaming-Check', short: 'Windows', desc: 'Prüft Windows auf gute Gaming-Einstellungen.', hue: 96, icon: 'windows' },
];

export const EXTRA = [
  { id: 'settings', title: 'Einstellungen', short: 'Einstellungen', desc: 'Sound, Intro und Fortnite-Ordner.', hue: 225, icon: 'settings' },
];

export function findTarget(id) {
  if (id === CORE.id) return CORE;
  return TOOLS.find((t) => t.id === id) || EXTRA.find((t) => t.id === id) || null;
}
