// Monitor-Tuner: Inhalte der geführten Einrichtung (reine Daten, ohne DOM).
// Quellen: Recherche "windows-gaming" §5 (NVIDIA/AMD/Intel, Monitor-Menü) und "fortnite-config" §6.
// Was am Monitor oder im Treiber eingestellt wird, kann HELIX nicht ändern – nur erklären.

/** Schwarz-Stabilisator heißt je nach Marke anders. verified = in der Recherche bestätigt. */
export const BRANDS = [
  { brand: 'BenQ ZOWIE', name: 'Black eQualizer', tip: 'Standard 10 von 20. Für Fortnite meist 12 bis 15.', verified: true },
  { brand: 'ASUS (ROG, TUF)', name: 'Shadow Boost', tip: 'Stufe 1 oder 2. „Dynamisch“ nur, wenn es dir gefällt.', verified: true },
  { brand: 'LG (UltraGear)', name: 'Black Stabilizer', tip: 'Etwas über der Mitte, z. B. 55 bis 65 von 100.', verified: false },
  { brand: 'Samsung (Odyssey)', name: 'Black Equalizer', tip: 'Etwas über der Mitte.', verified: false },
  { brand: 'MSI', name: 'Night Vision', tip: '„Normal“ oder „Stark“ – nicht „A.I.“, wenn das Bild flackert.', verified: false },
  { brand: 'Gigabyte / AORUS', name: 'Black Equalizer', tip: 'Etwas über der Mitte, z. B. 12 bis 14 von 20.', verified: false },
  { brand: 'AOC', name: 'Shadow Control', tip: 'Leicht über der Mitte.', verified: false },
  { brand: 'Dell / Alienware', name: 'Dark Stabilizer', tip: 'Stufe 1 oder 2.', verified: false },
  { brand: 'Acer (Nitro, Predator)', name: 'Black Boost', tip: 'Stufe 6 bis 7 von 10.', verified: false },
  { brand: 'ViewSonic', name: 'Black Stabilization', tip: 'Leicht über der Mitte.', verified: false },
];

export const VENDORS = [
  { id: 'nvidia', label: 'NVIDIA' },
  { id: 'amd', label: 'AMD' },
  { id: 'intel', label: 'Intel' },
];

/**
 * Die fünf Schritte. Jeder Punkt in "checks" ist ein Haken, den man setzen kann.
 * action: Knopf in der Ansicht (windows = Einstellungsseite öffnen, pattern = Testbild öffnen, …).
 */
