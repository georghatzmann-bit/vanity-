import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockMatchMedia } from '../../test/matchMedia.ts';
import { Dialog, type DialogCloseReason, type DialogProps } from './Dialog.tsx';
import { usePortalContainer } from './portal.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Harness({
  onCloseSpy = vi.fn(),
  ...props
}: Partial<DialogProps> & { readonly onCloseSpy?: (reason: DialogCloseReason) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="app">
      <button type="button" onClick={() => setOpen(true)}>
        Öffnen
      </button>
      <button type="button">Dahinter</button>
      <Dialog
        title="Prüfdialog"
        description="Beschreibung des Dialogs"
        {...props}
        open={open}
        onClose={(reason) => {
          onCloseSpy(reason);
          setOpen(false);
        }}
      >
        <button type="button">Erster</button>
        <input aria-label="Feld" />
        <button type="button">Letzter</button>
      </Dialog>
    </div>
  );
}

describe('Dialog', () => {
  it('rendert geschlossen nichts', () => {
    render(<Dialog open={false} onClose={vi.fn()} title="Zu" />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ist modal benannt und beschrieben, macht den Hintergrund inert und sperrt das Scrollen', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Öffnen' }));
    const dialog = screen.getByRole('dialog', { name: 'Prüfdialog' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Beschreibung des Dialogs');
    // Der App-Container (Kind von body) ist inert, die Dialog-Wurzel nicht.
    const appRoot = screen.getByTestId('app').parentElement;
    expect(appRoot).toHaveAttribute('inert');
    expect(dialog.closest('[data-aegis-dialog-root]')).not.toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('setzt den Startfokus aufs erste Element, fängt Tab ein und gibt den Fokus zurück', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onCloseSpy={onClose} />);
    const opener = screen.getByRole('button', { name: 'Öffnen' });
    await user.click(opener);
    // Erstes Element ist der Schließen-Button der Kopfzeile.
    expect(screen.getByRole('button', { name: 'Schließen' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Erster' })).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Letzter' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Schließen' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Letzter' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledWith('escape');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
    expect(screen.getByTestId('app').parentElement).not.toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('');
  });

  it('respektiert initialFocusRef und data-autofocus', async () => {
    const user = userEvent.setup();
    function WithRef() {
      const ref = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Öffnen
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} title="T" initialFocusRef={ref}>
            <button type="button">A</button>
            <button type="button" ref={ref}>
              Ziel
            </button>
          </Dialog>
        </>
      );
    }
    const { unmount } = render(<WithRef />);
    await user.click(screen.getByRole('button', { name: 'Öffnen' }));
    expect(screen.getByRole('button', { name: 'Ziel' })).toHaveFocus();
    unmount();

    render(
      <Dialog open onClose={vi.fn()} title="T" showCloseButton={false}>
        <button type="button">A</button>
        <button type="button" data-autofocus="">
          Auto
        </button>
      </Dialog>,
    );
    expect(screen.getByRole('button', { name: 'Auto' })).toHaveFocus();
  });

  it('fokussiert ohne bedienbare Elemente das Panel selbst und hält Tab dort', () => {
    render(
      <Dialog open onClose={vi.fn()} title="Leer" showCloseButton={false}>
        <p>Nur Text</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(dialog).toHaveFocus();
  });

  it('meldet Hintergrund-Klick und Schließen-Button, außer closeOnBackdrop=false', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(<Dialog open onClose={onClose} title="T" />);
    const backdrop = document.querySelector<HTMLElement>('[data-part="backdrop"]');
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as HTMLElement);
    expect(onClose).toHaveBeenLastCalledWith('backdrop');
    await user.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(onClose).toHaveBeenLastCalledWith('close-button');

    onClose.mockClear();
    rerender(<Dialog open onClose={onClose} title="T" closeOnBackdrop={false} />);
    await user.click(backdrop as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('blendet beim Schließen kurz aus (inert) und hängt sich dann aus', () => {
    vi.useFakeTimers();
    const { rerender } = render(<Dialog open onClose={vi.fn()} title="T" />);
    rerender(<Dialog open={false} onClose={vi.fn()} title="T" />);
    const root = document.querySelector('[data-aegis-dialog-root]');
    expect(root).toHaveAttribute('data-state', 'closed');
    expect(root).toHaveAttribute('inert');
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(document.querySelector('[data-aegis-dialog-root]')).toBeNull();
  });

  it('hängt sich bei „Bewegung reduzieren“ sofort aus', () => {
    mockMatchMedia(true);
    const { rerender } = render(<Dialog open onClose={vi.fn()} title="T" />);
    rerender(<Dialog open={false} onClose={vi.fn()} title="T" />);
    expect(document.querySelector('[data-aegis-dialog-root]')).toBeNull();
  });

  it('stapelt verschachtelte Dialoge: Escape schließt nur den oberen, Fokus wandert zurück', async () => {
    const user = userEvent.setup();
    const outerClose = vi.fn();
    function Nested() {
      const [inner, setInner] = useState(false);
      return (
        <Dialog open onClose={outerClose} title="Außen" showCloseButton={false}>
          <button type="button" onClick={() => setInner(true)}>
            Innen öffnen
          </button>
          <Dialog open={inner} onClose={() => setInner(false)} title="Innen">
            <button type="button">Innen-Knopf</button>
          </Dialog>
        </Dialog>
      );
    }
    render(<Nested />);
    const opener = screen.getByRole('button', { name: 'Innen öffnen' });
    expect(opener).toHaveFocus();
    await user.click(opener);
    const outerRoot = screen
      .getByRole('dialog', { name: 'Außen', hidden: true })
      .closest('[data-aegis-dialog-root]');
    expect(outerRoot).toHaveAttribute('inert');
    await user.keyboard('{Escape}');
    expect(outerClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Innen' })).toBeNull();
    expect(outerRoot).not.toHaveAttribute('inert');
    expect(opener).toHaveFocus();
  });

  it('holt Fokus zurück, der per Skript hinausgelangt', () => {
    render(
      <>
        <button type="button">Draußen</button>
        <Dialog open onClose={vi.fn()} title="T" showCloseButton={false}>
          <button type="button">Drinnen</button>
        </Dialog>
      </>,
    );
    const outside = screen.getByRole('button', { name: 'Draußen', hidden: true });
    act(() => {
      outside.focus();
    });
    expect(screen.getByRole('button', { name: 'Drinnen' })).toHaveFocus();
  });

  it('versteckt die Überschrift auf Wunsch nur optisch und stellt ein Portal-Ziel bereit', () => {
    const seen = vi.fn();
    function Probe() {
      const container = usePortalContainer();
      useEffect(() => {
        seen(container);
      }, [container]);
      return null;
    }
    render(
      <Dialog open onClose={vi.fn()} title="Unsichtbar" hideTitle description="Nur vorgelesen">
        <Probe />
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Unsichtbar' });
    expect(dialog).toHaveAccessibleDescription('Nur vorgelesen');
    expect(screen.getByText('Unsichtbar')).toHaveClass('sr-only');
    expect(seen).toHaveBeenLastCalledWith(dialog.closest('[data-aegis-dialog-root]'));
  });

  it('zeigt Ton-Kante, Kopfzeilen-Zusatz und Fußzeile', () => {
    render(
      <Dialog
        open
        onClose={vi.fn()}
        title="T"
        eyebrow="Oben"
        tone="danger"
        headerAside={<span>Zusatz</span>}
        footer={<span>Fuß</span>}
        size="lg"
        placement="top"
        glass
      />,
    );
    expect(document.querySelector('[data-part="tone"]')).toHaveAttribute('data-tone', 'danger');
    expect(screen.getByText('Oben')).toBeInTheDocument();
    expect(screen.getByText('Zusatz')).toBeInTheDocument();
    expect(screen.getByText('Fuß')).toBeInTheDocument();
  });

  it('außerhalb eines Dialogs ist das Portal-Ziel document.body', () => {
    const seen = vi.fn();
    function Probe() {
      const container = usePortalContainer();
      useEffect(() => {
        seen(container);
      }, [container]);
      return null;
    }
    render(<Probe />);
    expect(seen).toHaveBeenLastCalledWith(document.body);
  });
});
