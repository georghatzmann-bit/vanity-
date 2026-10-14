import { afterEach, describe, expect, it, vi } from "vitest";
import { F_STAR, crossfade, harmonic, mulberry32 } from "@shared/sound/dsp";
import { SoundEngine, sound, type SoundName } from "@shared/sound/engine";
import { SOUND_NAMES } from "@shared/sound/recipes";
import { SpinModel } from "@shared/sound/spin";
import { SilentPulseVoice, type PulseEvent } from "@shared/sound/voice";
import { FakeAudioContext, FakeBufferSource, FakeDoc, FakeGain, FakeNode, FakeOscillator, FakeParam, ManualTime } from "./fakeAudio";

const ALL = SOUND_NAMES as SoundName[];

function setup(o: { warm?: boolean } = {}) {
  const time = new ManualTime(1000);
  const doc = new FakeDoc();
  const box: { ctx: FakeAudioContext | null } = { ctx: null };
  const eng = new SoundEngine({
    createContext: () => {
      box.ctx = new FakeAudioContext(time.now);
      return box.ctx as unknown as AudioContext;
    },
    now: time.now,
    timers: time.timers,
    doc,
    win: null,
    random: mulberry32(1),
  });
  if (o.warm !== false) {
    eng.warmup();
    time.advance(0.3); // Wachhund hat einmal geprüft
  }
  return { time, eng, doc, get ctx() {
    return box.ctx as FakeAudioContext;
  } };
}

/** Klick-Quellen: BufferSources mit einer 4-ms-Anregung (192 Samples bei 48 kHz). */
const clicksOf = (ctx: FakeAudioContext, from = 0) =>
  ctx.created.slice(from).filter((n): n is FakeBufferSource => n.kind === "bufferSource" && (n as FakeBufferSource).buffer?.length === 192 && !(n as FakeBufferSource).loop);

const gainsOf = (ctx: FakeAudioContext, from = 0) => ctx.created.slice(from).filter((n): n is FakeGain => n.kind === "gain");

function masterOf(ctx: FakeAudioContext): FakeGain {
  const comp = ctx.created.find((n) => n.kind === "compressor") as FakeNode;
  return ctx.created.find((n) => n.kind === "gain" && n.outputs.has(comp)) as FakeGain;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ohne window/AudioContext (node)", () => {
  it("play(alle) wirft nicht, Stimmen sind inaktiv", () => {
    const e = new SoundEngine();
    for (const n of ALL) expect(() => e.play(n, { value: 0.5, gain: 0.7 })).not.toThrow();
    for (const n of ALL) expect(() => sound.play(n)).not.toThrow();
    const v = sound.createVoice();
    expect(v.active).toBe(false);
    expect(() => {
      v.start({ fadeS: 0.1 });
      v.setPeriod(0.5);
      v.setJitter(0.5);
      v.setDropout(0.2, { rampS: 0.1 });
      v.skipNext();
      v.accentNext();
      v.setLevel(0.4, { rampS: 0.03 });
      v.setStep(3);
      v.pulse();
      v.follow(new SpinModel({ t0: 0, f0: 1 }));
      v.onPulse(() => undefined)();
      v.stop({ fadeS: 0.1 });
      v.dispose();
    }).not.toThrow();
    expect(v.active).toBe(false);
    expect(e.available).toBe(false);
    expect(e.clock.healthy).toBe(false);
    expect(e.clock.ctxTimeFor(1)).toBeNull();
    expect(() => {
      e.warmup();
      e.setVolume(0.5);
      e.setMuted(true);
      e.setMuted(false);
      e.pulse();
      e.alertTone(1);
      e.chord().release();
      e.noiseBed().set({ levelDb: -40 });
      e.noiseBed().follow(new Float32Array([300, 1000]), { at: 0, durS: 0.3 });
      e.noiseBed().stop();
      e.sweep({ fHi: 3200, fLo: 400, durS: 0.22, gainDb: -24 });
      e.score([{ at: 0, run: () => undefined }], e.clock.now()).cancel();
    }).not.toThrow();
    expect(() => e.sweep({ fHi: 400, fLo: 3200, durS: 0.2, gainDb: -24 })).toThrow(RangeError);
  });
});

