import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Divider } from './Divider.tsx';
import { Kbd } from './Kbd.tsx';
import { Card, Panel, surfaceClasses } from './Panel.tsx';

describe('surfaceClasses', () => {
  it('kombiniert Ebene, Glas und Leuchten aus Tokens', () => {
    expect(surfaceClasses({})).toContain('bg-surface-1');
    expect(surfaceClasses({ level: 3 })).toContain('bg-surface-3');
    expect(surfaceClasses({ glass: true })).toContain('glass');
    expect(surfaceClasses({ glass: true })).not.toContain('bg-surface-1');
    expect(surfaceClasses({ glow: true })).toContain('shadow-glow');
  });
});

describe('Card', () => {
  it('rendert eine Fläche mit Innenabstand', () => {
    render(
      <Card level={2} padding="lg" data-testid="card">
        Inhalt
      </Card>,
    );
    const card = screen.getByTestId('card');
    expect(card).toHaveClass('bg-surface-2', 'p-6', 'border-border');
    expect(card).toHaveTextContent('Inhalt');
  });
});

describe('Panel', () => {
  it('ist mit Überschrift eine benannte Region mit Kopf, Aktionen und Fuß', () => {
    render(
      <Panel
        title="Echtzeit-Wächter"
        eyebrow="Modul"
        description="Überwacht Dateien beim Öffnen."
        actions={<button type="button">Details</button>}
        footer={<span>Fußzeile</span>}
        headingLevel={3}
        glow
      >
        Körper
      </Panel>,
    );
    const region = screen.getByRole('region', { name: 'Echtzeit-Wächter' });
    expect(screen.getByRole('heading', { level: 3, name: 'Echtzeit-Wächter' })).toBeInTheDocument();
    expect(region).toHaveTextContent('Modul');
    expect(region).toHaveTextContent('Überwacht Dateien beim Öffnen.');
    expect(screen.getByRole('button', { name: 'Details' })).toBeInTheDocument();
    expect(region).toHaveTextContent('Fußzeile');
    expect(region).toHaveClass('shadow-glow');
  });

  it('ist ohne Überschrift keine benannte Region', () => {
    render(
      <Panel padding="none" data-testid="panel" actions={<span>A</span>} footer="F">
        Nur Inhalt
      </Panel>,
    );
    const panel = screen.getByTestId('panel');
    expect(panel).not.toHaveAttribute('aria-labelledby');
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('rendert auch ganz ohne Kopf und Inhalt', () => {
    render(<Panel data-testid="leer" />);
    expect(screen.getByTestId('leer').children).toHaveLength(0);
  });
});

describe('Divider', () => {
  it('ist standardmäßig dekorativ', () => {
    const { container } = render(<Divider />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('kann semantisch, senkrecht und beschriftet sein', () => {
    render(
      <>
        <Divider decorative={false} />
        <Divider decorative={false} orientation="vertical" />
        <Divider label="oder" />
      </>,
    );
    const separators = screen.getAllByRole('separator');
    expect(separators).toHaveLength(2);
    expect(separators[1]).toHaveAttribute('aria-orientation', 'vertical');
    expect(screen.getByText('oder')).toBeInTheDocument();
  });
});

describe('Kbd', () => {
  it('zeigt eine einzelne Taste', () => {
    render(<Kbd>Esc</Kbd>);
    expect(screen.getByText('Esc').tagName).toBe('KBD');
  });

  it('zeigt Tastenkombinationen als verschachtelte kbd-Elemente', () => {
    const { container } = render(<Kbd keys={['Strg', 'K']} size="sm" />);
    const outer = container.firstElementChild;
    expect(outer?.tagName).toBe('KBD');
    expect(outer?.querySelectorAll('kbd')).toHaveLength(2);
    expect(outer).toHaveTextContent('Strg+K');
  });
});
