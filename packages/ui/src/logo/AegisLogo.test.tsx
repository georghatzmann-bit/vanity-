import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AegisLogo } from './AegisLogo.tsx';
import { AegisWordmark } from './AegisWordmark.tsx';
import { fillShape, innerMark, outline, scanLine, wordmarkFill } from './geometry.ts';

describe('AegisLogo', () => {
  it('ist ein Bild mit zugänglichem Namen „AEGIS“ (Standard)', () => {
    render(<AegisLogo />);
    const logo = screen.getByRole('img', { name: 'AEGIS' });
    expect(logo.tagName.toLowerCase()).toBe('svg');
    expect(logo.style.height).toBe('32px');
    expect(logo.style.width).toBe('32px');
    expect(logo.querySelector('title')?.textContent).toBe('AEGIS');
  });

  it('übernimmt einen eigenen Titel', () => {
    render(<AegisLogo title="AEGIS Suite – Startseite" />);
    expect(screen.getByRole('img', { name: 'AEGIS Suite – Startseite' })).toBeInTheDocument();
  });

  it('ist als Dekoration vor Hilfstechnologien verborgen', () => {
    const { container } = render(<AegisLogo decorative />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('focusable', 'false');
    expect(svg?.querySelector('title')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('zeichnet Umriss, Λ und Scan-Balken aus der gemeinsamen Geometrie', () => {
    const { container } = render(<AegisLogo />);
    const paths = [...container.querySelectorAll('path')].map((p) => p.getAttribute('d'));
    expect(paths).toEqual(expect.arrayContaining([fillShape, outline, innerMark, scanLine]));
    // Farben nur über Tokens (CSS-Variablen mit Rückfallwert) bzw. Verlauf.
    expect(container.innerHTML).toContain('var(--aegis-accent');
  });

  it('„solid“ spart Λ und Balken per Maske aus – mit eindeutigen IDs je Instanz', () => {
    const { container } = render(
      <>
        <AegisLogo appearance="solid" title="eins" />
        <AegisLogo appearance="solid" title="zwei" />
      </>,
    );
    const masks = [...container.querySelectorAll('mask')];
    expect(masks).toHaveLength(2);
    const ids = masks.map((m) => m.id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(container.querySelector(`[mask="url(#${id})"]`)).not.toBeNull();
    }
  });

  it('„mono“ nutzt ausschließlich currentColor', () => {
    const { container } = render(<AegisLogo tone="mono" appearance="solid" />);
    expect(container.querySelector('linearGradient')).toBeNull();
    expect(container.innerHTML).not.toContain('--aegis-accent');
    expect(container.innerHTML.toLowerCase()).toContain('currentcolor');
  });

  it('„full“ enthält Bildzeichen und Schriftzug und ist breiter als hoch', () => {
    const { container } = render(<AegisLogo variant="full" size={40} />);
    const svg = screen.getByRole('img', { name: 'AEGIS' });
    expect(svg).toHaveAttribute('data-variant', 'full');
    expect(svg.getAttribute('viewBox')).toMatch(/^0 0 [\d.]+ 64$/);
    expect(container.querySelector(`path[d="${wordmarkFill}"]`)).not.toBeNull();
    expect(container.querySelector(`path[d="${outline}"]`)).not.toBeNull();
  });

  it('akzeptiert CSS-Längen als Größe', () => {
    render(<AegisLogo size="2rem" variant="full" />);
    const svg = screen.getByRole('img');
    expect(svg.style.height).toBe('2rem');
    // jsdom vereinfacht calc(2rem * 2,645…) zu calc(5,29…rem): Breite folgt dem Seitenverhältnis.
    expect(svg.style.width).toMatch(/^calc\(5\.29\d*rem\)$/);
  });
});

describe('AegisWordmark', () => {
  it('ist ein Bild mit Namen „AEGIS“ in currentColor', () => {
    const { container } = render(<AegisWordmark height={18} />);
    const svg = screen.getByRole('img', { name: 'AEGIS' });
    expect(svg).toHaveStyle({ height: '18px' });
    expect(container.querySelector(`path[d="${wordmarkFill}"]`)).toHaveAttribute(
      'fill',
      'currentColor',
    );
  });

  it('kann dekorativ sein', () => {
    const { container } = render(<AegisWordmark decorative title="ignoriert" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('img')).toBeNull();
  });
});
