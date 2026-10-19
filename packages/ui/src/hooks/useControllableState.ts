import { useCallback, useState } from 'react';

export interface ControllableStateOptions<T> {
  /** Kontrollierter Wert (dann führt der Aufrufer den Zustand). */
  readonly value: T | undefined;
  /** Startwert im unkontrollierten Betrieb. */
  readonly defaultValue: T;
  /** Wird bei jeder Änderung durch die Komponente aufgerufen. */
  readonly onChange?: ((value: T) => void) | undefined;
}

/**
 * Zustand, der wahlweise kontrolliert (`value`) oder unkontrolliert (`defaultValue`) ist –
 * wie bei nativen Formularelementen.
 */
export function useControllableState<T>({
  value,
  defaultValue,
  onChange,
}: ControllableStateOptions<T>): [T, (next: T) => void] {
  const [internal, setInternal] = useState(defaultValue);
  const controlled = value !== undefined;
  const current = controlled ? value : internal;
  const setValue = useCallback(
    (next: T) => {
      if (!controlled) {
        setInternal(next);
      }
      onChange?.(next);
    },
    [controlled, onChange],
  );
  return [current, setValue];
}
