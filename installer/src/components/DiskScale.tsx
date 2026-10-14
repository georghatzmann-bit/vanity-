/**
 * Laufwerksskala (C.4), oben = y 352: Kopf `LAUFWERK C:\`, Balken 472 × 10 (y 368–378):
 * belegt = Schraffur, Bedarf = gelb (≥ 3 px), frei = leer mit 1 px `rule-strong`.
 * Darunter Striche und Labels in 1-2-5-Schritten, dann BENÖTIGT · FREI · GESAMT (y 418).
 */
import type { DiskInfo } from "../api";
import { useT } from "../i18n";
import { bytes } from "./Readout";

export interface DiskScaleProps {
  disk: DiskInfo | null;
}

const W = 472;
const UNIT = 1024;

/** Striche in 1-2-5-Schritten (in Bytes), etwa 4–6 Stück bis `total` */
export function diskTicks(total: number): number[] {
  if (!(total > 0)) return [];
  const exp = Math.min(4, Math.floor(Math.log(total) / Math.log(UNIT)));
  const unit = UNIT ** exp;
  const value = total / unit;
  const raw = value / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const out: number[] = [];
  for (let v = 0; v <= value + 1e-9; v += step) out.push(v * unit);
  return out;
}

export function DiskScale({ disk }: DiskScaleProps) {
  const t = useT();
  // Ungültiger Pfad oder noch keine Antwort: keine Werte vom alten Laufwerk, nur „—“ in fg-4
  const valid = Boolean(disk?.valid);
  const drive = valid && disk?.path && /^[a-z]:\\/i.test(disk.path) ? disk.path.slice(0, 3) : "—";
  const ok = valid && disk !== null && disk.total > 0;
  const val = (b: number | undefined) => (valid && b !== undefined ? bytes(b) : <span className="text-obs-fg-4">—</span>);
  const usedW = ok ? Math.round(((disk.total - disk.free) / disk.total) * W) : 0;
  const needW = ok ? Math.max(3, Math.round((disk.required / disk.total) * W)) : 0;
  const ticks = ok ? diskTicks(disk.total) : [];
  return (
    <div className="relative h-[86px] w-[472px]">
      <div className="obs-label absolute top-0 left-0">{t("folder.drive", { d: drive })}</div>
      {/* Balken y 368–378 */}
      <svg aria-hidden width={W} height={10} className="absolute top-4 left-0 block" shapeRendering="crispEdges">
        <defs>
          <pattern id="obs-hatch-disk" width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1={0} y1={0} x2={0} y2={4} stroke="var(--obs-fg-4)" strokeWidth={1} />
          </pattern>
        </defs>
        <rect x={0.5} y={0.5} width={W - 1} height={9} fill="none" stroke="var(--obs-rule-strong)" />
        {ok && <rect x={0} y={0} width={usedW} height={10} fill="url(#obs-hatch-disk)" />}
        {ok && <rect x={Math.min(usedW, W - needW)} y={0} width={needW} height={10} fill="var(--obs-signal)" />}
      </svg>
      {/* Striche und Labels y 378–402 */}
      {ticks.map((b, i) => {
        const x = Math.min(W - 1, Math.round((b / (disk as DiskInfo).total) * W));
        return (
          <div key={b} aria-hidden>
            <div className="absolute top-[26px] h-2 w-px bg-obs-fg-3" style={{ left: x }} />
            <span className={i === 0 ? "obs-label absolute top-[36px] left-0" : "obs-label absolute top-[36px] -translate-x-1/2 whitespace-nowrap"} style={i === 0 ? undefined : { left: x }}>
              {i === 0 ? "0" : bytes(b)}
            </span>
          </div>
        );
      })}
      {/* Summe y 418 */}
      <div className="obs-value obs-value-sm absolute top-[66px] left-0 text-obs-fg" data-testid="disk-summary">
        <span className="obs-label text-[13px] leading-5 tracking-[0.04em]">{t("folder.required")}</span> {val(disk?.required)}
        <span className="text-obs-fg-3"> · </span>
        <span className="obs-label text-[13px] leading-5 tracking-[0.04em]">{t("folder.free")}</span> {val(disk?.free)}
        <span className="text-obs-fg-3"> · </span>
        <span className="obs-label text-[13px] leading-5 tracking-[0.04em]">{t("folder.total")}</span> {ok ? bytes((disk as DiskInfo).total) : val(undefined)}
      </div>
    </div>
  );
}
