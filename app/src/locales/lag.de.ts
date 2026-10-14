/** Deutsche Texte des Namensraums „lag“ (Lag-Detektiv) – eingehängt in `de.ts`. */
export const lagDe = {
  title: "Lag-Detektiv",
  /** Anzeigenamen der eingeschätzten Ursachen (immer mit „vermutlich“/„Einschätzung“ zeigen) */
  cause: {
    wifi: "WLAN",
    router: "Heimnetz/Router",
    isp: "Anschluss/Anbieter",
    internet: "Internet (hinter dem Anbieter)",
    localTraffic: "Datenverkehr auf diesem PC",
    unknown: "unklar",
  },
  /** Zählung für Karte, Detail, Berichte und Bildkarte (`causeSummary` in lib/lagtext.ts) */
  summary: {
    none: "Keine Ausreißer untersucht",
    headOne: "1 Ausreißer untersucht",
    head: "{n} Ausreißer untersucht",
    likely: "vermutlich: {list}",
    item: "{n}× {cause}",
    unclear: "{n}× unklar",
  },
} as const;
