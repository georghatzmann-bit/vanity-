'use strict';
// Zählt lokal, wie lange Fortnite läuft – pro aktivem Profil.
// Prüft alle paar Sekunden die Prozessliste (nur Namen, nichts aus dem Spiel selbst).

const MAX_SESSIONS = 5000;

class SessionTracker {
  constructor(core, { intervalMs = 10000 } = {}) {
    this.core = core;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.queue = Promise.resolve();
    core.onFortniteState((running) => this.onChange(running).catch(() => {}));
  }

  /** Schreibzugriffe nacheinander ausführen, damit sich nichts überschneidet. */
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async load() {
    const s = await this.core.readState('sessions', { list: [], current: null });
    s.list ||= [];
    return s;
  }

  async init() {
    // Nach einem Absturz: offene Sitzung mit dem zuletzt gesehenen Zeitpunkt abschließen
    const s = await this.load();
    if (s.current) {
      const end = s.current.lastSeen || s.current.start;
      if (end - s.current.start > 30000) s.list.push({ ...s.current, end, recovered: true });
      s.current = null;
      await this.core.writeState('sessions', s);
    }
  }

  start() {
    this.stop();
    const tick = async () => {
      try {
        await this.core.fortniteStatus();
        if (this.core.fortniteState.running) await this.touch();
      } catch { /* nächster Versuch */ }
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  touch() {
    return this.serial(async () => {
      const s = await this.load();
      if (!s.current) return this.change(true);
      s.current.lastSeen = Date.now();
      await this.core.writeState('sessions', s);
    });
  }

  onChange(running) {
    return this.serial(() => this.change(running));
  }

  async change(running) {
    const s = await this.load();
    if (running && !s.current) {
      const applied = await this.core.readState('applied', null);
      s.current = {
        start: this.core.fortniteState.since || Date.now(),
        lastSeen: Date.now(),
        profileId: applied?.profileId || null,
        profileName: applied?.profileId ? applied.profileName : null,
      };
      await this.core.writeState('sessions', s);
      this.core.emit('sessions.changed', { running: true });
    } else if (!running && s.current) {
      const end = Date.now();
      const sess = { ...s.current, end };
      delete sess.lastSeen;
      if (end - sess.start > 15000) s.list.push(sess);
      if (s.list.length > MAX_SESSIONS) s.list = s.list.slice(-MAX_SESSIONS);
      s.current = null;
      await this.core.writeState('sessions', s);
      this.core.emit('sessions.changed', { running: false, session: sess });
    }
  }

  /** Zusammenfassung pro Profil und pro Tag (für die Session-Statistik). */
  async summary({ days = 30 } = {}) {
    const s = await this.load();
    const list = [...s.list];
    if (s.current) list.push({ ...s.current, end: Date.now(), live: true });
    const perProfile = {};
    const perDay = {};
    for (const x of list) {
      const dur = Math.max(0, x.end - x.start);
      const key = x.profileId || 'ohne';
      const p = (perProfile[key] ||= { profileId: x.profileId, name: x.profileName || 'Ohne Profil', seconds: 0, sessions: 0 });
      p.seconds += dur / 1000;
      p.sessions++;
      const d = new Date(x.start);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      perDay[day] = (perDay[day] || 0) + dur / 1000;
    }
    const today = new Date();
    const daily = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      daily.push({ day, seconds: Math.round(perDay[day] || 0) });
    }
    return {
      running: !!s.current,
      current: s.current,
      totalSeconds: Math.round(list.reduce((n, x) => n + Math.max(0, x.end - x.start), 0) / 1000),
      perProfile: Object.values(perProfile).map((p) => ({ ...p, seconds: Math.round(p.seconds) })).sort((a, b) => b.seconds - a.seconds),
      daily,
      recent: list.slice(-30).reverse().map((x) => ({ start: x.start, end: x.end, profileName: x.profileName || 'Ohne Profil', live: !!x.live })),
    };
  }
}

module.exports = { SessionTracker };