export const STEPS = [
  {
    id: 'osd',
    title: 'Monitor-Menü',
    intro: 'Nimm die Knöpfe an deinem Monitor (meist unten oder hinten). Dort stellst du das Bild direkt im Monitor ein.',
    checks: [
      { id: 'mode', label: 'Bildmodus „Standard“, „FPS“ oder „Benutzer“ wählen', hint: 'Modi wie „Kino“, „Lesen“ oder „Augenschutz“ machen das Bild gelb oder dunkel.' },
      { id: 'dcr', label: 'Dynamischen Kontrast (DCR) ausschalten', hint: 'Er ändert die Helligkeit ständig von selbst. Dunkle Szenen werden dann noch dunkler.' },
      { id: 'eco', label: 'Eco-Modus und Lichtsensor ausschalten', hint: 'Beide dimmen das Bild, um Strom zu sparen.' },
      { id: 'black', label: 'Schwarz-Stabilisator auf eine mittlere Stufe', hint: 'Hebt nur die dunklen Töne an. Zu hoch macht das ganze Bild grau. Der Name hängt von der Marke ab (Liste unten).' },
      { id: 'brightness', label: 'Helligkeit passend zum Raum', hint: 'Heller Raum: eher hoch. Dunkler Raum: eher niedrig, sonst blendet es.' },
      { id: 'contrast', label: 'Kontrast auf Werkseinstellung lassen', hint: 'Meist 50 oder 70 bis 80. Prüfe es mit dem Weißwert-Bild.' },
    ],
    patterns: ['schwarz', 'weiss'],
  },
  {
    id: 'windows',
    title: 'Windows',
    intro: 'Windows kann das Bild zusätzlich verändern. Diese Punkte prüfst du in den Windows-Einstellungen.',
    checks: [
      { id: 'hdr', label: 'HDR nur bei echtem HDR-Monitor einschalten', hint: 'HDR = mehr Helligkeitsumfang. Bei einfachen Monitoren (HDR400) wirkt das Bild damit blass und Schwarz grau. Bei OLED oder HDR600 und mehr darf es an sein.', action: { type: 'settings', uri: 'ms-settings:display', label: 'Anzeige-Einstellungen öffnen' } },
      { id: 'hdrcal', label: 'Bei HDR: einmal die App „Windows HDR Calibration“ nutzen', hint: 'Die kostenlose App von Microsoft stellt ein, wie hell und dunkel HDR sein darf. Ohne HDR kannst du das überspringen.', action: { type: 'hdrStore', label: 'App im Microsoft Store öffnen' } },
      { id: 'nightlight', label: 'Nachtlicht beim Spielen ausschalten', hint: 'Das Nachtlicht färbt das Bild gelb. Gegner im Sturm sind dann schwerer zu sehen.', action: { type: 'settings', uri: 'ms-settings:nightlight', label: 'Nachtlicht öffnen' } },
      { id: 'autobright', label: 'Laptop: automatische Helligkeit ausschalten', hint: '„Helligkeit automatisch ändern“ und „Inhaltsabhängige Helligkeit“ dimmen dunkle Szenen. Am Desktop-PC gibt es das meist nicht.', action: { type: 'settings', uri: 'ms-settings:display', label: 'Anzeige-Einstellungen öffnen' } },
      { id: 'dccw', label: 'Optional: Windows-Farbkalibrierung durchgehen', hint: 'Ein Windows-Programm führt dich durch Gamma, Helligkeit und Kontrast. Am Ende kannst du „Vorherige Kalibrierung“ wählen, wenn es dir nicht gefällt.', action: { type: 'calibration', label: 'Farbkalibrierung starten' } },
    ],
    patterns: ['gamma'],
  },
  {
    id: 'treiber',
    title: 'Grafiktreiber',
    intro: 'Der Grafiktreiber ist das Programm deiner Grafikkarte. Dort stellst du Farbe und Schwarzwert ein.',
    vendors: {
      nvidia: [
        { id: 'nv-range', label: 'Ausgabe-Dynamikbereich auf „Voll“', hint: 'NVIDIA-Systemsteuerung → Auflösung ändern → „NVIDIA-Farbeinstellungen verwenden“ → Ausgabe-Farbformat RGB, Ausgabe-Dynamikbereich „Voll“ (Full). Über HDMI steht er oft auf „Begrenzt“ – dann ist Schwarz nur grau. Nach Treiber-Updates noch einmal prüfen.' },
        { id: 'nv-vibrance', label: 'Digitale Schwingung (Digital Vibrance) 60 bis 80 %', hint: 'NVIDIA-Systemsteuerung → Anzeige → Desktop-Farbeinstellungen anpassen. Standard ist 50 %. Kräftigere Farben lassen Gegner vor Wiese und Sturm mehr auffallen. Das ist Geschmackssache.' },
        { id: 'nv-app', label: 'Alternative: RTX Dynamic Vibrance in der NVIDIA App', hint: 'Nur ab RTX-20-Serie. Ein Filter nur für das Spiel – nutze entweder diesen oder die Digitale Schwingung, nicht beides stark.' },
      ],
      amd: [
        { id: 'amd-range', label: 'Pixelformat „RGB 4:4:4 PC-Standard (Full RGB)“', hint: 'AMD Software → Einstellungen (Zahnrad) → Anzeige → Pixelformat. So wird Schwarz wirklich schwarz.' },
        { id: 'amd-sat', label: 'Sättigung etwas erhöhen (110 bis 130)', hint: 'AMD Software → Einstellungen → Anzeige → „Benutzerdefinierte Farbe“ einschalten → Sättigung. Standard ist 100. Sättigung = wie kräftig die Farben sind.' },
        { id: 'amd-temp', label: 'Farbtemperatur auf 6500 K oder Steuerung aus', hint: 'Bei „Benutzerdefinierte Farbe“. 6500 K ist neutrales Weiß ohne Blau- oder Gelbstich.' },
      ],
      intel: [
        { id: 'intel-range', label: 'Quantisierungsbereich „Voll“, falls angeboten', hint: 'Intel Graphics Software (früher Arc Control) → Anzeige. „Voll“ sorgt für echtes Schwarz.' },
        { id: 'intel-sat', label: 'Sättigung leicht erhöhen', hint: 'Intel Graphics Software → Anzeige → Farbe → Sättigung. Bei HDMI mit YCbCr-Ausgabe wirkt das nicht – dann RGB wählen.' },
      ],
    },
    patterns: ['farben', 'verlauf'],
  },
  {
    id: 'fortnite',
    title: 'Fortnite',
    intro: 'Erst wenn Monitor, Windows und Treiber passen, stellst du Fortnite ein. Sonst gleichst du einen Fehler mit einem anderen aus.',
    checks: [
      { id: 'fn-bright', label: 'Helligkeit in Fortnite: 100 bis 130 %', hint: 'Das ist der Wert „DisplayGamma“ in der Fortnite-Datei. 100 % ist Standard. HELIX stellt ihn in den Sicht-Presets für dich ein.', action: { type: 'nav', to: 'sicht', label: 'Zu den Sicht-Presets' } },
      { id: 'fn-cb', label: 'Für den Sturm: Farbenblind-Modus Tritanopie, Stärke 5 bis 7', hint: 'Fortnite: Einstellungen → Barrierefreiheit (bei älteren Versionen: Video). Der Sturm wirkt weniger lila. Den Wert speichert Fortnite in der Epic-Cloud – deshalb stellst du ihn im Spiel ein.' },
      { id: 'fn-ui', label: 'Anzeige-Kontrast 1,0 bis 1,3', hint: 'Macht Leben, Munition und Karte kontrastreicher – nicht die Spielwelt.' },
    ],
    patterns: [],
  },
  {
    id: 'kontrolle',
    title: 'Kontrolle',
    intro: 'Jetzt der Test: Wie viele Figuren erkennst du im Sturm? So siehst du, ob sich die Einstellungen gelohnt haben.',
    checks: [],
    patterns: ['sturm'],
  },
];

/** Haken eines Schritts (beim Treiber nur die des gewählten Herstellers). */
export function stepChecks(step, vendor = 'nvidia') {
  if (step.vendors) return step.vendors[vendor] || step.vendors.nvidia;
  return step.checks || [];
}

/** Fortschritt: wie viele Haken insgesamt gesetzt sind. */
export function progress(checks = {}, vendor = 'nvidia') {
  let done = 0;
  let total = 0;
  for (const s of STEPS) {
    for (const c of stepChecks(s, vendor)) {
      total++;
      if (checks[c.id]) done++;
    }
  }
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}
