/**
 * Schutz eigener Anzeigen auf fremden Seiten (Knopf, Menü, Speichern-Frage): geschlossener
 * Schatten-Baum mit neutralem Zufallsnamen, oberste Ebene (Popover), Prüfung auf Veränderungen
 * durch die Seite und auf die echte Klickstelle.
 */

import { effectiveOpacity } from './fields';

/** Neuer Wirt mit zufälligem, neutralem Namen (noch nicht eingehängt). */
export function randomHost(): HTMLElement {
  // getRandomValues gibt es auch auf HTTP-Seiten (randomUUID nicht).
  const tag = [...crypto.getRandomValues(new Uint8Array(4))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const host = document.createElement(`x-${tag}`);
  host.setAttribute('data-hint', '');
  return host;
}

/** Zeigt ein Element in der obersten Ebene (falls der Browser das kann). */
export function lift(node: HTMLElement): void {
  node.setAttribute('popover', 'manual');
  try {
    node.showPopover();
  } catch {
    // ohne Popover bleibt es ein festes Element – die Sichtprüfung gilt trotzdem
  }
}

/** Ist die Anzeige unverändert sichtbar (Wirt nicht durchsichtig, gefiltert, verformt)? */
export function intact(host: HTMLElement): boolean {
  if (!host.isConnected) {
    return false;
  }
  for (let node: Element | null = host; node !== null; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (
      style.filter !== 'none' ||
      style.visibility === 'hidden' ||
      style.display === 'none' ||
      (node === host && style.transform !== 'none')
    ) {
      return false;
    }
  }
  return effectiveOpacity(host) >= 0.99;
}

/** Liegt an der Klickstelle wirklich `target` (nichts von der Seite darüber)? */
export function hit(e: MouseEvent, host: HTMLElement, root: ShadowRoot, target: Element): boolean {
  // Tastatur (Enter/Leertaste auf dem fokussierten Knopf) hat keine Klickstelle.
  if (e.detail === 0) {
    return true;
  }
  if (document.elementFromPoint(e.clientX, e.clientY) !== host) {
    return false;
  }
  const inner = root.elementFromPoint(e.clientX, e.clientY);
  return inner !== null && target.contains(inner);
}

/** Schließt die Anzeige, sobald die Seite Stil, Klassen oder Attribute des Wirts ändert. */
export function watchHost(host: HTMLElement, onTamper: () => void): MutationObserver {
  const observer = new MutationObserver(onTamper);
  observer.observe(host, { attributes: true });
  return observer;
}
