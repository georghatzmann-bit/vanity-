import { useState } from 'react';
import {
  Button,
  ConsentDialog,
  IconArrowRight,
  IconClock,
  IconDanger,
  IconInfo,
  IconQuarantine,
  IconScan,
  IconShield,
  IconTrash,
  Kbd,
  Panel,
  PermanentDeleteConfirmDialog,
  RiskBadge,
  ScoreGauge,
  StatusRing,
  consentDialogLabelsDe,
  type ConsentDecision,
  type ConsentPlan,
} from '../src/index.ts';
import {
  deletePlan,
  deleteTargets,
  demoEvents,
  demoModules,
  demoScore,
  quarantinePlan,
  shortDeadlinePlan,
  terminatePlan,
} from './demoData.ts';
import { Card, DemoTag, Label, Section } from './primitives.tsx';

/* --------------------------------------------------------------- Freigabe */

const decisionText: Readonly<Record<ConsentDecision, string>> = {
  execute: '„Ja, ausführen“',
  decline: '„Nein“',
  ignore: '„Ignorieren“',
  trust: '„Vertrauen“',
};

/** Ablauf der Beispiel-Freigabe (der zuletzt gezeigte Plan bleibt für das Ausblenden erhalten). */
export interface ConsentFlow {
  readonly step: 'idle' | 'consent' | 'second';
  readonly plan: ConsentPlan;
  readonly permanent: boolean;
  readonly notBefore?: number | undefined;
  readonly expiresAt?: number | undefined;
}

/** Platzhalter, solange kein Beispiel offen war (der Dialog ist dann geschlossen). */
const placeholderPlan: ConsentPlan = {
  id: 'beispiel-leer',
  kindLabel: 'Beispiel',
  severity: 'info',
  targets: [{ type: 'other', description: 'Beispiel' }],
  what: '',
  why: '',
  consequence: '',
  undo: { type: 'reversible', how: '' },
  expiresAt: 0,
};

export const idleConsentFlow: ConsentFlow = {
  step: 'idle',
  plan: placeholderPlan,
  permanent: false,
};

/** Öffnet ein Beispiel (für Buttons und die Befehlspalette). */
export function openConsentExample(
  kind: 'quarantine' | 'terminate' | 'delete' | 'deadline',
): ConsentFlow {
  const now = Date.now();
  switch (kind) {
    case 'quarantine':
      return { step: 'consent', plan: quarantinePlan(now), permanent: false };
    case 'terminate':
      return { step: 'consent', plan: terminatePlan(now), permanent: false };
    case 'delete':
      return { step: 'consent', plan: deletePlan(now), permanent: true };
    case 'deadline':
      return { step: 'consent', plan: shortDeadlinePlan(now), permanent: false };
  }
}

const safetyRules = [
  'Startfokus auf „Nein“ – nie auf „Ja, ausführen“.',
  '„Ja, ausführen“, „Vertrauen“ und „Ignorieren“ sind nach dem Öffnen 600 ms gesperrt (gegen Durchklicken/Doppelklick) – „Nein“ geht sofort.',
  'Die Sperre beginnt neu bei jeder Planänderung, wenn ein Dialog darüber schließt und wenn das Fenster wieder nach vorn kommt; ein Druck, der schon während der Sperre begann, zählt nicht.',
  'Escape = „Nein“. Klick neben den Dialog tut nichts. Enter löst nie „Ja“ aus.',
  'Höchstens eine Antwort je Öffnen; nach Ablauf der Frist ist alles gesperrt.',
  'Unsichtbare Zeichen in Pfaden erscheinen als ⟨U+202E⟩, lange Pfade sind in der Mitte gekürzt.',
  'Endgültiges Löschen braucht eine zweite, getrennte Bestätigung mit Wartezeit.',
];

