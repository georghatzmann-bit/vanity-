/** Katalog der vier Referenz-Pulsare (Spec B.6, wörtlich). */

export type RefId = "b1919" | "vela" | "crab" | "j0437";

export interface Reference {
  id: RefId;
  /** Bezeichnung wie in der Statusleiste */
  designation: string;
  /** Langname */
  name: string;
  /** Periode in Sekunden */
  periodS: number;
  /** Frequenz in Hz (1/P) */
  freqHz: number;
  ra: string;
  dec: string;
}

const ref = (id: RefId, designation: string, name: string, periodS: number, ra: string, dec: string): Reference => ({ id, designation, name, periodS, freqHz: 1 / periodS, ra, dec });

export const REFERENCES: Record<RefId, Reference> = {
  b1919: ref("b1919", "PSR B1919+21", "PSR B1919+21 (CP 1919)", 1.3373, "19h21m44.8s", "+21°53′02″"),
  vela: ref("vela", "PSR B0833−45", "PSR B0833−45 (Vela)", 0.08933, "08h35m20.6s", "−45°10′35″"),
  crab: ref("crab", "PSR B0531+21", "PSR B0531+21 (Krebsnebel / Crab)", 0.0337, "05h34m31.9s", "+22°00′52″"),
  j0437: ref("j0437", "PSR J0437−4715", "PSR J0437−4715", 0.005757, "04h37m15.9s", "−47°15′09″"),
};

/** Von langsam nach schnell */
export const REF_ORDER: RefId[] = ["b1919", "vela", "crab", "j0437"];

/** Grenzen = geometrische Mittel benachbarter Perioden (0,3456 s / 0,05487 s / 0,013929 s) */
export const REF_BOUNDARIES: number[] = REF_ORDER.slice(1).map((id, i) => Math.sqrt(REFERENCES[REF_ORDER[i]].periodS * REFERENCES[id].periodS));

/** Nächster Katalog-Pulsar im log-Abstand */
export function nearestReference(periodS: number): RefId {
  for (let i = 0; i < REF_BOUNDARIES.length; i++) if (periodS > REF_BOUNDARIES[i]) return REF_ORDER[i];
  return REF_ORDER[REF_ORDER.length - 1];
}

/** Koordinatenzeile für die Statusleiste (nach `ZIEL `) */
export function coordLine(r: RefId | Reference): string {
  const x = typeof r === "string" ? REFERENCES[r] : r;
  return `${x.designation} · RA ${x.ra} · DEC ${x.dec} · J2000`;
}

/** x-Lage einer Periode auf der Log-Skala des Schirms (C.2): 24 + 93·log10(P / 1 ms) */
export function logScaleX(periodS: number): number {
  return 24 + 93 * Math.log10(periodS / 0.001);
}
