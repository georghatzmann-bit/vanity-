// Sensi-Kalibrierung: die drei Rundentypen des Aim-Tests als reine Logik (ohne DOM, ohne Uhr).
// Zeit (t, in ms seit Rundenbeginn, ohne Pausen) und Blickrichtung {yaw, pitch} kommen von außen.
// So lassen sich die Runden in Unit-Tests mit erfundenen Mausbewegungen prüfen.

import { angDist, wrapDeg, clamp } from './sensi-math.mjs';

/** Zielgröße als Winkel-Radius in Grad. */
export const RADIUS = { flick: 1.5, tracking: 2.0, moving: 1.8 };
/** Bereich, in dem Ziele erscheinen (± Grad um die Mitte der Arena). */
export const ZONE = { yaw: 35, pitch: 12 };
/** So lange (ms) ohne Mausbewegung gilt als "angehalten". */
export const STOP_MS = 60;

const RAD = Math.PI / 180;

function local(a, s) {
  return { x: wrapDeg(a.yaw - s.yaw) * Math.cos(((a.pitch + s.pitch) / 2) * RAD), y: a.pitch - s.pitch };
}

/** Fortschritt entlang der Linie Start -> Ziel: 0 = Start, 1 = Zielmitte, > 1 = darüber hinaus. */
export function flickProgress(start, target, aim) {
  const ax = local(target, start);
  const len2 = ax.x * ax.x + ax.y * ax.y;
  if (len2 < 1e-9) return 1;
  const p = local(aim, start);
  return (p.x * ax.x + p.y * ax.y) / len2;
}

/**
 * Bewertet einen Flick.
 * 'over'  = das Fadenkreuz ist über den hinteren Rand des Ziels hinausgegangen (zu schnell)
 * 'under' = beim ersten Anhalten oder bei einem Fehlklick war das Fadenkreuz noch vor dem Ziel (zu langsam)
 * 'clean' = direkt drauf
 * rr = Zielradius / Abstand (Rand des Ziels auf der Fortschritts-Skala)
 */
export function classifyFlick({ pMax, firstStopP, shortClick, rr }) {
  if (pMax > 1 + rr) return 'over';
  if ((firstStopP != null && firstStopP < 1 - rr) || shortClick) return 'under';
  return 'clean';
}

class Round {
  constructor(type, { durationMs = 6000, leadInMs = 1200, rng = Math.random } = {}) {
    this.type = type;
    this.durationMs = durationMs;
    this.leadInMs = leadInMs;
    this.rng = rng;
    this.t = 0;
    this.hits = 0;
    this.misses = 0;
    this.clicks = 0;
    this.timeouts = 0;
    this.ttks = [];
    this.nextId = 1;
  }

  /** Wird gerade gemessen (Ansage vorbei, Zeit nicht abgelaufen)? */
  get live() { return this.t >= this.leadInMs && !this.done; }
  get done() { return this.t >= this.leadInMs + this.durationMs; }
  get inLeadIn() { return this.t < this.leadInMs; }
  get liveMs() { return clamp(this.t - this.leadInMs, 0, this.durationMs); }
  get progress() { return clamp(this.liveMs / this.durationMs, 0, 1); }

  begin(_aim, t = 0) { this.t = t; }
  move(_aim, _t) {}
  update(_aim, t) { this.t = t; }
  shoot() { return { result: 'ignored' }; }
  targets() { return []; }
}

function randomInZone(rng) {
  return { yaw: (rng() * 2 - 1) * ZONE.yaw, pitch: (rng() * 2 - 1) * ZONE.pitch };
}

// ---------------------------------------------------------------- Flicks

export class FlickRound extends Round {
  constructor(opts = {}) {
    super('flick', opts);
    this.radius = opts.radius ?? RADIUS.flick;
    this.timeoutMs = opts.timeoutMs ?? 4000;
    this.minDist = opts.minDist ?? 8;
    this.maxDist = opts.maxDist ?? 55;
    this.target = null;
    this.over = 0;
    this.under = 0;
    this.flicks = 0;
    this.lastMoveAt = -Infinity;
    this.finished = [];
  }

  spawn(aim, t) {
    let pick = null;
    let pickD = 0;
    for (let i = 0; i < 40; i++) {
      const c = randomInZone(this.rng);
      const d = angDist(aim, c);
      if (d >= this.minDist && d <= this.maxDist) { pick = c; pickD = d; break; }
      if (!pick || Math.abs(d - 25) < Math.abs(pickD - 25)) { pick = c; pickD = d; }
    }
    const d = Math.max(pickD, this.radius * 2);
    this.target = {
      id: this.nextId++, yaw: pick.yaw, pitch: pick.pitch, radius: this.radius, bornAt: t,
      start: { yaw: aim.yaw, pitch: aim.pitch }, rr: this.radius / d,
      pMax: 0, pLast: 0, movedEnough: false, firstStopP: null, stopChecked: false, shortClick: false,
    };
  }