describe("mit Fake-Kontext", () => {
  it("Kontext erst in ensure(), Master = v² ohne 0,9", () => {
    const s = setup({ warm: false });
    expect(s.ctx).toBeNull();
    s.eng.warmup();
    expect(s.ctx).not.toBeNull();
    s.eng.setVolume(0.5);
    const m = masterOf(s.ctx);
    expect(m.gain.last("setTargetAtTime")?.args[0]).toBeCloseTo(0.25, 12);
    s.eng.setMuted(true);
    expect(m.gain.last("setTargetAtTime")?.args[0]).toBe(0);
    s.eng.setMuted(false);
    expect(m.gain.last("setTargetAtTime")?.args[0]).toBeCloseTo(0.25, 12);
    expect(m.gain.last("setTargetAtTime")?.args[2]).toBeCloseTo(0.03, 12);
  });

  it("play(alle) wirft nie und erzeugt Knoten", () => {
    const s = setup();
    for (const n of ALL) {
      const before = s.ctx.count();
      for (const v of [0, 0.3, 0.7, 1, Number.NaN]) expect(() => s.eng.play(n, { value: v, gain: 0.8 })).not.toThrow();
      expect(s.ctx.count(), n).toBeGreaterThan(before);
      s.time.advance(0.2);
    }
    expect(() => s.eng.play("click", { at: s.eng.clock.now() + 0.5 })).not.toThrow();
  });

  it("stumm → 0 Knoten; hoverEnabled=false → 0 Knoten", () => {
    const s = setup();
    s.eng.setMuted(true);
    const before = s.ctx.count();
    for (const n of ALL) s.eng.play(n, { value: 0.5 });
    s.eng.pulse();
    s.eng.alertTone(1);
    s.eng.chord();
    s.eng.sweep({ fHi: 3200, fLo: 400, durS: 0.22, gainDb: -24 });
    s.eng.noiseBed().set({ levelDb: -34 });
    const v = s.eng.createVoice();
    v.follow(new SpinModel({ t0: s.time.t, f0: 5 }));
    v.start();
    s.time.advance(1);
    expect(s.ctx.count()).toBe(before);
    expect(v.active).toBe(false);
    v.dispose();

    s.eng.setMuted(false);
    s.eng.noiseBed().stop({ fadeS: 0.01 });
    s.time.advance(0.5);
    s.eng.setHoverEnabled(false);
    const b2 = s.ctx.count();
    s.eng.play("hover");
    expect(s.ctx.count()).toBe(b2);
    s.eng.setHoverEnabled(true);
    s.eng.play("hover");
    expect(s.ctx.count()).toBeGreaterThan(b2);
  });

  it("Sperren: hover 50 ms", () => {
    const s = setup();
    const b = s.ctx.count();
    s.eng.play("hover");
    const one = s.ctx.count() - b;
    s.time.advance(0.03);
    s.eng.play("hover");
    expect(s.ctx.count() - b).toBe(one);
    s.time.advance(0.03);
    s.eng.play("hover");
    expect(s.ctx.count() - b).toBe(2 * one);
  });

  it("ohne healthy wird nichts geplant", () => {
    const s = setup();
    s.ctx.state = "suspended";
    s.time.advance(1.1);
    expect(s.eng.clock.healthy).toBe(false);
    expect(s.eng.available).toBe(false);
    const b = s.ctx.count();
    for (const n of ALL) s.eng.play(n);
    expect(s.ctx.count()).toBe(b);
  });

  it("Uhr: ctxTimeFor/modelTimeFor bilden mit Ausgabelatenz ab", () => {
    const s = setup();
    const t = s.eng.clock.now();
    expect(s.eng.clock.ctxTimeFor(t)).toBeCloseTo(s.ctx.currentTime - 0.02, 9);
    expect(s.eng.clock.modelTimeFor(s.eng.clock.ctxTimeFor(t + 1) as number)).toBeCloseTo(t + 1, 9);
    expect(s.eng.clock.healthy).toBe(true);
  });
});

