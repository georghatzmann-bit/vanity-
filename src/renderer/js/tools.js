// Alle Ziele im Cockpit. "ring": 0 = Kern in der Mitte, 1 = innere Umlaufbahn, 2 = äußere.
// Jedes Tool hat eine eigene Ansicht in js/views/<id>.js (export default { mount(root, env), unmount() }).

export const CORE = {
  id: 'profiles',
  title: 'Settings-Profile',
  short: 'Profile',
  desc: 'Alle Fortnite-Einstellungen als Profil speichern und mit einem Klick anwenden.',
};

export const TOOLS = [
  { id: 'sensi', ring: 1, title: 'Sensi-Kalibrierung', short: 'Sensi', desc: 'Aim-Test mit Zielen, Tracking und Flicks – findet deine beste Empfindlichkeit.', hue: 190 },
  { id: 'pccheck', ring: 1, title: 'PC-Check & Video-Settings', short: 'PC-Check', desc: 'Liest deine Hardware aus und schlägt passende Grafikeinstellungen vor.', hue: 160 },
  { id: 'sicht', ring: 1, title: 'Sicht-Presets', short: 'Sicht', desc: 'Fertige Einstellungen für bessere Sicht im Sturm, nachts und auf heller Karte.', hue: 280 },
  { id: 'maus', ring: 1, title: 'Maus-Check', short: 'Maus', desc: 'Prüft Zeigergeschwindigkeit, Beschleunigung und Abfragerate.', hue: 210 },
  { id: 'ping', ring: 1, title: 'Ping-Tester', short: 'Ping', desc: 'Misst die Verbindung zu allen Fortnite-Regionen und zeigt die beste.', hue: 130 },
  { id: 'booster', ring: 1, title: 'Spiel-Booster', short: 'Booster', desc: 'Schließt deine Hintergrundprogramme per Klick und startet sie danach wieder.', hue: 20 },
  { id: 'monitor', ring: 2, title: 'Monitor-Tuner', short: 'Monitor', desc: 'Testbilder und Anleitung für Helligkeit, Kontrast, Gamma und Schwarzwert.', hue: 300 },
  { id: 'cache', ring: 2, title: 'Cache-Cleaner', short: 'Cache', desc: 'Löscht Shader-, DirectX- und Fortnite-Zwischenspeicher und zeigt den Platzgewinn.', hue: 45 },
  { id: 'hardware', ring: 2, title: 'Hardware-Überblick', short: 'Hardware', desc: 'Temperaturen, Auslastung und Arbeitsspeicher live – nur lesend.', hue: 0 },
  { id: 'stats', ring: 2, title: 'Session-Statistik', short: 'Statistik', desc: 'Spielzeit pro Profil und dein Aim-Test-Verlauf als Diagramm.', hue: 240 },
  { id: 'replays', ring: 2, title: 'Replay-Tresor', short: 'Replays', desc: 'Sichert deine besten Fortnite-Replays, bevor Fortnite sie löscht.', hue: 260 },
  { id: 'reaktion', ring: 2, title: 'Reaktions-Labor', short: 'Reaktion', desc: 'Reaktionstest und Trainer für deine Bau- und Edit-Tasten.', hue: 330 },
  { id: 'wincheck', ring: 2, title: 'Windows-Gaming-Check', short: 'Windows', desc: 'Prüft Spielmodus, Aufnahme im Hintergrund, GPU-Planung und Energieplan.', hue: 100 },
];

export const EXTRA = [
  { id: 'settings', title: 'Einstellungen', short: 'Einstellungen', desc: 'Sound, Intro und Fortnite-Ordner.' },
];

export function findTarget(id) {
  if (id === CORE.id) return CORE;
  return TOOLS.find((t) => t.id === id) || EXTRA.find((t) => t.id === id) || null;
}

export function planetImage(id) {
  return `assets/img/planet-${id}.png`;
}
