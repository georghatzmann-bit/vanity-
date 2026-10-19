import type { ColorToken } from './tokens.ts';

/** Die sechs Risikostufen von AEGIS, aufsteigend nach Schwere. */
export const riskLevels = ['clean', 'info', 'game', 'risky', 'suspicious', 'dangerous'] as const;
export type RiskLevel = (typeof riskLevels)[number];

/**
 * Deutsche Bezeichnungen für die UI – gleichlautend mit `RiskLevel::label_de` in
 * `crates/core/src/risk.rs`.
 */
export const riskLabels: Readonly<Record<RiskLevel, string>> = {
  clean: 'Sauber',
  info: 'Info',
  game: 'Spiel-Tool/Cheat',
  risky: 'Tool mit Risiko',
  suspicious: 'Verdächtig',
  dangerous: 'Gefährlich',
};

/** Kurze, ehrliche Erklärung je Stufe (Tooltips, Legenden). */
export const riskDescriptions: Readonly<Record<RiskLevel, string>> = {
  clean: 'Nichts gefunden.',
  info: 'Erwähnenswert, aber kein Risiko.',
  game: 'Meist gewollt, kann aber Kontosperren o. Ä. auslösen.',
  risky: 'Legitimes Werkzeug mit Missbrauchsrisiko (z. B. Fernwartung, Passwort-Tools).',
  suspicious: 'Heuristik schlägt an, aber kein sicherer Nachweis.',
  dangerous: 'Sichere Erkennung von Schadsoftware.',
};

/**
 * Kennungen aus `aegis-core` (serde `snake_case`, z. B. `"risky_tool"`) → UI-Stufe.
 * Die UI-Schlüssel sind kürzer, weil sie Teil der Token-Namen sind (`risk-risky`).
 */
export const coreRiskIds: Readonly<Record<RiskLevel, string>> = {
  clean: 'clean',
  info: 'info',
  game: 'game_tool',
  risky: 'risky_tool',
  suspicious: 'suspicious',
  dangerous: 'dangerous',
};

/** Ordnet eine Kennung aus `aegis-core` einer UI-Stufe zu (unbekannt → undefined). */
export function riskLevelFromCoreId(id: string): RiskLevel | undefined {
  return riskLevels.find((level) => coreRiskIds[level] === id);
}

/** Farb-Token für Text/Icon einer Risikostufe. */
export function riskColorToken(level: RiskLevel): ColorToken {
  return `risk-${level}`;
}

/** Farb-Token für die dezente Hintergrundfläche einer Risikostufe. */
export function riskSubtleColorToken(level: RiskLevel): ColorToken {
  return `risk-${level}-subtle`;
}
