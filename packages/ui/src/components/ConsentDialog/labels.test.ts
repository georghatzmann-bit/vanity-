import { describe, expect, it } from 'vitest';
import {
  consentDialogLabelsDe,
  consentDialogLabelsEn,
  consentTargetLabelsDe,
  consentTargetLabelsEn,
  permanentDeleteLabelsDe,
  permanentDeleteLabelsEn,
} from './labels.ts';
import { consentDecisions } from './types.ts';

describe('Beschriftungen der Freigabe-Dialoge', () => {
  it('nutzen für die Knöpfe genau die Bezeichnungen aus aegis-core (Decision::label_de/en)', () => {
    expect(consentDecisions).toEqual(['execute', 'decline', 'ignore', 'trust']);
    expect([
      consentDialogLabelsDe.execute,
      consentDialogLabelsDe.decline,
      consentDialogLabelsDe.ignore,
      consentDialogLabelsDe.trust,
    ]).toEqual(['Ja, ausführen', 'Nein', 'Ignorieren', 'Vertrauen']);
    expect([
      consentDialogLabelsEn.execute,
      consentDialogLabelsEn.decline,
      consentDialogLabelsEn.ignore,
      consentDialogLabelsEn.trust,
    ]).toEqual(['Yes, execute', 'No', 'Ignore', 'Trust']);
  });

  it('formulieren Anzahlen, Fristen und Zeichen in beiden Sprachen', () => {
    expect(consentDialogLabelsDe.targetsHeading(1)).toBe('Betroffen');
    expect(consentDialogLabelsDe.targetsHeading(3)).toBe('Betroffen (3)');
    expect(consentDialogLabelsEn.targetsHeading(1)).toBe('Affected');
    expect(consentDialogLabelsEn.targetsHeading(2)).toBe('Affected (2)');
    expect(consentDialogLabelsEn.deadline('9:41')).toBe('Expires in 9:41');
    expect(consentDialogLabelsEn.deadlineAccessible('14:05')).toBe(
      'Without an answer, the request expires at 14:05.',
    );
    expect(consentTargetLabelsDe.pid(7)).toBe('PID 7');
    expect(consentTargetLabelsEn.pid(7)).toBe('PID 7');
    expect(consentTargetLabelsDe.describeInvisible('U+202E', undefined)).toBe(
      'Steuerzeichen U+202E',
    );
    expect(consentTargetLabelsEn.describeInvisible('U+202E', 'RLO')).toBe(
      'control character U+202E (RLO)',
    );
    expect(consentTargetLabelsEn.describeInvisible('U+E0041', undefined)).toBe(
      'control character U+E0041',
    );
    expect(permanentDeleteLabelsDe.targetsHeading(1)).toBe('Wird gelöscht');
    expect(permanentDeleteLabelsDe.targetsHeading(2)).toBe('Wird gelöscht (2)');
    expect(permanentDeleteLabelsEn.targetsHeading(1)).toBe('Will be deleted');
    expect(permanentDeleteLabelsEn.targetsHeading(4)).toBe('Will be deleted (4)');
    expect(permanentDeleteLabelsDe.waiting('1,5 s')).toBe('Bestätigen möglich in 1,5 s');
  });

  it('sagen beim endgültigen Löschen ausdrücklich, dass es nicht rückgängig zu machen ist', () => {
    expect(permanentDeleteLabelsDe.title).toBe(
      'Endgültig löschen – kann nicht rückgängig gemacht werden',
    );
    expect(consentDialogLabelsDe.expiredTitle).toBe('Abgelaufen – es wurde nichts getan');
    expect(permanentDeleteLabelsDe.expiredTitle).toBe('Abgelaufen – es wurde nichts gelöscht');
  });

  it('UX-09: die Restzeit liest sich nicht als Uhrzeit', () => {
    expect(consentDialogLabelsDe.deadline('10:00')).toBe('Verfällt in 10:00');
    expect(consentDialogLabelsEn.deadline('10:00')).toBe('Expires in 10:00');
  });

  it('F17: nennt bei Bedarf das Datum der Frist und setzt beim Löschen keine Einzahl voraus', () => {
    expect(consentDialogLabelsDe.deadlineAccessible('14:05')).toBe(
      'Ohne Antwort verfällt die Anfrage um 14:05 Uhr.',
    );
    expect(consentDialogLabelsDe.deadlineAccessible('14:05', '20.10.2026')).toBe(
      'Ohne Antwort verfällt die Anfrage am 20.10.2026 um 14:05 Uhr.',
    );
    expect(consentDialogLabelsEn.deadlineAccessible('2:05 PM', '10/20/2026')).toBe(
      'Without an answer, the request expires on 10/20/2026 at 2:05 PM.',
    );
    for (const labels of [permanentDeleteLabelsDe, permanentDeleteLabelsEn]) {
      expect(labels.description).not.toMatch(/Die Datei|The file/);
      expect(labels.expiredText).not.toMatch(/Die Datei|The file/);
    }
  });

  it('haben für jeden deutschen Text eine englische Entsprechung', () => {
    expect(Object.keys(consentDialogLabelsEn).sort()).toEqual(
      Object.keys(consentDialogLabelsDe).sort(),
    );
    expect(Object.keys(permanentDeleteLabelsEn).sort()).toEqual(
      Object.keys(permanentDeleteLabelsDe).sort(),
    );
    expect(Object.keys(consentTargetLabelsEn).sort()).toEqual(
      Object.keys(consentTargetLabelsDe).sort(),
    );
    expect(consentDialogLabelsEn.answered('Yes, execute')).toBe('Answer “Yes, execute” sent.');
    expect(consentDialogLabelsDe.answered('Nein')).toBe('Antwort „Nein“ gesendet.');
  });
});
