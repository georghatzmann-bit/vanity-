import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IconLab, IconScan } from '../icons/icons.tsx';
import { mockMatchMedia } from '../test/matchMedia.ts';
import {
  CommandPalette,
  commandPaletteLabelsEn,
  filterCommands,
  type CommandItem,
} from './CommandPalette/CommandPalette.tsx';
import { Dialog } from './Dialog/Dialog.tsx';
import { ComingSoon, EmptyState, PhaseBadge } from './EmptyState/EmptyState.tsx';
import { PageTransition } from './Motion/PageTransition.tsx';
import { Skeleton, SkeletonText } from './Motion/Skeleton.tsx';
import { SafeText } from './SafeText/SafeText.tsx';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SafeText', () => {
  it('gibt harmlose Texte unverändert und isoliert links-nach-rechts aus', () => {
    render(<SafeText value={'C:\\Temp\\bericht.pdf'} />);
    const element = screen.getByText('C:\\Temp\\bericht.pdf');
    expect(element).toHaveAttribute('dir', 'ltr');
    expect(element).toHaveClass('font-mono', '[unicode-bidi:isolate]');
  });

  it('ersetzt Steuerzeichen durch Marken und beschreibt sie für Screenreader', () => {
    const { container } = render(
      <SafeText
        value={'a\u202Eb\u200Bc'}
        mono={false}
        describeInvisible={(cp) => `Zeichen ${cp}`}
      />,
    );
    expect(container.textContent).not.toMatch(/[\u202E\u200B]/);
    const marks = container.querySelectorAll('mark');
    expect([...marks].map((mark) => mark.textContent)).toEqual(['⟨U+202E⟩', '⟨U+200B⟩']);
    expect(container.querySelector('.sr-only')).toHaveTextContent(
      'a [Zeichen U+202E] b [Zeichen U+200B] c',
    );
    expect(container.firstElementChild).not.toHaveClass('font-mono');
  });

  it('kürzt in der Mitte nur sichtbar', () => {
    const value = `C:\\${'x'.repeat(80)}\\datei.exe`;
    const { container } = render(<SafeText value={value} maxLength={30} />);
    const visible = container.querySelector('[aria-hidden="true"]');
    expect(visible?.textContent).toContain('…');
    expect(visible?.textContent?.endsWith('\\datei.exe')).toBe(true);
    expect(container.querySelector('.sr-only')).toHaveTextContent(value);
    expect(container.firstElementChild).toHaveAttribute('data-truncated', 'true');
  });
});

