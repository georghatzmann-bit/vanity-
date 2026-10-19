import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentDialog, CONSENT_GUARD_MS, type ConsentDialogProps } from './ConsentDialog.tsx';
import { consentDialogLabelsEn } from './labels.ts';
import type { ConsentPlan } from './types.ts';

const START = new Date('2026-10-19T12:00:00Z').getTime();
const RLO = '\u202E';

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function makePlan(overrides: Partial<ConsentPlan> = {}): ConsentPlan {
  return {
    id: 'plan-1',
    kindLabel: 'In Quarantäne verschieben',
    severity: 'dangerous',
    targets: [{ type: 'file', path: 'C:\\Users\\Beispiel\\Downloads\\eicar.com' }],
    what: 'Die Datei wird verschlüsselt in die Quarantäne verschoben.',
    why: 'Signatur „EICAR-Testdatei“ erkannt.',
    consequence: 'Die Datei ist danach nicht mehr ausführbar.',
    undo: { type: 'reversible', how: 'Quarantäne → Wiederherstellen.' },
    expiresAt: START + 10 * 60_000,
    ...overrides,
  };
}

function setup(props: Partial<ConsentDialogProps> = {}) {
  const onDecision = vi.fn();
  const onDismiss = vi.fn();
  const onExpire = vi.fn();
  const utils = render(
    <ConsentDialog
      open
      plan={makePlan()}
      onDecision={onDecision}
      onDismiss={onDismiss}
      onExpire={onExpire}
      {...props}
    />,
  );
  return { ...utils, onDecision, onDismiss, onExpire };
}

