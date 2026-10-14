/**
 * Klanglabor (nur DEV und ?lab): alle SoundNames, Puls-Stimme mit eigenem Takt oder SpinModel,
 * Intro-Pulse, Akkord, Warnton, Rauschbett – dazu Spitze/RMS in dBFS vor dem Master (AnalyserNode).
 * Werkzeug zum Einmessen (E.9), kein Teil der Oberfläche; Beschriftungen sind technische Bezeichner.
 */
import { useEffect, useRef, useState } from "react";
import { F_STAR, heardAs } from "@shared/sound/dsp";
import { sound, type PulseVoice, type SoundName } from "@shared/sound/engine";
import { SOUND_NAMES } from "@shared/sound/recipes";
import { SpinModel } from "@shared/sound/spin";

const PULSE_S = 1.3373;
const GRID = { display: "grid", gridTemplateColumns: "160px minmax(0, 1fr) 140px", alignItems: "center", gap: "8px 12px", maxWidth: 720, marginBottom: 20 } as const;
const BTN = { border: "1px solid #646B75", borderRadius: 2, padding: "2px 8px", background: "transparent", color: "inherit", font: "inherit", cursor: "pointer" } as const;
const ROW = { display: "flex", flexWrap: "wrap", gap: 8 } as const;
const H2 = { color: "#808792", fontSize: 12, fontWeight: 400, margin: "0 0 8px" } as const;
const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "−∞");

/** log-Schieber 0..1000 ↔ Wert */
const logTo = (u: number, lo: number, hi: number) => lo * Math.pow(hi / lo, u / 1000);
const logFrom = (v: number, lo: number, hi: number) => (1000 * Math.log(v / lo)) / Math.log(hi / lo);

function useMeter() {
  const [m, setM] = useState({ peak: -Infinity, rms: -Infinity, hold: -Infinity });
  useEffect(() => {
    const an = sound.createAnalyser(8192);
    if (!an) return;
    const buf = new Float32Array(an.fftSize);
    let hold = -Infinity;
    let holdAt = 0;
    const id = window.setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let pk = 0;
      let sq = 0;
      for (const x of buf) {
        pk = Math.max(pk, Math.abs(x));
        sq += x * x;
      }
      const peak = 20 * Math.log10(pk || 1e-9);
      const rms = 10 * Math.log10(sq / buf.length || 1e-18);
      const now = performance.now();
      if (peak > hold || now - holdAt > 2000) {
        hold = peak;
        holdAt = now;
      }
      setM({ peak, rms, hold });
    }, 100);
    return () => {
      window.clearInterval(id);
      try {
        an.disconnect();
      } catch {
        /* egal */
      }
    };
  }, []);
  return m;
}

