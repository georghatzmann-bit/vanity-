/** Deutsche Texte des Namensraums „sonar“ (Hör dein Netz) – eingehängt in `de.ts`. */
export const sonarDe = {
  title: "Hör dein Netz",
  /** Knopf im Cockpit (Live-Ping-Karte) */
  turnOn: "Hör dein Netz: Live-Ping als Pulsar-Ton einschalten",
  turnOff: "Hör dein Netz ausschalten",
  playing: "Hör dein Netz läuft",
  monitorOff: "Hör dein Netz: erst den Live-Monitor fortsetzen",
  muted: "Pulsar-Töne sind aus (Einstellungen › Ton) – nichts zu hören",
  blocked: "Der Ton ist gerade blockiert (kein Audiogerät oder vom System angehalten)",
  dropped: "Aussetzer (Verlust)",
  accent: "betont (Ausreißer)",
  /** Kurz-Legende unter dem Knopf-Titel */
  legend: "Gleichmäßig = stabil · stolpernd = Schwankung · Lücken = Verlust · betont = Ausreißer",
  /** Einstellungen › Ton › Hör dein Netz */
  settings: {
    desc: "Macht den Live-Ping hörbar: ein Puls je Messung. Einschalten im Cockpit (Kopfhörer-Knopf an der Live-Ping-Karte). Der Ton verbessert nichts – er übersetzt nur die Messung.",
    volume: "Lautstärke",
    volumeDesc: "Zusätzlich zur Gesamtlautstärke oben.",
    pitch: "Tonhöhe folgt dem Ping",
    pitchDesc: "Heller Klang bei niedrigem Ping, dunkler bei hohem (gleiche Stufen wie die Ping-Noten). Keine Melodie – nur eine andere Resonanz.",
    alertInGame: "Warnton im Spiel",
    alertInGameDesc: "Sehr leiser Einzelton, wenn ein Ausreißer erkannt wird – nur während ein Spiel läuft, höchstens alle 10 s. Reagiert auf Pulsars Messziel, nicht auf die Verbindung des Spiels. Funktioniert auch, wenn „Hör dein Netz“ aus ist.",
    alertVolume: "Warnton-Lautstärke",
    preview: "Probehören",
    previewDesc: "Je 4 Sekunden mit Beispielwerten – keine echte Messung.",
    previewStop: "Probe beenden",
    previewNames: {
      stable: "Stabil",
      unstable: "Schwankung",
      loss: "Verlust",
      alert: "Warnton",
    },
    mutedHint: "Pulsar-Töne sind aus – oben „Töne“ einschalten, sonst bleibt alles still.",
    honest: "Das Stolpern übersetzt die gemessene Schwankung in Klang, es ist nicht das echte Timing einzelner Pakete. Läuft Pulsar versteckt im Infobereich, stoppt „Hör dein Netz“; ob Windows den Warnton dann noch abspielt, hängt von WebView2 ab.",
  },
} as const;
