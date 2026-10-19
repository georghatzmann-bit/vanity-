import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { permanentDeleteLabelsEn } from './labels.ts';
import {
  PERMANENT_DELETE_DELAY_MS,
  PermanentDeleteConfirmDialog,
  type PermanentDeleteConfirmDialogProps,
} from './PermanentDeleteConfirmDialog.tsx';
import type { ConsentTarget } from './types.ts';

const START = new Date('2026-10-19T12:00:00Z').getTime();
const targets: readonly ConsentTarget[] = [
  { type: 'file', path: 'C:\\Users\\Beispiel\\AppData\\Local\\Temp\\aegis-test\\dummy.bin' },
];

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function setup(props: Partial<PermanentDeleteConfirmDialogProps> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const onDismiss = vi.fn();
  const element = (overrides: Partial<PermanentDeleteConfirmDialogProps>) => (
    <PermanentDeleteConfirmDialog
      open
      targets={targets}
      onConfirm={onConfirm}
      onCancel={onCancel}
      onDismiss={onDismiss}
      {...props}
      {...overrides}
    />
  );
  const utils = render(element({}));
  return {
    ...utils,
    onConfirm,
    onCancel,
    onDismiss,
    rerenderWith: (overrides: Partial<PermanentDeleteConfirmDialogProps>) =>
      utils.rerender(element(overrides)),
  };
}

