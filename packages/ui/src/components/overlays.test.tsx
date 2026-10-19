import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockMatchMedia } from '../test/matchMedia.ts';
import { Dialog } from './Dialog/Dialog.tsx';
import {
  ToastProvider,
  resolveToastDuration,
  useToast,
  type ToastApi,
  type ToastOptions,
} from './Toast/Toast.tsx';
import { Tooltip, computeTooltipPosition } from './Tooltip/Tooltip.tsx';

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Tooltip', () => {
  function Example({ delay }: { readonly delay?: number }) {
    return (
      <Tooltip content="Quarantäne öffnen" delay={delay}>
        <button type="button" aria-describedby="vorhanden">
          Quarantäne
        </button>
      </Tooltip>
    );
  }

  it('erscheint beim Überfahren verzögert und verknüpft sich per aria-describedby', () => {
    render(
      <>
        <span id="vorhanden">Vorhandene Beschreibung</span>
        <Example />
      </>,
    );
    const trigger = screen.getByRole('button', { name: 'Quarantäne' });
    fireEvent.pointerEnter(trigger.parentElement as Element, { pointerType: 'mouse' });
    advance(349);
    expect(screen.queryByRole('tooltip')).toBeNull();
    advance(1);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Quarantäne öffnen');
    expect(trigger.getAttribute('aria-describedby')).toBe(`vorhanden ${tooltip.id}`);
    // Bleibt offen, wenn die Maus auf den Tooltip wechselt (WCAG 1.4.13).
    fireEvent.pointerLeave(trigger.parentElement as Element);
    fireEvent.pointerEnter(tooltip);
    advance(500);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.pointerLeave(tooltip);
    advance(120);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(trigger).toHaveAttribute('aria-describedby', 'vorhanden');
  });

  it('erscheint bei Tastaturfokus sofort und verschwindet beim Verlassen', () => {
    render(<Example />);
    const trigger = screen.getByRole('button');
    act(() => {
      trigger.focus();
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    act(() => {
      trigger.blur();
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('schließt mit Escape, ohne dass ein umgebender Dialog schließt', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Dialog" showCloseButton={false}>
        <Example />
      </Dialog>,
    );
    const trigger = screen.getByRole('button', { name: 'Quarantäne' });
    act(() => {
      trigger.focus();
    });
    const tooltip = screen.getByRole('tooltip');
    // Portal landet im Dialog, nicht im (inerten) Hintergrund.
    expect(tooltip.closest('[data-aegis-dialog-root]')).not.toBeNull();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledWith('escape');
  });

  it('erscheint nicht bei Touch und nicht, wenn gesperrt', () => {
    const { rerender } = render(<Example delay={0} />);
    const wrapper = screen.getByRole('button').parentElement as Element;
    fireEvent.pointerEnter(wrapper, { pointerType: 'touch' });
    advance(1000);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.pointerEnter(wrapper, { pointerType: 'mouse' });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    rerender(
      <Tooltip content="X" disabled>
        <button type="button">Quarantäne</button>
      </Tooltip>,
    );
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('positioniert sich bei Scrollen und Größenänderung neu (fixed, ohne Layout-Animation)', () => {
    render(<Example delay={0} />);
    fireEvent.pointerEnter(screen.getByRole('button').parentElement as Element, {
      pointerType: 'mouse',
    });
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveClass('fixed');
    expect(tooltip.style.top).toMatch(/px$/);
    fireEvent.scroll(window);
    fireEvent(window, new Event('resize'));
    expect(tooltip.dataset.placement).toBeDefined();
  });

  it('nutzt bei reduzierter Bewegung keinen Versatz', () => {
    mockMatchMedia(true);
    render(<Example delay={0} />);
    fireEvent.pointerEnter(screen.getByRole('button').parentElement as Element, {
      pointerType: 'mouse',
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  describe('computeTooltipPosition', () => {
    const viewport = { width: 1000, height: 800 };
    const size = { width: 100, height: 30 };
    const trigger = { top: 400, left: 500, width: 40, height: 20 };

    it.each([
      ['top', { top: 362, left: 470 }],
      ['bottom', { top: 428, left: 470 }],
      ['left', { top: 395, left: 392 }],
      ['right', { top: 395, left: 548 }],
    ] as const)('platziert %s', (placement, expected) => {
      expect(computeTooltipPosition(trigger, size, placement, viewport)).toEqual({
        ...expected,
        placement,
      });
    });

    it('klappt um, wenn auf der gewünschten Seite kein Platz ist, und bleibt im Fenster', () => {
      const atTop = { top: 4, left: 2, width: 40, height: 20 };
      const flipped = computeTooltipPosition(atTop, size, 'top', viewport);
      expect(flipped.placement).toBe('bottom');
      expect(flipped.left).toBe(8);
      const atRight = { top: 400, left: 980, width: 20, height: 20 };
      expect(computeTooltipPosition(atRight, size, 'right', viewport).placement).toBe('left');
      // Weder oben noch unten Platz → gewünschte Seite bleibt.
      const tiny = { width: 1000, height: 40 };
      expect(computeTooltipPosition(trigger, size, 'top', tiny).placement).toBe('top');
    });
  });
});

describe('Toast', () => {
  function Probe({ onApi }: { readonly onApi: (api: ToastApi) => void }) {
    const api = useToast();
    useEffect(() => {
      onApi(api);
    }, [api, onApi]);
    return <button type="button">App</button>;
  }

  function setup(defaultDuration?: number) {
    let api: ToastApi | null = null;
    const utils = render(
      <ToastProvider defaultDuration={defaultDuration}>
        <Probe onApi={(value) => (api = value)} />
      </ToastProvider>,
    );
    const show = (options: ToastOptions): string => {
      let id = '';
      act(() => {
        id = api?.show(options) ?? '';
      });
      return id;
    };
    return { ...utils, show, api: () => api as unknown as ToastApi };
  }

  it('regelt die Dauer nach den Sicherheitsregeln', () => {
    expect(resolveToastDuration({ title: 'a' }, 6000)).toBe(6000);
    expect(resolveToastDuration({ title: 'a', tone: 'danger' }, 6000)).toBeNull();
    expect(resolveToastDuration({ title: 'a', tone: 'danger', duration: 3000 }, 6000)).toBe(3000);
    expect(resolveToastDuration({ title: 'a', duration: null }, 6000)).toBeNull();
    expect(resolveToastDuration({ title: 'a', duration: 0 }, 6000)).toBeNull();
    expect(resolveToastDuration({ title: 'a', duration: Number.NaN }, 6000)).toBeNull();
    // Entscheidungen verschwinden nie von selbst – auch nicht mit Dauer.
    expect(
      resolveToastDuration(
        { title: 'a', duration: 1000, actions: [{ label: 'Ja', onAction: () => undefined }] },
        6000,
      ),
    ).toBeNull();
  });

  it('kündigt normale Meldungen höflich, Gefahren dringlich an', () => {
    const { show } = setup();
    show({ title: 'Scan fertig', description: 'Nichts gefunden.', tone: 'success' });
    show({ title: 'Fund', description: 'EICAR-Testdatei', tone: 'danger' });
    expect(screen.getByTestId('toast-polite')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByTestId('toast-polite')).toHaveTextContent('Scan fertig. Nichts gefunden.');
    expect(screen.getByTestId('toast-polite')).not.toHaveTextContent('Fund');
    expect(screen.getByTestId('toast-assertive')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('toast-assertive')).toHaveTextContent('Fund. EICAR-Testdatei');
    expect(screen.getByRole('region', { name: 'Benachrichtigungen' })).toBeInTheDocument();
  });

  it('blendet nach der Dauer aus und pausiert bei Hover und Fokus', () => {
    const { show } = setup(1000);
    show({ title: 'Info' });
    const region = screen.getByRole('region', { name: 'Benachrichtigungen' });
    advance(600);
    fireEvent.pointerEnter(region);
    expect(region).toHaveAttribute('data-paused', 'true');
    advance(5000);
    expect(screen.getAllByText('Info').length).toBeGreaterThan(0);
    fireEvent.pointerLeave(region);
    advance(399);
    expect(screen.getAllByText('Info').length).toBeGreaterThan(0);
    advance(1);
    advance(200);
    expect(screen.queryAllByText('Info')).toHaveLength(0);

    show({ title: 'Fokus' });
    const close = screen.getByRole('button', { name: 'Meldung schließen' });
    act(() => {
      close.focus();
    });
    advance(5000);
    expect(screen.getAllByText('Fokus').length).toBeGreaterThan(0);
    act(() => {
      close.blur();
    });
    advance(1200);
    expect(screen.queryAllByText('Fokus')).toHaveLength(0);
  });

  it('pausiert, solange das Fenster im Hintergrund ist', () => {
    const { show } = setup(1000);
    show({ title: 'Hintergrund' });
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    advance(3000);
    expect(screen.getAllByText('Hintergrund').length).toBeGreaterThan(0);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    advance(1200);
    expect(screen.queryAllByText('Hintergrund')).toHaveLength(0);
  });

  it('lässt Meldungen mit Entscheidung und Gefahren stehen', () => {
    const onAction = vi.fn();
    const { show } = setup(500);
    show({
      title: 'Neue Version',
      actions: [
        { label: 'Details', onAction, variant: 'primary' },
        { label: 'Später', onAction: vi.fn() },
      ],
      duration: 500,
    });
    show({ title: 'Gefahr', tone: 'danger' });
    advance(60_000);
    expect(screen.getAllByText('Neue Version').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Gefahr').length).toBeGreaterThan(0);
    const persistent = document.querySelectorAll('[data-persistent="true"]');
    expect(persistent).toHaveLength(2);
    expect(document.querySelectorAll('[data-part="timer"]')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    advance(200);
    expect(screen.queryAllByText('Neue Version')).toHaveLength(0);
  });

  it('schließt per Button, ersetzt Meldungen mit gleicher ID und leert alles', () => {
    const { show, api } = setup();
    const id = show({ id: 'scan', title: 'Scan läuft', duration: null });
    expect(id).toBe('scan');
    show({ id: 'scan', title: 'Scan fertig' });
    expect(screen.queryAllByText('Scan läuft')).toHaveLength(0);
    expect(screen.getAllByText('Scan fertig').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Meldung schließen' }));
    // Während des Ausblendens inert und nicht mehr angesagt.
    expect(screen.getByTestId('toast-polite')).not.toHaveTextContent('Scan fertig');
    act(() => {
      api().dismiss('scan');
    });
    advance(200);
    expect(screen.queryAllByText('Scan fertig')).toHaveLength(0);

    show({ title: 'Eins', duration: null });
    show({ title: 'Zwei', tone: 'warn', duration: null });
    const zwei = show({ title: 'Drei', tone: 'info' });
    act(() => {
      api().dismiss(zwei);
      api().clear();
    });
    expect(screen.queryAllByText('Eins')).toHaveLength(0);
    expect(screen.queryAllByText('Zwei')).toHaveLength(0);
    // Erneutes Zeigen derselben ID während des Ausblendens bricht das Entfernen ab.
    show({ id: 'x', title: 'X', duration: null });
    act(() => {
      api().dismiss('x');
    });
    show({ id: 'x', title: 'X wieder', duration: null });
    advance(500);
    expect(screen.getAllByText('X wieder').length).toBeGreaterThan(0);
  });

  it('entfernt bei reduzierter Bewegung sofort und nimmt eigene Beschriftungen', () => {
    mockMatchMedia(true);
    let api: ToastApi | null = null;
    render(
      <ToastProvider labels={{ region: 'Notifications', dismiss: 'Dismiss' }}>
        <Probe onApi={(value) => (api = value)} />
      </ToastProvider>,
    );
    act(() => {
      api?.show({ title: 'Hello', duration: null });
    });
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryAllByText('Hello')).toHaveLength(0);
  });

  it('meldet einen Fehler ohne Provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe onApi={vi.fn()} />)).toThrow('useToast()');
    spy.mockRestore();
  });

  it('räumt beim Aushängen laufende Timer auf', () => {
    const { show, api, unmount } = setup();
    show({ id: 'a', title: 'A', duration: null });
    act(() => {
      api().dismiss('a');
    });
    unmount();
    advance(1000);
    expect(screen.queryByText('A')).toBeNull();
  });
});
