import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { ICON_GRID, ICON_STROKE_WIDTH } from './createIcon.tsx';
import { IconShield, icons } from './icons.tsx';

const requiredNames = [
  'dashboard',
  'scan',
  'shield',
  'lab',
  'network',
  'lock',
  'key',
  'tools',
  'quarantine',
  'report',
  'settings',
  'info',
  'warning',
  'danger',
  'check',
  'close',
  'minimize',
  'maximize',
  'restore',
  'search',
  'chevronDown',
  'external',
  'panic',
  'soundOn',
  'soundOff',
  'sun',
  'moon',
  'globe',
  'play',
  'pause',
  'refresh',
] as const;

describe('Icons', () => {
  it('enthält alle geforderten Motive', () => {
    for (const name of requiredNames) {
      expect(icons[name], name).toBeDefined();
    }
  });

  it.each(Object.entries(icons))(
    '%s: 24er-Raster, Strich 1,75, currentColor, dekorativ',
    (_, Icon) => {
      const { container } = render(<Icon />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('viewBox', `0 0 ${ICON_GRID} ${ICON_GRID}`);
      expect(svg).toHaveAttribute('stroke-width', String(ICON_STROKE_WIDTH));
      expect(svg).toHaveAttribute('stroke', 'currentColor');
      expect(svg).toHaveAttribute('fill', 'none');
      expect(svg).toHaveAttribute('aria-hidden', 'true');
      expect(svg).toHaveAttribute('focusable', 'false');
      expect(svg?.childElementCount).toBeGreaterThan(0);
      // Keine festen Farben in den Zeichnungen.
      expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
      // Alle Koordinaten liegen im Raster.
      for (const path of container.querySelectorAll('path')) {
        const numbers = (path.getAttribute('d') ?? '').match(/-?\d*\.?\d+/g) ?? [];
        expect(numbers.length).toBeGreaterThan(0);
      }
    },
  );

  it('wird mit Titel zur benannten Grafik', () => {
    render(<IconShield title="Schutz aktiv" />);
    const svg = screen.getByRole('img', { name: 'Schutz aktiv' });
    expect(svg).not.toHaveAttribute('aria-hidden');
    expect(svg.querySelector('title')).toHaveTextContent('Schutz aktiv');
  });

  it('übernimmt Größe, Strichstärke, Klassen und Ref', () => {
    const ref = createRef<SVGSVGElement>();
    const { container } = render(
      <IconShield ref={ref} size={16} strokeWidth={2} className="text-accent" title="" />,
    );
    const svg = container.querySelector('svg');
    expect(ref.current).toBe(svg);
    expect(svg).toHaveAttribute('width', '16');
    expect(svg).toHaveAttribute('stroke-width', '2');
    expect(svg).toHaveClass('text-accent');
    // Leerer Titel → weiterhin dekorativ.
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('hat sprechende Anzeigenamen', () => {
    expect(IconShield.displayName).toBe('IconShield');
    const names = Object.values(icons).map((Icon) => Icon.displayName);
    expect(new Set(names).size).toBe(names.length);
  });
});
