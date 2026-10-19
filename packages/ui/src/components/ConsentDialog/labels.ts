import type { ConsentTargetType } from './types.ts';

/** Beschriftungen der Zielliste (beide Freigabe-Dialoge). */
export interface ConsentTargetLabels {
  /** Art des Ziels, z. B. „Datei“. */
  readonly types: Readonly<Record<ConsentTargetType, string>>;
  readonly pid: (pid: number) => string;
  /** Standardwert eines Registrierungsschlüssels (leerer Name). */
  readonly registryDefault: string;
  readonly showFull: string;
  readonly showShort: string;
  readonly invisibleHint: string;
  readonly rtlHint: string;
  /** Screenreader-Text für eine Marke wie `⟨U+202E⟩`. */
  readonly describeInvisible: (codePoint: string, name: string | undefined) => string;
}

export interface ConsentDialogLabels {
  readonly eyebrow: string;
  readonly execute: string;
  readonly decline: string;
  readonly ignore: string;
  readonly trust: string;
  readonly targetsHeading: (count: number) => string;
  readonly what: string;
  readonly why: string;
  readonly consequence: string;
  readonly undo: string;
  readonly reversible: string;
  readonly irreversible: string;
  readonly irreversibleTitle: string;
  readonly dangerousTitle: string;
  readonly dangerousText: string;
  readonly parametersHeading: string;
  readonly noResponseHint: string;
  readonly ignoreHint: string;
  readonly trustHint: string;
  /** Sichtbare Frist, z. B. „Frist 9:41“. */
  readonly deadline: (remaining: string) => string;
  /** Zugängliche Frist mit Uhrzeit, z. B. „Ohne Antwort verfällt die Anfrage um 14:05 Uhr.“ */
  readonly deadlineAccessible: (time: string) => string;
  readonly expiredTitle: string;
  readonly expiredText: string;
  readonly close: string;
  /** Hinweis, solange „Ja, ausführen“ kurz gesperrt ist (nur für Screenreader). */
  readonly armingHint: string;
  readonly targets: ConsentTargetLabels;
}

export const consentTargetLabelsDe: ConsentTargetLabels = {
  types: {
    file: 'Datei',
    process: 'Prozess',
    registry_value: 'Registrierungswert',
    setting: 'Einstellung',
    other: 'Ziel',
  },
  pid: (pid) => `PID ${pid}`,
  registryDefault: '(Standard)',
  showFull: 'Ganz anzeigen',
  showShort: 'Kürzen',
  invisibleHint: 'Enthält unsichtbare Steuerzeichen – sie sind als ⟨U+…⟩ markiert.',
  rtlHint: 'Enthält Schrift mit Leserichtung rechts-nach-links – Reihenfolge genau prüfen.',
  describeInvisible: (codePoint, name) =>
    name === undefined ? `Steuerzeichen ${codePoint}` : `Steuerzeichen ${codePoint} (${name})`,
};

export const consentTargetLabelsEn: ConsentTargetLabels = {
  types: {
    file: 'File',
    process: 'Process',
    registry_value: 'Registry value',
    setting: 'Setting',
    other: 'Target',
  },
  pid: (pid) => `PID ${pid}`,
  registryDefault: '(Default)',
  showFull: 'Show full',
  showShort: 'Shorten',
  invisibleHint: 'Contains invisible control characters – shown as ⟨U+…⟩.',
  rtlHint: 'Contains right-to-left script – check the character order carefully.',
  describeInvisible: (codePoint, name) =>
    name === undefined
      ? `control character ${codePoint}`
      : `control character ${codePoint} (${name})`,
};

/** Deutsche Standard-Beschriftungen – Knöpfe wie `Decision::label_de` im Kern. */
export const consentDialogLabelsDe: ConsentDialogLabels = {
  eyebrow: 'Freigabe erforderlich',
  execute: 'Ja, ausführen',
  decline: 'Nein',
  ignore: 'Ignorieren',
  trust: 'Vertrauen',
  targetsHeading: (count) => (count === 1 ? 'Betroffen' : `Betroffen (${count})`),
  what: 'Was genau?',
  why: 'Warum?',
  consequence: 'Was passiert dann?',
  undo: 'Rückgängig?',
  reversible: 'Umkehrbar',
  irreversible: 'Nicht umkehrbar',
  irreversibleTitle: 'Kann nicht rückgängig gemacht werden',
  dangerousTitle: 'Als gefährlich eingestuft',
  dangerousText: 'Schwerwiegender Fund. Prüfe Ziel und Folgen genau, bevor du entscheidest.',
  parametersHeading: 'Einzelheiten',
  noResponseHint: 'Ohne Antwort passiert nichts.',
  ignoreHint: 'Ignorieren: nichts tun und nicht erneut melden.',
  trustHint: 'Vertrauen: nichts tun und als vertrauenswürdig merken.',
  deadline: (remaining) => `Frist ${remaining}`,
  deadlineAccessible: (time) => `Ohne Antwort verfällt die Anfrage um ${time} Uhr.`,
  expiredTitle: 'Abgelaufen – es wurde nichts getan',
  expiredText: 'Die Frist ist verstrichen. AEGIS hat nichts verändert; die Anfrage ist verfallen.',
  close: 'Schließen',
  armingHint: 'Bestätigen ist gleich möglich.',
  targets: consentTargetLabelsDe,
};

