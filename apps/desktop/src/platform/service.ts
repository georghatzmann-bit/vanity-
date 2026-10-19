/**
 * Verbindung zum Dienst `aegis-service` über die App-Befehle `service_*`.
 *
 * Die Oberfläche führt nichts aus: Sie fragt an, zeigt Vorschläge im Freigabe-Dialog und reicht
 * die Antwort (mit der Einmal-Nonce des Dienstes) zurück. Antworten des Dienstes werden hier
 * nur grob geprüft und typisiert – vertraut wird ihnen für die Anzeige, nicht für Sicherheit.
 */
import {
  riskLevelFromCoreId,
  type ConsentDecision,
  type ConsentPlan,
  type RiskLevel,
} from '@aegis/ui';

/** Ein Fund aus dem Scan (Ausschnitt aus `aegis_engine::Finding`). */
export interface ScanFinding {
  readonly path: string;
  readonly sha256: string | null;
  readonly size: number;
  readonly risk: RiskLevel;
  readonly confidence: number;
  readonly category: string;
  readonly summaryDe: string;
  readonly summaryEn: string;
  readonly recommendation: 'none' | 'review' | 'quarantine';
  readonly reasons: readonly FindingReason[];
  readonly notScannable: string | null;
  /** Auffällige Inhalte von Archiven/Abbildern/Dokumenten. */
  readonly contained: readonly ContainedItem[];
  /** Vom Nutzer vertraut (Hash + Pfad) – die Stufe bleibt trotzdem sichtbar. */
  readonly trusted: { readonly id: string; readonly reason: string; readonly since: string } | null;
}

/** Eintrag der Vertrauensliste. */
export interface TrustEntry {
  readonly id: string;
  readonly sha256: string;
  readonly path: string;
  readonly reason: string;
  readonly createdAt: string;
}

/** Eine Begründung („Warum?“). */
export interface FindingReason {
  readonly code: string;
  readonly de: string;
  readonly en: string;
}

/** Auffälliger Inhalt eines Containers. */
export interface ContainedItem {
  readonly name: string;
  readonly risk: RiskLevel;
  readonly summaryDe: string;
  readonly summaryEn: string;
}

