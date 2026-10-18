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
 * hint: eine kurze Zeile. how/why (optional): Details, die erst auf Klick aufgehen („So geht’s“ / „Warum?“).
 * action: Knopf in der Ansicht (windows = Einstellungsseite öffnen, pattern = Testbild öffnen, …).
 */
export const STEPS = [
  {
    id: 'osd',
    title: 'Monitor-Menü',
    intro: 'Mit den Knöpfen am Monitor – meist unten oder hinten.',
    checks: [
      { id: 'mode', label: 'Bildmodus „Standard“, „FPS“ oder „Benutzer“ wählen', hint: 'Modi wie „Kino“ oder „Augenschutz“ machen das Bild gelb oder dunkel.' },
      { id: 'dcr', label: 'Dynamischen Kontrast (DCR) ausschalten', hint: 'Er ändert die Helligkeit ständig. Dunkle Szenen werden noch dunkler.' },
      { id: 'eco', label: 'Eco-Modus und Lichtsensor ausschalten', hint: 'Beide dimmen das Bild, um Strom zu sparen.' },
      { id: 'black', label: 'Schwarz-Stabilisator auf eine mittlere Stufe', hint: 'Hebt dunkle Töne an. Zu hoch wirkt alles grau. Name je Marke: unten.' },
      { id: 'brightness', label: 'Helligkeit passend zum Raum', hint: 'Heller Raum: eher hoch. Dunkler Raum: eher niedrig, sonst blendet es.' },
      { id: 'contrast', label: 'Kontrast auf Werkseinstellung lassen', hint: 'Meist 50 oder 70 bis 80. Prüfe es mit dem Weißwert-Bild.' },
    ],
    patterns: ['schwarz', 'weiss'],
  },
  {
    id: 'windows',
    title: 'Windows',
    intro: 'Diese Punkte prüfst du in den Windows-Einstellungen.',
    checks: [
      { id: 'hdr', label: 'HDR nur bei echtem HDR-Monitor einschalten', hint: 'Bei einfachen Monitoren (HDR400) wirkt das Bild sonst blass.', why: 'HDR = mehr Helligkeitsumfang. Bei einfachen Monitoren wirkt das Bild damit blass und Schwarz grau. Bei OLED oder HDR600 und mehr darf es an sein.', action: { type: 'settings', uri: 'ms-settings:display', label: 'Anzeige-Einstellungen öffnen' } },
      { id: 'hdrcal', label: 'Bei HDR: einmal die App „Windows HDR Calibration“ nutzen', hint: 'Stellt ein, wie hell HDR sein darf. Ohne HDR: überspringen.', action: { type: 'hdrStore', label: 'App im Microsoft Store öffnen' } },
      { id: 'nightlight', label: 'Nachtlicht beim Spielen ausschalten', hint: 'Es färbt das Bild gelb. Gegner im Sturm sind dann schwerer zu sehen.', action: { type: 'settings', uri: 'ms-settings:nightlight', label: 'Nachtlicht öffnen' } },
      { id: 'autobright', label: 'Laptop: automatische Helligkeit ausschalten', hint: 'Dimmt dunkle Szenen. Am Desktop-PC gibt es das meist nicht.', how: 'Schalte „Helligkeit automatisch ändern“ und „Inhaltsabhängige Helligkeit“ aus.', action: { type: 'settings', uri: 'ms-settings:display', label: 'Anzeige-Einstellungen öffnen' } },
      { id: 'dccw', label: 'Optional: Windows-Farbkalibrierung durchgehen', hint: 'Gefällt es dir nicht, wähle am Ende „Vorherige Kalibrierung“.', action: { type: 'calibration', label: 'Farbkalibrierung starten' } },
    ],
    patterns: ['gamma'],
  },
  {
    id: 'treiber',
    title: 'Grafiktreiber',
    intro: 'Im Programm deiner Grafikkarte stellst du Farbe und Schwarzwert ein.',
    vendors: {
      nvidia: [
        { id: 'nv-range', label: 'Ausgabe-Dynamikbereich auf „Voll“', hint: 'Über HDMI steht er oft auf „Begrenzt“ – dann ist Schwarz nur grau.', how: 'NVIDIA-Systemsteuerung → Auflösung ändern → „NVIDIA-Farbeinstellungen verwenden“ → Ausgabe-Farbformat RGB, Ausgabe-Dynamikbereich „Voll“ (Full). Nach Treiber-Updates noch einmal prüfen.' },
        { id: 'nv-vibrance', label: 'Digitale Schwingung (Digital Vibrance) 60 bis 80 %', hint: 'Standard ist 50 %. Gegner fallen vor Wiese und Sturm mehr auf.', how: 'NVIDIA-Systemsteuerung → Anzeige → Desktop-Farbeinstellungen anpassen. Wie kräftig, ist Geschmackssache.' },
        { id: 'nv-app', label: 'Alternative: RTX Dynamic Vibrance in der NVIDIA App', hint: 'Ab RTX 20. Entweder das oder Digitale Schwingung – nicht beides stark.' },
      ],
      amd: [
        { id: 'amd-range', label: 'Pixelformat „RGB 4:4:4 PC-Standard (Full RGB)“', hint: 'So wird Schwarz wirklich schwarz.', how: 'AMD Software → Einstellungen (Zahnrad) → Anzeige → Pixelformat.' },
        { id: 'amd-sat', label: 'Sättigung etwas erhöhen (110 bis 130)', hint: 'Standard ist 100. Sättigung = wie kräftig die Farben sind.', how: 'AMD Software → Einstellungen → Anzeige → „Benutzerdefinierte Farbe“ einschalten → Sättigung.' },
        { id: 'amd-temp', label: 'Farbtemperatur auf 6500 K oder Steuerung aus', hint: 'Bei „Benutzerdefinierte Farbe“. 6500 K ist neutrales Weiß.' },
      ],
      intel: [
        { id: 'intel-range', label: 'Quantisierungsbereich „Voll“, falls angeboten', hint: '„Voll“ sorgt für echtes Schwarz.', how: 'Intel Graphics Software (früher Arc Control) → Anzeige.' },
        { id: 'intel-sat', label: 'Sättigung leicht erhöhen', hint: 'Wirkt nicht bei HDMI mit YCbCr-Ausgabe – dann RGB wählen.', how: 'Intel Graphics Software → Anzeige → Farbe → Sättigung.' },
      ],
    },
    patterns: ['farben', 'verlauf'],
  },
  {
    id: 'fortnite',
    title: 'Fortnite',
    intro: 'Erst wenn Monitor, Windows und Treiber passen, kommt Fortnite dran.',
    checks: [
      { id: 'fn-bright', label: 'Helligkeit in Fortnite: 100 bis 130 %', hint: '100 % ist Standard. HELIX stellt das in den Sicht-Presets ein.', action: { type: 'nav', to: 'sicht', label: 'Zu den Sicht-Presets' } },
      { id: 'fn-cb', label: 'Für den Sturm: Farbenblind-Modus Tritanopie, Stärke 5 bis 7', hint: 'Der Sturm wirkt weniger lila. Das stellst du im Spiel ein.', how: 'Fortnite: Einstellungen → Barrierefreiheit (bei älteren Versionen: Video). Fortnite speichert den Wert in der Epic-Cloud – deshalb geht es nur im Spiel.' },
      { id: 'fn-ui', label: 'Anzeige-Kontrast 1,0 bis 1,3', hint: 'Macht Leben, Munition und Karte kontrastreicher – nicht die Spielwelt.' },
    ],
    patterns: [],
  },
  {
    id: 'kontrolle',
    title: 'Kontrolle',
    intro: 'Wie viele Figuren erkennst du im Sturm? So siehst du, ob es sich gelohnt hat.',
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