describe("PulseVoice folgt dem SpinModel", () => {
  it("Klicks zu ctxTimeFor(t), keine Klicks ab 48 Hz, Tonschicht startet an einer Pulszeit, stop() trennt", () => {
    const s = setup();
    const t0 = s.time.t;
    const model = new SpinModel({ t0, f0: 2 });
    model.setTarget({ f: F_STAR, tauS: 0.6, maxOctPerS: 2 });
    const v = s.eng.createVoice();
    const events: PulseEvent[] = [];
    v.onPulse((e) => events.push(e));
    const mark = s.ctx.count();
    v.follow(model);
    v.start({ fadeS: 0.1 });
    expect(v.active).toBe(false); // erster Takt asynchron
    s.time.advance(6);
    expect(v.active).toBe(true);

    const clicks = clicksOf(s.ctx, mark).sort((a, b) => (a.startAt as number) - (b.startAt as number));
    const heard = events.filter((e) => !e.dropped && crossfade(model.freqAt(e.atModel)).wc > 1e-4);
    expect(heard.length).toBeGreaterThan(30);
    expect(clicks.length).toBe(heard.length);
    heard.forEach((e, i) => {
      const want = s.eng.clock.ctxTimeFor(e.atModel) as number;
      if (e.atModel > t0 + 0.05) expect(Math.abs((clicks[i].startAt as number) - want)).toBeLessThan(1e-3);
    });
    // ab 48 Hz keine Klicks mehr
    const fast = events.filter((e) => model.freqAt(e.atModel) >= 48);
    expect(fast.length).toBeGreaterThan(50);
    const lastClick = clicks[clicks.length - 1].startAt as number;
    expect(fast.every((e) => (s.eng.clock.ctxTimeFor(e.atModel) as number) > lastClick)).toBe(true);
    // keine Doppel-Indizes
    expect(new Set(events.map((e) => e.index)).size).toBe(events.length);

    // Tonschicht: genau ein Oszillator mit PeriodicWave, Start an einer Pulszeit
    const oscs = s.ctx.created.slice(mark).filter((n): n is FakeOscillator => n.kind === "oscillator");
    expect(oscs.length).toBe(1);
    const osc = oscs[0];
    expect(osc.type).toBe("custom");
    expect((osc.wave as { disableNormalization: boolean }).disableNormalization).toBe(true);
    expect(events.some((e) => Math.abs((s.eng.clock.ctxTimeFor(e.atModel) as number) - (osc.startAt as number)) < 1e-9)).toBe(true);
    expect(model.freqAt(s.eng.clock.modelTimeFor(osc.startAt as number) as number)).toBeGreaterThan(24);
    // Frequenz-Knoten als linearRamp (dieselben Knoten wie das Modell)
    const ramps = osc.frequency.calls.filter((c) => c.m === "linearRampToValueAtTime");
    expect(ramps.length).toBeGreaterThan(50);
    for (const r of ramps.slice(0, 20)) {
      const tm = s.eng.clock.modelTimeFor(r.args[1]) as number;
      expect(r.args[0]).toBeCloseTo(model.freqAt(tm), 6);
    }

    v.stop({ fadeS: 0.1 });
    expect(v.active).toBe(false);
    s.time.advance(0.5);
    const after = s.ctx.created.slice(mark);
    expect(after.every((n) => n.disconnected)).toBe(true);
    expect(osc.stopAt).not.toBeNull();
    const n = s.ctx.count();
    s.time.advance(1);
    expect(s.ctx.count()).toBe(n); // nach stop keine neuen Knoten
  });

  it("tone: false → Klicks bis 173,7 Hz (Ersatz für alte WebView), kein Oszillator", () => {
    const s = setup();
    const model = new SpinModel({ t0: s.time.t, f0: 100 });
    const v = s.eng.createVoice({ tone: false });
    const mark = s.ctx.count();
    v.follow(model);
    v.start();
    s.time.advance(1);
    expect(clicksOf(s.ctx, mark).length).toBeGreaterThan(80);
    expect(s.ctx.created.slice(mark).some((n) => n.kind === "oscillator")).toBe(false);
  });

  it("Doppel-Mount (StrictMode) → keine Doppel-Pulse", () => {
    const s = setup();
    const model = new SpinModel({ t0: s.time.t, f0: 3 });
    const seen: number[] = [];
    const mark = s.ctx.count();
    const mount = () => {
      const v = s.eng.createVoice();
      const off = v.onPulse((e) => seen.push(e.index));
      v.follow(model);
      v.start({ fadeS: 0.1 });
      return () => {
        off();
        v.dispose();
      };
    };
    const c1 = mount();
    c1();
    const c2 = mount();
    s.time.advance(3);
    expect(seen.length).toBeGreaterThanOrEqual(8);
    expect(new Set(seen).size).toBe(seen.length);
    expect(clicksOf(s.ctx, mark).length).toBe(seen.length);
    expect(s.eng.voiceCount).toBe(1);
    c2();
    expect(s.eng.voiceCount).toBe(0);
  });

  it("höchstens 4 Stimmen; die 5. ist stumm (console.warn)", () => {
    const s = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const vs = [1, 2, 3, 4].map(() => s.eng.createVoice());
    const v5 = s.eng.createVoice();
    expect(v5).toBeInstanceOf(SilentPulseVoice);
    expect(warn).toHaveBeenCalledTimes(1);
    const mark = s.ctx.count();
    v5.start();
    v5.pulse();
    s.time.advance(0.5);
    expect(v5.active).toBe(false);
    expect(s.ctx.count()).toBe(mark);
    vs[0].dispose();
    expect(s.eng.createVoice()).not.toBeInstanceOf(SilentPulseVoice);
  });

  it("verborgenes Fenster: keine Planung, danach kein Nachhol-Burst", () => {
    const s = setup();
    const v = s.eng.createVoice({ periodS: 0.1 });
    const ev: PulseEvent[] = [];
    v.onPulse((e) => ev.push(e));
    v.start();
    s.time.advance(1);
    const n1 = ev.length;
    s.doc.setHidden(true);
    s.time.advance(3);
    expect(ev.length - n1).toBeLessThanOrEqual(2);
    const n2 = ev.length;
    s.doc.setHidden(false);
    s.time.advance(0.05);
    expect(ev.length - n2).toBeLessThanOrEqual(2);
    expect(ev.slice(n2).every((e) => e.atModel >= s.time.t - 0.06)).toBe(true);
  });
});