/** Englische Beschriftungen (zweite Sprache) – Knöpfe wie `Decision::label_en`. */
export const consentDialogLabelsEn: ConsentDialogLabels = {
  eyebrow: 'Approval required',
  execute: 'Yes, execute',
  decline: 'No',
  ignore: 'Ignore',
  trust: 'Trust',
  targetsHeading: (count) => (count === 1 ? 'Affected' : `Affected (${count})`),
  what: 'What exactly?',
  why: 'Why?',
  consequence: 'What happens then?',
  undo: 'Undo?',
  reversible: 'Reversible',
  irreversible: 'Irreversible',
  irreversibleTitle: 'Cannot be undone',
  dangerousTitle: 'Rated dangerous',
  dangerousText: 'Serious finding. Check the target and consequences carefully before deciding.',
  parametersHeading: 'Details',
  noResponseHint: 'Without an answer, nothing happens.',
  ignoreHint: 'Ignore: do nothing and do not report again.',
  trustHint: 'Trust: do nothing and remember as trusted.',
  deadline: (remaining) => `Expires ${remaining}`,
  deadlineAccessible: (time) => `Without an answer, the request expires at ${time}.`,
  expiredTitle: 'Expired – nothing was done',
  expiredText: 'The deadline has passed. AEGIS changed nothing; the request has lapsed.',
  close: 'Close',
  armingHint: 'Confirming will be possible in a moment.',
  targets: consentTargetLabelsEn,
};

export interface PermanentDeleteLabels {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly targetsHeading: (count: number) => string;
  readonly confirm: string;
  readonly cancel: string;
  /** Countdown bis zur möglichen Bestätigung, z. B. „Bestätigen möglich in 1,2 s“. */
  readonly waiting: (seconds: string) => string;
  readonly ready: string;
  readonly expiredTitle: string;
  readonly expiredText: string;
  readonly close: string;
  readonly targets: ConsentTargetLabels;
}

export const permanentDeleteLabelsDe: PermanentDeleteLabels = {
  eyebrow: 'Zweite Bestätigung',
  title: 'Endgültig löschen – kann nicht rückgängig gemacht werden',
  description:
    'Die Datei wird unwiderruflich gelöscht – auch über die Quarantäne lässt sie sich danach nicht wiederherstellen.',
  targetsHeading: (count) => (count === 1 ? 'Wird gelöscht' : `Wird gelöscht (${count})`),
  confirm: 'Endgültig löschen',
  cancel: 'Abbrechen',
  waiting: (seconds) => `Bestätigen möglich in ${seconds}`,
  ready: 'Bestätigen jetzt möglich. Abbrechen lässt alles, wie es ist.',
  expiredTitle: 'Abgelaufen – es wurde nichts gelöscht',
  expiredText: 'Die Frist für die zweite Bestätigung ist verstrichen. Die Datei ist unverändert.',
  close: 'Schließen',
  targets: consentTargetLabelsDe,
};

export const permanentDeleteLabelsEn: PermanentDeleteLabels = {
  eyebrow: 'Second confirmation',
  title: 'Delete permanently – cannot be undone',
  description:
    'The file will be deleted irrevocably – it cannot be restored afterwards, not even from quarantine.',
  targetsHeading: (count) => (count === 1 ? 'Will be deleted' : `Will be deleted (${count})`),
  confirm: 'Delete permanently',
  cancel: 'Cancel',
  waiting: (seconds) => `Confirming possible in ${seconds}`,
  ready: 'Confirming is possible now. Cancel leaves everything as it is.',
  expiredTitle: 'Expired – nothing was deleted',
  expiredText: 'The deadline for the second confirmation has passed. The file is unchanged.',
  close: 'Close',
  targets: consentTargetLabelsEn,
};
