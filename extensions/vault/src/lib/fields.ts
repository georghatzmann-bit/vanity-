/**
 * Findet Login-Felder und füllt sie aus. Gefüllt wird nur, was der Nutzer angeklickt hat; die
 * Werte setzt der Browser-eigene Setter (nicht von der Seite überschreibbar), danach folgen
 * `input`/`change`, damit Seiten-Frameworks die Eingabe bemerken.
 */

const USER_TYPES = new Set(['text', 'email', 'tel', '']);

/** Sichtbar, aktiv und beschreibbar? */
export function usable(input: HTMLInputElement): boolean {
  if (input.disabled || input.readOnly || input.type === 'hidden') {
    return false;
  }
  const style = input.ownerDocument.defaultView?.getComputedStyle(input);
  if (style !== undefined && (style.display === 'none' || style.visibility === 'hidden')) {
    return false;
  }
  return true;
}

/** Sichtbarkeit samt Vorfahren (Produkt der Opazitäten). */
export function effectiveOpacity(el: Element): number {
  let opacity = 1;
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    const value = Number.parseFloat(getComputedStyle(node).opacity);
    opacity *= Number.isNaN(value) ? 1 : value;
  }
  return opacity;
}

/** Rechteck, wie es der Nutzer sieht (für Tests austauschbar). */
type RectOf = (
  el: Element,
) => Pick<DOMRect, 'top' | 'left' | 'bottom' | 'right' | 'width' | 'height'>;

const rectOf: RectOf = (el) => el.getBoundingClientRect();

/**
 * Deutlich sichtbar? Ausgefüllt wird nur in Felder, die der Nutzer sehen kann: nicht
 * durchsichtig (auch nicht über Vorfahren), nicht winzig, im sichtbaren Bereich. So landet ein
 * Passwort nicht in einem versteckten Feld, das die Seite heimlich ausliest.
 */
export function clearlyVisible(el: HTMLElement, rect: RectOf = rectOf): boolean {
  if (typeof el.checkVisibility === 'function') {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
      return false;
    }
  }
  if (effectiveOpacity(el) < 0.9) {
    return false;
  }
  const r = rect(el);
  const view = el.ownerDocument.defaultView;
  const width = view?.innerWidth ?? 0;
  const height = view?.innerHeight ?? 0;
  return (
    r.width >= 8 && r.height >= 8 && r.bottom > 0 && r.right > 0 && r.top < height && r.left < width
  );
}

/** Alle nutzbaren Passwortfelder des Dokuments. */
export function passwordFields(doc: Document): HTMLInputElement[] {
  return [...doc.querySelectorAll<HTMLInputElement>('input[type="password"]')].filter(usable);
}

/** Benutzername-Feld zu einem Passwortfeld: das letzte passende Feld davor (im selben Formular). */
export function usernameFor(password: HTMLInputElement): HTMLInputElement | null {
  const scope: ParentNode = password.form ?? password.ownerDocument;
  const candidates = [...scope.querySelectorAll<HTMLInputElement>('input')].filter(
    (i) =>
      i !== password &&
      usable(i) &&
      (USER_TYPES.has(i.type) || i.autocomplete === 'username') &&
      (i.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  );
  const marked = candidates.filter((i) => i.autocomplete === 'username');
  return marked.at(-1) ?? candidates.at(-1) ?? null;
}

/** Setzt einen Wert wie eine Eingabe des Nutzers. */
export function setValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter === undefined) {
    input.value = value;
  } else {
    setter.call(input, value);
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Füllt Benutzername (falls Feld sichtbar und Wert nicht leer) und Passwort – nur, wenn das
 * Passwortfeld deutlich sichtbar ist. `false`: nichts ausgefüllt.
 */
export function fill(
  password: HTMLInputElement,
  username: string,
  secret: string,
  rect: RectOf = rectOf,
): boolean {
  if (!usable(password) || !clearlyVisible(password, rect)) {
    return false;
  }
  const user = usernameFor(password);
  if (user !== null && username !== '' && clearlyVisible(user, rect)) {
    setValue(user, username);
  }
  setValue(password, secret);
  return true;
}