describe("PulseVoice-API für „Hör dein Netz“ (E.11)", () => {
  const net = () => {
    const s = setup();
    const v = s.eng.createVoice({ timbre: "radio", tone: false, loudnessComp: false, gainDb: -20, periodS: 0.25 });
    const ev: PulseEvent[] = [];
    v.onPulse((e) => ev.push(e));
    return { ...s, v, ev };
  };

  it("start/stop ≤ 150 ms, Knoten werden freigegeben, dispose", () => {
    const { v, time, ctx } = net();
    const mark = ctx.count();
    v.start({ fadeS: 1 });
    time.advance(0.1);
    expect(v.active).toBe(true);
    const fadeRamp = gainsOf(ctx, mark)
      .map((g) => g.gain.calls)
      .flatMap((calls) => calls.map((c, i) => ({ c, prev: calls[i - 1] })))
      .find(({ c, prev }) => c.m === "linearRampToValueAtTime" && c.args[0] === 1 && prev?.m === "setValueAtTime" && prev.args[0] === 0);
    expect(fadeRamp).toBeDefined();
    expect((fadeRamp!.c.args[1] - fadeRamp!.prev.args[1])).toBeCloseTo(0.15, 9);
    v.stop({ fadeS: 0.1 });
    time.advance(0.3);
    expect(v.active).toBe(false);
    expect(ctx.created.slice(mark).every((n) => n.disconnected)).toBe(true);
    v.start({ fadeS: 0.1 });
    time.advance(0.3);
    expect(v.active).toBe(true);
    v.dispose();
    time.advance(0.3);
    expect(v.active).toBe(false);
    expect(ctx.created.slice(mark).every((n) => n.disconnected)).toBe(true);
  });

  it("setPeriod ab dem nächsten Puls, eigener Takt ohne Drift", () => {
    const { v, time, ev } = net();
    v.start();
    time.advance(1.02);
    const t = ev.map((e) => e.atModel);
    for (let i = 1; i < t.length; i++) expect(t[i] - t[i - 1]).toBeCloseTo(0.25, 9);
    v.setPeriod(1);
    expect(v.periodS).toBe(1);
    const k = ev.length;
    time.advance(3);
    const t2 = ev.slice(k - 1).map((e) => e.atModel);
    for (let i = 1; i < t2.length; i++) expect(t2[i] - t2[i - 1]).toBeCloseTo(1, 9);
    v.setPeriod(99);
    expect(v.periodS).toBe(10);
  });

  it("setJitter: Versatz ≤ ±35 %", () => {
    const { v, time, ev } = net();
    v.setJitter(1);
    v.start();
    time.advance(20);
    expect(ev.length).toBeGreaterThan(60);
    const t0 = ev[0].atModel;
    let off = 0;
    ev.forEach((e, i) => {
      const d = e.atModel - (t0 + i * 0.25);
      expect(Math.abs(d)).toBeLessThanOrEqual(0.35 * 0.25 * 2 + 1e-9);
      off = Math.max(off, Math.abs(d));
    });
    expect(off).toBeGreaterThan(0.01);
  });

  it("skipNext: genau ein stummer Puls (kein Klick)", () => {
    const { v, time, ev, ctx } = net();
    v.start();
    time.advance(1);
    const mark = ctx.count();
    const k = ev.length;
    v.skipNext();
    time.advance(1);
    const next = ev.slice(k);
    expect(next.filter((e) => e.dropped).length).toBe(1);
    expect(next[0].dropped).toBe(true);
    expect(clicksOf(ctx, mark).length).toBe(next.length - 1);
  });

  it("accentNext: einmal min(1, 1,5·Pegel), Klick lauter", () => {
    const { v, time, ev, ctx } = net();
    v.setLevel(0.5);
    v.start();
    time.advance(1);
    const k = ev.length;
    const mark = ctx.count();
    v.accentNext(1.5);
    time.advance(1);
    const next = ev.slice(k);
    expect(next[0].level).toBeCloseTo(0.75, 12);
    expect(next.slice(1).every((e) => e.level === 0.5)).toBe(true);
    const cg = clicksOf(ctx, mark).map((src) => ctx.created[ctx.created.indexOf(src) + 1] as FakeGain);
    expect(cg[0].gain.value / cg[1].gain.value).toBeCloseTo(1.5, 9);
  });

  it("setDropout(1, rampS) → alle Pulse fallen aus", () => {
    const { v, time, ev } = net();
    v.start();
    time.advance(0.5);
    v.setDropout(1, { rampS: 0.3 });
    const k = ev.length;
    time.advance(2);
    const late = ev.slice(k).filter((e) => e.atModel > time.t - 1.5);
    expect(late.length).toBeGreaterThan(3);
    expect(late.every((e) => e.dropped)).toBe(true);
  });

  it("setLevel: Rampe ≥ 20 ms erzwungen", () => {
    const { v, time, ctx } = net();
    v.start();
    time.advance(0.3);
    v.setLevel(0.37, { rampS: 0 });
    const g = gainsOf(ctx).find((x) => x.gain.calls.some((c) => c.m === "linearRampToValueAtTime" && Math.abs(c.args[0] - 0.37) < 1e-12)) as FakeGain;
    expect(g).toBeDefined();
    const calls = g.gain.calls;
    const i = calls.findIndex((c) => c.m === "linearRampToValueAtTime" && Math.abs(c.args[0] - 0.37) < 1e-12);
    expect(calls[i - 1].m).toBe("setValueAtTime");
    expect(calls[i].args[1] - calls[i - 1].args[1]).toBeGreaterThanOrEqual(0.02 - 1e-12);
    v.setLevel(0.5, { rampS: 0.03 });
    expect(g.gain.last("linearRampToValueAtTime")?.args[0]).toBe(0.5);
  });

  it("setStep: Kern-BP auf Harmonische von f★ (Stufe 0 dunkel … 5 hell)", () => {
    const { v, time, ctx } = net();
    v.start();
    time.advance(0.3);
    const core = ctx.created.find((n) => n.kind === "biquad" && Math.abs((n as unknown as { frequency: FakeParam }).frequency.value - harmonic(6)) < 0.01 && (n as unknown as { Q: FakeParam }).Q.value === 7) as unknown as { frequency: FakeParam; Q: FakeParam };
    expect(core).toBeDefined();
    v.setStep(0);
    expect(core.frequency.last("setTargetAtTime")?.args[0]).toBeCloseTo(F_STAR * 2, 9);
    v.setStep(5);
    expect(core.frequency.last("setTargetAtTime")?.args[0]).toBeCloseTo(F_STAR * 12, 9);
    expect(core.Q.last("setTargetAtTime")?.args[0]).toBe(7);
    v.setStep(null);
    expect(core.frequency.last("setTargetAtTime")?.args[0]).toBeCloseTo(harmonic(6), 9);
  });

  it("pulse(): Ereignis-Modus unabhängig vom Takt", () => {
    const { v, time, ev, ctx } = net();
    const mark = ctx.count();
    v.pulse({ level: 0.8 });
    expect(ev.length).toBe(1);
    expect(ev[0].level).toBe(0.8);
    expect(clicksOf(ctx, mark).length).toBe(1);
    time.advance(2);
    expect(ctx.created.slice(mark).every((n) => n.disconnected)).toBe(true);
  });

  it("onPulse-Abmeldung", () => {
    const { v, time } = net();
    const seen: number[] = [];
    const off = v.onPulse((e) => seen.push(e.index));
    v.start();
    time.advance(0.6);
    const n = seen.length;
    off();
    time.advance(1);
    expect(seen.length).toBe(n);
  });
});

