/** Elemente, die per Tab erreichbar sein können (vor dem Filtern). */
const TABBABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'iframe',
  'summary',
  '[tabindex]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(',');

function isTabbable(element: HTMLElement): boolean {
  if (element.tabIndex < 0) {
    return false;
  }
  if ((element as HTMLButtonElement).disabled) {
    return false;
  }
  // Inerte, versteckte und vor Hilfstechnologien verborgene Teilbäume sind nicht erreichbar.
  return element.closest('[inert], [hidden], [aria-hidden="true"]') === null;
}

/** Alle per Tab erreichbaren Elemente in `root`, in Dokument-Reihenfolge. */
export function getTabbableElements(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)].filter(isTabbable);
}

/** Fokussiert ohne Scrollsprung; gibt zurück, ob das Element danach den Fokus hat. */
export function focusElement(element: HTMLElement | null | undefined): boolean {
  if (!element) {
    return false;
  }
  element.focus({ preventScroll: true });
  return element.ownerDocument.activeElement === element;
}