  track(aim) {
    const tg = this.target;
    if (!tg) return;
    const p = flickProgress(tg.start, tg, aim);
    tg.pLast = p;
    if (p > tg.pMax) tg.pMax = p;
    if (p >= 0.25) tg.movedEnough = true;
  }

  finish(tg, how) {
    this.flicks++;
    const c = classifyFlick(tg);
    if (c === 'over') this.over++;
    else if (c === 'under') this.under++;
    this.finished.push({ id: tg.id, how, result: c });
  }

  move(aim, t) {
    this.lastMoveAt = t;
    if (this.live) this.track(aim);
  }

  update(aim, t) {
    this.t = t;
    if (this.done) { this.target = null; return; } // angefangenes Ziel zählt nicht
    if (!this.live) return;
    if (!this.target) { this.spawn(aim, t); return; }
    this.track(aim);
    const tg = this.target;
    if (!tg.stopChecked && tg.movedEnough && this.lastMoveAt > tg.bornAt && t - this.lastMoveAt >= STOP_MS) {
      tg.firstStopP = tg.pLast;
      tg.stopChecked = true;
    }
    if (t - tg.bornAt >= this.timeoutMs) {
      this.misses++;
      this.timeouts++;
      this.finish(tg, 'timeout');
      this.spawn(aim, t);
    }
  }

  shoot(aim, t) {
    if (!this.live || !this.target) return { result: 'ignored' };
    this.clicks++;
    const tg = this.target;
    this.track(aim);
    if (angDist(aim, tg) <= tg.radius) {
      this.hits++;
      this.ttks.push(Math.max(0, t - tg.bornAt));
      this.finish(tg, 'hit');
      const hit = { id: tg.id, yaw: tg.yaw, pitch: tg.pitch, radius: tg.radius };
      this.target = null;
      this.spawn(aim, t);
      return { result: 'hit', target: hit };
    }
    this.misses++;
    if (tg.movedEnough && tg.pLast < 1 - tg.rr) tg.shortClick = true;
    return { result: 'miss' };
  }

  targets() {
    return this.target && this.live ? [{ id: this.target.id, yaw: this.target.yaw, pitch: this.target.pitch, radius: this.target.radius, bornAt: this.target.bornAt }] : [];
  }

  stats() {
    return {
      type: 'flick', hits: this.hits, misses: this.misses, clicks: this.clicks, timeouts: this.timeouts,
      ttks: this.ttks.slice(), liveMs: this.liveMs, flicks: this.flicks, over: this.over, under: this.under,
    };
  }
}

// ---------------------------------------------------------------- Tracking

export class TrackingRound extends Round {
  constructor(opts = {}) {
    super('tracking', opts);
    this.radius = opts.radius ?? RADIUS.tracking;
    this.minSpeed = opts.minSpeed ?? 14; // Grad pro Sekunde
    this.maxSpeed = opts.maxSpeed ?? 30;
    this.pos = { yaw: 0, pitch: 0 };
    this.vel = { x: 0, y: 0 };
    this.want = { x: 0, y: 0 };
    this.nextChange = 0;
    this.onTargetMs = 0;
    this.measuredMs = 0;
    this.hot = false;
    this.lastT = 0;
  }

  begin(aim, t = 0) {
    this.t = t;
    this.lastT = t;
    this.pos = {
      yaw: clamp(wrapDeg(aim.yaw), -ZONE.yaw + 4, ZONE.yaw - 4),
      pitch: clamp(aim.pitch, -ZONE.pitch + 2, ZONE.pitch - 2),
    };
    this.nextChange = this.leadInMs;
  }

  pickVelocity(t) {
    const ang = this.rng() * Math.PI * 2;
    const speed = this.minSpeed + this.rng() * (this.maxSpeed - this.minSpeed);
    // meist seitlich, wie ein Gegner, der hin und her läuft
    this.want = { x: Math.cos(ang) * speed, y: Math.sin(ang) * speed * 0.45 };
    this.nextChange = t + 350 + this.rng() * 800;
  }

  update(aim, t) {
    const dt = clamp(t - this.lastT, 0, 100);
    this.lastT = t;
    this.t = t;
    if (t < this.leadInMs || this.done) {
      this.hot = angDist(aim, this.pos) <= this.radius;
      return;
    }
    if (t >= this.nextChange) this.pickVelocity(t);
    const Y = ZONE.yaw - 3; const P = ZONE.pitch - 2;
    if (this.pos.yaw > Y - 4 && this.want.x > 0) this.want.x = -this.want.x;
    if (this.pos.yaw < -Y + 4 && this.want.x < 0) this.want.x = -this.want.x;
    if (this.pos.pitch > P - 2 && this.want.y > 0) this.want.y = -this.want.y;
    if (this.pos.pitch < -P + 2 && this.want.y < 0) this.want.y = -this.want.y;
    const k = Math.min(1, (dt / 1000) * 6);
    this.vel.x += (this.want.x - this.vel.x) * k;
    this.vel.y += (this.want.y - this.vel.y) * k;
    this.pos.yaw += (this.vel.x * dt) / 1000;
    this.pos.pitch += (this.vel.y * dt) / 1000;
    if (this.pos.yaw > Y) { this.pos.yaw = Y; this.vel.x = -Math.abs(this.vel.x); }
    if (this.pos.yaw < -Y) { this.pos.yaw = -Y; this.vel.x = Math.abs(this.vel.x); }
    if (this.pos.pitch > P) { this.pos.pitch = P; this.vel.y = -Math.abs(this.vel.y); }
    if (this.pos.pitch < -P) { this.pos.pitch = -P; this.vel.y = Math.abs(this.vel.y); }
    this.hot = angDist(aim, this.pos) <= this.radius;
    this.measuredMs += dt;
    if (this.hot) this.onTargetMs += dt;
  }