const confirm = (): HTMLElement => screen.getByRole('button', { name: 'Endgültig löschen' });
const cancel = (): HTMLElement => screen.getByRole('button', { name: 'Abbrechen' });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PermanentDeleteConfirmDialog', () => {
  it('sagt deutlich, dass nichts rückgängig zu machen ist, und zeigt die Dateien', () => {
    setup();
    const dialog = screen.getByRole('alertdialog', {
      name: 'Endgültig löschen – kann nicht rückgängig gemacht werden',
    });
    expect(dialog).toHaveAccessibleDescription(/unwiderruflich gelöscht/);
    expect(screen.getByText('Zweite Bestätigung')).toBeInTheDocument();
    expect(screen.getByText('Wird gelöscht')).toBeInTheDocument();
    expect(document.querySelector('[data-part="tone"]')).toHaveAttribute('data-tone', 'danger');
    expect(confirm()).toHaveAttribute('data-variant', 'danger');
  });

  it('fokussiert „Abbrechen“ und gibt „Endgültig löschen“ erst nach 1,5 s frei (Countdown)', () => {
    const { onConfirm } = setup();
    expect(cancel()).toHaveFocus();
    expect(confirm()).toBeDisabled();
    advance(0);
    expect(screen.getByText('Bestätigen möglich in 1,5 s')).toBeInTheDocument();
    advance(500);
    expect(screen.getByText('Bestätigen möglich in 1,0 s')).toBeInTheDocument();
    fireEvent.click(confirm());
    advance(PERMANENT_DELETE_DELAY_MS - 501);
    expect(confirm()).toBeDisabled();
    expect(screen.getByText('Bestätigen möglich in 0,1 s')).toBeInTheDocument();
    fireEvent.click(confirm());
    expect(onConfirm).not.toHaveBeenCalled();

    advance(1);
    expect(confirm()).toBeEnabled();
    expect(screen.getByText(/Bestätigen jetzt möglich/)).toBeInTheDocument();
    fireEvent.click(confirm());
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(confirm()).toBeDisabled();
    expect(cancel()).toBeDisabled();
  });

  it('wartet zusätzlich auf not_before aus dem Dienst', () => {
    setup({ notBefore: START + 4000 });
    advance(PERMANENT_DELETE_DELAY_MS);
    expect(confirm()).toBeDisabled();
    expect(screen.getByText('Bestätigen möglich in 2,5 s')).toBeInTheDocument();
    advance(2500);
    expect(confirm()).toBeEnabled();
  });

  it('wartet trotz früherem not_before mindestens die Mindestzeit nach dem Öffnen', () => {
    setup({ notBefore: START - 10_000, delayMs: 200 });
    advance(999);
    expect(confirm()).toBeDisabled();
    advance(1);
    expect(confirm()).toBeEnabled();
  });

  it('nutzt bei ungültiger Wartezeit den Standard', () => {
    setup({ delayMs: Number.NaN });
    advance(PERMANENT_DELETE_DELAY_MS - 1);
    expect(confirm()).toBeDisabled();
    advance(1);
    expect(confirm()).toBeEnabled();
  });

  it('Abbrechen und Escape löschen nichts', () => {
    const first = setup();
    fireEvent.click(cancel());
    expect(first.onCancel).toHaveBeenCalledTimes(1);
    expect(first.onConfirm).not.toHaveBeenCalled();
    first.unmount();

    const second = setup();
    advance(PERMANENT_DELETE_DELAY_MS);
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(second.onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(confirm());
    expect(second.onConfirm).not.toHaveBeenCalled();
  });

  it('verwirft gehaltene Tasten und Klicks neben den Dialog', () => {
    const { onCancel, onConfirm } = setup();
    advance(PERMANENT_DELETE_DELAY_MS);
    expect(fireEvent.keyDown(confirm(), { key: 'Enter', repeat: true })).toBe(false);
    expect(fireEvent.keyDown(confirm(), { key: ' ', repeat: true })).toBe(false);
    expect(fireEvent.keyDown(confirm(), { key: 'Enter' })).toBe(true);
    fireEvent.click(document.querySelector('[data-part="backdrop"]') as Element);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('läuft ab: „Abgelaufen – es wurde nichts gelöscht“, Bestätigen gesperrt, Schließen fokussiert', () => {
    const { onConfirm, onCancel, onDismiss } = setup({ expiresAt: START + 3000 });
    advance(PERMANENT_DELETE_DELAY_MS);
    expect(confirm()).toBeEnabled();
    advance(1500);
    expect(screen.getByRole('alert')).toHaveTextContent('Abgelaufen – es wurde nichts gelöscht');
    expect(confirm()).toBeDisabled();
    const close = screen.getByRole('button', { name: 'Schließen' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Escape' });
    fireEvent.click(close);
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('verwirft „Endgültig löschen“ im Moment des Ablaufs, auch ohne Anzeige-Takt', () => {
    const { onConfirm } = setup({ expiresAt: START + 2000 });
    advance(PERMANENT_DELETE_DELAY_MS);
    vi.setSystemTime(START + 2001);
    fireEvent.click(confirm());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('behandelt ungültige Zeitangaben als abgelaufen', () => {
    const { onConfirm } = setup({ notBefore: 'Unsinn' });
    expect(screen.getByRole('alert')).toHaveTextContent('Abgelaufen – es wurde nichts gelöscht');
    advance(PERMANENT_DELETE_DELAY_MS);
    fireEvent.click(confirm());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('beginnt beim erneuten Öffnen von vorn (keine übernommene Wartezeit)', () => {
    const { onConfirm, rerenderWith } = setup();
    advance(PERMANENT_DELETE_DELAY_MS);
    expect(confirm()).toBeEnabled();
    rerenderWith({ open: false });
    advance(500);
    rerenderWith({ open: true });
    expect(confirm()).toBeDisabled();
    advance(PERMANENT_DELETE_DELAY_MS - 1);
    expect(confirm()).toBeDisabled();
    advance(1);
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('übernimmt eigene Beschriftungen (z. B. Englisch, mit eigenem Gebietsschema)', () => {
    setup({ labels: permanentDeleteLabelsEn, locale: 'en-US' });
    expect(
      screen.getByRole('alertdialog', { name: 'Delete permanently – cannot be undone' }),
    ).toBeInTheDocument();
    advance(0);
    expect(screen.getByText('Confirming possible in 1.5 s')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('gibt während des Ausblendens keine Antwort mehr weiter', () => {
    const { onConfirm, onCancel, rerenderWith } = setup();
    advance(PERMANENT_DELETE_DELAY_MS);
    const confirmButton = confirm();
    const cancelButton = cancel();
    rerenderWith({ open: false });
    fireEvent.click(confirmButton);
    fireEvent.click(cancelButton);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('meldet nichts, solange er geschlossen ist', () => {
    const { onConfirm, onCancel } = setup({ open: false });
    advance(5000);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe('PermanentDeleteConfirmDialog – Härtung (Review P1)', () => {
  const otherTargets: readonly ConsentTarget[] = [
    { type: 'file', path: 'C:\\Users\\Beispiel\\Dokumente\\Steuer2025.pdf' },
    { type: 'file', path: 'C:\\Users\\Beispiel\\Dokumente\\Vertrag.pdf' },
  ];

  it('F8: ein Druck während der Wartezeit, der erst danach losgelassen wird, bestätigt nicht', () => {
    const { onConfirm } = setup({ challengeId: 'challenge-1' });
    advance(0);
    advance(1300);
    fireEvent.pointerDown(confirm());
    advance(400);
    expect(confirm()).toBeEnabled();
    fireEvent.click(confirm(), { detail: 1 });
    expect(onConfirm).not.toHaveBeenCalled();
    // Ein neuer Druck nach der Wartezeit zählt – mit Kennung und Zielen der Rückfrage.
    fireEvent.pointerDown(confirm());
    fireEvent.click(confirm(), { detail: 1 });
    expect(onConfirm).toHaveBeenCalledWith({ challengeId: 'challenge-1', targets });
  });

  it('F8: geänderte Ziele im offenen Dialog starten die Wartezeit neu und werden gemeldet', () => {
    const { onConfirm, rerenderWith } = setup({ challengeId: 'challenge-1' });
    advance(PERMANENT_DELETE_DELAY_MS);
    expect(confirm()).toBeEnabled();
    rerenderWith({ challengeId: 'challenge-1', targets: otherTargets });
    expect(confirm()).toBeDisabled();
    expect(document.querySelector('[data-part="changed"]')).toHaveTextContent(
      'Die Liste hat sich geändert',
    );
    expect(cancel()).toHaveFocus();
    fireEvent.click(confirm());
    expect(onConfirm).not.toHaveBeenCalled();
    advance(PERMANENT_DELETE_DELAY_MS);
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith({ challengeId: 'challenge-1', targets: otherTargets });
  });

  it('F8: eine neue Kennung startet die Wartezeit ebenfalls neu', () => {
    const { rerenderWith } = setup({ challengeId: 'challenge-1' });
    advance(PERMANENT_DELETE_DELAY_MS);
    expect(confirm()).toBeEnabled();
    rerenderWith({ challengeId: 'challenge-2' });
    expect(confirm()).toBeDisabled();
  });

  it('F6: nach der Bestätigung nie „Abgelaufen – es wurde nichts gelöscht“', () => {
    const { onConfirm } = setup({ expiresAt: START + 3000 });
    advance(PERMANENT_DELETE_DELAY_MS);
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    advance(5000);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Abgelaufen – es wurde nichts gelöscht')).toBeNull();
    expect(document.querySelector('[data-part="answered"]')).toHaveTextContent('Antwort gesendet.');
    expect(confirm()).toBeDisabled();
    expect(cancel()).toBeDisabled();
  });

  it('F7: die Wartezeit verstreicht nicht, solange das Fenster im Hintergrund ist', () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    setup();
    advance(5000);
    expect(confirm()).toBeDisabled();
    hasFocus.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    advance(PERMANENT_DELETE_DELAY_MS - 1);
    expect(confirm()).toBeDisabled();
    advance(1);
    expect(confirm()).toBeEnabled();
  });

  it('F9: verwirft gehaltene Tasten auch auf „Abbrechen“', () => {
    setup();
    expect(fireEvent.keyDown(cancel(), { key: 'Enter', repeat: true })).toBe(false);
    expect(fireEvent.keyDown(cancel(), { key: 'Enter' })).toBe(true);
  });

  it('F17: die Beschreibung passt auch zu mehreren Dateien', () => {
    setup({ targets: otherTargets });
    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(
      /^Alles Aufgeführte wird unwiderruflich gelöscht/,
    );
    expect(screen.getByText('Wird gelöscht (2)')).toBeInTheDocument();
  });
});
