/**
 * Phasen- bzw. Schrittliste (C.6/C.9): Zeilen à 26 px, Index Mono, Status rechts.
 * Aktiv: 2 px gelber Balken bei x 452 (16 px links der Inhaltskante) und SVG-Dreieck.
 */
import { cn } from "@shared/lib/cn";
import { Glyph } from "./Glyph";

export type PhaseState = "done" | "active" | "todo" | "failed" | "kept";

export interface PhaseItem {
  id: string;
  index: number;
  label: string;
  state: PhaseState;
  /** Status wie gesetzt (Wörter VERSAL vom Aufrufer, Einheiten klein: „OK · 0,4 s“) */
  status?: string;
  /** Status gelb (z. B. Download-Prozent) */
  signal?: boolean;
}

export interface PhaseListProps {
  items: PhaseItem[];
}

const LABEL: Record<PhaseState, string> = {
  done: "text-obs-fg-2",
  active: "text-obs-fg",
  todo: "text-obs-fg-3",
  failed: "text-obs-fg",
  kept: "text-obs-fg-3",
};
const STATUS: Record<PhaseState, string> = {
  done: "text-obs-fg-2",
  active: "text-obs-fg",
  todo: "text-obs-fg-3",
  failed: "text-obs-error",
  kept: "text-obs-fg-3",
};

export function PhaseList({ items }: PhaseListProps) {
  return (
    <ol className="relative w-[472px]">
      {items.map((it) => (
        <li key={it.id} className="relative flex h-[26px] items-center" aria-current={it.state === "active" ? "step" : undefined}>
          {it.state === "active" && <span aria-hidden className="absolute top-1 -left-4 h-[18px] w-[2px] bg-obs-signal" />}
          <span aria-hidden className="obs-value w-7 shrink-0 text-[11px] leading-4 text-obs-fg-3">
            {String(it.index).padStart(2, "0")}
          </span>
          <span className={cn("min-w-0 flex-1 truncate text-[13px] leading-[18px]", LABEL[it.state])}>{it.label}</span>
          <span className={cn("obs-label flex shrink-0 items-center gap-1.5 pl-3 normal-case", STATUS[it.state], it.signal && "text-obs-signal")}>
            {it.state === "active" && <Glyph name="tri-right" className="text-obs-signal" />}
            {it.status ?? "—"}
          </span>
        </li>
      ))}
    </ol>
  );
}
