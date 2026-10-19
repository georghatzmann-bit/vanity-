import type { Translator } from '../i18n/translator.ts';

/** Apple-Gerät (nur für die Anzeige der Tastenkürzel: ⌘ statt Strg). */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  return /Mac|iPhone|iPad/i.test(navigator.platform);
}

/** Anzeige von „Strg + Taste“ bzw. „⌘ + Taste“. */
export function modifierKeys(t: Translator['t'], key: string): readonly string[] {
  return [isApplePlatform() ? '⌘' : t('keys.ctrl'), key];
}

/** Steht der Fokus in einem Textfeld? Dann gehört „/“ dem Feld, nicht der App. */
export function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'reset', 'submit', 'color', 'file'].includes(
      target.type,
    );
  }
  return false;
}

/** Ist gerade ein Dialog (auch die Befehlspalette) offen? */
export function isDialogOpen(): boolean {
  return document.querySelector('[data-aegis-dialog-root][data-state="open"]') !== null;
}