const yes = (): HTMLElement => screen.getByRole('button', { name: 'Ja, ausführen' });
const no = (): HTMLElement => screen.getByRole('button', { name: 'Nein' });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ConsentDialog – Darstellung des Plans', () => {
  it('zeigt Art, Einstufung, Ziele und alle vier Fragen als benannten Freigabe-Dialog', () => {
    setup();
    const dialog = screen.getByRole('alertdialog', { name: 'In Quarantäne verschieben' });
    expect(within(dialog).getByText('Freigabe erforderlich')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Gefährlich').length).toBeGreaterThan(0);
    expect(within(dialog).getByText('Was genau?')).toBeInTheDocument();
    expect(within(dialog).getByText('Warum?')).toBeInTheDocument();
    expect(within(dialog).getByText('Was passiert dann?')).toBeInTheDocument();
    expect(within(dialog).getByText('Rückgängig?')).toBeInTheDocument();
    expect(within(dialog).getByText('Umkehrbar')).toBeInTheDocument();
    expect(within(dialog).getByText('Quarantäne → Wiederherstellen.')).toBeInTheDocument();
    expect(within(dialog).getByText('C:\\Users\\Beispiel\\Downloads\\eicar.com')).toHaveClass(
      'font-mono',
    );
    expect(within(dialog).getByText('Ohne Antwort passiert nichts.')).toBeInTheDocument();
  });

  it('zeigt die Frist als laufende Uhr und die feste Uhrzeit für Screenreader', () => {
    setup();
    const deadline = document.querySelector('[data-part="deadline"]');
    expect(deadline).toHaveTextContent('Frist 10:00');
    expect(deadline?.querySelector('time')).toHaveAttribute('aria-hidden', 'true');
    expect(deadline).toHaveTextContent(/Ohne Antwort verfällt die Anfrage um \d\d:\d\d Uhr\./);
    advance(61_000);
    expect(deadline).toHaveTextContent('Frist 8:59');
    expect(deadline).not.toHaveClass('text-risk-risky');
    advance(8 * 60_000 + 30_000);
    expect(document.querySelector('[data-part="deadline"]')).toHaveClass('text-risk-risky');
  });

  it('warnt deutlich bei nicht umkehrbaren Plänen und färbt „Ja, ausführen“ rot', () => {
    setup({
      plan: makePlan({
        kindLabel: 'Prozess beenden',
        severity: 'suspicious',
        targets: [{ type: 'process', pid: 4242, image_path: 'C:\\Tools\\miner.exe' }],
        undo: { type: 'irreversible', warning: 'Nicht gespeicherte Daten gehen verloren.' },
      }),
    });
    expect(document.querySelector('[data-callout="danger"]')).toHaveTextContent(
      'Kann nicht rückgängig gemacht werden',
    );
    expect(screen.getByText('Nicht umkehrbar')).toBeInTheDocument();
    expect(yes()).toHaveAttribute('data-variant', 'danger');
    expect(document.querySelector('[data-part="tone"]')).toHaveAttribute('data-tone', 'danger');
    expect(screen.getByText('Prozess · PID 4242')).toBeInTheDocument();
  });

  it('warnt bei der Stufe „Gefährlich“ auch für umkehrbare Pläne', () => {
    setup();
    expect(document.querySelector('[data-callout="danger"]')).toHaveTextContent(
      'Als gefährlich eingestuft',
    );
    expect(yes()).toHaveAttribute('data-variant', 'primary');
  });

  it('nutzt für mittlere Stufen eine Warnkante, für harmlose die Akzentkante', () => {
    const { rerender, onDecision, onDismiss } = setup({ plan: makePlan({ severity: 'risky' }) });
    expect(document.querySelector('[data-part="tone"]')).toHaveAttribute('data-tone', 'warn');
    expect(document.querySelector('[data-callout]')).toBeNull();
    rerender(
      <ConsentDialog
        open
        plan={makePlan({ severity: 'info' })}
        onDecision={onDecision}
        onDismiss={onDismiss}
      />,
    );
    expect(document.querySelector('[data-part="tone"]')).toHaveAttribute('data-tone', 'accent');
  });

  it('macht Bidi-Steuerzeichen als ⟨U+202E⟩ sichtbar und warnt davor', () => {
    const path = `C:\\Users\\Beispiel\\Downloads\\Rechnung_${RLO}fdp.exe`;
    setup({ plan: makePlan({ targets: [{ type: 'file', path }] }) });
    const marker = screen.getByText('⟨U+202E⟩');
    expect(marker.tagName).toBe('MARK');
    expect(marker).toHaveAttribute('data-codepoint', 'U+202E');
    // Der sichtbare Teil enthält das Steuerzeichen nicht roh.
    const visible = marker.closest('[aria-hidden="true"]');
    expect(visible?.textContent).not.toContain(RLO);
    expect(visible).toHaveTextContent('Rechnung_⟨U+202E⟩fdp.exe');
    // Screenreader hören eine Beschreibung statt des rohen Zeichens.
    expect(screen.getByText(/\[Steuerzeichen U\+202E \(RLO\)\]/)).toHaveClass('sr-only');
    expect(document.querySelector('[data-hint="invisible"]')).toHaveTextContent(
      'Enthält unsichtbare Steuerzeichen',
    );
    // Die Leserichtung ist isoliert links-nach-rechts.
    expect(marker.closest('[dir="ltr"]')).not.toBeNull();
  });

  it('kürzt lange Pfade in der Mitte, behält den Dateinamen und zeigt auf Wunsch alles', () => {
    const path = `C:\\Users\\Beispiel\\AppData\\Local\\Temp\\${'sehr-langer-ordner\\'.repeat(4)}setup_v2.4.1.exe`;
    setup({ plan: makePlan({ targets: [{ type: 'file', path }] }) });
    const toggle = screen.getByRole('button', { name: 'Ganz anzeigen' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const truncated = document.querySelector('[data-truncated]');
    expect(truncated).not.toBeNull();
    const visible = truncated?.querySelector('[aria-hidden="true"]');
    expect(visible?.textContent).toContain('…');
    expect(visible?.textContent?.endsWith('\\setup_v2.4.1.exe')).toBe(true);
    expect(truncated?.querySelector('.sr-only')).toHaveTextContent(path);

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Kürzen' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(path)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Kürzen' }));
    expect(screen.getByRole('button', { name: 'Ganz anzeigen' })).toBeInTheDocument();
  });

  it('stellt alle Ziel-Arten dar und weist auf Rechts-nach-links-Schrift hin', () => {
    setup({
      plan: makePlan({
        targets: [
          { type: 'registry_value', key: 'HKCU\\Software\\Run', name: '' },
          { type: 'registry_value', key: 'HKCU\\Software\\Run', name: 'Updater' },
          { type: 'setting', id: 'realtime.enabled' },
          { type: 'other', description: 'Geplanter Task „שלום“' },
        ],
      }),
    });
    expect(screen.getByText('Betroffen (4)')).toBeInTheDocument();
    expect(screen.getByText('Registrierungswert · (Standard)')).toBeInTheDocument();
    expect(screen.getByText('HKCU\\Software\\Run\\Updater')).toBeInTheDocument();
    expect(screen.getByText('Einstellung')).toBeInTheDocument();
    expect(screen.getByText('realtime.enabled')).toBeInTheDocument();
    expect(document.querySelector('[data-hint="rtl"]')).toHaveTextContent('rechts-nach-links');
    // „Sonstiges“ ist Freitext – ohne Monospace.
    expect(screen.getByText('Geplanter Task „שלום“')).not.toHaveClass('font-mono');
  });

  it('zeigt Ausführungsparameter sicher an', () => {
    setup({
      plan: makePlan({
        parameters: [{ label: 'Zielordner', value: `D:\\Archiv${RLO}gpj` }],
      }),
    });
    expect(screen.getByText('Einzelheiten')).toBeInTheDocument();
    expect(screen.getByText('Zielordner')).toBeInTheDocument();
    expect(screen.getAllByText('⟨U+202E⟩')).toHaveLength(1);
  });

  it('übernimmt eigene Beschriftungen (z. B. Englisch)', () => {
    setup({ labels: consentDialogLabelsEn });
    expect(screen.getByRole('button', { name: 'Yes, execute' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No' })).toBeInTheDocument();
    expect(screen.getByText('Approval required')).toBeInTheDocument();
    expect(screen.getByText('What exactly?')).toBeInTheDocument();
  });
});

describe('ConsentDialog – Sicherheitsregeln', () => {
  it('setzt den Startfokus auf „Nein“, nie auf „Ja, ausführen“', () => {
    setup();
    expect(no()).toHaveFocus();
    expect(yes()).not.toHaveFocus();
  });

  it('sperrt „Ja, ausführen“ für die ersten 600 ms – auch gegen Doppelklick', () => {
    const { onDecision } = setup();
    expect(yes()).toBeDisabled();
    expect(document.querySelector('[data-part="arming"]')).not.toBeNull();
    fireEvent.click(yes());
    fireEvent.click(yes());
    advance(CONSENT_GUARD_MS - 1);
    expect(yes()).toBeDisabled();
    fireEvent.click(yes());
    expect(onDecision).not.toHaveBeenCalled();

    advance(1);
    expect(yes()).toBeEnabled();
    expect(document.querySelector('[data-part="arming"]')).toBeNull();
    fireEvent.click(yes());
    fireEvent.click(yes());
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('execute');
  });

  it('meldet höchstens eine Antwort und sperrt danach alle Knöpfe', () => {
    const { onDecision } = setup();
    advance(CONSENT_GUARD_MS);
    fireEvent.click(no());
    fireEvent.click(yes());
    fireEvent.click(screen.getByRole('button', { name: 'Ignorieren' }));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('decline');
    for (const name of ['Ja, ausführen', 'Nein', 'Ignorieren', 'Vertrauen']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
  });

  it('Escape bedeutet „Nein“ (decline)', () => {
    const { onDecision, onDismiss } = setup();
    fireEvent.keyDown(no(), { key: 'Escape' });
    expect(onDecision).toHaveBeenCalledWith('decline');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('Enter auf dem Dialog-Inhalt löst nie „Ja“ aus', () => {
    const { onDecision } = setup();
    advance(CONSENT_GUARD_MS);
    const dialog = screen.getByRole('alertdialog');
    const text = screen.getByText('Was genau?');
    expect(fireEvent.keyDown(text, { key: 'Enter' })).toBe(false); // verworfen
    fireEvent.keyDown(dialog, { key: 'Enter' });
    fireEvent.keyPress(dialog, { key: 'Enter', charCode: 13 });
    fireEvent.keyUp(dialog, { key: 'Enter' });
    expect(onDecision).not.toHaveBeenCalled();
    expect(dialog.querySelector('form')).toBeNull();
    expect(dialog.querySelector('button[type="submit"]')).toBeNull();
  });

  it('Enter auf dem fokussierten „Nein“ ergibt „Nein“, nicht „Ja“', () => {
    const { onDecision } = setup();
    advance(CONSENT_GUARD_MS);
    // Ein Button löst bei Enter einen Klick auf sich selbst aus – nachgebildet:
    fireEvent.keyDown(no(), { key: 'Enter' });
    fireEvent.click(no());
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('decline');
  });

  it('verwirft gehaltene Tasten (Autorepeat) auf „Ja, ausführen“', () => {
    setup();
    advance(CONSENT_GUARD_MS);
    expect(fireEvent.keyDown(yes(), { key: 'Enter', repeat: true })).toBe(false);
    expect(fireEvent.keyDown(yes(), { key: ' ', repeat: true })).toBe(false);
    expect(fireEvent.keyDown(yes(), { key: 'Enter' })).toBe(true);
  });

  it('ein Klick neben den Dialog tut nichts', () => {
    const { onDecision, onDismiss } = setup();
    fireEvent.click(document.querySelector('[data-part="backdrop"]') as Element);
    expect(onDecision).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('sperrt auch „Vertrauen“ und „Ignorieren“ während der Sperrzeit – „Nein“ geht sofort', () => {
    const { onDecision } = setup();
    expect(screen.getByRole('button', { name: 'Vertrauen' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ignorieren' })).toBeDisabled();
    expect(no()).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Vertrauen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ignorieren' }));
    expect(onDecision).not.toHaveBeenCalled();
    fireEvent.click(no());
    expect(onDecision).toHaveBeenCalledWith('decline');
  });

  it('meldet „Ignorieren“ und „Vertrauen“ und erklärt sie', () => {
    const first = setup();
    advance(CONSENT_GUARD_MS);
    fireEvent.click(screen.getByRole('button', { name: 'Ignorieren' }));
    expect(first.onDecision).toHaveBeenCalledWith('ignore');
    expect(screen.getByRole('button', { name: 'Ignorieren' })).toHaveAccessibleDescription(
      'Ignorieren: nichts tun und nicht erneut melden.',
    );
    first.unmount();

    const second = setup();
    advance(CONSENT_GUARD_MS);
    fireEvent.click(screen.getByRole('button', { name: 'Vertrauen' }));
    expect(second.onDecision).toHaveBeenCalledWith('trust');
  });

  it('blendet „Ignorieren“ und „Vertrauen“ je Plan aus', () => {
    setup({ allowIgnore: false, allowTrust: false });
    expect(screen.queryByRole('button', { name: 'Ignorieren' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Vertrauen' })).toBeNull();
    expect(screen.queryByText(/Ignorieren:/)).toBeNull();
    expect(no()).toBeInTheDocument();
  });

  it('erzwingt eine Mindest-Sperrzeit von 300 ms', () => {
    setup({ guardMs: 0 });
    expect(yes()).toBeDisabled();
    advance(299);
    expect(yes()).toBeDisabled();
    advance(1);
    expect(yes()).toBeEnabled();
  });

  it('nutzt bei ungültiger Sperrzeit den Standard', () => {
    setup({ guardMs: Number.NaN });
    advance(CONSENT_GUARD_MS - 1);
    expect(yes()).toBeDisabled();
    advance(1);
    expect(yes()).toBeEnabled();
  });
});

describe('ConsentDialog – Frist', () => {
  it('wechselt beim Ablauf zu „Abgelaufen – es wurde nichts getan“ und sperrt alles', () => {
    const { onDecision, onDismiss, onExpire } = setup({
      plan: makePlan({ expiresAt: START + 5000 }),
    });
    advance(CONSENT_GUARD_MS);
    expect(yes()).toBeEnabled();
    advance(5000 - CONSENT_GUARD_MS);
    const expired = screen.getByRole('alert');
    expect(expired).toHaveTextContent('Abgelaufen – es wurde nichts getan');
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(yes()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ignorieren' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Vertrauen' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Nein' })).toBeNull();
    const close = screen.getByRole('button', { name: 'Schließen' });
    expect(close).toHaveFocus();
    expect(document.querySelector('[data-part="deadline"]')).toBeNull();

    fireEvent.click(yes());
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    fireEvent.click(close);
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(onDecision).not.toHaveBeenCalled();
    advance(60_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('verwirft eine Antwort im Moment des Ablaufs, auch wenn die Anzeige noch nicht nachgezogen hat', () => {
    const { onDecision } = setup({ plan: makePlan({ expiresAt: START + 2000 }) });
    advance(CONSENT_GUARD_MS);
    // Uhr springt ohne Timer-Takt über die Frist (z. B. Ruhezustand).
    vi.setSystemTime(START + 2500);
    expect(yes()).toBeEnabled();
    fireEvent.click(yes());
    fireEvent.click(no());
    expect(onDecision).not.toHaveBeenCalled();
  });

  it('ist bei bereits abgelaufener Frist sofort gesperrt und fokussiert „Schließen“', () => {
    const { onDecision, onExpire } = setup({ plan: makePlan({ expiresAt: START - 1 }) });
    expect(screen.getByRole('alert')).toHaveTextContent('Abgelaufen – es wurde nichts getan');
    expect(screen.getByRole('button', { name: 'Schließen' })).toHaveFocus();
    advance(CONSENT_GUARD_MS);
    expect(yes()).toBeDisabled();
    fireEvent.click(yes());
    expect(onDecision).not.toHaveBeenCalled();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('behandelt eine ungültige Frist als abgelaufen (im Zweifel nichts tun)', () => {
    const { onDecision } = setup({ plan: makePlan({ expiresAt: 'kein Datum' }) });
    expect(screen.getByRole('alert')).toHaveTextContent('Abgelaufen – es wurde nichts getan');
    advance(CONSENT_GUARD_MS);
    fireEvent.click(yes());
    expect(onDecision).not.toHaveBeenCalled();
  });

  it('akzeptiert die Frist als RFC-3339-Text und als Date', () => {
    const { unmount } = setup({
      plan: makePlan({ expiresAt: new Date(START + 90_000).toISOString() }),
    });
    expect(document.querySelector('[data-part="deadline"]')).toHaveTextContent('Frist 1:30');
    unmount();
    setup({ plan: makePlan({ expiresAt: new Date(START + 3_600_000 + 5000) }) });
    expect(document.querySelector('[data-part="deadline"]')).toHaveTextContent('Frist 1:00:05');
  });
});

describe('ConsentDialog – Sitzungen', () => {
  function Harness({ plans }: { readonly plans: readonly ConsentPlan[] }) {
    const [open, setOpen] = useState(false);
    const [index, setIndex] = useState(0);
    const [log, setLog] = useState<string[]>([]);
    const plan = plans[index] ?? makePlan();
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Plan anzeigen
        </button>
        <button type="button" onClick={() => setIndex(index + 1)}>
          Nächster Plan
        </button>
        <output data-testid="log">{log.join(',')}</output>
        <ConsentDialog
          open={open}
          plan={plan}
          onDecision={(decision) => {
            setLog((current) => [...current, `${plan.id}:${decision}`]);
            setOpen(false);
          }}
          onDismiss={() => setOpen(false)}
        />
      </>
    );
  }

  it('beginnt beim erneuten Öffnen von vorn: Sperrzeit, eine neue Antwort, Fokus zurück', () => {
    render(<Harness plans={[makePlan()]} />);
    const opener = screen.getByRole('button', { name: 'Plan anzeigen' });
    act(() => {
      opener.focus();
    });
    fireEvent.click(opener);
    expect(no()).toHaveFocus();
    advance(CONSENT_GUARD_MS);
    fireEvent.click(yes());
    advance(500);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(opener).toHaveFocus();
    expect(screen.getByTestId('log')).toHaveTextContent('plan-1:execute');

    fireEvent.click(opener);
    expect(yes()).toBeDisabled();
    expect(no()).toHaveFocus();
    advance(CONSENT_GUARD_MS);
    fireEvent.click(no());
    expect(screen.getByTestId('log')).toHaveTextContent('plan-1:execute,plan-1:decline');
  });

  it('fokussiert nach Ablauf „Schließen“ und gibt den Fokus danach an den Auslöser zurück', () => {
    render(<Harness plans={[makePlan({ expiresAt: START + 3000 })]} />);
    const opener = screen.getByRole('button', { name: 'Plan anzeigen' });
    act(() => {
      opener.focus();
    });
    fireEvent.click(opener);
    expect(no()).toHaveFocus();
    advance(3000);
    const close = screen.getByRole('button', { name: 'Schließen' });
    expect(close).toHaveFocus();
    fireEvent.click(close);
    advance(500);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(opener).toHaveFocus();
    expect(screen.getByTestId('log')).toHaveTextContent('');
  });

  it('startet bei einem Planwechsel im offenen Dialog die Sperrzeit neu und fokussiert „Nein“', () => {
    const onDecision = vi.fn();
    const { rerender } = render(
      <ConsentDialog open plan={makePlan()} onDecision={onDecision} onDismiss={vi.fn()} />,
    );
    advance(CONSENT_GUARD_MS);
    expect(yes()).toBeEnabled();
    act(() => {
      yes().focus();
    });
    rerender(
      <ConsentDialog
        open
        plan={makePlan({ id: 'plan-2', kindLabel: 'Datei verschieben', severity: 'info' })}
        onDecision={onDecision}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole('alertdialog', { name: 'Datei verschieben' })).toBeInTheDocument();
    expect(yes()).toBeDisabled();
    advance(0);
    expect(no()).toHaveFocus();
    advance(CONSENT_GUARD_MS);
    fireEvent.click(yes());
    expect(onDecision).toHaveBeenCalledTimes(1);
  });

  it('meldet nichts, solange der Dialog geschlossen ist', () => {
    const onDecision = vi.fn();
    render(
      <ConsentDialog open={false} plan={makePlan()} onDecision={onDecision} onDismiss={vi.fn()} />,
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    advance(CONSENT_GUARD_MS);
    expect(onDecision).not.toHaveBeenCalled();
  });

  it('gibt während des Ausblendens keine Antwort mehr weiter', () => {
    const onDecision = vi.fn();
    const { rerender } = render(
      <ConsentDialog open plan={makePlan()} onDecision={onDecision} onDismiss={vi.fn()} />,
    );
    advance(CONSENT_GUARD_MS);
    const button = yes();
    rerender(
      <ConsentDialog open={false} plan={makePlan()} onDecision={onDecision} onDismiss={vi.fn()} />,
    );
    fireEvent.click(button);
    expect(onDecision).not.toHaveBeenCalled();
  });
});
