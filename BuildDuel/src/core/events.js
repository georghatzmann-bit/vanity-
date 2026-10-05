// =============================================================================
// Ereignis-Bus ("EventBus")
// =============================================================================
// Teile des Spiels sagen Bescheid, wenn etwas passiert ("emit"), z. B.
//   game.events.emit('jump', { character });
// Andere Teile hören zu ("on"), z. B. der Ton spielt dann ein Sprung-Geräusch:
//   game.events.on('jump', ({ character }) => { … });
//
// Die Namen und Inhalte aller Ereignisse stehen in ARCHITECTURE.md (Abschnitt 8).
//
// Technik: Die Zuhörer-Liste wird beim An- und Abmelden neu angelegt
// ("copy on write"). Beim Senden wird nichts Neues angelegt – das ist schnell
// und erlaubt, dass sich ein Zuhörer während des Sendens abmeldet.
// =============================================================================

export class EventBus {
  constructor() {
    /** @type {Map<string, Function[]>} */
    this._listeners = new Map();
  }

  /**
   * Zuhören.
   * @param {string} name      Name des Ereignisses
   * @param {Function} fn      wird mit dem Inhalt (payload) aufgerufen
   * @returns {() => void}     Funktion zum Abmelden
   */
  on(name, fn) {
    if (typeof fn !== 'function') throw new Error(`EventBus.on("${name}"): Zuhörer muss eine Funktion sein`);
    const list = this._listeners.get(name);
    this._listeners.set(name, list ? [...list, fn] : [fn]);
    return () => this.off(name, fn);
  }

  /** Einmal zuhören (danach automatisch abgemeldet). */
  once(name, fn) {
    const off = this.on(name, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  /** Zuhören beenden. */
  off(name, fn) {
    const list = this._listeners.get(name);
    if (!list) return;
    const index = list.indexOf(fn);
    if (index < 0) return;
    if (list.length === 1) {
      this._listeners.delete(name);
      return;
    }
    const copy = list.slice();
    copy.splice(index, 1);
    this._listeners.set(name, copy);
  }

  /**
   * Bescheid sagen. Alle Zuhörer werden aufgerufen – auch wenn einer davon
   * einen Fehler wirft. Der erste Fehler wird danach weitergeworfen (damit er
   * in der Fehler-Anzeige landet und nicht still verschwindet).
   * @returns {number} Anzahl der Zuhörer
   */
  emit(name, payload) {
    const list = this._listeners.get(name);
    if (!list) return 0;
    let firstError = null;
    for (let i = 0; i < list.length; i++) {
      try {
        list[i](payload);
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
    if (firstError) throw firstError;
    return list.length;
  }

  /** Wie viele Zuhörer hat ein Ereignis? (für Tests) */
  listenerCount(name) {
    return this._listeners.get(name)?.length ?? 0;
  }

  /** Alle Zuhörer entfernen (beim Aufräumen). */
  clear() {
    this._listeners.clear();
  }
}
