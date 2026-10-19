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

describe('Dialog – Stapel (Review P1)', () => {
  it('F3: zwei im selben Durchgang geöffnete Dialoge sperren sich nicht gegenseitig', () => {
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();
    render(
      <>
        <Dialog open onClose={onCloseA} title="A" showCloseButton={false}>
          <button type="button">A-Knopf</button>
        </Dialog>
        <Dialog open onClose={onCloseB} title="B" showCloseButton={false}>
          <button type="button">B-Knopf</button>
        </Dialog>
      </>,
    );
    const roots = [...document.querySelectorAll('[data-aegis-dialog-root]')];
    // Nur der obere (zuletzt geöffnete) ist bedienbar, der untere ist inert – nie beide.
    expect(roots.map((root) => root.hasAttribute('inert'))).toEqual([true, false]);
    expect(screen.getByRole('button', { name: 'B-Knopf' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('button', { name: 'B-Knopf' }), { key: 'Escape' });
    expect(onCloseB).toHaveBeenCalledWith('escape');
    expect(onCloseA).not.toHaveBeenCalled();
  });

  it('F11: gibt den Hintergrund erst frei, wenn der letzte Dialog schließt – auch in anderer Reihenfolge', () => {
    function Pair({ lower, upper }: { readonly lower: boolean; readonly upper: boolean }) {
      const safeRef = useRef<HTMLButtonElement>(null);
      return (
        <div data-testid="app">
          <button type="button">App-Knopf</button>
          <Dialog open={lower} onClose={vi.fn()} title="Unten" showCloseButton={false}>
            <button type="button">Unten-Knopf</button>
          </Dialog>
          <Dialog
            open={upper}
            onClose={vi.fn()}
            title="Oben"
            showCloseButton={false}
            initialFocusRef={safeRef}
          >
            <button type="button">Folgenreich</button>
            <button type="button" ref={safeRef}>
              Sicher
            </button>
          </Dialog>
        </div>
      );
    }
    const { rerender } = render(<Pair lower upper={false} />);
    const appRoot = screen.getByTestId('app').parentElement;
    expect(appRoot).toHaveAttribute('inert');
    rerender(<Pair lower upper />);
    // Der untere schließt zuerst – der obere ist noch offen, der App-Inhalt bleibt gesperrt.
    rerender(<Pair lower={false} upper />);
    expect(appRoot).toHaveAttribute('inert');
    const upperRoot = screen
      .getByRole('dialog', { name: 'Oben' })
      .closest('[data-aegis-dialog-root]');
    expect(upperRoot).not.toHaveAttribute('inert');

    // Fokus, der hinausgelangt, kehrt zum Startfokus zurück – nicht zum erstbesten Knopf.
    act(() => {
      screen.getByRole('button', { name: 'App-Knopf', hidden: true }).focus();
    });
    expect(screen.getByRole('button', { name: 'Sicher' })).toHaveFocus();

    rerender(<Pair lower={false} upper={false} />);
    expect(appRoot).not.toHaveAttribute('inert');
  });

  it('meldet, welcher Dialog oben liegt (onStackTopChange)', () => {
    const lowerTop = vi.fn();
    const upperTop = vi.fn();
    function Pair({ upper }: { readonly upper: boolean }) {
      return (
        <>
          <Dialog open onClose={vi.fn()} title="Unten" onStackTopChange={lowerTop} />
          <Dialog open={upper} onClose={vi.fn()} title="Oben" onStackTopChange={upperTop} />
        </>
      );
    }
    const { rerender } = render(<Pair upper={false} />);
    expect(lowerTop.mock.calls).toEqual([[true]]);
    rerender(<Pair upper />);
    expect(lowerTop.mock.calls).toEqual([[true], [false]]);
    expect(upperTop.mock.calls).toEqual([[true]]);
    rerender(<Pair upper={false} />);
    expect(upperTop.mock.calls).toEqual([[true], [false]]);
    expect(lowerTop.mock.calls).toEqual([[true], [false], [true]]);
  });

  it('F12: ein Klick auf den Hintergrund nimmt den Fokus nicht weg; Escape gilt auch auf body', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="T" closeOnBackdrop={false} showCloseButton={false}>
        <button type="button">Drinnen</button>
      </Dialog>,
    );
    const backdrop = document.querySelector<HTMLElement>('[data-part="backdrop"]');
    expect(backdrop).not.toBeNull();
    // Standardaktion von mousedown (Fokuswechsel auf body) ist unterbunden.
    expect(fireEvent.mouseDown(backdrop as HTMLElement)).toBe(false);
    expect(screen.getByRole('button', { name: 'Drinnen' })).toHaveFocus();

    // Fällt der Fokus trotzdem auf body (z. B. weil ein fokussierter Knopf gesperrt wird),
    // bedeutet Escape weiterhin „schließen“.
    act(() => {
      screen.getByRole('button', { name: 'Drinnen' }).blur();
    });
    expect(document.body).toHaveFocus();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('escape');
  });

  it('F12: Escape auf body schließt nur den obersten Dialog und nur einmal', () => {
    const lowerClose = vi.fn();
    const upperClose = vi.fn();
    render(
      <>
        <Dialog open onClose={lowerClose} title="Unten" />
        <Dialog open onClose={upperClose} title="Oben" />
      </>,
    );
    act(() => {
      (document.activeElement as HTMLElement).blur();
    });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(upperClose).toHaveBeenCalledTimes(1);
    expect(lowerClose).not.toHaveBeenCalled();
  });

  it('verknüpft zusätzliche Beschreibungen (describedBy)', () => {
    render(
      <Dialog open onClose={vi.fn()} title="T" description="Kurz" describedBy="extra">
        <p id="extra">Mehr dazu</p>
      </Dialog>,
    );
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription('Kurz Mehr dazu');
  });
});