export default function SoundLab() {
  const meter = useMeter();
  const voice = useRef<PulseVoice | null>(null);
  const model = useRef<SpinModel | null>(null);
  const [running, setRunning] = useState(false);
  const [follow, setFollow] = useState(false);
  const [period, setPeriod] = useState(PULSE_S);
  const [target, setTarget] = useState(1 / PULSE_S);
  const [jitter, setJitter] = useState(0);
  const [dropout, setDropout] = useState(0);
  const [level, setLevel] = useState(1);
  const [step, setStep] = useState<number | null>(null);
  const [volume, setVolume] = useState(sound.volume);
  const [bed, setBed] = useState(false);
  const [bedDb, setBedDb] = useState(-34);
  const [pulses, setPulses] = useState(0);
  const chord = useRef<{ release(o?: { tauS?: number }): void } | null>(null);

  useEffect(() => {
    const v = sound.createVoice({ periodS: PULSE_S });
    voice.current = v;
    const off = v.onPulse((e) => {
      if (!e.dropped) setPulses((n) => n + 1);
    });
    return () => {
      off();
      v.dispose();
      voice.current = null;
    };
  }, []);

  const toggleVoice = () => {
    const v = voice.current;
    if (!v) return;
    if (running) v.stop({ fadeS: 0.1 });
    else v.start({ fadeS: 0.1 });
    setRunning(!running);
  };

  const toggleFollow = () => {
    const v = voice.current;
    if (!v) return;
    if (follow) {
      v.follow(null);
    } else {
      const m = new SpinModel({ t0: sound.clock.now(), f0: 1 / period });
      m.setTarget({ f: target, tauS: 0.6, maxOctPerS: 2 });
      model.current = m;
      v.follow(m);
    }
    setFollow(!follow);
  };

  const curF = follow && model.current ? model.current.freqAt(sound.clock.now()) : 1 / period;

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "auto", padding: 24, background: "#0A0B0D", color: "#E6E8EB", font: "12px/1.5 'IBM Plex Mono', Consolas, monospace" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 24, marginBottom: 16, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 14, margin: 0 }}>sound lab · f★ {fmt(F_STAR, 4)} Hz</h1>
        <span>
          peak {fmt(meter.peak)} dBFS · hold {fmt(meter.hold)} · rms {fmt(meter.rms)} (pre-master)
        </span>
        <span>{sound.available ? "audio ok" : "audio n/a"}</span>
      </div>

      <section style={{ marginBottom: 20 }}>
        <h2 style={H2}>SoundName</h2>
        <div style={ROW}>
          {(SOUND_NAMES as SoundName[]).map((n) => (
            <button key={n} type="button" style={BTN} onClick={() => sound.play(n, { value: 0.5 })}>
              {n}
            </button>
          ))}
        </div>
      </section>

      <section style={GRID}>
        <h2 style={{ ...H2, gridColumn: "1 / -1" }}>PulseVoice</h2>
        <button type="button" style={BTN} onClick={toggleVoice}>
          {running ? "stop" : "start"}
        </button>
        <button type="button" style={{ ...BTN, justifySelf: "start" }} onClick={toggleFollow}>
          {follow ? "follow(model) ✓" : "follow(model)"}
        </button>
        <span>
          {pulses} · {heardAs(curF)}
        </span>

        <label htmlFor="lab-period">period</label>
        <input id="lab-period" type="range" min={0} max={1000} value={logFrom(period, 0.004, 10)} onChange={(e) => {
          const p = logTo(+e.target.value, 0.004, 10);
          setPeriod(p);
          voice.current?.setPeriod(p);
        }} />
        <span>{fmt(period * 1000, 2)} ms</span>

        <label htmlFor="lab-target">model target f</label>
        <input id="lab-target" type="range" min={0} max={1000} value={logFrom(target, 0.5, 180)} onChange={(e) => {
          const f = logTo(+e.target.value, 0.5, 180);
          setTarget(f);
          model.current?.setTarget({ f, tauS: 0.6, maxOctPerS: 2 });
        }} />
        <span>{fmt(target, 2)} Hz</span>

        <label htmlFor="lab-jitter">jitter</label>
        <input id="lab-jitter" type="range" min={0} max={100} value={jitter * 100} onChange={(e) => {
          const j = +e.target.value / 100;
          setJitter(j);
          voice.current?.setJitter(j);
        }} />
        <span>{fmt(jitter, 2)}</span>

        <label htmlFor="lab-dropout">dropout</label>
        <input id="lab-dropout" type="range" min={0} max={100} value={dropout * 100} onChange={(e) => {
          const d = +e.target.value / 100;
          setDropout(d);
          voice.current?.setDropout(d, { rampS: 0.1 });
        }} />
        <span>{fmt(dropout, 2)}</span>

        <label htmlFor="lab-level">level</label>
        <input id="lab-level" type="range" min={0} max={100} value={level * 100} onChange={(e) => {
          const l = +e.target.value / 100;
          setLevel(l);
          voice.current?.setLevel(l, { rampS: 0.03 });
        }} />
        <span>{fmt(level, 2)}</span>

        <label htmlFor="lab-step">step</label>
        <input id="lab-step" type="range" min={-1} max={5} value={step ?? -1} onChange={(e) => {
          const s = +e.target.value < 0 ? null : +e.target.value;
          setStep(s);
          voice.current?.setStep(s);
        }} />
        <span>{step === null ? "timbre" : `n = ${[2, 3, 4, 6, 8, 12][step]}`}</span>

        <span />
        <div style={ROW}>
          <button type="button" style={BTN} onClick={() => voice.current?.skipNext()}>skipNext</button>
          <button type="button" style={BTN} onClick={() => voice.current?.accentNext(1.5)}>accentNext</button>
          <button type="button" style={BTN} onClick={() => voice.current?.pulse()}>pulse()</button>
        </div>
        <span />
      </section>

      <section style={GRID}>
        <h2 style={{ ...H2, gridColumn: "1 / -1" }}>engine</h2>
        <span />
        <div style={ROW}>
          <button type="button" style={BTN} onClick={() => {
            const t0 = sound.clock.now() + 0.1;
            sound.score([
              { at: 0, run: (t) => sound.pulse({ at: t, gainDb: -14 }) },
              { at: PULSE_S, run: (t) => sound.pulse({ at: t, gainDb: -14 }) },
            ], t0);
          }}>2 × B1919</button>
          <button type="button" style={BTN} onClick={() => {
            chord.current?.release({ tauS: 0.2 });
            chord.current = sound.chord();
          }}>chord()</button>
          <button type="button" style={BTN} onClick={() => chord.current?.release({ tauS: 0.7 })}>release</button>
          <button type="button" style={BTN} onClick={() => sound.alertTone(1)}>alertTone(1)</button>
          <button type="button" style={BTN} onClick={() => sound.sweep({ fHi: 3200, fLo: 400, durS: 0.22, gainDb: -24 })}>sweep fwd</button>
          <button type="button" style={BTN} onClick={() => sound.sweep({ fHi: 1800, fLo: 300, durS: 0.16, gainDb: -27 })}>sweep back</button>
        </div>
        <span />

        <label htmlFor="lab-bed">noise bed</label>
        <input id="lab-bed" type="range" min={-70} max={-30} value={bedDb} onChange={(e) => {
          const d = +e.target.value;
          setBedDb(d);
          if (bed) sound.noiseBed().set({ levelDb: d, centerHz: F_STAR * 6, q: 0.7 });
        }} />
        <button type="button" style={BTN} onClick={() => {
          if (bed) sound.noiseBed().stop({ fadeS: 0.3 });
          else sound.noiseBed().set({ levelDb: bedDb, centerHz: F_STAR * 6, q: 0.7 });
          setBed(!bed);
        }}>
          {bed ? `${bedDb} dBFS ✓` : `${bedDb} dBFS`}
        </button>

        <label htmlFor="lab-vol">volume</label>
        <input id="lab-vol" type="range" min={0} max={100} value={volume * 100} onChange={(e) => {
          const v = +e.target.value / 100;
          setVolume(v);
          sound.setVolume(v);
        }} />
        <span>{fmt(volume, 2)} → {fmt(20 * Math.log10(volume * volume))} dB</span>
      </section>
    </div>
  );
}
