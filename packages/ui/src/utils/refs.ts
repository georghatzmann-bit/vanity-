import type { Ref, RefCallback } from 'react';

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') {
    ref(value);
  } else if (ref !== null && ref !== undefined) {
    ref.current = value;
  }
}

/**
 * Verbindet mehrere Refs (Objekt- oder Funktions-Refs) zu einem Callback-Ref. Beim Lösen
 * werden alle Refs auf `null` gesetzt.
 */
export function mergeRefs<T>(...refs: readonly (Ref<T> | undefined)[]): RefCallback<T> {
  return (value) => {
    for (const ref of refs) {
      assignRef(ref, value);
    }
    return () => {
      for (const ref of refs) {
        assignRef(ref, null);
      }
    };
  };
}
