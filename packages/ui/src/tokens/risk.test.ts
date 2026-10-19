// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  coreRiskIds,
  riskColorToken,
  riskDescriptions,
  riskLevelFromCoreId,
  riskLabels,
  riskLevels,
  riskSubtleColorToken,
} from './risk.ts';
import { colorTokenNames } from './tokens.ts';

describe('Risikostufen', () => {
  it('hat sechs Stufen in aufsteigender Schwere mit deutschen Bezeichnungen', () => {
    expect(riskLevels).toEqual(['clean', 'info', 'game', 'risky', 'suspicious', 'dangerous']);
    expect(Object.values(riskLabels)).toEqual([
      'Sauber',
      'Info',
      'Spiel-Tool/Cheat',
      'Tool mit Risiko',
      'Verdächtig',
      'Gefährlich',
    ]);
    for (const level of riskLevels) {
      expect(riskDescriptions[level].length).toBeGreaterThan(10);
    }
  });

  it('bildet die Kennungen aus aegis-core ab (snake_case)', () => {
    expect(Object.values(coreRiskIds)).toEqual([
      'clean',
      'info',
      'game_tool',
      'risky_tool',
      'suspicious',
      'dangerous',
    ]);
    for (const level of riskLevels) {
      expect(riskLevelFromCoreId(coreRiskIds[level])).toBe(level);
    }
    expect(riskLevelFromCoreId('unbekannt')).toBeUndefined();
  });

  it('verweist auf existierende Farb-Tokens', () => {
    for (const level of riskLevels) {
      expect(colorTokenNames).toContain(riskColorToken(level));
      expect(colorTokenNames).toContain(riskSubtleColorToken(level));
    }
    expect(riskColorToken('dangerous')).toBe('risk-dangerous');
    expect(riskSubtleColorToken('clean')).toBe('risk-clean-subtle');
  });
});
