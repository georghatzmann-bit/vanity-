/**
 * Protokoll (C.7/C.9): Kopf „PROTOKOLL“ (Mono 10) mit Tag GEMESSEN, darunter Zeilen in Mono 13 –
 * Label links (Spalte 200 px, Mono 10 fg-3), Wert rechts davon (fg). Nur vorhandene Messwerte.
 */
import type { ReactNode } from "react";

export interface LogRow {
  label: string;
  value: ReactNode;
  testId?: string;
}

export function LogList({ title, tag, rows, testId }: { title: string; tag?: string; rows: LogRow[]; testId?: string }) {
  return (
    <div className="w-[472px]" data-testid={testId}>
      <div className="obs-label flex items-center gap-2">
        <span>{title}</span>
        {tag && <span className="obs-tag">{tag}</span>}
      </div>
      <dl className="mt-2 m-0">
        {rows.map((r) => (
          <div key={r.label} className="flex h-5 items-baseline">
            <dt className="obs-label w-[200px] shrink-0">{r.label}</dt>
            <dd className="obs-value obs-value-sm m-0 text-obs-fg" data-testid={r.testId}>
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
