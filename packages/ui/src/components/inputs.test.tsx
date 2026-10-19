import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IconMoon, IconSun } from '../icons/icons.tsx';
import { mockMatchMedia } from '../test/matchMedia.ts';
import { SegmentedControl } from './SegmentedControl/SegmentedControl.tsx';
import { Tab, TabList, TabPanel, Tabs, tabId, tabPanelId } from './Tabs/Tabs.tsx';
import { Toggle } from './Toggle/Toggle.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Toggle', () => {
  it('ist ein benannter Schalter, der per Klick, Beschriftung und Tastatur umschaltet', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Toggle label="Klänge" description="Sehr leise, abschaltbar." onCheckedChange={onChange} />,
    );
    const toggle = screen.getByRole('switch', { name: 'Klänge' });
    expect(toggle).toHaveAccessibleDescription('Sehr leise, abschaltbar.');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByText('Klänge'));
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    toggle.focus();
    await user.keyboard(' ');
    await user.keyboard('{Enter}');
    expect(onChange.mock.calls.map((call) => call[0])).toEqual([true, false, true, false]);
  });

  it('kann kontrolliert sein und respektiert preventDefault im onClick', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    const { rerender } = render(
      <Toggle
        ref={ref}
        aria-label="Echtzeit"
        checked
        onCheckedChange={onChange}
        onClick={(event) => event.preventDefault()}
      />,
    );
    expect(ref.current).toBe(screen.getByRole('switch', { name: 'Echtzeit' }));
    await user.click(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
    rerender(<Toggle aria-label="Echtzeit" checked onCheckedChange={onChange} />);
    await user.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('ist gesperrt nicht umschaltbar, auch nicht über die Beschriftung', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Toggle
        label="Gesperrt"
        disabled
        defaultChecked
        onCheckedChange={onChange}
        size="sm"
        labelPosition="start"
      />,
    );
    await user.click(screen.getByRole('switch'));
    await user.click(screen.getByText('Gesperrt'));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('funktioniert mit nur einer Beschreibung und bei reduzierter Bewegung', async () => {
    mockMatchMedia(true);
    const user = userEvent.setup();
    render(<Toggle aria-label="Ohne Label" description="Nur Beschreibung" id="eigene-id" />);
    const toggle = screen.getByRole('switch', { name: 'Ohne Label' });
    expect(toggle).toHaveAttribute('id', 'eigene-id');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('data-state', 'on');
  });
});

describe('Toggle – Kontrastdesigns (UX-02)', () => {
  it('zeigt „an“/„aus“ auch bei forced-colors: eigener Knopf in Systemfarben', async () => {
    const user = userEvent.setup();
    render(<Toggle aria-label="Klang" />);
    const toggle = screen.getByRole('switch', { name: 'Klang' });
    const knob = toggle.querySelector('[data-part="knob"]');
    // Das System entfernt Hintergründe – der Knopf behält seine Farbe (Systemfarbe).
    expect(knob).toHaveClass(
      'forced-colors:forced-color-adjust-none',
      'forced-colors:bg-[ButtonText]',
    );
    expect(knob).not.toHaveClass('forced-colors:bg-[Highlight]');
    expect(toggle).toHaveClass('forced-colors:border-[ButtonText]');
    await user.click(toggle);
    expect(knob).toHaveClass('forced-colors:bg-[Highlight]');
    expect(knob).not.toHaveClass('forced-colors:bg-[ButtonText]');
    expect(toggle).toHaveClass('forced-colors:border-[Highlight]');
  });
});

describe('SegmentedControl', () => {
  const options = [
    { value: 'dark', label: 'Dunkel', icon: <IconMoon /> },
    { value: 'light', label: 'Hell', icon: <IconSun /> },
    { value: 'system', label: 'System' },
  ] as const;

  it('ist eine Radiogruppe mit einem Tab-Stopp und Pfeiltasten', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <button type="button">Davor</button>
        <SegmentedControl
          label="Farbschema"
          options={options}
          defaultValue="dark"
          onValueChange={onChange}
        />
      </>,
    );
    const group = screen.getByRole('radiogroup', { name: 'Farbschema' });
    expect(group).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
    await user.click(screen.getByRole('button', { name: 'Davor' }));
    await user.tab();
    expect(screen.getByRole('radio', { name: 'Dunkel' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Hell' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Hell' })).toBeChecked();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Dunkel' })).toBeChecked();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
    await user.keyboard('{Home}');
    expect(screen.getByRole('radio', { name: 'Dunkel' })).toBeChecked();
    await user.keyboard('{End}');
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('radio', { name: 'Hell' })).toBeChecked();
    await user.keyboard('a');
    await user.click(screen.getByRole('radio', { name: 'System' }));
    expect(onChange.mock.calls.map((call) => call[0])).toEqual([
      'light',
      'system',
      'dark',
      'system',
      'dark',
      'system',
      'light',
      'system',
    ]);
  });

  it('überspringt gesperrte Optionen und fokussiert ohne gültigen Wert die erste', async () => {
    const user = userEvent.setup();
    function Controlled() {
      const [value, setValue] = useState<'a' | 'b' | 'c'>('b');
      return (
        <SegmentedControl
          label="Auswahl"
          value={value}
          onValueChange={setValue}
          size="sm"
          fullWidth
          options={[
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B', disabled: true },
            { value: 'c', label: 'C', ariaLabel: 'Option C' },
          ]}
        />
      );
    }
    render(<Controlled />);
    // „b“ ist gesperrt → die erste freie Option ist der Tab-Stopp.
    expect(screen.getByRole('radio', { name: 'A' })).toHaveAttribute('tabindex', '0');
    screen.getByRole('radio', { name: 'A' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Option C' })).toBeChecked();
  });

  it('ist als Ganzes sperrbar und ignoriert dann Tasten', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SegmentedControl label="Aus" options={options} disabled onValueChange={onChange} />);
    expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-disabled', 'true');
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toBeDisabled();
    }
    screen.getByRole('radiogroup').focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('arbeitet bei reduzierter Bewegung ohne Animation', async () => {
    mockMatchMedia(true);
    const user = userEvent.setup();
    render(<SegmentedControl label="Ruhig" options={options} />);
    await user.click(screen.getByRole('radio', { name: 'Hell' }));
    expect(screen.getByRole('radio', { name: 'Hell' })).toBeChecked();
  });
});

