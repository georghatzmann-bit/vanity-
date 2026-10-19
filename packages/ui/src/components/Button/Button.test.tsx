import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IconCheck, IconClose } from '../../icons/icons.tsx';
import { mockMatchMedia } from '../../test/matchMedia.ts';
import { contrastRatio } from '../../tokens/contrast.ts';
import { themeNames, themes } from '../../tokens/tokens.ts';
import { Button, buttonVariantClasses } from './Button.tsx';
import { IconButton } from './IconButton.tsx';
import { Spinner } from './Spinner.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Button', () => {
  it('ist standardmäßig type="button", sekundär und mittelgroß', () => {
    render(<Button>Prüfen</Button>);
    const button = screen.getByRole('button', { name: 'Prüfen' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('data-variant', 'secondary');
    expect(button).toHaveClass('h-9');
  });

  it('löst Klicks aus, gibt die Ref weiter und ist per Tastatur bedienbar', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(
      <Button ref={ref} variant="primary" size="lg" onClick={onClick}>
        Jetzt prüfen
      </Button>,
    );
    expect(ref.current).toBe(screen.getByRole('button'));
    await user.click(screen.getByRole('button'));
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it('zeigt Icons dekorativ vor und nach dem Text', () => {
    render(
      <Button iconStart={<IconCheck />} iconEnd={<IconClose />} fullWidth>
        Mit Icons
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Mit Icons' });
    expect(button.querySelectorAll('[aria-hidden="true"] svg')).toHaveLength(2);
    expect(button).toHaveClass('w-full');
  });

  it('blockiert im Ladezustand Klicks, bleibt fokussierbar und meldet „Bitte warten“', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick} iconStart={<IconCheck />}>
        Speichern
      </Button>,
    );
    const button = screen.getByRole('button', { name: /^Speichern\s*, Bitte warten$/ });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toBeEnabled();
    expect(screen.getByTestId('aegis-spinner')).toBeInTheDocument();
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
    button.focus();
    expect(button).toHaveFocus();
  });

  it('erlaubt eine eigene Lade-Ansage', () => {
    render(
      <Button loading loadingLabel="Please wait">
        Save
      </Button>,
    );
    expect(screen.getByRole('button', { name: /^Save\s*, Please wait$/ })).toBeInTheDocument();
  });

  it('ist gesperrt nicht klickbar', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick} variant="danger" size="sm" style={{ minWidth: 10 }}>
        Löschen
      </Button>,
    );
    await user.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole('button')).toHaveStyle({ minWidth: '10px' });
  });

  it('hat für jede Variante Klassen und genug Kontrast für „danger“ (Text auf Rot)', () => {
    for (const variant of ['primary', 'secondary', 'ghost', 'danger'] as const) {
      expect(buttonVariantClasses[variant].length).toBeGreaterThan(0);
    }
    for (const theme of themeNames) {
      const colors = themes[theme].colors;
      expect(contrastRatio(colors.bg, colors.danger)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors['on-accent'], colors.accent)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors['on-accent'], colors['accent-strong'])).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it('federt bei „Bewegung reduzieren“ nicht (keine transform-Animation beim Drücken)', () => {
    mockMatchMedia(true);
    render(<Button>Ruhig</Button>);
    const button = screen.getByRole('button');
    fireEvent.pointerDown(button);
    expect(button.style.transform).toBe('');
  });
});

describe('IconButton', () => {
  it('verlangt einen zugänglichen Namen und versteckt das Icon', () => {
    render(<IconButton label="Fenster schließen" icon={<IconClose />} />);
    const button = screen.getByRole('button', { name: 'Fenster schließen' });
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(button).toHaveAttribute('type', 'button');
  });

  it('kann als Umschalter dienen (aria-pressed) und gibt die Ref weiter', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(
      <IconButton
        ref={ref}
        label="Klang"
        icon={<IconCheck />}
        pressed
        variant="secondary"
        size="lg"
        onClick={onClick}
        style={{ opacity: 1 }}
      />,
    );
    const button = screen.getByRole('button', { name: 'Klang', pressed: true });
    expect(ref.current).toBe(button);
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('ist gesperrt nicht klickbar', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<IconButton label="Aus" icon={<IconClose />} disabled size="sm" onClick={onClick} />);
    await user.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Spinner', () => {
  it('ist dekorativ und rotiert per CSS-Klasse', () => {
    render(<Spinner size={20} className="text-accent" />);
    const spinner = screen.getByTestId('aegis-spinner');
    expect(spinner).toHaveAttribute('aria-hidden', 'true');
    expect(spinner).toHaveAttribute('width', '20');
    expect(spinner).toHaveClass('animate-spin', 'text-accent');
  });
});
