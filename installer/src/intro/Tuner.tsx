/**
 * Frequenzregler des Intros (C.1): log2-Skala 0,25–4 Hz auf x 200–780 (145 px pro Oktave),
 * Hauptstriche bei 0,25/0,5/1/2/4, Zwischenstriche alle ¼ Oktave. Die Nadel wird per Ref
 * bewegt (kein State pro Bild), die Ablesung höchstens mit 20 Hz aktualisiert.
 */
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { getLang, useT } from "../i18n";
import { fixed, NBSP } from "../obs/format";
import { tunerX } from "../obs/introTimeline";

export interface TunerHandle {
  /** Nadel auf f (Hz); `locked` = eingerastet (gelb, Ablesung mit 4 Stellen) */
  set(hz: number, locked: boolean): void;
}

export interface TunerProps {
  handleRef?: Ref<TunerHandle>;
}

const X0 = 200;
const X1 = 780;
/** Tuner-Gruppe 16 px tiefer als ursprünglich (Platz für Achsentitel und Objektzeile) */
const DY = 16;
const BASE_Y = 484.5 + DY;
const MAJORS: ReadonlyArray<readonly [number, string, string]> = [
  [0.25, "0,25", "0.25"],
  [0.5, "0,5", "0.5"],
  [1, "1", "1"],
  [2, "2", "2"],
  [4, "4", "4"],
];
/** Periode von CP 1919 (wörtlich, B.6) */
const P_LOCK = "1.3373";
const F_LOCK_TXT = "0.7478";

/** Werte der Ablesung: { f: „0,412 Hz“, p: „2,427 s“ } bzw. eingerastet { f: „0,7478 Hz“, p: „1,3373 s“ } */
export function tunerValues(hz: number, locked: boolean, lang: "de" | "en"): { f: string; p: string } {
  const dec = (s: string) => (lang === "de" ? s.replace(".", ",") : s);
  if (locked) return { f: `${dec(F_LOCK_TXT)}${NBSP}Hz`, p: `${dec(P_LOCK)}${NBSP}s` };
  return { f: `${fixed(hz, 3, lang)}${NBSP}Hz`, p: `${fixed(1 / hz, 3, lang)}${NBSP}s` };
}

/** Ablesung als Text „F 0,412 Hz · P 2,427 s“ (F/P sind Beschriftungen, im Bild Mono 10 fg-3) */
export function tunerReading(hz: number, locked: boolean, lang: "de" | "en"): string {
  const v = tunerValues(hz, locked, lang);
  return `F ${v.f} · P ${v.p}`;
}

const SIGNAL = "var(--obs-signal)";
const SEARCH = "var(--obs-fg-2)";