describe('CommandPalette', () => {
  function makeItems(onSelect = vi.fn()): CommandItem[] {
    return [
      {
        id: 'dash',
        label: 'Dashboard',
        group: 'Navigation',
        icon: <IconScan />,
        shortcut: ['Strg', '1'],
        onSelect,
      },
      {
        id: 'scan',
        label: 'Schnell-Scan starten',
        group: 'Aktionen',
        keywords: ['scan', 'prüfen'],
        hint: 'Folgt in P2',
        onSelect,
      },
      { id: 'skip', label: 'Start-Animation überspringen', group: 'Aktionen', onSelect },
      {
        id: 'lab',
        label: 'Labor',
        group: 'Navigation',
        icon: <IconLab />,
        disabled: true,
        onSelect,
      },
      { id: 'sett', label: 'Einstellungen', group: 'Navigation', keywords: ['settings'], onSelect },
    ];
  }

  function Harness({ items }: { readonly items: readonly CommandItem[] }) {
    const [open, setOpen] = useState(false);
    const [reason, setReason] = useState('');
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Palette
        </button>
        <output data-testid="reason">{reason}</output>
        <CommandPalette
          open={open}
          items={items}
          onClose={(why) => {
            setReason(why);
            setOpen(false);
          }}
        />
      </>
    );
  }

  it('gruppiert ohne Suche in Original-Reihenfolge und filtert akzentunabhängig', () => {
    const items = makeItems();
    expect(filterCommands(items, '').map((group) => group.name)).toEqual([
      'Navigation',
      'Aktionen',
    ]);
    const groups = filterCommands(items, 'uberspringen');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.results[0]?.item.id).toBe('skip');
    expect(filterCommands(items, 'settings')[0]?.results[0]?.item.id).toBe('sett');
    expect(filterCommands(items, 'zzz')).toEqual([]);
    // Gruppen nach bestem Treffer: „Dashboard“ (Anfang) vor „Schnell-Scan“.
    const sorted = filterCommands(items, 'da');
    expect(sorted[0]?.name).toBe('Navigation');
  });

  it('folgt dem Combobox-Muster und wählt mit Pfeilen und Enter', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness items={makeItems(onSelect)} />);
    const opener = screen.getByRole('button', { name: 'Palette' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Befehlspalette' });
    const input = within(dialog).getByRole('combobox', { name: 'Befehl suchen' });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-expanded', 'true');
    const listbox = within(dialog).getByRole('listbox');
    expect(input).toHaveAttribute('aria-controls', listbox.id);
    expect(within(listbox).getAllByRole('group')).toHaveLength(2);
    const options = within(listbox).getAllByRole('option');
    expect(options).toHaveLength(5);
    expect(input).toHaveAttribute('aria-activedescendant', options[0]?.id);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveAttribute('aria-disabled', 'true');

    // Gesperrte Einträge werden übersprungen, die Liste läuft um.
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', options[2]?.id);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(input).toHaveAttribute('aria-activedescendant', options[4]?.id);
    await user.keyboard('{Control>}{Home}{/Control}');
    expect(input).toHaveAttribute('aria-activedescendant', options[0]?.id);
    await user.keyboard('{Control>}{End}{/Control}');
    expect(input).toHaveAttribute('aria-activedescendant', options[4]?.id);
    await user.keyboard('{PageUp}');
    await user.keyboard('{PageDown}');
    await user.keyboard('{Home}');
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('reason')).toHaveTextContent('select');
  });

  it('sucht, hebt Treffer hervor, meldet die Anzahl und zeigt einen leeren Zustand', async () => {
    const user = userEvent.setup();
    render(<Harness items={makeItems()} />);
    await user.click(screen.getByRole('button', { name: 'Palette' }));
    const input = screen.getByRole('combobox');
    await user.type(input, 'uberspringen');
    const option = screen.getByRole('option', { name: 'Start-Animation überspringen' });
    expect(option).toHaveAttribute('aria-selected', 'true');
    expect(option.querySelector('mark')).toHaveTextContent('überspringen');
    const count = within(screen.getByRole('dialog')).getByRole('status');
    expect(count).toHaveTextContent('1 Treffer');
    await user.clear(input);
    await user.type(input, 'xyz');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('Keine Treffer für „xyz“')).toBeInTheDocument();
    expect(count).toHaveTextContent('0 Treffer');
    expect(input).not.toHaveAttribute('aria-activedescendant');
    // Ohne Treffer: zugeklappt, keine leere Listbox.
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveAttribute('aria-controls');
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('wählt per Maus, ignoriert gesperrte Einträge und schließt mit Escape', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness items={makeItems(onSelect)} />);
    const opener = screen.getByRole('button', { name: 'Palette' });
    await user.click(opener);
    const options = screen.getAllByRole('option');
    fireEvent.pointerMove(options[2] as Element);
    expect(options[2]).toHaveAttribute('aria-selected', 'true');
    fireEvent.pointerMove(options[1] as Element);
    expect(options[1]).toHaveAttribute('aria-selected', 'false');
    await user.click(options[1] as Element);
    expect(onSelect).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(screen.getByTestId('reason')).toHaveTextContent('escape');
  });

  it('setzt die Suche beim erneuten Öffnen zurück und gibt den Fokus zurück', async () => {
    const user = userEvent.setup();
    render(<Harness items={makeItems()} />);
    const opener = screen.getByRole('button', { name: 'Palette' });
    await user.click(opener);
    await user.type(screen.getByRole('combobox'), 'scan');
    await user.click(screen.getByRole('option', { name: /Schnell-Scan starten/ }));
    expect(screen.getByTestId('reason')).toHaveTextContent('select');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(opener).toHaveFocus();
    await user.click(opener);
    expect(screen.getByRole('combobox')).toHaveValue('');
  });

  it('übernimmt eigene Beschriftungen', async () => {
    const user = userEvent.setup();
    render(<CommandPalette open items={[]} onClose={vi.fn()} labels={commandPaletteLabelsEn} />);
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('0 results');
    await user.keyboard('{Enter}');
  });

  it('lässt einen Befehl den Fokus setzen (z. B. Sprung zu einer Überschrift)', async () => {
    const user = userEvent.setup();
    function Jump() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Öffnen
          </button>
          <h2 id="ziel" tabIndex={-1}>
            Ziel
          </h2>
          <CommandPalette
            open={open}
            onClose={() => setOpen(false)}
            items={[
              {
                id: 'z',
                label: 'Zum Ziel',
                group: 'Navigation',
                onSelect: () => document.getElementById('ziel')?.focus(),
              },
            ]}
          />
        </>
      );
    }
    render(<Jump />);
    await user.click(screen.getByRole('button', { name: 'Öffnen' }));
    await user.keyboard('{Enter}');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(screen.getByRole('heading', { name: 'Ziel' })).toHaveFocus();
  });

  it('führt einen gewählten Befehl auch aus, wenn die App die Palette aushängt', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    function Unmounting() {
      const [open, setOpen] = useState(true);
      return open ? (
        <CommandPalette
          open
          onClose={() => setOpen(false)}
          items={[{ id: 'a', label: 'A', group: 'G', onSelect }]}
        />
      ) : null;
    }
    render(<Unmounting />);
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('übergibt den Fokus an einen Dialog, den ein Befehl öffnet, und danach zurück', async () => {
    const user = userEvent.setup();
    function Chain() {
      const [palette, setPalette] = useState(false);
      const [settings, setSettings] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setPalette(true)}>
            Start
          </button>
          <CommandPalette
            open={palette}
            onClose={() => setPalette(false)}
            items={[
              {
                id: 's',
                label: 'Einstellungen öffnen',
                group: 'A',
                onSelect: () => setSettings(true),
              },
            ]}
          />
          <Dialog open={settings} onClose={() => setSettings(false)} title="Einstellungen">
            <button type="button">Im Dialog</button>
          </Dialog>
        </>
      );
    }
    render(<Chain />);
    const start = screen.getByRole('button', { name: 'Start' });
    await user.click(start);
    await user.keyboard('{Enter}');
    const dialog = screen.getByRole('dialog', { name: 'Einstellungen' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(start).toHaveFocus();
  });
});

