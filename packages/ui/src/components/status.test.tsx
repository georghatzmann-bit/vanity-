import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IconShield } from '../icons/icons.tsx';
import { mockMatchMedia } from '../test/matchMedia.ts';
import { riskLabels, riskLevels } from '../tokens/risk.ts';
import { CountUp } from './CountUp/CountUp.tsx';
import { RiskBadge, riskIcons } from './RiskBadge/RiskBadge.tsx';
import {
  ScoreGauge,
  normalizeScore,
  scoreBand,
  scoreBandThresholds,
} from './ScoreGauge/ScoreGauge.tsx';
import { StatusRing, moduleStateLabels, moduleStates } from './StatusRing/StatusRing.tsx';

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

describe('RiskBadge', () => {
  it.each(riskLevels)('zeigt Stufe %s mit Text und eigenem Icon (nie nur Farbe)', (level) => {
    render(<RiskBadge level={level} />);
    const badge = screen.getByText(riskLabels[level]);
    expect(badge).toHaveAttribute('data-level', level);
    expect(badge.querySelector('svg')).toHaveAttribute('data-icon', riskIcons[level].displayName);
    expect(badge.className).toContain(`text-risk-${level}`);
  });

  it('hat für jede Stufe ein anderes Icon', () => {
    const names = new Set(riskLevels.map((level) => riskIcons[level].displayName));
    expect(names.size).toBe(riskLevels.length);
  });

  it('erlaubt eigene Beschriftung, kleine Größe und kein Icon', () => {
    render(<RiskBadge level="dangerous" label="Dangerous" size="sm" showIcon={false} />);
    const badge = screen.getByText('Dangerous');
    expect(badge.querySelector('svg')).toBeNull();
    expect(badge).toHaveClass('h-5');
  });
});