export function Tuner({ handleRef }: TunerProps) {
  const t = useT();
  const lang = getLang();
  const needleRef = useRef<SVGGElement>(null);
  const wordRef = useRef<HTMLSpanElement>(null);
  const valueRef = useRef<HTMLSpanElement>(null);
  const fRef = useRef<HTMLSpanElement>(null);
  const pRef = useRef<HTMLSpanElement>(null);
  const last = useRef({ hz: 0.4, locked: false, textAt: -1, x: -1, lockedShown: null as boolean | null });

  const applyText = (hz: number, locked: boolean) => {
    const w = wordRef.current;
    const v = valueRef.current;
    if (!w || !v) return;
    w.textContent = locked ? t("intro.locked") : t("intro.search");
    w.style.color = locked ? SIGNAL : "var(--obs-fg-3)";
    const r = tunerValues(hz, locked, getLang());
    if (fRef.current) fRef.current.textContent = r.f;
    if (pRef.current) pRef.current.textContent = r.p;
    v.style.color = locked ? SIGNAL : SEARCH;
  };

  useImperativeHandle(
    handleRef,
    () => ({
      set(hz: number, locked: boolean) {
        const L = last.current;
        L.hz = hz;
        L.locked = locked;
        const x = Math.min(X1, Math.max(X0, tunerX(hz)));
        const g = needleRef.current;
        if (g && Math.abs(x - L.x) > 0.01) {
          g.setAttribute("transform", `translate(${(x - X0).toFixed(2)} 0)`);
          L.x = x;
        }
        if (g && L.lockedShown !== locked) g.style.color = locked ? SIGNAL : SEARCH;
        const now = performance.now();
        // 20 Hz beim Suchen, Zustandswechsel sofort
        if (L.lockedShown !== locked || now - L.textAt >= 50) {
          applyText(hz, locked);
          L.textAt = now;
          L.lockedShown = locked;
        }
      },
    }),
    [t, lang],
  );

  // Sprachwechsel: Ablesung neu setzen
  useEffect(() => {
    applyText(last.current.hz, last.current.locked);
  }, [t, lang]);

  const minors: number[] = [];
  for (let q = 1; q < 16; q++) if (q % 4 !== 0) minors.push(X0 + (145 / 4) * q);

  return (
    <div className="pointer-events-none absolute top-0 left-0 h-[560px] w-[980px]" data-testid="intro-tuner">
      {/* Kopfzeile: Faltfrequenz links, Ablesung rechts – eine gemeinsame Grundlinie */}
      <div className="absolute left-[200px] flex w-[580px] items-baseline justify-between whitespace-nowrap" style={{ top: 402 + DY }}>
        <span className="obs-label">{t("intro.folding")}</span>
        <span className="flex items-baseline gap-2" data-testid="intro-reading">
          <span ref={wordRef} className="obs-label" />
          <span ref={valueRef} className="flex items-baseline gap-[6px] normal-case">
            <span className="obs-label text-obs-fg-3">F</span>
            <span ref={fRef} className="obs-value obs-value-md" style={{ color: "inherit" }} />
            <span className="obs-label text-obs-fg-3">·</span>
            <span className="obs-label text-obs-fg-3">P</span>
            <span ref={pRef} className="obs-value obs-value-md" style={{ color: "inherit" }} />
          </span>
        </span>
      </div>
      <svg aria-hidden width={980} height={560} viewBox="0 40 980 560" className="absolute top-0 left-0">
        <g style={{ shapeRendering: "crispEdges" }}>
          <line x1={X0} y1={BASE_Y} x2={X1} y2={BASE_Y} stroke="var(--obs-rule-strong)" strokeWidth={1} />
          {MAJORS.map(([f]) => {
            const x = Math.round(tunerX(f)) + 0.5;
            return <line key={f} x1={x} y1={BASE_Y} x2={x} y2={BASE_Y - 8} stroke="var(--obs-fg-3)" strokeWidth={1} />;
          })}
          {minors.map((m) => {
            const x = Math.round(m) + 0.5;
            return <line key={m} x1={x} y1={BASE_Y} x2={x} y2={BASE_Y - 4} stroke="var(--obs-fg-3)" strokeOpacity={0.6} strokeWidth={1} />;
          })}
        </g>
        <g style={{ fontFamily: "var(--obs-mono)", fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", fill: "var(--obs-fg-3)" }}>
          {MAJORS.map(([f, de, en]) => (
            <text key={f} x={tunerX(f)} y={490 + DY} dominantBaseline="hanging" textAnchor="middle">
              {lang === "de" ? de : en}
            </text>
          ))}
          <text x={X1 + 10} y={490 + DY} dominantBaseline="hanging">
            Hz
          </text>
        </g>
        {/* Nadel: Dreieck 7 × 5 bei y 466, 1-px-Linie zur Grundlinie */}
        <g ref={needleRef} style={{ color: SEARCH }} transform={`translate(${(tunerX(0.4) - X0).toFixed(2)} 0)`}>
          <path d={`M${X0 - 3.5} ${466 + DY} L${X0 + 3.5} ${466 + DY} L${X0} ${471 + DY} Z`} fill="currentColor" />
          <line x1={X0} y1={471 + DY} x2={X0} y2={BASE_Y} stroke="currentColor" strokeWidth={1} />
        </g>
      </svg>
    </div>
  );
}
