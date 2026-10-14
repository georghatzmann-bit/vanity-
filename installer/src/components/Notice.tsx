/**
 * Hinweis (B.7) als Messprotokoll-Eintrag statt Alert-Kasten: keine Fläche, kein Seitenbalken,
 * nur eine 1-px-Haarlinie oben in Tonfarbe. Zeile 1: kleines Dreieck 12 px (warn/error) und das
 * Wort HINWEIS/FEHLER (Mono 10); darunter Titel 13/600 und Text 13/20 `fg-2`.
 * Aktionen gehören in die Fußleiste der Seite (primär rechts, Zurück links), nicht in den Hinweis.
 */
import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@shared/lib/cn";
import { useT } from "../i18n";

export interface NoticeProps {
  tone: "warn" | "error" | "neutral";
  title?: ReactNode;
  role?: "alert" | "status";
  children?: ReactNode;
  /** Wort und Text in einer Zeile (wenig Platz, ohne Titel) */
  compact?: boolean;
  className?: string;
  testId?: string;
}

const TONE = {
  warn: { color: "var(--obs-warn)", icon: true, word: "obs.hint" },
  error: { color: "var(--obs-error)", icon: true, word: "obs.error" },
  neutral: { color: "var(--obs-fg-3)", icon: false, word: "obs.hint" },
} as const;

export function Notice({ tone, title, role, children, compact, className, testId }: NoticeProps) {
  const t = useT();
  const s = TONE[tone];
  const word = (
    <span className="obs-label inline-flex items-center gap-1.5 align-middle" style={{ color: s.color }}>
      {s.icon && <AlertTriangle aria-hidden className="h-3 w-3 shrink-0" strokeWidth={1.5} />}
      {t(s.word)}
    </span>
  );
  return (
    <div role={role} data-testid={testId} data-tone={tone} className={cn("w-[472px] pt-2", className)} style={{ borderTop: `1px solid ${s.color}` }}>
      {compact ? (
        <p className="m-0 text-[13px] leading-5 text-obs-fg-2">
          {word}
          <span className="ml-2">{children}</span>
        </p>
      ) : (
        <>
          <div className="leading-4">{word}</div>
          {title && <div className="mt-1.5 text-[13px] leading-5 font-semibold text-obs-fg">{title}</div>}
          {children && <div className="mt-0.5 text-[13px] leading-5 text-obs-fg-2">{children}</div>}
        </>
      )}
    </div>
  );
}