  get trackingPct() { return this.measuredMs > 0 ? (100 * this.onTargetMs) / this.measuredMs : 0; }

  targets() {
    return this.done ? [] : [{ id: 1, yaw: this.pos.yaw, pitch: this.pos.pitch, radius: this.radius, hot: this.hot, bornAt: 0 }];
  }

  stats() {
    return { type: 'tracking', onTargetMs: Math.round(this.onTargetMs), measuredMs: Math.round(this.measuredMs), liveMs: this.liveMs };
  }
}

// ---------------------------------------------------------------- Bewegte Ziele

export class MovingRound extends Round {
  constructor(opts = {}) {
    super('moving', opts);
    this.radius = opts.radius ?? RADIUS.moving;
    this.count = opts.count ?? 2;
    this.minSpeed = opts.minSpeed ?? 5;
    this.maxSpeed = opts.maxSpeed ?? 13;
    this.lifeMs = opts.lifeMs ?? 5000;
    this.list = [];
    this.lastT = 0;
  }

  begin(aim, t = 0) { this.t = t; this.lastT = t; this.list = []; }

  spawn(aim, t) {
    let pick = null;
    for (let i = 0; i < 40; i++) {
      const c = randomInZone(this.rng);
      c.yaw *= 0.9; c.pitch *= 0.85;
      if (angDist(aim, c) >= 6 && this.list.every((o) => angDist(o, c) >= 8)) { pick = c; break; }
      pick = c;
    }
    const ang = this.rng() * Math.PI * 2;
    const speed = this.minSpeed + this.rng() * (this.maxSpeed - this.minSpeed);
    this.list.push({ id: this.nextId++, yaw: pick.yaw, pitch: pick.pitch, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed * 0.5, radius: this.radius, bornAt: t });
  }

  update(aim, t) {
    const dt = clamp(t - this.lastT, 0, 100);
    this.lastT = t;
    this.t = t;
    if (this.done) { this.list = []; return; }
    if (!this.live) return;
    while (this.list.length < this.count) this.spawn(aim, t);
    const Y = ZONE.yaw; const P = ZONE.pitch;
    for (let i = 0; i < this.list.length; i++) {
      const o = this.list[i];
      o.yaw += (o.vx * dt) / 1000;
      o.pitch += (o.vy * dt) / 1000;
      if (o.yaw > Y) { o.yaw = Y; o.vx = -Math.abs(o.vx); }
      if (o.yaw < -Y) { o.yaw = -Y; o.vx = Math.abs(o.vx); }
      if (o.pitch > P) { o.pitch = P; o.vy = -Math.abs(o.vy); }
      if (o.pitch < -P) { o.pitch = -P; o.vy = Math.abs(o.vy); }
      if (t - o.bornAt >= this.lifeMs) {
        this.misses++;
        this.timeouts++;
        this.list.splice(i, 1);
        i--;
      }
    }
    while (this.list.length < this.count) this.spawn(aim, t);
  }

  shoot(aim, t) {
    if (!this.live || !this.list.length) return { result: 'ignored' };
    this.clicks++;
    let best = -1; let bestD = Infinity;
    this.list.forEach((o, i) => {
      const d = angDist(aim, o);
      if (d <= o.radius && d < bestD) { best = i; bestD = d; }
    });
    if (best >= 0) {
      const o = this.list[best];
      this.hits++;
      this.ttks.push(Math.max(0, t - o.bornAt));
      this.list.splice(best, 1);
      this.spawn(aim, t);
      return { result: 'hit', target: { id: o.id, yaw: o.yaw, pitch: o.pitch, radius: o.radius } };
    }
    this.misses++;
    return { result: 'miss' };
  }

  targets() {
    return this.live ? this.list.map((o) => ({ id: o.id, yaw: o.yaw, pitch: o.pitch, radius: o.radius, bornAt: o.bornAt })) : [];
  }

  stats() {
    return { type: 'moving', hits: this.hits, misses: this.misses, clicks: this.clicks, timeouts: this.timeouts, ttks: this.ttks.slice(), liveMs: this.liveMs };
  }
}

export function createRound(type, opts) {
  if (type === 'tracking') return new TrackingRound(opts);
  if (type === 'moving') return new MovingRound(opts);
  return new FlickRound(opts);
}