describe("Bausteine der Fassade", () => {
  it("alertTone: 694,81 + 1389,61 Hz, Spitze = level × −20 dBFS", () => {
    const s = setup();
    const mark = s.ctx.count();
    s.eng.alertTone(1);
    const oscs = s.ctx.created.slice(mark).filter((n): n is FakeOscillator => n.kind === "oscillator");
    expect(oscs.map((o) => o.frequency.value).sort((a, b) => a - b)).toEqual([expect.closeTo(694.81, 2), expect.closeTo(1389.61, 2)]);
    const env = gainsOf(s.ctx, mark).find((g) => g.gain.calls.some((c) => c.m === "linearRampToValueAtTime")) as FakeGain;
    const peak = env.gain.calls.find((c) => c.m === "linearRampToValueAtTime")!.args[0];
    expect(peak * (1 + 10 ** (-12 / 20))).toBeCloseTo(0.1, 9);
    const b = s.ctx.count();
    s.eng.alertTone(0);
    expect(s.ctx.count()).toBe(b);
  });

  it("alertTone bei verborgenem Fenster nur mit whileHidden, stumm bleibt stumm", () => {
    const s = setup();
    s.doc.setHidden(true);
    const mark = s.ctx.count();
    s.eng.alertTone(1);
    expect(s.ctx.count()).toBe(mark);
    s.eng.alertTone(1, { whileHidden: true });
    const oscs = s.ctx.created.slice(mark).filter((n): n is FakeOscillator => n.kind === "oscillator");
    expect(oscs.length).toBe(2);
    s.eng.setMuted(true);
    const b = s.ctx.count();
    s.eng.alertTone(1, { whileHidden: true });
    expect(s.ctx.count()).toBe(b);
    // die Puls-Stimme plant verborgen weiterhin nichts
    s.eng.setMuted(false);
    const v = s.eng.createVoice({ periodS: 0.25 });
    const c = s.ctx.count();
    v.start();
    s.time.advance(1);
    expect(clicksOf(s.ctx, c).length).toBe(0);
  });

  it("sweep: fallende Kurve, RangeError bei fHi ≤ fLo", () => {
    const s = setup();
    const mark = s.ctx.count();
    s.eng.sweep({ fHi: 3200, fLo: 400, durS: 0.22, gainDb: -24 });
    const osc = s.ctx.created.slice(mark).find((n): n is FakeOscillator => n.kind === "oscillator") as FakeOscillator;
    const c = osc.frequency.last("setValueCurveAtTime")!;
    expect(c.args[0]).toBeCloseTo(3200, 3);
    expect(c.args[3]).toBeCloseTo(400, 3);
    expect(c.args[2]).toBeCloseTo(0.22, 9);
    expect(() => s.eng.sweep({ fHi: 400, fLo: 400, durS: 0.2, gainDb: -24 })).toThrow(RangeError);
  });

  it("chord: Teiltöne n·f★ gleichzeitig, release blendet aus", () => {
    const s = setup();
    const mark = s.ctx.count();
    const h = s.eng.chord();
    const oscs = s.ctx.created.slice(mark).filter((n): n is FakeOscillator => n.kind === "oscillator");
    expect(oscs.map((o) => o.frequency.value / F_STAR)).toEqual([1, 2, 3, 4, 5, 6, 8].map((n) => expect.closeTo(n, 9)));
    expect(new Set(oscs.map((o) => o.startAt)).size).toBe(1);
    h.release({ tauS: 0.4 });
    for (const o of oscs) {
      const g = [...o.outputs][0] as FakeGain;
      expect(g.gain.last("setTargetAtTime")?.args).toEqual([0, expect.any(Number), 0.4]);
    }
  });

  it("noiseBed: eine Instanz, stumm ohne Knoten, nach Stumm-Aus wieder da, stop gibt frei", () => {
    const s = setup();
    const bed = s.eng.noiseBed();
    expect(s.eng.noiseBed()).toBe(bed);
    const mark = s.ctx.count();
    bed.set({ levelDb: -34, centerHz: 300, q: 4 });
    const loops = () => s.ctx.created.slice(mark).filter((n) => n.kind === "bufferSource" && (n as FakeBufferSource).loop);
    expect(loops().length).toBe(1);
    bed.follow(new Float32Array([300, 600, 1042]), { at: s.eng.clock.now() + 0.1, durS: 0.5 });
    s.eng.setMuted(true);
    s.time.advance(0.2);
    expect(loops().every((n) => n.disconnected)).toBe(true);
    s.eng.setMuted(false);
    expect(loops().length).toBe(2);
    bed.stop({ fadeS: 0.6 });
    s.time.advance(1);
    expect(s.ctx.created.slice(mark).every((n) => n.disconnected)).toBe(true);
  });

  it("score: Ereignisse zur Modellzeit, cancel stoppt alle in run() erzeugten Quellen", () => {
    const s = setup();
    const t0 = s.eng.clock.now();
    const ran: number[] = [];
    const mark = s.ctx.count();
    const h = s.eng.score(
      [
        { at: 0, run: (t) => (ran.push(t), s.eng.pulse({ at: t, gainDb: -14 })) },
        { at: 0.5, run: (t) => (ran.push(t), s.eng.chord({ at: t })) },
        { at: 2, run: (t) => ran.push(t) },
      ],
      t0,
    );
    expect(ran.length).toBe(0); // nichts synchron
    s.time.advance(0.45);
    expect(ran).toEqual([t0, t0 + 0.5].map((x) => expect.closeTo(x, 9)));
    h.cancel({ fadeS: 0.04 });
    const srcs = s.ctx.created.slice(mark).filter((n): n is FakeOscillator | FakeBufferSource => n.kind === "oscillator" || n.kind === "bufferSource");
    expect(srcs.length).toBe(8);
    for (const x of srcs) expect(x.stopAt).not.toBeNull();
    s.time.advance(2);
    expect(ran.length).toBe(2);
  });

  it("pulse: vorgerenderter Einzelpuls zur Modellzeit", () => {
    const s = setup();
    const mark = s.ctx.count();
    const at = s.eng.clock.now() + 0.3;
    s.eng.pulse({ timbre: "soft", gainDb: -20, at });
    const src = s.ctx.created.slice(mark).find((n): n is FakeBufferSource => n.kind === "bufferSource") as FakeBufferSource;
    expect(src.startAt).toBeCloseTo(s.eng.clock.ctxTimeFor(at) as number, 9);
    expect(([...src.outputs][0] as FakeGain).gain.value).toBeCloseTo(0.1, 9);
  });

  it("launch: Hochdrehen mit Klicks und Tonschicht, danach Teiltöne", () => {
    const s = setup();
    const mark = s.ctx.count();
    s.eng.play("launch");
    const created = s.ctx.created.slice(mark);
    expect(clicksOf(s.ctx, mark).length).toBeGreaterThan(10);
    const oscs = created.filter((n): n is FakeOscillator => n.kind === "oscillator");
    expect(oscs.filter((o) => o.type === "custom").length).toBe(1);
    expect(oscs.filter((o) => o.type === "sine").length).toBe(4);
    s.time.advance(4);
    expect(created.filter((n) => n.kind === "oscillator" || n.kind === "bufferSource").every((n) => (n as FakeOscillator).stopAt !== null || n.disconnected)).toBe(true);
  });

  it("availability-Rückruf", () => {
    const s = setup({ warm: false });
    const seen: boolean[] = [];
    s.eng.onAvailabilityChange((a) => seen.push(a));
    s.eng.warmup();
    s.time.advance(0.3);
    s.ctx.state = "suspended";
    s.time.advance(1.1);
    expect(seen).toEqual([true, false]);
  });
});
