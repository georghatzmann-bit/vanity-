import type { RiskLevel } from '../../tokens/risk.ts';
import type { TimeInput } from '../../utils/time.ts';

/**
 * Ziel eines Plans – gleiche Form wie `aegis_core::plan::Target` im JSON (serde
 * `tag = "type"`, `snake_case`). Die App kann die Ziele aus dem Dienst direkt durchreichen.
 */
export type ConsentTarget =
  | { readonly type: 'file'; readonly path: string }
  | { readonly type: 'process'; readonly pid: number; readonly image_path: string }
  | { readonly type: 'registry_value'; readonly key: string; readonly name: string }
  | { readonly type: 'setting'; readonly id: string }
  | { readonly type: 'other'; readonly description: string };

export type ConsentTargetType = ConsentTarget['type'];

/** „Rückgängig wie?“ – gleiche Form wie `aegis_core::plan::UndoHint` im JSON. */
export type ConsentUndo =
  | { readonly type: 'reversible'; readonly how: string }
  | { readonly type: 'irreversible'; readonly warning: string };

/** Ein angezeigter Ausführungsparameter (z. B. Zielordner beim Verschieben). */
export interface ConsentParameter {
  readonly label: string;
  readonly value: string;
}

/**
 * Was der Freigabe-Dialog zeigt – spiegelt `aegis_core::plan::ActionPlan` plus die Frist
 * aus dem `ProposalTicket`. Die UI trifft keine Entscheidung und prüft nichts: Gültigkeit,
 * Digest und Frist prüft der Dienst (`ConsentGate`).
 */
export interface ConsentPlan {
  /** Plan-ID (`PlanId`). Wechselt sie, beginnt der Dialog von vorn (Sperrzeit, Fokus). */
  readonly id: string;
  /** Bezeichnung der Aktion, z. B. „In Quarantäne verschieben“ (`ActionKind::label_de`). */
  readonly kindLabel: string;
  /** Schweregrad des Anlasses (UI-Stufe; aus dem Kern per `riskLevelFromCoreId`). */
  readonly severity: RiskLevel;
  /** Betroffene Ziele (mindestens eins). */
  readonly targets: readonly ConsentTarget[];
  /** „Was genau?“ */
  readonly what: string;
  /** „Warum?“ */
  readonly why: string;
  /** „Was passiert dann?“ */
  readonly consequence: string;
  /** „Rückgängig wie?“ */
  readonly undo: ConsentUndo;
  /** Ende der Frist (`ProposalTicket.expires_at`, ausschließlich). */
  readonly expiresAt: TimeInput;
  /** Ausführungsparameter, lesbar aufbereitet (optional). */
  readonly parameters?: readonly ConsentParameter[] | undefined;
}

/**
 * Antwort des Nutzers – gleiche Kennungen wie `aegis_core::consent::Decision` (serde).
 * Nur `execute` führt zu einer Freigabe; alle anderen bedeuten: es wird nichts ausgeführt.
 */
export type ConsentDecision = 'execute' | 'decline' | 'ignore' | 'trust';

export const consentDecisions: readonly ConsentDecision[] = [
  'execute',
  'decline',
  'ignore',
  'trust',
];