describe('Tabs', () => {
  function Example({ activation }: { readonly activation?: 'automatic' | 'manual' }) {
    return (
      <Tabs defaultValue="scan" activation={activation}>
        <TabList aria-label="Bereiche">
          <Tab value="scan">Scan</Tab>
          <Tab value="netz" disabled>
            Netzwerk
          </Tab>
          <Tab value="tools">Tools</Tab>
          <Tab value="über uns">Über</Tab>
        </TabList>
        <TabPanel value="scan">Scan-Inhalt</TabPanel>
        <TabPanel value="netz">Netz-Inhalt</TabPanel>
        <TabPanel value="tools" keepMounted>
          Tools-Inhalt
        </TabPanel>
        <TabPanel value="über uns">Über-Inhalt</TabPanel>
      </Tabs>
    );
  }

  it('folgt dem WAI-ARIA-Muster (Rollen, IDs, ein Tab-Stopp)', () => {
    render(<Example />);
    const list = screen.getByRole('tablist', { name: 'Bereiche' });
    expect(list).toHaveAttribute('aria-orientation', 'horizontal');
    const scan = screen.getByRole('tab', { name: 'Scan' });
    expect(scan).toHaveAttribute('aria-selected', 'true');
    expect(scan).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Tools' })).toHaveAttribute('tabindex', '-1');
    const panel = screen.getByRole('tabpanel', { name: 'Scan' });
    expect(panel).toHaveTextContent('Scan-Inhalt');
    expect(scan).toHaveAttribute('aria-controls', panel.id);
    // keepMounted: versteckt eingehängt.
    expect(screen.getByText('Tools-Inhalt').closest('[role="tabpanel"]')).toHaveAttribute('hidden');
    expect(screen.queryByText('Netz-Inhalt')).toBeNull();
  });

  it('wechselt mit Pfeilen (automatisch), überspringt gesperrte Reiter, Pos1/Ende', async () => {
    const user = userEvent.setup();
    render(<Example />);
    screen.getByRole('tab', { name: 'Scan' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Tools' })).toHaveFocus();
    expect(screen.getByRole('tabpanel', { name: 'Tools' })).toHaveTextContent('Tools-Inhalt');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Über' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Scan' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Über' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Scan' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('tab', { name: 'Scan' })).toHaveFocus();
  });

  it('wählt im manuellen Modus erst mit Enter/Leertaste', async () => {
    const user = userEvent.setup();
    render(<Example activation="manual" />);
    screen.getByRole('tab', { name: 'Scan' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Tools' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Scan' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('tab', { name: 'Tools' })).toHaveAttribute('aria-selected', 'true');
  });

  it('ist kontrolliert und senkrecht nutzbar; onClick/onKeyDown können abbrechen', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mockMatchMedia(true);
    render(
      <Tabs value="a" onValueChange={onChange} orientation="vertical">
        <TabList
          aria-label="Senkrecht"
          onKeyDown={(event) => event.key === 'End' && event.preventDefault()}
        >
          <Tab value="a">A</Tab>
          <Tab value="b" onClick={(event) => event.preventDefault()}>
            B
          </Tab>
          <Tab value="c">C</Tab>
        </TabList>
        <TabPanel value="a">A-Inhalt</TabPanel>
      </Tabs>,
    );
    expect(screen.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
    screen.getByRole('tab', { name: 'A' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenLastCalledWith('b');
    expect(screen.getByRole('tab', { name: 'A' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowUp}');
    expect(onChange).toHaveBeenLastCalledWith('a');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'A' })).toHaveFocus();
    await user.click(screen.getByRole('tab', { name: 'B' }));
    expect(onChange).toHaveBeenLastCalledWith('a');
    await user.click(screen.getByRole('tab', { name: 'C' }));
    expect(onChange).toHaveBeenLastCalledWith('c');
    await user.keyboard('x');
  });

  it('bildet beliebige Werte auf gültige IDs ab', () => {
    expect(tabId('t', 'über uns')).toBe('t-tab-_252ber_32uns');
    expect(tabPanelId('t', 'a-b_c')).toBe('t-panel-a-b_c');
  });

  it('meldet einen Fehler außerhalb von <Tabs>', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Tab value="x">X</Tab>)).toThrow('<Tab> muss innerhalb von <Tabs> stehen.');
    spy.mockRestore();
  });

  it('ignoriert Tasten, wenn alle Reiter gesperrt sind', async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="a">
        <TabList aria-label="Leer">
          <Tab value="a" disabled>
            A
          </Tab>
        </TabList>
      </Tabs>,
    );
    screen.getByRole('tablist').focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'A' })).toHaveAttribute('aria-selected', 'true');
  });
});
