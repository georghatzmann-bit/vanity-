// =============================================================================
// Kill-Feed (oben links): "Du [AR] Bot_3" – die letzten 5 Meldungen, nach 5 s weg
// =============================================================================
// Zwei Teile:
//   KillFeedQueue – reine Logik (welche Meldungen sind sichtbar?), ohne Bildschirm testbar
//   createKillFeed(container) – zeigt die Meldungen als HTML-Zeilen (feste Anzahl Zeilen,
//                               es werden keine neuen Elemente angelegt)
// Werte: CONFIG.hud.killFeed (max, lifetime, fadeTime), Kurz-Namen CONFIG.hud.weaponShortNames.
// =============================================================================
import { CONFIG } from '../config.js';

const K = CONFIG.hud.killFeed;

/**
 * Warteschlange der Meldungen. Neueste zuletzt. Höchstens `max` Einträge,
 * jeder lebt `lifetime` Sekunden.
 */
export class KillFeedQueue {
  constructor(max = K.max, lifetime = K.lifetime) {
    this.max = max;
    this.lifetime = lifetime;
    /** @type {Array<{killer: string, weapon: string, victim: string, head: boolean, mine: boolean, died: boolean, time: number}>} */
    this.entries = [];
    this.version = 0; // zählt jede Änderung (das HUD malt nur dann neu)
  }

  /** Neue Meldung (entry.time wird gesetzt). Zu viele → die älteste fliegt raus. */
  push(entry, now) {
    entry.time = now;
    this.entries.push(entry);
    while (this.entries.length > this.max) this.entries.shift();
    this.version++;
    return entry;
  }

  /** Abgelaufene Meldungen entfernen. @returns {boolean} hat sich etwas geändert? */
  prune(now) {
    let removed = 0;
    while (this.entries.length > 0 && now - this.entries[0].time >= this.lifetime) {
      this.entries.shift();
      removed++;
    }
    if (removed > 0) this.version++;
    return removed > 0;
  }

  /** Deckkraft einer Meldung (blendet am Ende ihrer Zeit aus). */
  opacity(entry, now, fadeTime = K.fadeTime) {
    const left = this.lifetime - (now - entry.time);
    if (left <= 0) return 0;
    return left >= fadeTime ? 1 : left / fadeTime;
  }

  clear() {
    if (this.entries.length === 0) return;
    this.entries.length = 0;
    this.version++;
  }
}

/** Kurzer Waffen-Name für den Kill-Feed ("AR", "Schrot" …). */
export function weaponShortName(weaponId, kind) {
  const names = CONFIG.hud.weaponShortNames;
  if (weaponId && names[weaponId]) return names[weaponId];
  if (kind && names[kind]) return names[kind];
  return weaponId ? String(weaponId) : '';
}

/**
 * Meldung aus einem 'characterKilled'-Ereignis bauen.
 * @param {object} e        { victim, killer, weaponId }
 * @param {object|null} player  die eigene Figur (heißt "Du")
 * @param {boolean} head    Kopfschuss?
 */
export function killFeedEntry(e, player, head = false) {
  const you = CONFIG.hud.texts.you;
  const nameOf = (c) => (c ? (c === player ? you : c.name) : '');
  const killer = e.killer && e.killer !== e.victim ? e.killer : null;
  return {
    killer: nameOf(killer),
    weapon: weaponShortName(e.weaponId),
    victim: nameOf(e.victim),
    head: !!head,
    mine: !!player && killer === player,
    died: !!player && e.victim === player,
    time: 0,
  };
}

/**
 * HTML-Anzeige. container = leeres Element (wird gefüllt).
 * @returns {{ queue: KillFeedQueue, add(entry, now), update(now), clear(), dispose() }}
 */
export function createKillFeed(container) {
  const queue = new KillFeedQueue();
  const rows = [];
  for (let i = 0; i < queue.max; i++) {
    const row = document.createElement('div');
    row.className = 'hud-feed-row';
    row.hidden = true;
    row.innerHTML = '<span class="k"></span><span class="w"></span><span class="v"></span><span class="h" title="Kopfschuss">◎</span>';
    container.appendChild(row);
    rows.push({
      el: row,
      k: row.children[0],
      w: row.children[1],
      v: row.children[2],
      h: row.children[3],
      entry: null,
      opacity: 1,
    });
  }
  let shownVersion = -1;

  function render() {
    shownVersion = queue.version;
    const list = queue.entries;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const entry = list[i] ?? null;
      if (entry === r.entry) continue;
      r.entry = entry;
      r.el.hidden = !entry;
      if (!entry) continue;
      r.k.textContent = entry.killer;
      r.k.hidden = !entry.killer;
      r.w.textContent = entry.weapon;
      r.w.hidden = !entry.weapon;
      r.v.textContent = entry.victim;
      r.h.hidden = !entry.head;
      r.el.classList.toggle('mine', entry.mine);
      r.el.classList.toggle('died', entry.died);
      r.el.style.opacity = '1';
      r.opacity = 1;
    }
  }

  return {
    queue,
    add(entry, now) {
      queue.push(entry, now);
      render();
    },
    /** Pro Bild: abgelaufene entfernen, ausblenden. */
    update(now) {
      queue.prune(now);
      if (queue.version !== shownVersion) render();
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r.entry) continue;
        const o = Math.round(queue.opacity(r.entry, now) * 20) / 20;
        if (o !== r.opacity) {
          r.opacity = o;
          r.el.style.opacity = String(o);
        }
      }
    },
    /** Für Tests: sichtbare Meldungen als Text. */
    texts() {
      return queue.entries.map((e) => [e.killer, e.weapon ? `[${e.weapon}]` : '', e.victim, e.head ? '(Kopf)' : ''].filter(Boolean).join(' '));
    },
    clear() {
      queue.clear();
      render();
    },
    dispose() {
      container.textContent = '';
    },
  };
}