describe('StatusRing', () => {
  it.each(moduleStates)('zeigt Zustand %s als sichtbaren Text', (state) => {
    const { container } = render(<StatusRing state={state} label="Echtzeit-Wächter" />);
    expect(screen.getByText('Echtzeit-Wächter')).toBeInTheDocument();
    expect(screen.getByText(moduleStateLabels[state])).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute('data-state', state);
    // Die Grafik selbst ist dekorativ – der Text trägt die Information.
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('zeichnet „nicht verfügbar“ gestrichelt und „prüft“ als rotierenden Bogen', () => {
    const { container, rerender } = render(<StatusRing state="unavailable" label="Web-Schutz" />);
    expect(container.querySelector('[data-part="dashed"]')).toHaveAttribute('stroke-dasharray');
    expect(container.querySelector('[data-part="arc"]')).toBeNull();
    rerender(<StatusRing state="scanning" label="Scan" />);
    const scan = container.querySelector('[data-part="scan"]');
    expect(scan).toHaveClass('animate-aegis-orbit', 'motion-reduce:animate-none');
    rerender(<StatusRing state="ok" label="Scan" />);
    expect(container.querySelector('[data-part="arc"]')).toHaveClass('text-success');
    rerender(<StatusRing state="off" label="Scan" />);
    expect(container.querySelector('[data-part="track"]')).toHaveClass('stroke-border-strong');
  });

  it('zeigt Ergänzung, eigenes Icon, eigene Beschriftung und waagerechtes Layout', () => {
    render(
      <StatusRing
        state="unavailable"
        label="Web-Schutz"
        sublabel="Folgt in P7"
        stateLabel="Noch nicht verfügbar"
        icon={<IconShield />}
        layout="inline"
        size={64}
      />,
    );
    expect(screen.getByText('Folgt in P7')).toBeInTheDocument();
    expect(screen.getByText('Noch nicht verfügbar')).toBeInTheDocument();
    expect(document.querySelector('[data-icon="IconShield"]')).not.toBeNull();
  });

  it('ist ohne Text eine benannte Grafik', () => {
    render(<StatusRing state="warn" label="Signaturen" hideText />);
    expect(screen.getByRole('img', { name: 'Signaturen: Achtung' })).toBeInTheDocument();
    expect(screen.queryByText('Signaturen')).toBeNull();
  });
});

describe('CountUp', () => {
  it('zählt per requestAnimationFrame hoch und kündigt nur den Endwert an', () => {
    const { container } = render(<CountUp value={82} duration={400} />);
    const visible = container.querySelector('[aria-hidden="true"]');
    const spoken = container.querySelector('.sr-only');
    expect(spoken).toHaveTextContent('82');
    expect(spoken).toHaveAttribute('aria-live', 'off');
    expect(visible).toHaveTextContent('0');
    advance(200);
    const mid = Number(visible?.textContent);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(82);
    advance(400);
    expect(visible).toHaveTextContent('82');
    expect(container.firstElementChild).toHaveClass('tabular-nums');
  });

  it('zählt bei Änderungen vom alten Wert weiter', () => {
    const { container, rerender } = render(<CountUp value={10} duration={100} />);
    advance(200);
    rerender(<CountUp value={20} duration={100} />);
    advance(16);
    const value = Number(container.querySelector('[aria-hidden="true"]')?.textContent);
    expect(value).toBeGreaterThanOrEqual(10);
    advance(200);
    expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent('20');
    rerender(<CountUp value={20} duration={100} />);
    expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent('20');
  });

  it('zeigt bei „Bewegung reduzieren“ oder Dauer 0 sofort den Endwert', () => {
    mockMatchMedia(true);
    const { container, unmount } = render(<CountUp value={1234} />);
    expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent('1.234');
    unmount();
    vi.unstubAllGlobals();
    const instant = render(<CountUp value={7} duration={0} />);
    expect(instant.container.querySelector('[aria-hidden="true"]')).toHaveTextContent('7');
  });

  it('formatiert mit Nachkommastellen, Gebietsschema, eigener Funktion und Live-Ansage', () => {
    const { container, rerender } = render(
      <CountUp value={12.5} decimals={1} duration={0} live="polite" />,
    );
    expect(container.querySelector('.sr-only')).toHaveTextContent('12,5');
    expect(container.querySelector('.sr-only')).toHaveAttribute('aria-live', 'polite');
    rerender(<CountUp value={12.5} decimals={1} duration={0} locale="en-US" />);
    expect(container.querySelector('.sr-only')).toHaveTextContent('12.5');
    rerender(<CountUp value={3} duration={0} format={(n) => `${n} Funde`} />);
    expect(container.querySelector('.sr-only')).toHaveTextContent('3 Funde');
  });

  it('startet auf Wunsch von einem anderen Wert', () => {
    const { container } = render(<CountUp value={100} from={50} duration={100} />);
    expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent('50');
  });
});

describe('ScoreGauge', () => {
  it('ordnet Bereiche zu und begrenzt Werte', () => {
    expect(scoreBand(0)).toBe('low');
    expect(scoreBand(scoreBandThresholds.medium - 1)).toBe('low');
    expect(scoreBand(scoreBandThresholds.medium)).toBe('medium');
    expect(scoreBand(scoreBandThresholds.high)).toBe('high');
    expect(normalizeScore(120)).toBe(100);
    expect(normalizeScore(-3)).toBe(0);
    expect(normalizeScore(72.6)).toBe(73);
    expect(normalizeScore(Number.NaN)).toBeNull();
    expect(normalizeScore(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeScore(null)).toBeNull();
    expect(normalizeScore(undefined)).toBeNull();
  });

  it('ist mit Wert ein Messinstrument (meter) mit Bereich als Text und Icon', () => {
    render(<ScoreGauge value={72} glow />);
    const meter = screen.getByRole('meter', { name: 'Sicherheits-Score' });
    expect(meter).toHaveAttribute('aria-valuenow', '72');
    expect(meter).toHaveAttribute('aria-valuemin', '0');
    expect(meter).toHaveAttribute('aria-valuemax', '100');
    expect(meter).toHaveAttribute('aria-valuetext', '72 von 100 – Verbesserungswürdig');
    expect(meter).toHaveAttribute('data-band', 'medium');
    expect(screen.getByText('Verbesserungswürdig').querySelector('svg')).not.toBeNull();
    expect(meter.querySelector('[data-part="value"]')).toHaveClass('text-warn');
  });

  it('zeigt ohne Daten neutral „–“ mit ehrlicher Erklärung – nie einen Schätzwert', () => {
    render(<ScoreGauge value={null} glow />);
    expect(screen.queryByRole('meter')).toBeNull();
    const group = screen.getByRole('group', { name: 'Sicherheits-Score' });
    expect(group).toHaveAttribute('data-score', 'none');
    expect(group).toHaveTextContent('–');
    expect(group).toHaveTextContent('Noch keine Daten');
    expect(group).toHaveTextContent('Es wird nichts geschätzt');
    expect(group.querySelector('[data-part="value"]')).toBeNull();
    expect(group.querySelector('[data-part="track-empty"]')).not.toBeNull();
    expect(group.textContent).not.toMatch(/\d/);
  });

  it('behandelt ungültige Werte wie „keine Daten“', () => {
    render(<ScoreGauge value={Number.NaN} />);
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.getByText('Noch keine Daten')).toBeInTheDocument();
  });

  it('übernimmt eigene Texte und Bereichsnamen', () => {
    const { rerender } = render(
      <ScoreGauge
        value={95}
        label="Security score"
        outOfLabel="of 100"
        bandLabels={{ high: 'Good' }}
        size={160}
      />,
    );
    expect(screen.getByRole('meter', { name: 'Security score' })).toHaveAttribute(
      'aria-valuetext',
      '95 of 100 – Good',
    );
    rerender(
      <ScoreGauge
        value={null}
        label="Security score"
        unavailableText="No data yet"
        unavailableHint="Available from P6."
      />,
    );
    expect(screen.getByText('No data yet')).toBeInTheDocument();
    expect(screen.getByText('Available from P6.')).toBeInTheDocument();
  });

  it('färbt niedrige Werte als kritisch und hohe als gut', () => {
    const { rerender } = render(<ScoreGauge value={20} />);
    expect(screen.getByRole('meter')).toHaveAttribute('data-band', 'low');
    expect(screen.getByText('Kritisch')).toBeInTheDocument();
    rerender(<ScoreGauge value={90} />);
    expect(screen.getByText('Gut')).toBeInTheDocument();
  });

  it('zeichnet bei „Bewegung reduzieren“ sofort den Endstand', () => {
    mockMatchMedia(true);
    render(<ScoreGauge value={64} />);
    expect(screen.getByRole('meter')).toHaveTextContent('64');
  });
});