export function ConsentSection({
  flow,
  setFlow,
}: {
  readonly flow: ConsentFlow;
  readonly setFlow: (flow: ConsentFlow) => void;
}) {
  const [log, setLog] = useState<string>('Noch keine Antwort.');
  const finish = (message: string): void => {
    setFlow({ ...flow, step: 'idle' });
    setLog(message);
  };

  const onDecision = (decision: ConsentDecision): void => {
    if (flow.step !== 'consent') {
      return;
    }
    if (decision === 'execute' && flow.permanent) {
      const now = Date.now();
      setFlow({ ...flow, step: 'second', notBefore: now + 1500, expiresAt: now + 120_000 });
      setLog('Erste Bestätigung erhalten – zweite Rückfrage folgt (Beispiel).');
      return;
    }
    finish(
      decision === 'execute'
        ? `Antwort ${decisionText[decision]} – im Showcase wird nichts ausgeführt (Beispiel).`
        : `Antwort ${decisionText[decision]} – es wurde nichts getan.`,
    );
  };

  return (
    <Section
      id="freigabe"
      eyebrow="Goldene Regel"
      title="Freigabe-Dialog"
      description="Die Oberfläche der Goldenen Regel: Ohne ausdrückliches „Ja“ passiert nichts. Der Dialog zeigt den Aktionsplan vollständig und holt genau eine Antwort ein."
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Card className="flex flex-col gap-5 p-5">
          <div className="flex items-center justify-between gap-3">
            <Label>Beispiele öffnen</Label>
            <DemoTag>Beispiel</DemoTag>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              iconStart={<IconQuarantine />}
              className="justify-start"
              onClick={() => setFlow(openConsentExample('quarantine'))}
            >
              Quarantäne (umkehrbar)
            </Button>
            <Button
              iconStart={<IconDanger />}
              className="justify-start"
              onClick={() => setFlow(openConsentExample('terminate'))}
            >
              Prozess beenden (endgültig)
            </Button>
            <Button
              iconStart={<IconTrash />}
              className="justify-start"
              onClick={() => setFlow(openConsentExample('delete'))}
            >
              Endgültig löschen (2 Schritte)
            </Button>
            <Button
              iconStart={<IconClock />}
              className="justify-start"
              onClick={() => setFlow(openConsentExample('deadline'))}
            >
              Frist 15 s (Ablauf zeigen)
            </Button>
          </div>
          <p
            role="status"
            className="flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text-muted [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0"
          >
            <IconInfo />
            <span>{log}</span>
          </p>
        </Card>
        <Card className="p-5">
          <Label>Sicherheitsregeln (getestet)</Label>
          <ul className="mt-3 flex flex-col gap-2.5">
            {safetyRules.map((rule) => (
              <li key={rule} className="flex items-start gap-2.5 text-sm text-text-muted">
                <span
                  aria-hidden="true"
                  className="mt-[7px] size-1.5 shrink-0 rounded-full bg-accent"
                />
                {rule}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <ConsentDialog
        open={flow.step === 'consent'}
        plan={flow.plan}
        onDecision={onDecision}
        onDismiss={() => finish('Frist abgelaufen – es wurde nichts getan.')}
        labels={{ eyebrow: `Beispiel · ${consentDialogLabelsDe.eyebrow}` }}
        allowTrust={!flow.permanent}
      />
      <PermanentDeleteConfirmDialog
        open={flow.step === 'second'}
        targets={deleteTargets}
        notBefore={flow.notBefore}
        expiresAt={flow.expiresAt}
        labels={{ eyebrow: 'Beispiel · Zweite Bestätigung' }}
        onConfirm={() =>
          finish('Zweite Bestätigung erhalten – im Showcase wird nichts gelöscht (Beispiel).')
        }
        onCancel={() => finish('Abgebrochen – es wurde nichts gelöscht.')}
        onDismiss={() => finish('Frist abgelaufen – es wurde nichts gelöscht.')}
      />
    </Section>
  );
}

/* ---------------------------------------------------------- Befehlspalette */

export function PaletteSection({ onOpen }: { readonly onOpen: () => void }) {
  return (
    <Section
      id="palette"
      eyebrow="Komponenten"
      title="Befehlspalette"
      description="Combobox mit gruppierter Liste, unscharfe und akzentunabhängige Suche („uberspringen“ findet „Überspringen“). Das Kürzel setzt die App – hier im Showcase ebenfalls."
    >
      <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="flex items-center gap-3 text-sm text-text-muted">
          <Kbd keys={['Strg', 'K']} />
          <span>oder</span>
          <Kbd keys={['⌘', 'K']} />
          <span>öffnet die Palette. ↑/↓ wählen, Enter führt aus, Escape schließt.</span>
        </div>
        <Button variant="secondary" iconEnd={<IconArrowRight />} onClick={onOpen}>
          Befehlspalette öffnen
        </Button>
      </Card>
    </Section>
  );
}

/* ---------------------------------------------------------- Dashboard-Demo */

export function DashboardDemo() {
  return (
    <Section
      id="dashboard"
      eyebrow="Muster"
      title="Dashboard (Komposition)"
      description="So fügen sich die Bausteine zusammen. Alle Zahlen und Zustände hier sind erfunden – in der App erscheinen nur echte Messwerte, sonst „–“ oder „Folgt in Pn“."
    >
      <div className="relative">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <DemoTag />
          <span className="text-xs text-text-subtle">
            Nur zur Gestaltung – nichts davon ist gemessen.
          </span>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <Panel
            eyebrow="Übersicht"
            title="Sicherheits-Score"
            actions={<DemoTag>Demo</DemoTag>}
            className="items-stretch"
          >
            <div className="flex flex-col items-center">
              <ScoreGauge value={demoScore} size={220} glow />
              <div className="mt-5 flex w-full gap-2">
                <Button variant="primary" iconStart={<IconScan />} className="flex-1">
                  Jetzt prüfen
                </Button>
                <Button variant="secondary" iconStart={<IconShield />}>
                  Details
                </Button>
              </div>
            </div>
          </Panel>
          <Panel
            eyebrow="Module"
            title="Schutz-Status"
            actions={<DemoTag>Demo</DemoTag>}
            footer={
              <p className="flex items-start gap-2 text-xs text-text-muted [&_svg]:mt-px [&_svg]:size-3.5 [&_svg]:shrink-0">
                <IconInfo />
                Ehrlich: Ohne Kernel-Treiber erkennt AEGIS, warnt und isoliert auf Wunsch –
                Programme werden nicht vor dem Start blockiert.
              </p>
            }
          >
            <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3">
              {demoModules.map((module) => (
                <StatusRing
                  key={module.label}
                  state={module.state}
                  label={module.label}
                  sublabel={module.sublabel}
                  size={76}
                />
              ))}
            </div>
          </Panel>
        </div>
        <Panel
          eyebrow="Zeitleiste"
          title="Letzte Ereignisse"
          actions={<DemoTag>Demo</DemoTag>}
          className="mt-4"
          padding="none"
        >
          <ol className="divide-y divide-border">
            {demoEvents.map((event) => (
              <li
                key={`${event.time}-${event.title}`}
                className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-4 px-5 py-3"
              >
                <time className="font-mono text-xs text-text-subtle tabular-nums">
                  {event.time}
                </time>
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm text-text">{event.title}</p>
                  <p className="truncate text-xs text-text-muted">{event.detail}</p>
                </div>
                <RiskBadge level={event.level} size="sm" />
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </Section>
  );
}