describe('EmptyState / ComingSoon / PhaseBadge', () => {
  it('zeigt Icon, Titel, Beschreibung, Phase, Hinweis und Aktionen', () => {
    render(
      <EmptyState
        icon={<IconLab />}
        title="Labor"
        description="Dateien sicher öffnen."
        phase="P4"
        note="Keine Werte ohne Messung."
        actions={<button type="button">Mehr</button>}
        headingLevel={3}
      />,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Labor' })).toBeInTheDocument();
    expect(screen.getByText('Folgt in P4')).toBeInTheDocument();
    expect(screen.getByText('Keine Werte ohne Messung.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mehr' })).toBeInTheDocument();
  });

  it('ComingSoon ergänzt einen ehrlichen Standard-Hinweis', () => {
    render(<ComingSoon title="Netzwerk" phase="P7" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Netzwerk' })).toBeInTheDocument();
    expect(screen.getByText(/keine Beispiel- oder Schätzwerte/)).toBeInTheDocument();
    expect(screen.getByText('Folgt in P7')).toHaveAttribute('data-phase', 'P7');
  });

  it('PhaseBadge übernimmt eigene Formulierung', () => {
    render(<PhaseBadge phase="P9" format={(phase) => `Coming in ${phase}`} />);
    expect(screen.getByText('Coming in P9')).toBeInTheDocument();
  });

  it('rendert minimal nur den Titel', () => {
    const { container } = render(<EmptyState title="Leer" />);
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });
});

describe('PageTransition / Skeleton', () => {
  it('blendet per Schlüssel neu ein', () => {
    const { rerender, container } = render(
      <PageTransition transitionKey="a" className="seite">
        Seite A
      </PageTransition>,
    );
    expect(container.firstElementChild).toHaveAttribute('data-transition-key', 'a');
    rerender(<PageTransition transitionKey="b">Seite B</PageTransition>);
    expect(screen.getByText('Seite B')).toHaveAttribute('data-transition-key', 'b');
  });

  it('animiert bei reduzierter Bewegung nicht', () => {
    mockMatchMedia(true);
    render(<PageTransition transitionKey="a">Ruhig</PageTransition>);
    // Kein Startzustand „unsichtbar“ – der Inhalt steht sofort da.
    expect(screen.getByText('Ruhig').style.opacity).not.toBe('0');
    expect(screen.getByText('Ruhig').style.transform).not.toMatch(/translate/);
  });

  it('Skeletons sind dekorativ, der Schimmer entfällt bei reduzierter Bewegung', () => {
    const { container } = render(
      <>
        <Skeleton width={120} height={20} radius="full" />
        <SkeletonText lines={3} />
        <SkeletonText lines={0} />
      </>,
    );
    const skeletons = container.querySelectorAll('[data-skeleton]');
    expect(skeletons).toHaveLength(5);
    expect(skeletons[0]).toHaveAttribute('aria-hidden', 'true');
    expect(skeletons[0]).toHaveStyle({ width: '120px', height: '20px' });
    expect(skeletons[0]?.firstElementChild).toHaveClass(
      'animate-aegis-shimmer',
      'motion-reduce:hidden',
    );
    expect(skeletons[3]).toHaveStyle({ width: '62%' });
  });
});
