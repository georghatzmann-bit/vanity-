import { render } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from './SegmentedControl.tsx';

// jsdom kennt kein Layout – geprüft wird daher, was die Markierung an Motion übergibt.
const seen = vi.hoisted(() => [] as Array<{ layoutId: unknown; layoutDependency: unknown }>);

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  function SpanProbe({ layoutId, layoutDependency, ...rest }: Record<string, unknown>) {
    seen.push({ layoutId, layoutDependency });
    // Nur DOM-Attribute weiterreichen (Motion-Optionen wie `transition` nicht).
    const attributes = Object.fromEntries(
      Object.entries(rest).filter(([key]) => key !== 'transition'),
    );
    return createElement('span', attributes);
  }
  return { ...actual, motion: { span: SpanProbe } };
});

describe('SegmentedControl – Markierung (UX-10)', () => {
  const options = [
    { value: 'dark', label: 'Dunkel' },
    { value: 'light', label: 'Hell' },
  ] as const;

  it('gleitet nur bei einem Wechsel der Auswahl, nicht bei jedem Neuzeichnen', () => {
    const view = (value: 'dark' | 'light', className?: string) => (
      <SegmentedControl label="Farbschema" options={options} value={value} className={className} />
    );
    const { rerender } = render(view('dark'));
    expect(seen.at(-1)?.layoutId).toEqual(expect.stringContaining('aegis-segmented-'));
    expect(seen.at(-1)?.layoutDependency).toBe('dark');

    // Neuzeichnen ohne Auswahlwechsel (z. B. weil die Seite sich verschiebt): unverändert.
    rerender(view('dark', 'w-full'));
    expect(seen.at(-1)?.layoutDependency).toBe('dark');

    rerender(view('light'));
    expect(seen.at(-1)?.layoutDependency).toBe('light');
  });
});