/** Ergebnis eines Scans. */
export interface ScanResult {
  readonly findings: readonly ScanFinding[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  readonly truncated: boolean;
}

/** Eintrag der Quarantäne. */
export interface QuarantineEntry {
  readonly id: string;
  readonly originalPath: string;
  readonly sha256: string;
  readonly size: number;
  readonly quarantinedAt: string;
  readonly reason: string;
}

/** Vorschlag des Dienstes für den Freigabe-Dialog. */
export interface Proposal {
  readonly plan: ConsentPlan;
  readonly digest: string;
  readonly nonce: string;
}

/** Rückfrage vor endgültigem Löschen. */
export interface SecondChallenge {
  readonly challengeId: string;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly nonce: string;
}

/** Ergebnis einer Antwort. */
export type DecisionResult =
  | { readonly kind: 'executed'; readonly ok: boolean; readonly message: string | null }
  | { readonly kind: 'nothing' }
  | { readonly kind: 'trusted'; readonly note: string }
  | { readonly kind: 'second'; readonly challenge: SecondChallenge };

/** Fehler des Dienstes (es wurde nichts ausgeführt, sofern nicht anders gesagt). */
export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

/** Dienst-Aufrufe (in der Browser-Vorschau nicht vorhanden). */
export interface ServiceApi {
  scan(paths: readonly string[]): Promise<ScanResult>;
  listQuarantine(): Promise<readonly QuarantineEntry[]>;
  proposeQuarantine(paths: readonly string[]): Promise<Proposal>;
  proposeRestore(entryId: string): Promise<Proposal>;
  proposeDelete(entryId: string): Promise<Proposal>;
  decide(proposal: Proposal, decision: ConsentDecision, dialogId: string): Promise<DecisionResult>;
  confirmSecond(
    challenge: SecondChallenge,
    decision: ConsentDecision,
    dialogId: string,
  ): Promise<DecisionResult>;
  listTrust(): Promise<readonly TrustEntry[]>;
  revokeTrust(id: string): Promise<void>;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function arr(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Wirft bei `{type:"error"}` und prüft den erwarteten Typ. */
export function expectType(response: unknown, type: string): Json {
  if (!isObject(response)) {
    throw new ServiceError('invalid', 'Unerwartete Antwort des Dienstes.');
  }
  if (response['type'] === 'error') {
    throw new ServiceError(str(response['code'], 'error'), str(response['message'], 'Fehler'));
  }
  if (response['type'] !== type) {
    throw new ServiceError(
      'invalid',
      `Unerwartete Antwort des Dienstes (${str(response['type'])}).`,
    );
  }
  return response;
}

export function parseFinding(value: unknown): ScanFinding {
  const f = isObject(value) ? value : {};
  const rec = str(f['recommendation']);
  return {
    path: str(f['path']),
    sha256: typeof f['sha256'] === 'string' ? f['sha256'] : null,
    size: num(f['size']),
    risk: riskLevelFromCoreId(str(f['risk'])) ?? 'info',
    confidence: num(f['confidence']),
    category: str(f['category']),
    summaryDe: str(f['summary_de']),
    summaryEn: str(f['summary_en']),
    recommendation: rec === 'quarantine' || rec === 'review' ? rec : 'none',
    reasons: arr(f['reasons'])
      .filter(isObject)
      .map((r) => ({ code: str(r['code']), de: str(r['de']), en: str(r['en']) })),
    notScannable: typeof f['not_scannable'] === 'string' ? f['not_scannable'] : null,
    contained: arr(f['contained'])
      .filter(isObject)
      .map((c) => ({
        name: str(c['name']),
        risk: riskLevelFromCoreId(str(c['risk'])) ?? 'info',
        summaryDe: str(c['summary_de']),
        summaryEn: str(c['summary_en']),
      })),
    trusted: isObject(f['trusted'])
      ? {
          id: str(f['trusted']['id']),
          reason: str(f['trusted']['reason']),
          since: str(f['trusted']['since']),
        }
      : null,
  };
}

export function parseScan(response: unknown): ScanResult {
  const report = expectType(response, 'scan_report')['report'];
  const r = isObject(report) ? report : {};
  return {
    findings: arr(r['findings']).map(parseFinding),
    skipped: arr(r['skipped'])
      .filter(isObject)
      .map((s) => ({ path: str(s['path']), reason: str(s['reason']) })),
    truncated: r['truncated'] === true,
  };
}

export function parseQuarantine(response: unknown): readonly QuarantineEntry[] {
  return arr(expectType(response, 'quarantine')['entries'])
    .filter(isObject)
    .map((e) => ({
      id: str(e['id']),
      originalPath: str(e['original_path']),
      sha256: str(e['sha256']),
      size: num(e['size']),
      quarantinedAt: str(e['quarantined_at']),
      reason: str(e['reason']),
    }));
}

export function parseTrust(response: unknown): readonly TrustEntry[] {
  return arr(expectType(response, 'trust')['entries'])
    .filter(isObject)
    .map((e) => ({
      id: str(e['id']),
      sha256: str(e['sha256']),
      path: str(e['path']),
      reason: str(e['reason']),
      createdAt: str(e['created_at']),
    }));
}

const kindLabels: Readonly<Record<string, string>> = {
  quarantine: 'In die Quarantäne verschieben',
  restore: 'Aus der Quarantäne wiederherstellen',
  delete_permanently: 'Endgültig löschen',
};

/** Wandelt den Vorschlag des Dienstes in die Form des Freigabe-Dialogs. */
export function parseProposal(response: unknown): Proposal {
  const proposal = expectType(response, 'proposal')['proposal'];
  const p = isObject(proposal) ? proposal : {};
  const plan = isObject(p['plan']) ? p['plan'] : {};
  const ticket = isObject(p['ticket']) ? p['ticket'] : {};
  const id = str(ticket['id']);
  const digest = str(ticket['digest']);
  const nonce = str(p['nonce']);
  if (id === '' || digest === '' || nonce === '') {
    throw new ServiceError('invalid', 'Unvollständiger Vorschlag des Dienstes – nichts angezeigt.');
  }
  const undo = isObject(plan['undo']) ? plan['undo'] : {};
  return {
    digest,
    nonce,
    plan: {
      id,
      digest,
      kindLabel: kindLabels[str(plan['kind'])] ?? str(plan['kind']),
      severity: riskLevelFromCoreId(str(plan['severity'])) ?? 'info',
      targets: arr(plan['targets'])
        .filter(isObject)
        .map((t) => ({ type: 'file' as const, path: str(t['path']) })),
      what: str(plan['what']),
      why: str(plan['why']),
      consequence: str(plan['consequence']),
      undo:
        undo['type'] === 'irreversible'
          ? { type: 'irreversible', warning: str(undo['warning']) }
          : { type: 'reversible', how: str(undo['how']) },
      expiresAt: str(ticket['expires_at']),
    },
  };
}

export function parseDecision(response: unknown): DecisionResult {
  if (!isObject(response)) {
    throw new ServiceError('invalid', 'Unerwartete Antwort des Dienstes.');
  }
  switch (response['type']) {
    case 'executed': {
      const result = isObject(response['result']) ? response['result'] : {};
      const status = str(result['status']);
      return {
        kind: 'executed',
        ok: status === 'succeeded',
        message: typeof result['message'] === 'string' ? result['message'] : null,
      };
    }
    case 'nothing_done':
      return { kind: 'nothing' };
    case 'trusted':
      return { kind: 'trusted', note: str(response['note']) };
    case 'second_confirmation_required': {
      const c = isObject(response['challenge']) ? response['challenge'] : {};
      return {
        kind: 'second',
        challenge: {
          challengeId: str(c['challenge_id']),
          notBefore: str(c['not_before']),
          expiresAt: str(c['expires_at']),
          nonce: str(response['nonce']),
        },
      };
    }
    default:
      expectType(response, 'executed');
      throw new ServiceError('invalid', 'Unerwartete Antwort des Dienstes.');
  }
}
