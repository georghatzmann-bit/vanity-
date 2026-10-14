import { describe, expect, it } from "vitest";
import { mulberry32 } from "@shared/sound/dsp";
import { SoundEngine } from "@shared/sound/engine";
import { FakeAudioContext, FakeBufferSource, FakeDoc, ManualTime } from "./fakeAudio";

function setup() {
  const time = new ManualTime(1000);
  const box: { ctx: FakeAudioContext | null } = { ctx: null };
  const eng = new SoundEngine({
    createContext: () => {
      box.ctx = new FakeAudioContext(time.now);
      return box.ctx as unknown as AudioContext;
    },
    now: time.now,
    timers: time.timers,
    doc: new FakeDoc(),
    win: null,
    random: mulberry32(1),
  });
  eng.warmup();
  time.advance(0.3);
  return {
    time,
    eng,
    get ctx() {
      return box.ctx as FakeAudioContext;
    },
  };
}

describe("Partitur: Nachholen und Abbruch (E.4)", () => {
  it("verspätete catchUp-Ereignisse (≤ 3 s) laufen sofort mit t = now, Pulse ohne catchUp entfallen", () => {
    const s = setup();
    const t0 = s.eng.clock.now() - 1; // Partitur beginnt 1 s in der Vergangenheit
    const ran: string[] = [];
    s.eng.score(
      [
        { at: 0, run: () => ran.push("pulse") },
        { at: 0, catchUp: true, run: (t) => ran.push(`noise-in@${(t - t0).toFixed(2)}`) },
        { at: -5, catchUp: true, run: () => ran.push("zu-alt") },
      ],
      t0,
    );
    s.time.advance(0.05);
    expect(ran.length).toBe(1);
    expect(ran[0]).toMatch(/^noise-in@/);
    expect(Number(ran[0].split("@")[1])).toBeGreaterThan(0.9); // nachgeholt bei „jetzt“, nicht bei t0
  });

  it("follow ohne laufendes Bett legt es aus dem Wunschzustand an", () => {
    const s = setup();
    const bed = s.eng.noiseBed();
    bed.set({ levelDb: -34, centerHz: 300, q: 4 });
    s.eng.setMuted(true);
    s.eng.setMuted(false);
    const mark = s.ctx.count();
    // Bett weg (z. B. suspend), Wunsch bleibt
    (bed as unknown as { suspend(): void }).suspend();
    s.time.advance(0.2);
    bed.follow(new Float32Array([300, 600, 1042]), { at: s.eng.clock.now() + 0.05, durS: 0.3 });
    const loops = s.ctx.created.slice(mark).filter((n) => n.kind === "bufferSource" && (n as FakeBufferSource).loop);
    expect(loops.length).toBe(1);
  });

  it("cancel: noch nicht gestartete Quellen sofort hart stoppen (kein Puls nach der Quittung)", () => {
    const s = setup();
    const t0 = s.eng.clock.now();
    const mark = s.ctx.count();
    const h = s.eng.score([{ at: 0.1, run: (t) => s.eng.pulse({ at: t, gainDb: -14 }) }], t0);
    s.time.advance(0.03); // Lookahead 0,12 s: Puls bei +0,1 s ist schon geplant, klingt aber noch nicht
    const src = s.ctx.created.slice(mark).find((n): n is FakeBufferSource => n.kind === "bufferSource") as FakeBufferSource;
    expect(src).toBeDefined();
    expect(src.startAt as number).toBeGreaterThan(s.ctx.currentTime);
    h.cancel({ fadeS: 0.04 });
    expect(src.stopAt).toBe(0);
    expect(src.disconnected).toBe(true);
  });
});
